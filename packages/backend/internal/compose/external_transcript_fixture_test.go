package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

// transcriptImportFixture is one install with a repository, three members and
// a branch machine boot, behind the production chat routes. Ben and Alice hold
// browser sessions; only the remote daemon and model host are scripted.
type transcriptImportFixture struct {
	pool                   *pgxpool.Pool
	owner, ben, alice      db.User
	repo                   db.Repository
	branch                 db.Workspace
	benCookie, aliceCookie string
	// host records any app-agent turn an import wrongly launched.
	host      revokedAuthorHost
	store     *chat.Store
	registry  *machined.Registry
	authority machined.BootAuthority
	// call sends one authenticated browser request and requires its status.
	call func(method, path, body, cookie string, expected int) string
}

func newTranscriptImportFixture(t *testing.T) *transcriptImportFixture {
	t.Helper()
	_, _, pool := splitProcessDatabase(t)
	q, ctx := db.New(pool), t.Context()
	user := func(login string) db.User {
		u, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: strings.ToUpper(login[:1]) + login[1:]})
		require.NoError(t, err)
		return u
	}
	owner, ben, alice := user("owner"), user("ben"), user("alice")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"owner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	for _, u := range []db.User{owner, ben, alice} {
		permission := "admin"
		if u.ID == alice.ID {
			permission = "write"
		}
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, u.ID, permission)
		require.NoError(t, err)
	}
	session := func(u db.User) string {
		key := u.Username + "-view-cookie"
		hash := sha256.Sum256([]byte(key))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return key
	}
	fixture := &transcriptImportFixture{pool: pool, owner: owner, ben: ben, alice: alice, repo: repo, benCookie: session(ben), aliceCookie: session(alice),
		host: revokedAuthorHost{started: make(chan ports.ChatTurnGrant, 8), stopped: make(chan string, 8)}}

	runtime, err := chat.NewRuntime(pool, fixture.host, "http://127.0.0.1:4000", chat.RuntimeOptions{})
	require.NoError(t, err)
	branches := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)))
	runtime.Handler.ResolveBranch = conversationBranchResolver(branches)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "smithers_session"
	cfg.Server.PublicURL = "http://127.0.0.1:4000"
	cfg.Server.AllowedOrigins = []string{"http://127.0.0.1:4000"}
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{}).(chi.Router)
	mountChatPublic(router, runtime, q, cfg)
	// The dispatcher runs throughout, so an import that queued a turn would be launched and seen.
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- runtime.Run(runCtx) }()
	t.Cleanup(func() { cancel(); require.NoError(t, <-done) })
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	fixture.call = func(method, path, body, cookie string, expected int) string {
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Host = "127.0.0.1:4000"
		req.Header.Set("Origin", "http://127.0.0.1:4000")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "csrf-fixture")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, expected, res.StatusCode, string(raw))
		return string(raw)
	}

	var machineOwner int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM users WHERE username='smithers-machines'`).Scan(&machineOwner))
	fixture.branch, err = q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machineOwner, Name: "external", TargetBookmark: "feature", Kind: "vm", Status: "stopped"})
	require.NoError(t, err)
	fixture.store, err = chat.NewStore(pool)
	require.NoError(t, err)
	fixture.registry = new(machined.Registry)
	fixture.authority, err = fixture.registry.MintBoot(fixture.branch.ID, "vm-external")
	require.NoError(t, err)
	return fixture
}
