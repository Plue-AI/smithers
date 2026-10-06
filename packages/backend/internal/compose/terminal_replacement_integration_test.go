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
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The guest filesystem/PTY is a test double: this check isolates host lifecycle
// ordering across two terminal managers, with real credentials, SQL and HTTP.
// It is not a root-input or microVM qualification receipt.
type replacementRuntime struct {
	workspaceapi.WorkspaceRuntime
	mu     sync.Mutex
	token  string
	repoID int64
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
func (*replacementRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceRunning}, nil
}
func (r *replacementRuntime) PutSessionToken(_ context.Context, _, session string, token []byte, expected string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if (r.token == "" && expected != "") || (r.token != "" && workspaceapi.SessionCredentialIdentity([]byte(r.token)) != expected) {
		return "", fmt.Errorf("identity mismatch")
	}
	r.token = string(token)
	return workspaceapi.SessionTokenRoot + "/" + session + "/token", nil
}
func (r *replacementRuntime) DeleteSessionToken(_ context.Context, _, _ string, expected string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.token != "" && workspaceapi.SessionCredentialIdentity([]byte(r.token)) != expected {
		return fmt.Errorf("identity mismatch")
	}
	r.token = ""
	return nil
}
func (r *replacementRuntime) current() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.token
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
	open := func(service *services.WorkspaceService, refused bool) *websocket.Conn {
		server := httptest.NewUnstartedServer(nil)
		origin := "http://" + server.Listener.Addr().String()
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
	a := open(svc, false)
	first := runtime.current()
	require.NotEmpty(t, first)
	// Another host service has no ownership of this retained session file.
	// Its create-only attempt must fail, revoke its candidate, and leave A usable.
	replica := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceTransactions(pool), services.WithWorkspaceGitBaseURL("http://127.0.0.1:4000"))
	require.Nil(t, open(replica, true))
	require.True(t, first == runtime.current(), "a replica must not replace a foreign lifecycle")
	var live int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE name=$1`, "terminal-session-"+session).Scan(&live))
	require.Equal(t, 1, live, "failed replacement must revoke its candidate without revoking A")
	b := open(svc, false)
	second := runtime.current()
	require.NotEmpty(t, second, "replacement must survive old credential cleanup")
	require.True(t, first != second, "replacement rotates the delegated credential")
	firstHash := sha256.Sum256([]byte(first))
	var retired int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE token_hash=$1`, hex.EncodeToString(firstHash[:])).Scan(&retired))
	require.Zero(t, retired, "previous delegated credential is revoked")
	_ = a.CloseNow()
	// Wait for the old handler's detach; it must not delete the successor.
	require.Eventually(t, func() bool {
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE name=$1`, "terminal-session-"+session).Scan(&count); err != nil {
			return false
		}
		return count == 1 && runtime.current() == second
	}, time.Second, 10*time.Millisecond)
	require.Never(t, func() bool { return runtime.current() != second }, 200*time.Millisecond, 10*time.Millisecond,
		"late detach must preserve the replacement file")
	_ = b.CloseNow()
	require.Eventually(t, func() bool { return runtime.current() == "" }, 5*time.Second, 10*time.Millisecond)
	var remaining int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE name=$1`, "terminal-session-"+session).Scan(&remaining))
	require.Zero(t, remaining)
}
