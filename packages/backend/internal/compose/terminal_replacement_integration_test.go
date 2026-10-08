package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
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
	var pool *pgxpool.Pool
	if os.Getenv("SMITHERS_TERMINAL_CONFIRM_PHASE_DIR") != "" {
		_, _, pool = splitProcessDatabase(t)
	} else {
		pool, _ = postgresfixture.NewProductDatabase(t)
	}
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben"})
	require.NoError(t, err)
	installOwner := owner
	removal := len(scopeChecks) > 3 && scopeChecks[3]
	suspension := removal && len(scopeChecks) > 4 && scopeChecks[4]
	if removal {
		installOwner, err = q.CreateUser(ctx, db.CreateUserParams{Username: "terminal-admin", LowerUsername: "terminal-admin"})
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, installOwner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	if removal {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,github_login) VALUES($1,$2,'write','ben')`, repo.ID, owner.ID)
		require.NoError(t, err)
		adminHash := sha256.Sum256([]byte("terminal-admin-cookie"))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: installOwner.ID, Username: installOwner.Username, SessionKey: hex.EncodeToString(adminHash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		bus := revocation.NewBus(pool, q)
		require.NoError(t, bus.Start(ctx))
		routes.SetRevocationSource(bus)
		t.Cleanup(func() { routes.SetRevocationSource(nil) })
	}
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
	content, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: "http://example.com", SigningKey: bytes.Repeat([]byte{0x32}, 32)})
	require.NoError(t, err)
	wiki := services.NewWikiService(q, nil, services.WithWikiContent(content), services.WithWikiInstallAuthorization(q))
	_, err = wiki.CreateWikiPage(ctx, &owner, "ben", "demo", services.CreateWikiPageInput{Title: "Terminal scope", Slug: "terminal-scope", Body: "Read through the packaged skill"})
	require.NoError(t, err)
	members := &services.Members{Pool: pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}
	var origin string
	open := func(service *services.WorkspaceService, refused bool, session string) *websocket.Conn {
		server := httptest.NewUnstartedServer(nil)
		origin = "http://" + server.Listener.Addr().String()
		cfg := testConfigAllFlagsOn()
		cfg.Auth.Mode = "selfhost"
		cfg.Server.PublicURL = origin
		cfg.Server.AllowedOrigins = []string{origin}
		handler := &routes.WorkspaceTerminalHandler{Service: service, AllowedOrigins: cfg.Server.AllowedOrigins}
		deps := conformanceServices{pool: pool, wiki: wiki, terminal: handler, user: &routes.UserHandler{ProfileService: services.NewUserService(q)}}
		if removal {
			deps.members = &routes.MembersHandler{Service: members}
		}
		server.Config.Handler = hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{Queries: q}, deps)
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
	if len(scopeChecks) > 2 && scopeChecks[2] {
		exerciseTerminalAppendConfirmation(t, ctx, pool, q, owner, repo.ID, first)
	}
	checkScope(first, false)
	if removal {
		invoke := packagedTerminalCLIInvoker(t, ctx, origin, first)
		code, receipt := invoke("wiki", "show", "--owner", "ben", "--repo", "demo")
		require.Zero(t, code, receipt)
		started := time.Now()
		var restore func()
		if suspension {
			// Production permission polling receives independently pinned GitHub
			// responses. No credential helper or authorizer double suspends Ben.
			_, err = pool.Exec(ctx, `UPDATE collaborators SET github_id=102 WHERE repository_id=$1 AND user_id=$2`, repo.ID, owner.ID)
			require.NoError(t, err)
			var restored atomic.Bool
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/repos/ben/demo/installation":
					fmt.Fprint(w, `{"id":91}`)
				case "/app/installations/91/access_tokens":
					w.WriteHeader(http.StatusCreated)
					fmt.Fprint(w, `{"token":"fixture-installation-token","expires_at":"2099-01-01T00:00:00Z"}`)
				case "/repos/ben/demo":
					fmt.Fprintf(w, `{"id":%d,"full_name":"ben/demo"}`, repo.ID)
				case "/installation/repositories":
					fmt.Fprintf(w, `{"total_count":1,"repositories":[{"id":%d}]}`, repo.ID)
				case "/user/102":
					fmt.Fprint(w, `{"id":102,"login":"ben"}`)
				case "/repos/ben/demo/collaborators/ben/permission":
					if restored.Load() {
						fmt.Fprint(w, `{"permission":"write","role_name":"write","user":{"id":102,"login":"ben"}}`)
					} else {
						fmt.Fprint(w, `{"permission":"read","role_name":"read","user":{"id":102,"login":"ben"}}`)
					}
				case "/users/terminal-admin/keys", "/users/ben/keys":
					fmt.Fprint(w, `[]`)
				default:
					t.Errorf("unexpected permission-provider request %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			t.Cleanup(provider.Close)
			t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", provider.URL)
			require.NoError(t, members.Recheck(ctx))
			var suspended bool
			require.NoError(t, pool.QueryRow(ctx, `SELECT suspended_at IS NOT NULL FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repo.ID, owner.ID).Scan(&suspended))
			require.True(t, suspended)
			restore = func() {
				restored.Store(true)
				require.NoError(t, members.Recheck(ctx))
				require.NoError(t, pool.QueryRow(ctx, `SELECT suspended_at IS NOT NULL FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repo.ID, owner.ID).Scan(&suspended))
				require.False(t, suspended)
			}
		} else {
			request, err := http.NewRequestWithContext(ctx, "DELETE", origin+"/api/members/ben", nil)
			require.NoError(t, err)
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "terminal-admin-cookie"})
			request.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
			request.Header.Set("X-CSRF-Token", "csrf")
			request.Header.Set("Origin", origin)
			response, err := http.DefaultClient.Do(request)
			require.NoError(t, err)
			body, err := io.ReadAll(response.Body)
			_ = response.Body.Close()
			require.NoError(t, err)
			require.Equal(t, http.StatusNoContent, response.StatusCode, string(body))
		}
		// Reuse the same compiled CLI/token file, without minting or switching
		// identity. Guest cleanup may lag; persisted authority is already dead.
		for _, argv := range [][]string{{"todo", "new", "--text", "Removed member", "--idempotencyKey", "removed-terminal"}, {"wiki", "show", "--owner", "ben", "--repo", "demo"}} {
			code, receipt := invoke(argv...)
			require.Equal(t, 1, code, receipt)
			require.Equal(t, "unauthenticated", receipt["code"], receipt)
			require.Equal(t, "permission", receipt["class"], receipt)
		}
		require.Eventually(t, func() bool { return runtime.current(session) == "" }, 5*time.Second, 10*time.Millisecond)
		require.Less(t, time.Since(started), 5*time.Second, "credential/file revocation must finish within five seconds")
		var remaining int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE user_id=$1`, owner.ID).Scan(&remaining))
		require.Zero(t, remaining)
		if restore != nil {
			restore()
			code, receipt := invoke("wiki", "show", "--owner", "ben", "--repo", "demo")
			require.Equal(t, 1, code, receipt)
			require.Equal(t, "unauthenticated", receipt["code"], "restoration must not resurrect revoked credentials")
			require.Empty(t, runtime.current(session))
		}
		for _, table := range []string{"mythical_items", "approvals", "product_job_requests"} {
			require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&remaining))
			require.Zero(t, remaining, table)
		}
		return
	}
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
	var checkClientCache func()
	if independent != nil {
		checkClientCache = startTerminalClientCacheProbe(t, ctx, origin, second, independentToken, func() string {
			old := independent
			independent = open(svc, false, independentSession)
			replacement := runtime.current(independentSession)
			require.NotEmpty(t, replacement)
			require.NotEqual(t, independentToken, replacement)
			independentToken = replacement
			_ = old.CloseNow()
			return replacement
		})
	}
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
	if checkClientCache != nil {
		checkClientCache()
	}
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
