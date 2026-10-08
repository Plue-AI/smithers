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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The guest filesystem/PTY is a test double: this check isolates host lifecycle
// ordering across two terminal managers, with real credentials, SQL and HTTP.
// It is not a root-input or microVM qualification receipt.
type replacementRuntime struct {
	workspaceapi.WorkspaceRuntime
	mu      sync.Mutex
	tokens  map[string]string
	repoID  int64
	asleep  bool
	starts  int
	onStart func()
	queue   microsandbox.Runtime
}

func (*replacementRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{Terminal: true, PersistentFiles: true, Execution: true, FileOperations: true}
}
func (*replacementRuntime) ListFiles(_ context.Context, _, path string) ([]workspaceapi.FileEntry, error) {
	if path == ".git" {
		return []workspaceapi.FileEntry{{Name: "smithers-workspace-initialization.json"}}, nil
	}
	return []workspaceapi.FileEntry{{Name: ".git", IsDir: true}, {Name: ".jj", IsDir: true}}, nil
}
func (r *replacementRuntime) ReadFile(_ context.Context, id, _ string) ([]byte, error) {
	return json.Marshal(map[string]any{"version": 1, "workspace_id": id, "repository_id": r.repoID,
		"clone_url": "http://127.0.0.1:4000/ben/demo.git", "source_bookmark": "main",
		"source_revision": strings.Repeat("a", 40), "initialized_at": time.Now().UTC()})
}
func (*replacementRuntime) ExecuteCommand(_ context.Context, _ string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	switch strings.Join(command.Args, " ") {
	case "git remote get-url origin":
		return workspaceapi.CommandResult{Stdout: "http://127.0.0.1:4000/ben/demo.git\n"}, nil
	case "git cat-file -e " + strings.Repeat("a", 40) + "^{commit}":
		return workspaceapi.CommandResult{}, nil
	default:
		return workspaceapi.CommandResult{}, fmt.Errorf("unexpected fixture command")
	}
}
func (*replacementRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}
func (r *replacementRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := workspaceapi.WorkspaceRunning
	if r.asleep {
		state = workspaceapi.WorkspaceStopped
	}
	return workspaceapi.Workspace{ID: id, State: state}, nil
}
func (r *replacementRuntime) StartWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.onStart != nil {
		r.onStart()
	}
	r.starts++
	r.asleep = false
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceRunning}, nil
}
func (r *replacementRuntime) Request(class, holder, actor, reason string) (microsandbox.AdmissionRequest, error) {
	return r.queue.Request(class, holder, actor, reason)
}
func (r *replacementRuntime) CancelAdmission(holder, actor string, now time.Time) bool {
	return r.queue.CancelAdmission(holder, actor, now)
}
func (r *replacementRuntime) AdmissionSnapshot() []microsandbox.AdmissionRequest {
	return r.queue.AdmissionSnapshot()
}

// Only the VM slot receipt is fake; demand and host authorization are real.
func (r *replacementRuntime) WaitAdmission(ctx context.Context, p microsandbox.AdmissionProviders, class, holder, actor, reason string) (context.Context, error) {
	request, err := r.Request(class, holder, actor, reason)
	if err != nil {
		return nil, err
	}
	if err := p.Ready(ctx, request); err != nil {
		return nil, err
	}
	return microsandbox.WithAdmissionHolder(ctx, holder), nil
}
func (r *replacementRuntime) PutSessionToken(_ context.Context, _, session string, token []byte, expected string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	current := r.tokens[session]
	if (current == "" && expected != "") || (current != "" && workspaceapi.SessionCredentialIdentity([]byte(current)) != expected) {
		return "", fmt.Errorf("identity mismatch")
	}
	if r.tokens == nil {
		r.tokens = make(map[string]string)
	}
	r.tokens[session] = string(token)
	return workspaceapi.SessionTokenRoot + "/" + session + "/token", nil
}
func (r *replacementRuntime) DeleteSessionToken(_ context.Context, _, session string, expected string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if current := r.tokens[session]; current != "" && workspaceapi.SessionCredentialIdentity([]byte(current)) != expected {
		return fmt.Errorf("identity mismatch")
	}
	delete(r.tokens, session)
	return nil
}
func (r *replacementRuntime) current(session string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.tokens[session]
}
func (*replacementRuntime) OpenWorkspaceTerminal(context.Context, string, workspaceapi.Command) (workspaceapi.Terminal, error) {
	reader, writer := io.Pipe()
	return &replacementPTY{reader: reader, writer: writer}, nil
}

type replacementPTY struct {
	reader *io.PipeReader
	writer *io.PipeWriter
}

func (p *replacementPTY) Read(b []byte) (int, error)                 { return p.reader.Read(b) }
func (*replacementPTY) Write(b []byte) (int, error)                  { return len(b), nil }
func (p *replacementPTY) Close() error                               { _ = p.writer.Close(); return p.reader.Close() }
func (*replacementPTY) Resize(context.Context, uint16, uint16) error { return nil }

func TestTerminalReplacementThroughInstallHTTPPostgres(t *testing.T) {
	terminalReplacementInstall(t, false)
}
func TestBranchTerminalWakeInstallHTTP(t *testing.T) { terminalReplacementInstall(t, true) }
func terminalReplacementInstall(t *testing.T, wake bool, scopeChecks ...bool) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"ben","repository_name":"demo","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	verified := strings.TrimSuffix(binding, "}") + fmt.Sprintf(`,"last_access_check_at":%q}`, time.Now().UTC().Format(time.RFC3339Nano))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(verified)}))
	var branch, session string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name,kind,status,vm_id) VALUES($1,$2,'terminal','container','running','vm-terminal') RETURNING id`, repo.ID, owner.ID).Scan(&branch))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspace_sessions(workspace_id,repository_id,user_id,status,kind) VALUES($1,$2,$3,'running','terminal') RETURNING id`, branch, repo.ID, owner.ID).Scan(&session))
	digest := sha256.Sum256([]byte("replacement-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	runtime := &replacementRuntime{repoID: repo.ID}
	svc := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceTransactions(pool), services.WithWorkspaceGitBaseURL("http://127.0.0.1:4000"))
	if wake {
		_, err = pool.Exec(ctx, `UPDATE workspaces SET status='suspended',target_bookmark='main' WHERE id=$1`, branch)
		require.NoError(t, err)
		runtime.asleep = true
		runtime.onStart = func() {
			row, err := q.GetWorkspace(ctx, branch)
			require.NoError(t, err)
			require.Equal(t, "starting", row.Status)
		}
		providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)
		providers.MicroVM = func(context.Context) error { return nil }
		providers.SessionIdentity = func(context.Context) error { return nil }
		services.WithBranchMachineProviders(providers)(svc)
		services.WithWorkspaceBillingPolicy(services.NewMachineAdmissionPolicy(services.NewUnlimitedBillingPolicy()))(svc)
		svc.EnableMachineAdmission(func(context.Context) (int64, error) { return 1 << 40, nil })
	}
	var origin string
	open := func(service *services.WorkspaceService, refused bool, session string) *websocket.Conn {
		server := httptest.NewUnstartedServer(nil)
		origin = "http://" + server.Listener.Addr().String()
		cfg := testConfigAllFlagsOn()
		cfg.Auth.Mode = "selfhost"
		cfg.Server.PublicURL = origin
		cfg.Server.AllowedOrigins = []string{origin}
		handler := &routes.WorkspaceTerminalHandler{Service: service, AllowedOrigins: cfg.Server.AllowedOrigins}
		server.Config.Handler = hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{Queries: q}, conformanceServices{pool: pool, terminal: handler})
		server.Start()
		t.Cleanup(server.Close)
		url := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/repos/ben/demo/workspace/sessions/" + session + "/terminal"
		conn, response, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"smithers_session=replacement-cookie"}}, Subprotocols: []string{"terminal"}})
		if refused {
			require.Error(t, err)
			require.NotNil(t, response)
			require.Equal(t, http.StatusInternalServerError, response.StatusCode)
			return nil
		}
		require.NoError(t, err)
		t.Cleanup(func() { _ = conn.CloseNow() })
		return conn
	}
	a := open(svc, false, session)
	if wake {
		runtime.mu.Lock()
		require.Equal(t, 1, runtime.starts)
		runtime.mu.Unlock()
		demands := runtime.AdmissionSnapshot()
		require.Len(t, demands, 1)
		require.Equal(t, "person", demands[0].Class)
		require.Equal(t, fmt.Sprintf("person:%d:session:%s", owner.ID, session), demands[0].Actor)
		row, err := q.GetWorkspace(ctx, branch)
		require.NoError(t, err)
		require.Equal(t, "running", row.Status)
	}

	checkScope := func(token string, closed bool) {
		if len(scopeChecks) == 0 || !scopeChecks[0] {
			return
		}
		var before, after int
		const effects = `SELECT (SELECT count(*) FROM mythical_items) + (SELECT count(*) FROM approvals) + (SELECT count(*) FROM product_job_requests)`
		require.NoError(t, pool.QueryRow(ctx, effects).Scan(&before))
		exerciseTerminalCatalogScope(t, ctx, origin, token, closed)
		require.NoError(t, pool.QueryRow(ctx, effects).Scan(&after))
		require.Equal(t, before, after, "scope refusals must create no TODO, approval or background request")
	}
	var independentSession, independentToken string
	var independent *websocket.Conn
	if len(scopeChecks) > 1 && scopeChecks[1] {
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspace_sessions(workspace_id,repository_id,user_id,status,kind) VALUES($1,$2,$3,'running','terminal') RETURNING id`, branch, repo.ID, owner.ID).Scan(&independentSession))
		independent = open(svc, false, independentSession)
		independentToken = runtime.current(independentSession)
		require.NotEmpty(t, independentToken)
		require.NotEqual(t, runtime.current(session), independentToken)
		checkScope(independentToken, false)
	}
	first := runtime.current(session)
	require.NotEmpty(t, first)
	checkScope(first, false)
	// Another host service has no ownership of this retained session file.
	// Its create-only attempt must fail, revoke its candidate, and leave A usable.
	replica := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceTransactions(pool), services.WithWorkspaceGitBaseURL("http://127.0.0.1:4000"))
	require.Nil(t, open(replica, true, session))
	require.True(t, first == runtime.current(session), "a replica must not replace a foreign lifecycle")
	var live int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE name=$1`, "terminal-session-"+session).Scan(&live))
	require.Equal(t, 1, live, "failed replacement must revoke its candidate without revoking A")
	b := open(svc, false, session)
	second := runtime.current(session)
	require.NotEmpty(t, second, "replacement must survive old credential cleanup")
	require.True(t, first != second, "replacement rotates the delegated credential")
	firstHash := sha256.Sum256([]byte(first))
	var retired int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE token_hash=$1`, hex.EncodeToString(firstHash[:])).Scan(&retired))
	require.Zero(t, retired, "previous delegated credential is revoked")
	checkScope(first, true)
	checkScope(second, false)
	_ = a.CloseNow()
	// Wait for the old handler's detach; it must not delete the successor.
	require.Eventually(t, func() bool {
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE name=$1`, "terminal-session-"+session).Scan(&count); err != nil {
			return false
		}
		return count == 1 && runtime.current(session) == second
	}, time.Second, 10*time.Millisecond)
	require.Never(t, func() bool { return runtime.current(session) != second }, 200*time.Millisecond, 10*time.Millisecond,
		"late detach must preserve the replacement file")
	// Close is an owner control on the retained socket, rather than a browser
	// disconnect: it ends the PTY and releases the delegated sign-in.
	typ, replay, replayErr := b.Read(ctx)
	require.NoError(t, replayErr)
	require.Equal(t, websocket.MessageText, typ)
	require.JSONEq(t, `{"type":"replay-complete"}`, string(replay))
	require.NoError(t, b.Write(ctx, websocket.MessageText, []byte(`{"type":"close","owner":0}`)))
	_, _, closeErr := b.Read(ctx)
	require.Equal(t, websocket.StatusNormalClosure, websocket.CloseStatus(closeErr))
	_ = b.CloseNow()
	require.Eventually(t, func() bool { return runtime.current(session) == "" }, 5*time.Second, 10*time.Millisecond)
	var remaining int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE name=$1`, "terminal-session-"+session).Scan(&remaining))
	require.Zero(t, remaining)
	checkScope(second, true)
	if independent != nil {
		require.Equal(t, independentToken, runtime.current(independentSession), "closing one session must leave the other file unchanged")
		checkScope(independentToken, false)
		// Rotate the surviving session through its own authenticated socket.
		rotated := open(svc, false, independentSession)
		newToken := runtime.current(independentSession)
		require.NotEmpty(t, newToken)
		require.NotEqual(t, independentToken, newToken)
		checkScope(independentToken, true)
		checkScope(newToken, false)
		_ = independent.CloseNow()
		require.Never(t, func() bool { return runtime.current(independentSession) != newToken }, 200*time.Millisecond, 10*time.Millisecond)
		_, replay, err := rotated.Read(ctx)
		require.NoError(t, err)
		require.JSONEq(t, `{"type":"replay-complete"}`, string(replay))
		require.NoError(t, rotated.Write(ctx, websocket.MessageText, []byte(`{"type":"close","owner":0}`)))
		_, _, err = rotated.Read(ctx)
		require.Equal(t, websocket.StatusNormalClosure, websocket.CloseStatus(err))
		require.Eventually(t, func() bool { return runtime.current(independentSession) == "" }, 5*time.Second, 10*time.Millisecond)
		checkScope(newToken, true)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE name IN ($1,$2)`, "terminal-session-"+session, "terminal-session-"+independentSession).Scan(&remaining))
		require.Zero(t, remaining)
	}
}
