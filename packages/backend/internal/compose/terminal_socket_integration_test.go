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
	if !r.prepared || branch != r.branch.ID || member != (microsandbox.MemberIdentity{Login: "ben", UID: 20001, Active: true}) {
		return nil, fmt.Errorf("unbound member")
	}
	return r, nil
}
func (r *terminalMemberRuntime) PutSessionToken(ctx context.Context, branch, id string, token []byte, expected string) (string, error) {
	_, err := r.replacementRuntime.PutSessionToken(ctx, branch, id, token, expected)
	return "/run/smithers/20001/token/sessions/" + id + "/token", err
}
func (r *terminalMemberRuntime) OpenTerminal(_ context.Context, branch, id, digest string, command workspaceapi.Command) (workspaceapi.Terminal, error) {
	if branch != r.branch.ID || digest != workspaceapi.SessionCredentialIdentity([]byte(r.current())) || command.Environment["SMITHERS_TOKEN_FILE"] != "/run/smithers/20001/token/sessions/"+id+"/token" || command.Environment["SMITHERS_URL"] != "http://127.0.0.1:4000" || strings.Join(command.Args, " ") != "/bin/bash -l" {
		return nil, fmt.Errorf("unbound session credential")
	}
	r.opened = true
	return r.terminal, nil
}

type echoOwnerTerminal struct {
	reader  *io.PipeReader
	writer  *io.PipeWriter
	mu      sync.Mutex
	input   bytes.Buffer
	resizes int
}

func (p *echoOwnerTerminal) Read(b []byte) (int, error) { return p.reader.Read(b) }
func (p *echoOwnerTerminal) Write(b []byte) (int, error) {
	p.mu.Lock()
	p.input.Write(b)
	p.mu.Unlock()
	return p.writer.Write(b)
}
func (p *echoOwnerTerminal) Close() error { _ = p.writer.Close(); return p.reader.Close() }
func (p *echoOwnerTerminal) Resize(context.Context, uint16, uint16) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.resizes++
	return nil
}

func TestOwnerTerminalComposedOpenWatchReplayClose(t *testing.T) {
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
	f.p.terminals = manager
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
	post := func(body string) (int, []byte) {
		req, err := http.NewRequest(http.MethodPost, server.URL+"/api/terminals", strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Origin", f.origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Cookie", "session="+f.cookie+"; __csrf=csrf")
		response, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		return response.StatusCode, raw
	}
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
	runtime := &terminalMemberRuntime{replacementRuntime: &replacementRuntime{repoID: f.row.RepositoryID}, terminal: terminal, branch: f.row}
	_, err = f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'admin','ben',20001)`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	auth := services.NewAuthService(q, cfg.Auth, nil, nil)
	auth.Members = &services.Members{Pool: f.pool}
	auth.TerminalSubject = manager.OwnsSubject
	serviceFor := func(omitted string) *services.WorkspaceService {
		var execution workspaceapi.WorkspaceRuntime = runtime
		issuer := auth
		providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)
		switch omitted {
		case "isolation":
			execution = isolatedRuntime{WorkspaceRuntime: runtime}
		case "authorization":
			providers.Authorize = nil
		case "membership":
			providers.Membership = nil
		case "identities":
			providers.SessionIdentity = nil
		case "credentials":
			issuer = nil
		}
		branches := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceRuntime(execution), services.WithBranchMachineProviders(providers), services.WithWorkspaceCredentialIssuer(issuer), services.WithWorkspaceGitBaseURL("http://127.0.0.1:4000"))
		if omitted != "admission" {
			branches.EnableMachineAdmission(func(context.Context) (int64, error) { return 100 << 30, nil })
		}
		return branches
	}
	for _, missing := range []string{"isolation", "admission", "authorization", "membership", "identities", "credentials", "connection", "revocation"} {
		t.Run("missing_"+missing, func(t *testing.T) {
			unavailable := &installOwnerTerminals{queries: q, branches: serviceFor(missing), registry: registry}
			if missing == "connection" {
				unavailable.registry = nil
			}
			if missing == "revocation" {
				routes.SetRevocationSource(nil)
				defer routes.SetRevocationSource(f.bus)
			}
			handler.OwnerTerminals = unavailable
			status, body := post(fmt.Sprintf(`{"branch":%q}`, f.row.ID))
			require.Equal(t, 503, status, string(body))
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM access_tokens`).Scan(&minted))
			require.Zero(t, minted)
			require.False(t, runtime.opened)
			require.Empty(t, runtime.current())
			require.False(t, manager.HasBranchTerminal(f.row.RepositoryID, f.row.ID))
		})
	}
	branches := serviceFor("")
	provider := &installOwnerTerminals{queries: q, branches: branches, registry: registry}
	handler.OwnerTerminals = observedOwnerTerminals{provider, t}
	status, body = post(fmt.Sprintf(`{"branch":%q,"owner":%d,"uid":0}`, f.row.ID, alice.ID))
	require.Equal(t, 400, status, string(body))
	status, body = post(fmt.Sprintf(`{"branch":%q}`, f.row.ID))
	require.Equal(t, 201, status, string(body))
	var opened struct{ ID string }
	require.NoError(t, json.Unmarshal(body, &opened))
	require.NotEmpty(t, opened.ID)
	require.True(t, runtime.prepared)
	require.True(t, runtime.opened)
	require.NotEmpty(t, runtime.current())
	require.True(t, manager.OwnsSubject(f.user.ID, f.row.RepositoryID, f.row.ID, opened.ID))
	require.False(t, manager.OwnsSubject(alice.ID, f.row.RepositoryID, f.row.ID, opened.ID))
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM workspace_shares WHERE workspace_id=$1`, f.row.ID).Scan(&count))
	require.Zero(t, count, "owner-uid terminals grant no legacy shared-user access")
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM workspace_sessions`).Scan(&count))
	require.Zero(t, count)
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
	_, _, err = owner.Read(ctx)
	require.NoError(t, err)
	_, _, err = watcher.Read(ctx)
	require.NoError(t, err)
	require.NoError(t, watcher.Write(ctx, websocket.MessageBinary, []byte("forbidden")))
	require.NoError(t, watcher.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","rows":40,"cols":100}`)))
	require.NoError(t, watcher.Write(ctx, websocket.MessageText, []byte(`{"type":"close"}`)))
	require.NoError(t, owner.Write(ctx, websocket.MessageBinary, []byte("owner echo")))
	_, output, err := watcher.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, "owner echo", string(output))
	_, _, err = owner.Read(ctx)
	require.NoError(t, err)
	terminal.mu.Lock()
	require.Equal(t, "owner echo", terminal.input.String())
	require.Zero(t, terminal.resizes)
	terminal.mu.Unlock()
	facts := manager.BranchTerminals(f.row.RepositoryID, f.row.ID)
	require.Len(t, facts, 1)
	require.Equal(t, []int64{alice.ID}, facts[0].Watchers)
	require.NoError(t, owner.Close(websocket.StatusNormalClosure, "reload"))
	owner = dial(f.cookie)
	_, output, err = owner.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, "owner echo", string(output))
	_, _, err = owner.Read(ctx)
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
	_, _, err = watcher.Read(ctx)
	require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
	require.True(t, manager.HasBranchTerminal(f.row.RepositoryID, f.row.ID))
	require.NoError(t, owner.Write(ctx, websocket.MessageBinary, []byte("still owner")))
	_, output, err = owner.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, "still owner", string(output))
	require.NoError(t, owner.Write(ctx, websocket.MessageText, []byte(`{"type":"close"}`)))
	_, _, err = owner.Read(ctx)
	require.Equal(t, websocket.StatusNormalClosure, websocket.CloseStatus(err))
	require.Eventually(t, func() bool { return !manager.HasBranchTerminal(f.row.RepositoryID, f.row.ID) }, time.Second, time.Millisecond)
}
