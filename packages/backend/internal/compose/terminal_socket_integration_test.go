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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type observedOwnerTerminals struct {
	*installOwnerTerminals
	t *testing.T
}

func (p observedOwnerTerminals) Open(ctx context.Context, id string, principal revocation.Principal) (workspaceapi.Terminal, error) {
	terminal, err := p.installOwnerTerminals.Open(ctx, id, principal)
	if err != nil {
		p.t.Logf("owner open: %v", err)
	}
	return terminal, err
}

// Only guest effects are replaced; the installed owner service, membership,
// delegated issuer, admitted-link readiness and HTTP/socket routes are real.
type terminalMemberRuntime struct {
	*replacementRuntime
	terminal *echoOwnerTerminal
	branch   db.Workspace
	member   microsandbox.MemberIdentity
	prepared bool
	opened   bool
	admitted bool
}

func (r *terminalMemberRuntime) WaitAdmission(ctx context.Context, p microsandbox.AdmissionProviders, class, holder, actor, reason string) (context.Context, error) {
	if class != "person" || holder != "workspace:"+r.branch.ID || !strings.HasPrefix(actor, "person:") {
		return nil, fmt.Errorf("invalid person admission")
	}
	if err := p.Ready(ctx, microsandbox.AdmissionRequest{Class: class, Holder: holder, Actor: actor, Reason: reason}); err != nil {
		return nil, err
	}
	r.admitted = true
	return ctx, nil
}
func (*terminalMemberRuntime) GuestIdentity() (string, int) { return "agent", 19999 }
func (r *terminalMemberRuntime) EnsureMachined(context.Context, string) error {
	if !r.admitted {
		return fmt.Errorf("missing person admission")
	}
	r.prepared = true
	return nil
}
func (r *terminalMemberRuntime) ReadFile(_ context.Context, id, _ string) ([]byte, error) {
	return json.Marshal(map[string]any{"version": 1, "workspace_id": id, "repository_id": r.repoID, "clone_url": "http://127.0.0.1:4000/presence-owner/app.git", "source_bookmark": r.branch.TargetBookmark, "source_revision": strings.Repeat("a", 40), "initialized_at": time.Now().UTC()})
}
func (r *terminalMemberRuntime) ExecuteCommand(ctx context.Context, id string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	if strings.Join(command.Args, " ") == "git remote get-url origin" {
		return workspaceapi.CommandResult{Stdout: "http://127.0.0.1:4000/presence-owner/app.git\n"}, nil
	}
	return r.replacementRuntime.ExecuteCommand(ctx, id, command)
}
func (r *terminalMemberRuntime) SessionCredentialsForMember(_ context.Context, branch string, member microsandbox.MemberIdentity) (microsandbox.MemberSessionCredentials, error) {
	if !r.prepared || branch != r.branch.ID || member != r.member {
		return nil, fmt.Errorf("unbound member")
	}
	return r, nil
}
func (r *terminalMemberRuntime) PutSessionToken(ctx context.Context, branch, id string, token []byte, expected string) (string, error) {
	_, err := r.replacementRuntime.PutSessionToken(ctx, branch, id, token, expected)
	return fmt.Sprintf("/run/smithers/%d/token/sessions/%s/token", r.member.UID, id), err
}
func (r *terminalMemberRuntime) StopService(context.Context, string, string) error { return nil }

func (r *terminalMemberRuntime) OpenTerminal(_ context.Context, branch, id, digest string, command workspaceapi.Command) (workspaceapi.Terminal, error) {
	if branch != r.branch.ID || digest != workspaceapi.SessionCredentialIdentity([]byte(r.current(id))) || command.Environment["SMITHERS_TOKEN_FILE"] != fmt.Sprintf("/run/smithers/%d/token/sessions/%s/token", r.member.UID, id) || command.Environment["SMITHERS_URL"] != "http://127.0.0.1:4000" || strings.Join(command.Args, " ") != "/bin/bash -l" {
		return nil, fmt.Errorf("unbound session credential")
	}
	r.opened = true
	return r.terminal, nil
}

type echoOwnerTerminal struct {
	reader     *io.PipeReader
	writer     *io.PipeWriter
	mu         sync.Mutex
	input      bytes.Buffer
	resizes    int
	rows, cols uint16
}

func (p *echoOwnerTerminal) Read(b []byte) (int, error) { return p.reader.Read(b) }
func (p *echoOwnerTerminal) Write(b []byte) (int, error) {
	p.mu.Lock()
	p.input.Write(b)
	p.mu.Unlock()
	return p.writer.Write(b)
}
func (p *echoOwnerTerminal) Close() error { _ = p.writer.Close(); return p.reader.Close() }
func (p *echoOwnerTerminal) Resize(_ context.Context, cols, rows uint16) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.resizes++
	p.rows, p.cols = rows, cols
	return nil
}

func TestOwnerTerminalComposedOpenWatchReplayClose(t *testing.T) {
	testOwnerTerminalComposed(t, false)
}

// This receipt uses the production owner service and composed HTTP door.
// Guest/kernel effects remain separately gated by the reference-host suite.
func TestTerminalUnavailableProvidersFailClosed(t *testing.T) {
	testOwnerTerminalComposed(t, true)
}

func testOwnerTerminalComposed(t *testing.T, unavailableOnly bool) {
	t.Helper()
	f := presenceInstall(t)
	q := db.New(f.pool)
	machineOwner, err := q.GetBranchMachineOwner(t.Context())
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `UPDATE workspaces SET user_id=$2 WHERE id=$1`, f.row.ID, machineOwner)
	require.NoError(t, err)
	f.row.UserID = machineOwner
	alice, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "alice", LowerUsername: "alice"})
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission,github_login,unix_login,unix_uid) VALUES($1,$2,'write','alice','alice',20002)`, f.row.RepositoryID, alice.ID)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte("alice-terminal-cookie"))
	_, err = q.CreateAuthSession(t.Context(), db.CreateAuthSessionParams{UserID: alice.ID, Username: alice.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	reader, writer := io.Pipe()
	terminal := &echoOwnerTerminal{reader: reader, writer: writer}
	handler := &routes.WorkspaceTerminalHandler{OwnerOnly: true, AllowedOrigins: []string{f.origin}, SessionCookieName: "session"}
	manager := handler.SharedTerminalSessions()
	defer manager.Close()
	f.p.terminalManager = manager
	f.p.terminals = terminalProjection(f.pool, manager, nil)
	server := httptest.NewUnstartedServer(nil)
	f.origin = "http://" + server.Listener.Addr().String()
	handler.AllowedOrigins = []string{f.origin}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = f.origin
	cfg.Server.AllowedOrigins = []string{f.origin}
	server.Config.Handler = hostStatusProductionRouter(cfg, q, nil, conformanceServices{pool: f.pool, terminal: handler, members: &routes.MembersHandler{Service: &services.Members{Pool: f.pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}}})
	server.Start()
	defer server.Close()
	postAs := func(body, cookie string) (int, []byte) {
		req, err := http.NewRequest(http.MethodPost, server.URL+"/api/terminals", strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Origin", f.origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", uuid.NewString())
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Cookie", "session="+cookie+"; __csrf=csrf")
		response, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		return response.StatusCode, raw
	}
	post := func(body string) (int, []byte) { return postAs(body, f.cookie) }
	// Exercise the real owner service through the composed door before replacing
	// the unavailable guest broker. A missing admitted link must mint nothing.
	handler.OwnerTerminals = &installOwnerTerminals{queries: q, branches: f.p.branches}
	status, body := post(fmt.Sprintf(`{"branch":%q}`, f.row.ID))
	require.Equal(t, 503, status, string(body))
	var minted int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM access_tokens`).Scan(&minted))
	require.Zero(t, minted)
	require.Empty(t, manager.BranchTerminals(f.row.RepositoryID, f.row.ID))
	require.False(t, manager.HasBranchTerminal(f.row.RepositoryID, f.row.ID))
	registry := new(machined.Registry)
	link, _ := presenceTestLink(t, registry, f.row.ID)
	require.NoError(t, link.Reconciled())
	runtime := &terminalMemberRuntime{replacementRuntime: &replacementRuntime{repoID: f.row.RepositoryID}, terminal: terminal, branch: f.row, member: microsandbox.MemberIdentity{Login: "ben", UID: 20001, Active: true}}
	_, err = f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'admin','ben',20001)`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	auth := services.NewAuthService(q, cfg.Auth, nil, nil)
	auth.Members = &services.Members{Pool: f.pool}
	auth.TerminalSubject = manager.OwnsSubject
	hostPreparations := 0
	serviceFor := func(omitted string) *services.WorkspaceService {
		var execution workspaceapi.WorkspaceRuntime = runtime
		issuer := auth
		providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)
		switch omitted {
		case "isolation":
			execution = isolatedRuntime{WorkspaceRuntime: runtime}
		case "session provider":
			execution = isolatedRuntime{WorkspaceRuntime: runtime, isolation: workspaceapi.IsolationSandboxed}
		case "lane binding":
			providers.LaneBinding = nil
		case "authorization":
			providers.Authorize = nil
		case "membership":
			providers.Membership = nil
		case "identities":
			providers.SessionIdentity = nil
		case "credentials":
			issuer = nil
		}
		gitURL := "http://127.0.0.1:4000"
		if omitted == "guest URL" {
			gitURL = ""
		}
		branches := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceRuntime(execution), services.WithBranchMachineProviders(providers), services.WithWorkspaceCredentialIssuer(issuer), services.WithWorkspaceGitBaseURL(gitURL))
		if omitted != "admission" {
			branches.EnableMachineAdmission(func(context.Context) (int64, error) { return 100 << 30, nil })
		}
		branches.BindBranchTerminalHost(func(ctx context.Context, branch db.Workspace, member int64) error {
			require.NoError(t, link.RequireReady(branch.ID))
			hostPreparations++
			return nil
		})
		return branches
	}
	for _, missing := range []string{"isolation", "admission", "authorization", "membership", "identities", "credentials", "connection", "revocation", "session provider", "lane binding", "guest URL"} {
		t.Run("missing_"+missing, func(t *testing.T) {
			unavailable := &installOwnerTerminals{queries: q, branches: serviceFor(missing), registry: registry}
			if missing == "connection" {
				unavailable.registry = nil
			}
			if missing == "revocation" {
				routes.SetRevocationSource(nil)
				defer routes.SetRevocationSource(f.bus)
			}
			unavailable.Bind(manager)
			handler.Service = unavailable.branches
			handler.OwnerTerminals = unavailable
			status, body := post(fmt.Sprintf(`{"branch":%q}`, f.row.ID))
			require.Equal(t, 503, status, string(body))
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM access_tokens`).Scan(&minted))
			require.Zero(t, minted)
			require.False(t, runtime.opened)
			require.Empty(t, runtime.tokens)
			require.False(t, manager.HasBranchTerminal(f.row.RepositoryID, f.row.ID))
		})
	}
	if unavailableOnly {
		return
	}
	branches := serviceFor("")
	provider := &installOwnerTerminals{queries: q, branches: branches, registry: registry}
	provider.Bind(manager)
	handler.Service = branches
	handler.OwnerTerminals = observedOwnerTerminals{provider, t}
	status, body = post(fmt.Sprintf(`{"branch":%q,"owner":%d,"uid":0}`, f.row.ID, alice.ID))
	require.Equal(t, 400, status, string(body))
	status, body = post(fmt.Sprintf(`{"branch":%q}`, f.row.ID))
	require.Equal(t, 202, status, string(body))
	var opened struct{ ID string }
	require.NoError(t, json.Unmarshal(body, &opened))
	require.Eventually(t, func() bool { return len(manager.BranchTerminals(f.row.RepositoryID, f.row.ID)) == 1 }, 5*time.Second, time.Millisecond)
	require.NoError(t, branches.WaitForProvisioning(t.Context()))
	require.NotEmpty(t, opened.ID)
	require.True(t, runtime.prepared)
	require.True(t, runtime.opened)
	require.Equal(t, 1, hostPreparations)
	require.NotEmpty(t, runtime.current(opened.ID))
	require.True(t, manager.OwnsSubject(f.user.ID, f.row.RepositoryID, f.row.ID, opened.ID))
	require.False(t, manager.OwnsSubject(alice.ID, f.row.RepositoryID, f.row.ID, opened.ID))
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM workspace_shares WHERE workspace_id=$1`, f.row.ID).Scan(&count))
	require.Zero(t, count, "owner-uid terminals grant no legacy shared-user access")
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM workspace_sessions`).Scan(&count))
	require.Zero(t, count)
	type socketMessage struct {
		kind websocket.MessageType
		data []byte
		err  error
	}
	messages := make(map[*websocket.Conn]chan socketMessage)
	read := func(socket *websocket.Conn, ctx context.Context) (websocket.MessageType, []byte, error) {
		select {
		case message := <-messages[socket]:
			return message.kind, message.data, message.err
		case <-ctx.Done():
			return 0, nil, ctx.Err()
		}
	}
	dial := func(cookie string) *websocket.Conn {
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		socket, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/repos/presence-owner/app/workspace/sessions/"+opened.ID+"/terminal", &websocket.DialOptions{Subprotocols: []string{"terminal"}, HTTPHeader: http.Header{"Origin": {f.origin}, "Cookie": {"session=" + cookie}}})
		if err != nil {
			if response != nil {
				raw, _ := io.ReadAll(response.Body)
				t.Fatalf("socket: %v: %s", err, raw)
			}
			require.NoError(t, err)
		}
		t.Cleanup(func() { socket.CloseNow() })
		stream := make(chan socketMessage, 16)
		messages[socket] = stream
		// Keep reading control frames while Ping waits for its pong.
		go func() {
			for {
				kind, data, err := socket.Read(t.Context())
				select {
				case stream <- socketMessage{kind, data, err}:
				case <-t.Context().Done():
					return
				}
				if err != nil {
					return
				}
			}
		}()
		return socket
	}
	provider.registry = nil
	refused, response, err := websocket.Dial(t.Context(), "ws"+strings.TrimPrefix(server.URL, "http")+"/api/repos/presence-owner/app/workspace/sessions/"+opened.ID+"/terminal", &websocket.DialOptions{Subprotocols: []string{"terminal"}, HTTPHeader: http.Header{"Origin": {f.origin}, "Cookie": {"session=" + f.cookie}}})
	require.Error(t, err)
	require.Nil(t, refused)
	require.Equal(t, 503, response.StatusCode)
	provider.registry = registry
	owner, watcher := dial(f.cookie), dial("alice-terminal-cookie")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	_, _, err = read(owner, ctx)
	require.NoError(t, err)
	_, _, err = read(watcher, ctx)
	require.NoError(t, err)
	for i := 0; i < 1000; i++ {
		require.NoError(t, watcher.Write(ctx, websocket.MessageBinary, []byte("forbidden")))
	}
	// A control frame cannot confer ownership or carry input on a watcher.
	require.NoError(t, watcher.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"type":"input","owner":%d,"data":"forged"}`, f.user.ID))))
	require.NoError(t, watcher.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","rows":40,"cols":100}`)))
	require.NoError(t, watcher.Write(ctx, websocket.MessageText, []byte(`{"type":"close"}`)))
	// Ping is a same-socket barrier: all preceding watcher frames have been
	// consumed before checking the guest effect, even on a slow machine.
	require.NoError(t, watcher.Ping(ctx))
	require.NoError(t, owner.Write(ctx, websocket.MessageBinary, []byte("owner echo")))
	_, output, err := read(watcher, ctx)
	require.NoError(t, err)
	require.Equal(t, "owner echo", string(output))
	_, _, err = read(owner, ctx)
	require.NoError(t, err)
	terminal.mu.Lock()
	require.Equal(t, "owner echo", terminal.input.String())
	require.Zero(t, terminal.resizes)
	terminal.mu.Unlock()
	// Invalid owner dimensions must never reach the PTY; the retained socket
	// stays usable and accepts both edges of the unsigned 16-bit range.
	for _, frame := range []string{
		`{"type":"resize","rows":0,"cols":80}`,
		`{"type":"resize","rows":24,"cols":0}`,
		`{"type":"resize","rows":65536,"cols":80}`,
		`{"type":"resize","rows":24,"cols":65536}`,
		`{"type":"resize","rows":-1,"cols":80}`,
		`{"type":"resize","rows":24,"cols":1.5}`,
	} {
		require.NoError(t, owner.Write(ctx, websocket.MessageText, []byte(frame)))
	}
	require.NoError(t, owner.Ping(ctx))
	terminal.mu.Lock()
	require.Zero(t, terminal.resizes)
	terminal.mu.Unlock()
	for _, size := range []uint16{1, 65535} {
		require.NoError(t, owner.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"type":"resize","rows":%d,"cols":%d}`, size, size))))
		require.NoError(t, owner.Ping(ctx))
		terminal.mu.Lock()
		require.Equal(t, size, terminal.rows)
		require.Equal(t, size, terminal.cols)
		terminal.mu.Unlock()
	}
	terminal.mu.Lock()
	require.Equal(t, 2, terminal.resizes)
	terminal.mu.Unlock()
	facts := manager.BranchTerminals(f.row.RepositoryID, f.row.ID)
	require.Len(t, facts, 1)
	require.Equal(t, []int64{alice.ID}, facts[0].Watchers)
	require.NoError(t, owner.Close(websocket.StatusNormalClosure, "reload"))
	owner = dial(f.cookie)
	_, output, err = read(owner, ctx)
	require.NoError(t, err)
	require.Equal(t, "owner echo", string(output))
	_, _, err = read(owner, ctx)
	require.NoError(t, err)
	remove, err := http.NewRequest(http.MethodDelete, server.URL+"/api/members/alice", nil)
	require.NoError(t, err)
	remove.Header.Set("Origin", f.origin)
	remove.Header.Set("X-CSRF-Token", "csrf")
	remove.Header.Set("Cookie", "session="+f.cookie+"; __csrf=csrf")
	removed, err := http.DefaultClient.Do(remove)
	require.NoError(t, err)
	defer removed.Body.Close()
	removedBody, err := io.ReadAll(removed.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusNoContent, removed.StatusCode, string(removedBody))
	_, _, err = read(watcher, ctx)
	require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
	require.True(t, manager.HasBranchTerminal(f.row.RepositoryID, f.row.ID))
	require.NoError(t, owner.Write(ctx, websocket.MessageBinary, []byte("still owner")))
	_, output, err = read(owner, ctx)
	require.NoError(t, err)
	require.Equal(t, "still owner", string(output))
	require.NoError(t, owner.Write(ctx, websocket.MessageText, []byte(`{"type":"close"}`)))
	_, _, err = read(owner, ctx)
	require.Equal(t, websocket.StatusNormalClosure, websocket.CloseStatus(err))
	require.Eventually(t, func() bool { return !manager.HasBranchTerminal(f.row.RepositoryID, f.row.ID) }, time.Second, time.Millisecond)

	// A member who owns the PTY is revoked through the same installed door.
	// Only guest process effects are fixtures; removal, credentials and fanout
	// use the real database and production router.
	carol, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "carol", LowerUsername: "carol"})
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission,github_login,unix_login,unix_uid) VALUES($1,$2,'write','carol','carol',20003)`, f.row.RepositoryID, carol.ID)
	require.NoError(t, err)
	carolHash := sha256.Sum256([]byte("carol-terminal-cookie"))
	_, err = q.CreateAuthSession(t.Context(), db.CreateAuthSessionParams{UserID: carol.ID, Username: carol.Username, SessionKey: hex.EncodeToString(carolHash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	reader, writer = io.Pipe()
	runtime.terminal = &echoOwnerTerminal{reader: reader, writer: writer}
	runtime.member = microsandbox.MemberIdentity{Login: "carol", UID: 20003, Active: true}
	status, body = postAs(fmt.Sprintf(`{"branch":%q}`, f.row.ID), "carol-terminal-cookie")
	require.Equal(t, 202, status, string(body))
	require.NoError(t, json.Unmarshal(body, &opened))
	require.Eventually(t, func() bool { return len(manager.BranchTerminals(f.row.RepositoryID, f.row.ID)) == 1 }, 5*time.Second, time.Millisecond)
	require.NoError(t, branches.WaitForProvisioning(t.Context()))
	carolSocket := dial("carol-terminal-cookie")
	benWatcher := dial(f.cookie)
	attachCtx, attachCancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer attachCancel()
	for _, socket := range []*websocket.Conn{carolSocket, benWatcher} {
		messageType, marker, err := read(socket, attachCtx)
		require.NoError(t, err)
		require.Equal(t, websocket.MessageText, messageType)
		require.JSONEq(t, `{"type":"replay-complete"}`, string(marker))
	}
	remove, err = http.NewRequest(http.MethodDelete, server.URL+"/api/members/carol", nil)
	require.NoError(t, err)
	remove.Header.Set("Origin", f.origin)
	remove.Header.Set("X-CSRF-Token", "csrf")
	remove.Header.Set("Cookie", "session="+f.cookie+"; __csrf=csrf")
	removed, err = http.DefaultClient.Do(remove)
	require.NoError(t, err)
	defer removed.Body.Close()
	removedBody, err = io.ReadAll(removed.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusNoContent, removed.StatusCode, string(removedBody))
	revokedCtx, revokedCancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer revokedCancel()
	_, _, err = read(carolSocket, revokedCtx)
	require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
	_, _, err = read(benWatcher, revokedCtx)
	require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
	require.Eventually(t, func() bool { return !manager.HasBranchTerminal(f.row.RepositoryID, f.row.ID) }, time.Second, time.Millisecond)
	require.Empty(t, manager.BranchTerminals(f.row.RepositoryID, f.row.ID))
	require.False(t, manager.OwnsSubject(carol.ID, f.row.RepositoryID, f.row.ID, opened.ID))
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM access_tokens WHERE user_id=$1`, carol.ID).Scan(&count))
	require.Zero(t, count)
}
