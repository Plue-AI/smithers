package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/externalsessions"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// external.read is person-only (spec §8.7.2, §5.2.1): the raw Codex and
// Claude Code transcripts of the account the install runs as are read by
// the owner's own browser session alone, through the composed install
// router and real PostgreSQL. The owner's personal access token and CLI
// credential are refused with never; an unbound terminal is unauthenticated;
// a run credential and every other member are refused with permission. The
// live topic external:<agent>:<session> takes the same decision.
func TestExternalReadIsPersonOnlyComposedInstallPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	busCtx, cancelBus := context.WithCancel(ctx)
	defer cancelBus()
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(busCtx))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	user := func(name string) db.User {
		created, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name, DisplayName: name})
		require.NoError(t, err)
		return created
	}
	owner, maintainer, writer := user("ben"), user("maya"), user("alice")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"acme","repository_name":"app","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(strings.TrimSuffix(binding, "}") + `,"last_access_check_at":"2026-10-06T10:00:00Z"}`)}))
	for _, row := range []struct {
		user       db.User
		permission string
		githubID   int64
	}{{owner, "admin", 101}, {maintainer, "admin", 102}, {writer, "write", 103}} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,github_id,github_login) VALUES($1,$2,$3,$4,$5)`,
			repo.ID, row.user.ID, row.permission, row.githubID, row.user.Username)
		require.NoError(t, err)
	}
	github := &rosterGitHub{roles: map[string]string{"ben": "admin", "maya": "maintain", "alice": "write"}}
	provider := httptest.NewServer(http.HandlerFunc(github.serve))
	defer provider.Close()
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", provider.URL)

	home := t.TempDir()
	const codexID = "0199e2e0-0000-7000-8000-00000000c0de"
	rollout := filepath.Join(home, ".codex", "sessions", "2026", "10", "06", "rollout-2026-10-06T09-00-00-"+codexID+".jsonl")
	const transcript = `{"type":"session_meta","payload":{"id":"` + codexID + `"}}` + "\n"
	require.NoError(t, os.MkdirAll(filepath.Dir(rollout), 0o700))
	require.NoError(t, os.WriteFile(rollout, []byte(transcript), 0o600))
	finder := &externalsessions.Finder{Home: home}

	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	topics := &liveTopics{queries: q, external: finder}
	liveHandler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	members := &services.Members{Pool: pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}
	server.Config.Handler = buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil,
		routerExtras{Members: &routes.MembersHandler{Service: members}, Live: liveHandler, ExternalSessions: &routes.ExternalSessionsHandler{Queries: q, Sessions: finder}})
	server.Start()
	defer server.Close()

	session := func(u db.User) string {
		key := u.Username + "-cookie"
		digest := sha256.Sum256([]byte(key))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return key
	}
	token := func(u db.User, name, scopes string, systemIssued bool) string {
		seed := sha256.Sum256([]byte(u.Username + "-" + name))
		raw := "smithers_" + hex.EncodeToString(seed[:])[:40]
		hash := sha256.Sum256([]byte(raw))
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: u.ID, Name: name, TokenHash: hex.EncodeToString(hash[:]),
			TokenLastEight: hex.EncodeToString(hash[:])[56:], Scopes: scopes, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}, SystemIssued: systemIssued})
		require.NoError(t, err)
		return raw
	}
	issuer := services.NewAuthService(q, cfg.Auth, nil, nil)
	issuer.Members = &services.Members{Pool: pool}
	workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: owner.ID, Name: "terminal", Kind: "agent", Status: "running", TargetBookmark: "mythical", EnvironmentSource: "repository"})
	require.NoError(t, err)
	terminalSession, err := q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{WorkspaceID: workspace.ID, RepositoryID: repo.ID, UserID: owner.ID, Cols: 80, Rows: 24})
	require.NoError(t, err)
	terminal, err := issuer.MintForTerminal(ctx, owner.ID, repo.ID, workspace.ID, terminalSession.ID)
	require.NoError(t, err)
	type credential struct{ cookie, bearer string }
	ownerSession, maintainerSession, writerSession := credential{cookie: session(owner)}, credential{cookie: session(maintainer)}, credential{cookie: session(writer)}
	get := func(c credential) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, origin+"/api/external/sessions?agent=codex&session="+codexID, nil)
		require.NoError(t, err)
		req.Header.Set("Origin", origin)
		if c.cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: c.cookie})
		}
		if c.bearer != "" {
			req.Header.Set("Authorization", "Bearer "+c.bearer)
		}
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		body := map[string]any{}
		require.NoError(t, json.Unmarshal(raw, &body), string(raw))
		return res.StatusCode, body
	}

	status, body := get(ownerSession)
	require.Equal(t, http.StatusOK, status, body)
	require.Equal(t, transcript, body["text"])

	never := map[string]any{"class": "never", "code": "never", "message": "Only a person can do this"}
	for _, tc := range []struct {
		name string
		who  credential
		code string // never, or the permission refusal's code
	}{
		{"the owner's personal access token", credential{bearer: token(owner, "pat", "all", false)}, "never"},
		{"the owner's CLI credential", credential{bearer: token(owner, "cli", "read:repository,write:repository,via:cli", true)}, "never"},
		{"the owner's CLI credential without read scope", credential{bearer: token(owner, "cli-user-only", "read:user,via:cli", true)}, "permission"},
		{"the owner's terminal credential", credential{bearer: terminal.Token}, "permission"},
		{"the owner's run credential", credential{bearer: token(owner, "run", "write:repository", true)}, "permission"},
		{"a maintainer's session", maintainerSession, "permission"},
		{"a maintainer's CLI credential", credential{bearer: token(maintainer, "cli", "write:repository,via:cli", true)}, "permission"},
		{"a member's session", writerSession, "permission"},
	} {
		status, body := get(tc.who)
		want := http.StatusForbidden
		if tc.code == "unauthenticated" {
			want = http.StatusUnauthorized
		}
		require.Equal(t, want, status, "%s: %v", tc.name, body)
		require.NotContains(t, body, "text", tc.name)
		if tc.code == "never" {
			require.Equal(t, never, body, tc.name)
		} else {
			require.Equal(t, []any{"permission", tc.code}, []any{body["class"], body["code"]}, "%s: %v", tc.name, body)
		}
	}

	// The live topic takes the same decision: the owner's session follows
	// the file, every other member's socket is refused it, and delegated sockets cannot subscribe to its private transcript.
	dial := func(c credential) (*websocket.Conn, int) {
		t.Helper()
		dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		header := http.Header{"Origin": {origin}}
		if c.cookie != "" {
			header.Set("Cookie", "session="+c.cookie)
		}
		if c.bearer != "" {
			header.Set("Authorization", "Bearer "+c.bearer)
		}
		conn, res, err := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: header})
		if err != nil {
			require.NotNil(t, res, err)
			return nil, res.StatusCode
		}
		t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
		return conn, http.StatusSwitchingProtocols
	}
	type frame struct {
		T    string `json:"t"`
		ID   uint32 `json:"id"`
		Code string `json:"code"`
	}
	subscribe := func(conn *websocket.Conn) frame {
		t.Helper()
		require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"external:codex:`+codexID+`"}`)))
		readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, raw, err := conn.Read(readCtx)
		require.NoError(t, err)
		var f frame
		require.NoError(t, json.Unmarshal(raw, &f))
		return f
	}
	conn, status := dial(ownerSession)
	require.Equal(t, http.StatusSwitchingProtocols, status)
	require.NotNil(t, conn)
	require.Equal(t, "snap", subscribe(conn).T)
	for name, who := range map[string]credential{"a maintainer's session": maintainerSession, "a member's session": writerSession} {
		conn, _ := dial(who)
		require.Equal(t, frame{T: "err", ID: 1, Code: live.Forbidden}, subscribe(conn), name)
	}
	for name, who := range map[string]credential{"the owner's personal access token": {bearer: token(owner, "pat-live", "all", false)},
		"the owner's CLI credential": {bearer: token(owner, "cli-live", "write:repository,via:cli", true)}} {
		conn, status := dial(who)
		require.Equal(t, http.StatusSwitchingProtocols, status, name)
		require.NotNil(t, conn, name)
		require.Equal(t, frame{T: "err", ID: 1, Code: live.Forbidden}, subscribe(conn), name)
	}
}
