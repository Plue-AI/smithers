package routes

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func cleanupSocketHandler(t *testing.T, kind string) (*WorkspaceTerminalHandler, func(revocation.Event), func() bool) {
	t.Helper()
	service := lspTestService("running")
	service.getSessionFunc = func(context.Context, string, int64, int64) (services.WorkspaceSessionResponse, error) {
		row := lspTestSession("s1", 11, 7, "running")
		row.Kind = kind
		return row, nil
	}
	h := &WorkspaceTerminalHandler{Service: service}
	if kind == "terminal" {
		fake := newFakeTerminalSSH()
		m := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
			return fake.client, fake.session, nil
		})
		m.keepaliveInterval = 0
		t.Cleanup(m.Close)
		h.TerminalSessions = m
		return h, m.RevokeMatching, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.sessions["s1"] == nil }
	}
	m, _ := newLSPRelayManager(t, 0, true)
	h.LSPSessions = m
	return h, m.RevokeMatching, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.sessions["s1"] == nil }
}

func TestWorkspaceSocketRevocationDoesNotWaitForSilentPeer(t *testing.T) {
	for _, kind := range []string{"terminal", "lsp"} {
		t.Run(kind, func(t *testing.T) {
			bus := revocation.NewBus(nil, nil)
			h, revoke, removed := cleanupSocketHandler(t, kind)
			t.Cleanup(bus.Subscribe(revoke))
			withSocketRevocationSource(t, bus)
			attached := make(chan struct{})
			if kind == "terminal" {
				h.beforeTerminalAttach = func(*terminalSession) { close(attached) }
			} else {
				h.beforeLSPAttach = func(*lspSession) { close(attached) }
			}
			server := httptest.NewServer(managerFirstSocketRouter(h, kind))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			ws, _, err := websocket.Dial(ctx, "ws"+server.URL[len("http"):]+"/repos/acme/repo/workspace/sessions/s1/"+kind, &websocket.DialOptions{Subprotocols: []string{kind}})
			require.NoError(t, err)
			defer ws.CloseNow()
			<-attached
			if kind == "lsp" {
				require.NoError(t, ws.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)))
			}
			// Ensure attachment completed through terminal replay / LSP response.
			_, _, err = ws.Read(ctx)
			require.NoError(t, err)
			// No further reads: this peer will never answer a close frame.
			delivered := make(chan struct{})
			go func() {
				bus.Deliver(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: 7, WorkspaceID: "workspace-1"})
				close(delivered)
			}()
			select {
			case <-delivered:
			case <-time.After(time.Second):
				t.Fatal("silent peer blocked revocation delivery")
			}
			require.Eventually(t, removed, time.Second, time.Millisecond)
		})
	}
}

// Observe the request guard at its delivery boundary, before the bus returns.
type cleanupObservedRevocationSource struct {
	*managerFirstRevocationSource
	observe func()
}

func (s *cleanupObservedRevocationSource) Subscribe(fn func(revocation.Event)) func() {
	return s.managerFirstRevocationSource.Subscribe(func(event revocation.Event) {
		fn(event)
		s.observe()
	})
}

// Keep the real language-server stdin and count only the late public request.
// Closing stdin must not itself manufacture a successful authorization check.
type cleanupObservedStdin struct {
	io.WriteCloser
	late atomic.Int32
}

func (s *cleanupObservedStdin) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte(`"method":"regression/late"`)) {
		s.late.Add(1)
	}
	return s.WriteCloser.Write(p)
}

func TestWorkspaceSocketManagerBeforeLaunchGuardCleansCreatedSession(t *testing.T) {
	for _, kind := range []string{"terminal", "lsp"} {
		t.Run(kind, func(t *testing.T) {
			bus := revocation.NewBus(nil, nil)
			h, revoke, removed := cleanupSocketHandler(t, kind)
			createdTerminal := make(chan *terminalSession, 1)
			createdLSP := make(chan *lspSession, 1)
			var stdin *cleanupObservedStdin
			h.beforeTerminalAttach = func(s *terminalSession) { createdTerminal <- s }
			h.beforeLSPAttach = func(s *lspSession) {
				stdin = &cleanupObservedStdin{WriteCloser: s.stdin}
				s.stdin = stdin
				createdLSP <- s
			}
			type callbackState struct{ dead, done bool }
			observed := make(chan callbackState, 1)
			var requestGuard atomic.Pointer[workspaceSocketRevocation]
			var observeOnce sync.Once
			var dead func() bool
			var done <-chan struct{}
			source := &cleanupObservedRevocationSource{
				managerFirstRevocationSource: &managerFirstRevocationSource{Bus: bus, onEvent: revoke, entered: make(chan struct{}), release: make(chan struct{})},
				observe: func() {
					guard := requestGuard.Load()
					if guard == nil {
						return
					}
					guard.mu.Lock()
					revoked := guard.revoked
					guard.mu.Unlock()
					if !revoked {
						return
					} // ignore the earlier registry subscriber
					state := callbackState{dead: dead()}
					select {
					case <-done:
						state.done = true
					default:
					}
					observeOnce.Do(func() { observed <- state })
				},
			}
			var releaseOnce sync.Once
			t.Cleanup(func() { releaseOnce.Do(func() { close(source.release) }) })
			withSocketRevocationSource(t, source)
			lookup := make(chan struct{})
			finishLookup := make(chan struct{})
			var finishOnce sync.Once
			defer finishOnce.Do(func() { close(finishLookup) })
			service := h.Service.(*mockWorkspaceTerminalService)
			service.getSSHConnectionFunc = func(ctx context.Context, _ string, _, _ int64) (services.WorkspaceSSHConnectionInfo, error) {
				close(lookup)
				select {
				case <-finishLookup:
				case <-ctx.Done():
					return services.WorkspaceSSHConnectionInfo{}, ctx.Err()
				}
				return services.WorkspaceSSHConnectionInfo{WorkspaceID: "workspace-1", VMID: "vm-1", Kind: "container"}, nil
			}
			handlerReturned := make(chan struct{})
			router := chi.NewRouter()
			router.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true, TokenHash: "token-7"})
					next.ServeHTTP(w, r.WithContext(ctx))
				})
			})
			router.Use(WorkspaceSocketRevocations)
			router.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requestGuard.Store(r.Context().Value(workspaceSocketRevocationKey{}).(*workspaceSocketRevocation))
					ctx := middleware.ContextWithRepoContext(r.Context(), &middleware.RepoContext{Owner: "acme", Repository: &db.Repository{ID: 11, Name: "repo"}}, middleware.PermissionWrite)
					next.ServeHTTP(w, r.WithContext(ctx))
				})
			})
			path := "/repos/{owner}/{repo}/workspace/sessions/{id}/" + kind
			if kind == "lsp" {
				router.Get(path, h.LSPWebSocket)
			} else {
				router.Get(path, h.TerminalWebSocket)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(handlerReturned)
				router.ServeHTTP(w, r)
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			type result struct {
				ws  *websocket.Conn
				err error
			}
			dialed := make(chan result, 1)
			go func() {
				ws, _, err := websocket.Dial(ctx, "ws"+server.URL[len("http"):]+"/repos/acme/repo/workspace/sessions/s1/"+kind, &websocket.DialOptions{Subprotocols: []string{kind}})
				dialed <- result{ws, err}
			}()
			<-lookup
			delivered := make(chan struct{})
			go func() {
				bus.Deliver(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: 7, WorkspaceID: "workspace-1"})
				close(delivered)
			}()
			<-source.entered // manager processed removal while no launch existed
			finishOnce.Do(func() { close(finishLookup) })
			got := <-dialed
			require.NoError(t, got.err)
			defer got.ws.CloseNow()
			if kind == "lsp" {
				session := <-createdLSP
				dead, done = session.isDead, session.done
			} else {
				session := <-createdTerminal
				dead, done = session.isDead, session.done
			}
			if kind == "lsp" {
				require.NoError(t, got.ws.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)))
			}
			_, _, err := got.ws.Read(ctx)
			require.NoError(t, err)
			require.False(t, removed())
			releaseOnce.Do(func() { close(source.release) })
			state := <-observed
			require.True(t, state.dead, "session alive when the guard callback returned")
			require.True(t, state.done, "done must signal the same synchronous dead state")
			<-delivered
			require.True(t, dead(), "session alive after delivery")
			if kind == "lsp" {
				// A successful client write only queues a frame; authorization is
				// verified after the public handler joins its relay goroutines.
				_ = got.ws.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":2,"method":"regression/late"}`))
			}
			for {
				_, _, err = got.ws.Read(ctx)
				if err != nil {
					break
				}
			}
			require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
			require.Eventually(t, removed, time.Second, time.Millisecond, "revoked request-created session remains published")
			select {
			case <-handlerReturned:
			case <-ctx.Done():
				t.Fatal("public socket handler did not finish its relay")
			}
			if kind == "lsp" {
				require.Zero(t, stdin.late.Load(), "late public request reached language-server stdin")
			} else {
				require.True(t, removed(), "terminal publication must be removed synchronously")
			}
		})
	}
}

func TestTerminalGuardCleanupPreservesDurability(t *testing.T) {
	for _, reuse := range []bool{false, true} {
		t.Run(map[bool]string{false: "disconnect", true: "reused_creator"}[reuse], func(t *testing.T) {
			bus := revocation.NewBus(nil, nil)
			h, revoke, _ := cleanupSocketHandler(t, "terminal")
			t.Cleanup(bus.Subscribe(revoke))
			withSocketRevocationSource(t, bus)
			var session *terminalSession
			if reuse {
				var err error
				session, _, err = h.TerminalSessions.getOrCreate(context.Background(), "s1", services.WorkspaceSSHConnectionInfo{WorkspaceID: "workspace-1", VMID: "vm-1", Kind: "container"}, 80, 24, revocation.Principal{UserID: 7, TokenHash: "creator", RepositoryID: 11, WorkspaceID: "workspace-1", SandboxID: "vm-1"})
				require.NoError(t, err)
			}
			attached := make(chan *terminalSession, 1)
			h.beforeTerminalAttach = func(s *terminalSession) { attached <- s }
			server := httptest.NewServer(managerFirstSocketRouter(h, "terminal"))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			ws, _, err := websocket.Dial(ctx, "ws"+server.URL[len("http"):]+"/repos/acme/repo/workspace/sessions/s1/terminal", &websocket.DialOptions{Subprotocols: []string{"terminal"}})
			require.NoError(t, err)
			defer ws.CloseNow()
			session = <-attached
			_, _, err = ws.Read(ctx)
			require.NoError(t, err)
			if reuse {
				bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-7"})
				for {
					_, _, err = ws.Read(ctx)
					if err != nil {
						break
					}
				}
				require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
			} else {
				require.NoError(t, ws.CloseNow())
			}
			require.Eventually(t, func() bool { session.mu.Lock(); defer session.mu.Unlock(); return len(session.sinks) == 0 }, time.Second, time.Millisecond)
			require.False(t, session.isDead())
			h.TerminalSessions.mu.Lock()
			published := h.TerminalSessions.sessions["s1"]
			h.TerminalSessions.mu.Unlock()
			require.Same(t, session, published)
			if reuse {
				session.mu.Lock()
				hash := session.principal.TokenHash
				session.mu.Unlock()
				require.Equal(t, "creator", hash)
			}
		})
	}
}

// Keep the transport open after synchronous relay death to exercise a peer
// sending a frame before the asynchronous close handshake finishes.
func TestLSPRevokedRelayDropsLatePublicSocketInput(t *testing.T) {
	serverWS, clientWS, cleanup := terminalSessionManagerHWebsocketPair(t)
	defer cleanup()
	fake := newFakeLSPSSHSession()
	defer fake.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	session := &lspSession{dead: true, stdin: fake.stdinW}
	session.once.Do(func() {})
	returned := make(chan struct{})
	go func() { session.pumpClientToServer(ctx, serverWS); close(returned) }()
	require.NoError(t, clientWS.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)))
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("dead relay consumed late input")
	}
}

// Model an SSH peer whose transport Close cannot finish until released. The
// guard must settle authorization, sinks and publication without waiting for it.
type cleanupBlockedClose struct {
	io.WriteCloser
	entered chan struct{}
	release <-chan struct{}
}

func (s *cleanupBlockedClose) Close() error {
	close(s.entered)
	<-s.release
	return s.WriteCloser.Close()
}

func TestTerminalGuardCleanupDoesNotWaitForTransportClose(t *testing.T) {
	bus := revocation.NewBus(nil, nil)
	withSocketRevocationSource(t, bus)
	guard := watchWorkspaceSocket(socketRevocationRequest())
	defer guard.close()
	fake := newFakeTerminalSSH()
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	stdin := &cleanupBlockedClose{WriteCloser: fake.session.stdinW, entered: make(chan struct{}), release: release}
	client := &terminalSessionManagerCovSSHClient{closeDone: make(chan struct{})}
	manager := NewTerminalSessionManager(nil)
	session := newTerminalSession("blocked-close", client, fake.session, stdin, bytes.NewReader(nil), bytes.NewReader(nil), 1024, 0, 0, func() { manager.remove("blocked-close") })
	manager.sessions[session.id] = session
	serverWS, _, cleanup := terminalSessionManagerHWebsocketPair(t)
	defer cleanup()
	sink := newTerminalSink(serverWS, 1, time.Second)
	session.sinks[sink] = struct{}{}
	guard.onRevoke(func() { session.destroyWithCode(websocket.StatusPolicyViolation, "revoked") })
	returned := make(chan struct{})
	go func() {
		bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-7"})
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("guard delivery waited for SSH transport close")
	}
	require.True(t, session.isDead())
	select {
	case <-session.done:
	default:
		t.Fatal("dead state did not close done synchronously")
	}
	manager.mu.Lock()
	published := manager.sessions[session.id]
	manager.mu.Unlock()
	require.Nil(t, published, "publication must end before delivery returns")
	_, open := <-sink.out
	require.False(t, open, "sink must stop before delivery returns")
	require.ErrorIs(t, session.writeStdin([]byte("late")), errWorkspaceSocketRevoked)
	require.ErrorIs(t, session.resize(24, 80), errWorkspaceSocketRevoked)
	select {
	case <-stdin.entered:
	case <-time.After(time.Second):
		t.Fatal("asynchronous transport cleanup did not start")
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case <-client.closeDone:
	case <-time.After(time.Second):
		t.Fatal("released transport cleanup did not finish")
	}
	require.True(t, fake.session.closed.Load())
}
