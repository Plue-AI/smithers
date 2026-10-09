package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
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
	providers transcriptImportProviders
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
		// Each member has the machine login a terminal session is opened under.
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login) VALUES($1,$2,$3,$4)`, repo.ID, u.ID, permission, u.Username)
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
	var machineOwner int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM users WHERE username='smithers-machines'`).Scan(&machineOwner))
	fixture.branch, err = q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machineOwner, Name: "external", TargetBookmark: "feature", Kind: "vm", Status: "stopped"})
	require.NoError(t, err)
	fixture.store, err = chat.NewStore(pool)
	require.NoError(t, err)
	fixture.registry = new(machined.Registry)
	fixture.authority, err = fixture.registry.MintBoot(fixture.branch.ID, "vm-external")
	require.NoError(t, err)
	fixture.registry.BindSessionIdentities(newMachineHost(pool, nil))
	_, err = pool.Exec(ctx, `INSERT INTO workspace_shares(workspace_id,owner_user_id,grantee_user_id,level) VALUES($1,$2,$3,'write')`, fixture.branch.ID, machineOwner, owner.ID)
	require.NoError(t, err)
	hosts, _ := presenceHostBinding(t, pool, fixture.branch, owner.ID)
	presence := &branchPresence{hosts: hosts, queries: q, branches: branches, dispatcher: presenceBridgeFixture{realPresenceBridge(t)}, members: &services.Members{Pool: pool}, visits: &presenceVisits{audit: services.NewAuditService(q), now: time.Now}}
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(ctx))
	presence.sourcesReady = presence.sourceCensus(bus, fixture.registry)
	history := func(ctx context.Context, member int64, branch string) (json.RawMessage, error) {
		entries, err := fixture.store.SharedEntries(ctx, chat.Scope{RepositoryID: repo.ID, UserID: member}, branch)
		if err != nil {
			return nil, err
		}
		return json.Marshal(entries)
	}
	topics := &liveTopics{queries: q, changePool: pool, presence: presence, conversation: history}
	liveHandler := &routes.LiveHandler{Queries: q, Hub: live.NewHub(ctx, nil), Origins: func() []string { return cfg.Server.AllowedOrigins }, Topics: topics.resolver, Presence: presence.session}
	fixture.providers = transcriptImportProviders{ReceiptStore: pool, Presence: presence, Live: liveHandler, Revocation: bus, History: history}

	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{}, routerExtras{Live: liveHandler}).(chi.Router)
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

	return fixture
}

// deliverTranscript writes one framed record on the authenticated link as the
// daemon would and returns the frame the host answered with, or the error when
// the host closed the link instead of settling the record.
func deliverTranscript(peer net.Conn, seq *uint64, record wire.Transcript, replayOf ...[16]byte) (machined.AckOutcome, [16]byte, error) {
	payload, err := wire.EncodeTranscript(record)
	if err != nil {
		return 0, [16]byte{}, err
	}
	*seq++
	event := machined.Event{Seq: *seq, EventID: [16]byte(uuid.New()), Payload: payload}
	if len(replayOf) == 1 {
		event.EventID = replayOf[0]
	}
	if err = wire.Write(peer, transcriptEventFrame(event)); err != nil {
		return 0, event.EventID, err
	}
	frame, err := wire.Read(peer)
	if err != nil {
		return 0, event.EventID, err
	}
	if frame.Kind != wire.Events || len(frame.Payload) == 0 || frame.Payload[0] != 3 {
		return 0, event.EventID, fmt.Errorf("the host answered a transcript with frame %d", frame.Kind)
	}
	fields, err := wire.Fields("ack", frame.Payload[1:])
	if err != nil {
		return 0, event.EventID, err
	}
	if !bytes.Equal(fields[1], wire.U64(*seq)) || len(fields[2]) != 1 {
		return 0, event.EventID, errors.New("the host acknowledged another event")
	}
	return machined.AckOutcome(fields[2][0]), event.EventID, nil
}

// externalMessage is the read-only message a member's browser receives for an
// imported entry: the fields a viewer sees and the ones that say whose it is.
type externalMessage struct {
	Origin      string `json:"origin"`
	ReadOnly    bool   `json:"read_only"`
	Role        string `json:"role"`
	Text        string `json:"text"`
	Status      string `json:"status"`
	Agent       string `json:"agent_kind"`
	Profile     string `json:"format_version"`
	SourceID    string `json:"source_id"`
	Participant string `json:"participant_id"`
	Actor       struct {
		Kind      string `json:"kind"`
		Login     string `json:"login"`
		Agent     string `json:"agent"`
		ForMember struct {
			Login string `json:"login"`
		} `json:"for_member"`
	} `json:"actor"`
}

// history reads the branch conversation as one signed-in member's browser does.
func (f *transcriptImportFixture) history(t *testing.T, cookie string) []externalMessage {
	t.Helper()
	var conversation struct {
		Entries []externalMessage `json:"entries"`
	}
	require.NoError(t, json.Unmarshal([]byte(f.call("GET", "/api/conversations/"+f.branch.ID, "", cookie, 200)), &conversation))
	return conversation.Entries
}

func (f *transcriptImportFixture) bindTranscripts(ingest *TranscriptIngest) {
	p := f.providers
	p.Ingest = ingest
	p.bind(f.registry)
}
