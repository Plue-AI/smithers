package routes

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// The channel-controlled dial keeps the public request between admission and
// upgrade while a real bus delivers the credential deletion.
func TestWorkspaceSocketRevocationDuringStartup(t *testing.T) {
	for _, kind := range []string{"lsp", "terminal"} {
		t.Run(kind, func(t *testing.T) {
			for _, phase := range []string{"during_startup", "after_attachment"} {
				t.Run(phase, func(t *testing.T) {
					const tokenHash = "revoked-during-socket-startup"
					bus := revocation.NewBus(nil, nil)
					previous := currentRevocationSource()
					SetRevocationSource(bus)
					t.Cleanup(func() { SetRevocationSource(previous) })
					entered := make(chan struct{})
					release := make(chan struct{})
					var releaseOnce sync.Once
					t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
					block := phase == "during_startup"
					var handler *WorkspaceTerminalHandler
					var lspServer *fakeLanguageServer
					var terminal *fakeTerminalSSH
					if kind == "lsp" {
						lspSession := newFakeLSPSSHSession()
						t.Cleanup(func() { _ = lspSession.Close() })
						lspServer = &fakeLanguageServer{sess: lspSession}
						manager := NewLSPSessionManager(func(ctx context.Context, _ services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error) {
							if block {
								close(entered)
								select {
								case <-release:
								case <-ctx.Done():
									return nil, nil, ctx.Err()
								}
							}
							go lspServer.serve(t)
							return &fakeLSPSSHClient{}, lspSession, nil
						})
						manager.startupRetryDelay = time.Millisecond
						t.Cleanup(manager.Close)
						t.Cleanup(bus.Subscribe(manager.RevokeMatching))
						handler = &WorkspaceTerminalHandler{Service: lspTestService("running"), AllowedOrigins: []string{"https://smithers.sh"}, LSPSessions: manager}
					} else {
						terminal = newFakeTerminalSSH()
						t.Cleanup(func() { _ = terminal.session.Close() })
						manager := NewTerminalSessionManager(func(ctx context.Context, _ services.WorkspaceSSHConnectionInfo, _, _ int32) (terminalSSHClient, terminalSSHSession, error) {
							if block {
								close(entered)
								select {
								case <-release:
								case <-ctx.Done():
									return nil, nil, ctx.Err()
								}
							}
							return terminal.client, terminal.session, nil
						})
						manager.keepaliveInterval = 0
						t.Cleanup(manager.Close)
						t.Cleanup(bus.Subscribe(manager.RevokeMatching))
						service := lspTestService("running")
						service.getSessionFunc = func(context.Context, string, int64, int64) (services.WorkspaceSessionResponse, error) {
							session := lspTestSession("s1", 1, 1, "running")
							session.Kind = services.WorkspaceSessionKindTerminal
							return session, nil
						}
						handler = &WorkspaceTerminalHandler{Service: service, AllowedOrigins: []string{"https://smithers.sh"}, TerminalSessions: manager}
					}

					router := chi.NewRouter()
					router.Use(func(next http.Handler) http.Handler {
						return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
							ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true, TokenHash: tokenHash})
							ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{Owner: "owner", Repository: &db.Repository{ID: 1, Name: "repo"}}, middleware.PermissionWrite)
							next.ServeHTTP(w, r.WithContext(ctx))
						})
					})
					path := "/repos/owner/repo/workspace/sessions/{id}/" + kind
					if kind == "lsp" {
						router.Get(path, handler.LSPWebSocket)
					} else {
						router.Get(path, handler.TerminalWebSocket)
					}
					srv := httptest.NewServer(router)
					t.Cleanup(srv.Close)
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					url := "ws" + srv.URL[len("http"):] + "/repos/owner/repo/workspace/sessions/s1/" + kind
					type dialResult struct {
						ws   *websocket.Conn
						resp *http.Response
						err  error
					}
					dial := func() dialResult {
						ws, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: []string{kind}})
						return dialResult{ws, resp, err}
					}
					var result dialResult
					if block {
						resultCh := make(chan dialResult, 1)
						go func() { resultCh <- dial() }()
						select {
						case <-entered:
						case <-ctx.Done():
							t.Fatal("SSH startup was not entered")
						}
						bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: tokenHash, Reason: "token deleted"})
						require.True(t, bus.IsTokenRevoked(tokenHash))
						releaseOnce.Do(func() { close(release) })
						select {
						case result = <-resultCh:
						case <-ctx.Done():
							t.Fatal("socket admission did not finish after revocation")
						}
						if result.ws != nil {
							result.ws.CloseNow()
						}
						require.Error(t, result.err, "revoked startup must not produce a usable WebSocket")
						require.NotNil(t, result.resp)
						require.Equal(t, http.StatusForbidden, result.resp.StatusCode)
						_ = result.resp.Body.Close()
						return
					}
					result = dial()
					require.NoError(t, result.err)
					defer result.ws.CloseNow()
					if kind == "lsp" {
						require.NoError(t, result.ws.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)))
						_, body, err := result.ws.Read(ctx)
						require.NoError(t, err)
						var reply struct {
							Result json.RawMessage `json:"result"`
						}
						require.NoError(t, json.Unmarshal(body, &reply))
						require.NotEmpty(t, reply.Result)
						require.Equal(t, []string{"initialize"}, lspServer.methods())
					} else {
						_, body, err := result.ws.Read(ctx)
						require.NoError(t, err)
						require.JSONEq(t, `{"type":"replay-complete"}`, string(body))
						read := make(chan []byte, 1)
						go func() {
							data := make([]byte, 5)
							_, err := io.ReadFull(terminal.session.stdinR, data)
							if err == nil {
								read <- data
							}
						}()
						require.NoError(t, result.ws.Write(ctx, websocket.MessageBinary, []byte("hello")))
						select {
						case bytes := <-read:
							require.Equal(t, []byte("hello"), bytes)
						case <-ctx.Done():
							t.Fatal("terminal input did not reach SSH stdin")
						}
					}
					delivered := make(chan struct{})
					go func() {
						bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: tokenHash, Reason: "token deleted"})
						close(delivered)
					}()
					_, _, err := result.ws.Read(ctx)
					require.Error(t, err)
					require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
					select {
					case <-delivered:
					case <-ctx.Done():
						t.Fatal("revocation delivery did not complete")
					}
				})
			}
		})
	}
}

func TestLSPSessionManagerRevokesMatchingPendingLaunch(t *testing.T) {
	const token = "pending-lsp-token"
	entered := make(chan context.Context, 1)
	manager := NewLSPSessionManager(func(ctx context.Context, _ services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error) {
		entered <- ctx
		<-ctx.Done()
		return nil, nil, ctx.Err()
	})
	t.Cleanup(manager.Close)
	result := make(chan error, 1)
	go func() {
		_, err := manager.start(context.Background(), "s1", services.WorkspaceSSHConnectionInfo{}, services.LanguageServerLaunch{}, revocation.Principal{UserID: 7, TokenHash: token})
		result <- err
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var dialCtx context.Context
	select {
	case dialCtx = <-entered:
	case <-ctx.Done():
		t.Fatal("pending LSP launch did not enter the dialer")
	}
	manager.RevokeMatching(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "other"})
	select {
	case <-dialCtx.Done():
		t.Fatal("unrelated token canceled the pending LSP launch")
	default:
	}
	manager.RevokeMatching(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: token})
	select {
	case err := <-result:
		require.True(t, errors.Is(err, context.Canceled), "matching revocation must cancel LSP dial: %v", err)
	case <-ctx.Done():
		t.Fatal("matching revocation did not cancel the pending LSP launch")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	require.Empty(t, manager.starting)
	require.Empty(t, manager.sessions)
}

func TestTerminalSessionManagerRevokesMatchingPendingLaunch(t *testing.T) {
	const token = "pending-terminal-token"
	entered := make(chan context.Context, 1)
	manager := NewTerminalSessionManager(func(ctx context.Context, _ services.WorkspaceSSHConnectionInfo, _, _ int32) (terminalSSHClient, terminalSSHSession, error) {
		entered <- ctx
		<-ctx.Done()
		return nil, nil, ctx.Err()
	})
	t.Cleanup(manager.Close)
	result := make(chan error, 1)
	go func() {
		_, _, err := manager.getOrCreate(context.Background(), "s1", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{UserID: 7, TokenHash: token})
		result <- err
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var dialCtx context.Context
	select {
	case dialCtx = <-entered:
	case <-ctx.Done():
		t.Fatal("pending terminal launch did not enter the dialer")
	}
	manager.RevokeMatching(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "other"})
	select {
	case <-dialCtx.Done():
		t.Fatal("unrelated token canceled the pending terminal launch")
	default:
	}
	manager.RevokeMatching(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: token})
	select {
	case err := <-result:
		require.True(t, errors.Is(err, context.Canceled), "matching revocation must cancel terminal dial: %v", err)
	case <-ctx.Done():
		t.Fatal("matching revocation did not cancel the pending terminal launch")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	require.Empty(t, manager.starting)
	require.Empty(t, manager.sessions)
}

func TestTerminalReusedSessionCallerRevokedBeforeAttach(t *testing.T) {
	bus := revocation.NewBus(nil, nil)
	previous := currentRevocationSource()
	SetRevocationSource(bus)
	t.Cleanup(func() { SetRevocationSource(previous) })
	fake := newFakeTerminalSSH()
	manager := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
		return fake.client, fake.session, nil
	})
	manager.keepaliveInterval = 0
	t.Cleanup(manager.Close)
	t.Cleanup(bus.Subscribe(manager.RevokeMatching))
	creator := revocation.Principal{UserID: 1, TokenHash: "creator", RepositoryID: 1, WorkspaceID: "workspace-1", SandboxID: "vm-1"}
	session, created, err := manager.getOrCreate(context.Background(), "s1", services.WorkspaceSSHConnectionInfo{WorkspaceID: "workspace-1", VMID: "vm-1", Kind: "container"}, 80, 24, creator)
	require.NoError(t, err)
	require.True(t, created)
	service := lspTestService("running")
	service.getSessionFunc = func(context.Context, string, int64, int64) (services.WorkspaceSessionResponse, error) {
		row := lspTestSession("s1", 1, 1, "running")
		row.Kind = services.WorkspaceSessionKindTerminal
		return row, nil
	}
	handler := &WorkspaceTerminalHandler{
		Service: service, AllowedOrigins: []string{"https://smithers.sh"}, TerminalSessions: manager,
		beforeTerminalAttach: func(*terminalSession) {
			bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "caller", Reason: "token deleted"})
		},
	}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true, TokenHash: "caller"})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{Owner: "owner", Repository: &db.Repository{ID: 1, Name: "repo"}}, middleware.PermissionWrite)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	router.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)
	server := httptest.NewServer(router)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+server.URL[len("http"):]+"/repos/owner/repo/workspace/sessions/s1/terminal", &websocket.DialOptions{Subprotocols: []string{"terminal"}})
	require.NoError(t, err)
	defer ws.CloseNow()
	_, _, err = ws.Read(ctx)
	require.Error(t, err)
	require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err), "replay must not begin after the caller's token is revoked")
	require.False(t, session.isDead(), "the creator's durable terminal remains available")
	session.mu.Lock()
	defer session.mu.Unlock()
	require.Equal(t, "creator", session.principal.TokenHash)
	require.Empty(t, session.sinks, "revoked caller must never attach a relay sink")
}

func TestWorkspaceSessionManagersRefuseCanceledStartupBeforeDial(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var lspDials atomic.Int32
	lsp := NewLSPSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error) {
		lspDials.Add(1)
		return nil, nil, errors.New("should not dial")
	})
	defer lsp.Close()
	_, err := lsp.start(ctx, "s1", services.WorkspaceSSHConnectionInfo{}, services.LanguageServerLaunch{}, revocation.Principal{TokenHash: "token"})
	require.ErrorIs(t, err, context.Canceled)
	require.Zero(t, lspDials.Load())

	var terminalDials atomic.Int32
	terminal := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
		terminalDials.Add(1)
		return nil, nil, errors.New("should not dial")
	})
	defer terminal.Close()
	_, _, err = terminal.getOrCreate(ctx, "s1", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{TokenHash: "token"})
	require.ErrorIs(t, err, context.Canceled)
	require.Zero(t, terminalDials.Load())
}

func TestTerminalRelayDropsInputAfterAuthorizationCancellationWithoutClientRead(t *testing.T) {
	fake := newFakeTerminalSSH()
	manager := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
		return fake.client, fake.session, nil
	})
	manager.keepaliveInterval = 0
	defer manager.Close()
	session, _, err := manager.getOrCreate(context.Background(), "s1", services.WorkspaceSSHConnectionInfo{Kind: "container"}, 80, 24, revocation.Principal{TokenHash: "creator"})
	require.NoError(t, err)
	serverWS, clientWS, cleanup := terminalSessionManagerHWebsocketPair(t)
	defer cleanup()
	ctx, stop := context.WithTimeout(context.Background(), 15*time.Second)
	defer stop()
	authorizationCtx, revoke := context.WithCancel(context.Background())
	forwarded := make(chan []byte, 1)
	go func() {
		data := make([]byte, 5)
		if _, err := io.ReadFull(fake.session.stdinR, data); err == nil {
			forwarded <- data
		}
	}()
	done := make(chan struct{})
	go func() {
		registerTerminalOwnerFixture(session, serverWS)
		(&WorkspaceTerminalHandler{}).pipeWSToTerminalSession(ctx, authorizationCtx, serverWS, session, "s1", func() {})
		close(done)
	}()
	revoke()
	// The peer deliberately does not Read the server's 1008 frame. It may
	// still write a frame while the close handshake is pending.
	require.NoError(t, clientWS.Write(ctx, websocket.MessageBinary, []byte("hello")))
	select {
	case data := <-forwarded:
		t.Fatalf("revoked input reached SSH stdin: %q", data)
	case <-done:
		select {
		case data := <-forwarded:
			t.Fatalf("revoked input reached SSH stdin: %q", data)
		default:
		}
	case <-ctx.Done():
		t.Fatal("revoked terminal relay blocked forwarding input to SSH stdin")
	}
}
