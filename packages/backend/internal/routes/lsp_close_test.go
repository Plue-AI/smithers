package routes

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// lspCloseGateConn holds the actual protocol close write at the TCP boundary.
// The HTTP upgrade and client reads still use the real net/http and websocket
// implementations. Closing the transport also releases a pending gated write.
type lspCloseGateConn struct {
	net.Conn
	writeEntered chan struct{}
	releaseWrite chan struct{}
	closed       chan struct{}
	writeOnce    sync.Once
	closeOnce    sync.Once
}

func (c *lspCloseGateConn) Write(p []byte) (int, error) {
	if len(p) > 0 && p[0] == 0x88 { // FIN and the WebSocket close opcode.
		c.writeOnce.Do(func() { close(c.writeEntered) })
		select {
		case <-c.releaseWrite:
		case <-c.closed:
			return 0, net.ErrClosed
		}
	}
	return c.Conn.Write(p)
}

func (c *lspCloseGateConn) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	return c.Conn.Close()
}

type lspCloseGateListener struct {
	net.Listener
	accepted chan *lspCloseGateConn
}

func (l *lspCloseGateListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	gate := &lspCloseGateConn{
		Conn: c, writeEntered: make(chan struct{}),
		releaseWrite: make(chan struct{}), closed: make(chan struct{}),
	}
	l.accepted <- gate
	return gate, nil
}

func waitLSPCloseEvent(t *testing.T, event <-chan struct{}, timeout time.Duration, message string) {
	t.Helper()
	select {
	case <-event:
	case <-time.After(timeout):
		t.Fatal(message)
	}
}

func TestLSPSessionRun_WaitsForProtocolCloseBeforeHandlerCleanup(t *testing.T) {
	// Only SSH process launch/stdio is simulated: a guest process is unnecessary
	// to verify socket cleanup ordering. HTTP, TCP and WebSocket are real.
	manager, _ := newLSPRelayManager(t, 0, true)
	sess, err := manager.start(context.Background(), "close-order", services.WorkspaceSSHConnectionInfo{}, services.LanguageServerLaunch{}, revocation.Principal{})
	require.NoError(t, err)
	killed := make(chan struct{})
	onDone := sess.onDone
	sess.onDone = func() { onDone(); close(killed) }

	runReturned := make(chan struct{})
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer ws.CloseNow()
		if err := sess.attach(ws, nil); err != nil {
			t.Error(err)
			return
		}
		sess.run(r.Context())
		// This is the caller-owned cleanup boundary used by LSPWebSocket.
		// CloseNow may itself wait if Close already started, masking early run
		// return; observe the ownership contract before invoking it.
		close(runReturned)
	}))
	listener := &lspCloseGateListener{Listener: srv.Listener, accepted: make(chan *lspCloseGateConn, 1)}
	srv.Listener = listener
	srv.Start()
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = ws.CloseNow() })
	gate := <-listener.accepted
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(gate.releaseWrite) }) }
	t.Cleanup(release)

	// A binary client message ends the client pump before the close write can
	// finish. This avoids depending on Close to unblock a pending socket read.
	require.NoError(t, ws.Write(ctx, websocket.MessageBinary, []byte("bad")))
	waitLSPCloseEvent(t, gate.writeEntered, 2*time.Second, "protocol close write never reached TCP")
	assert.True(t, sess.isDead())
	select {
	case <-sess.done:
	default:
		t.Error("destroy must signal done while the close write is pending")
	}
	waitLSPCloseEvent(t, killed, 2*time.Second, "SSH teardown waited for the socket close")

	sess.destroy(websocket.StatusGoingAway, "second destroy")
	code, reason := sess.closeStatus()
	assert.Equal(t, websocket.StatusUnsupportedData, code)
	assert.Equal(t, "binary frames are not accepted; send one JSON-RPC message per text frame", reason)

	select {
	case <-runReturned:
		t.Error("run returned before the protocol close write completed; caller can race CloseNow")
	case <-time.After(250 * time.Millisecond):
	}
	release()
	_, _, err = ws.Read(ctx)
	var closeErr websocket.CloseError
	require.True(t, errors.As(err, &closeErr), "client must receive the protocol close: %v", err)
	assert.Equal(t, code, closeErr.Code)
	assert.Equal(t, reason, closeErr.Reason)
	waitLSPCloseEvent(t, runReturned, 2*time.Second, "run did not return after close completed")
}

func newLSPCloseRouteServer(t *testing.T, handler *WorkspaceTerminalHandler, returned chan struct{}) *httptest.Server {
	t.Helper()
	router := chi.NewRouter()
	router.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/lsp", func(w http.ResponseWriter, r *http.Request) {
		ctx := middleware.ContextWithAuthInfo(r.Context(), lspTestAuth())
		ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
			Owner: "testowner", Repository: &db.Repository{ID: 1, Name: "testrepo"},
		}, middleware.PermissionWrite)
		handler.LSPWebSocket(w, r.WithContext(ctx))
		close(returned)
	})
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)
	return srv
}

func TestLSPWebSocket_CloseCodeAndReasonReachClient(t *testing.T) {
	// Guest SSH is simulated to select exact process verdicts. All request
	// preflight, upgrade, relay and protocol close behavior uses the real route.
	for _, tc := range []struct {
		name   string
		code   websocket.StatusCode
		reason string
		end    func(*LSPSessionManager, *fakeLanguageServer)
	}{
		{"clean exit", websocket.StatusNormalClosure, "language_server_exited: 0", func(_ *LSPSessionManager, guest *fakeLanguageServer) { guest.sess.exit(0) }},
		{"failed exit", websocket.StatusInternalError, "language_server_exited: 3", func(_ *LSPSessionManager, guest *fakeLanguageServer) { guest.sess.exit(3) }},
		{"shutdown", websocket.StatusGoingAway, "server shutting down", func(manager *LSPSessionManager, _ *fakeLanguageServer) { manager.Close() }},
		{"revoked", websocket.StatusPolicyViolation, "access revoked: token deleted", func(manager *LSPSessionManager, _ *fakeLanguageServer) {
			manager.RevokeMatching(revocation.Event{Kind: revocation.KindUserDisabled, UserID: 1, Reason: "token deleted"})
		}},
		{"destroy", websocket.StatusNormalClosure, "session ended", func(manager *LSPSessionManager, _ *fakeLanguageServer) { manager.Destroy("s1", "session ended") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			manager, guest := newLSPRelayManager(t, 0, true)
			returned := make(chan struct{})
			handler := &WorkspaceTerminalHandler{Service: lspTestService("running"), AllowedOrigins: []string{"https://smithers.sh"}, LSPSessions: manager}
			srv := newLSPCloseRouteServer(t, handler, returned)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			ws, _, err := dialLSP(ctx, srv.URL, "s1")
			require.NoError(t, err)
			defer ws.CloseNow()
			// The round trip proves attach and both relay pumps are running.
			require.NoError(t, ws.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`)))
			_, _, err = ws.Read(ctx)
			require.NoError(t, err)
			tc.end(manager, guest)
			_, _, err = ws.Read(ctx)
			var closeErr websocket.CloseError
			require.True(t, errors.As(err, &closeErr), "protocol close missing: %v", err)
			assert.Equal(t, tc.code, closeErr.Code)
			assert.Equal(t, tc.reason, closeErr.Reason)
			waitLSPCloseEvent(t, returned, 2*time.Second, "HTTP handler did not finish after protocol close")
		})
	}
}

func TestLSPWebSocket_NonreadingPeerDoesNotDelayManagerShutdown(t *testing.T) {
	manager, _ := newLSPRelayManager(t, 0, true)
	attached := make(chan *lspSession, 1)
	returned := make(chan struct{})
	handler := &WorkspaceTerminalHandler{
		Service: lspTestService("running"), AllowedOrigins: []string{"https://smithers.sh"}, LSPSessions: manager,
		beforeLSPAttach: func(sess *lspSession) { attached <- sess },
	}
	srv := newLSPCloseRouteServer(t, handler, returned)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	ws, _, err := dialLSP(ctx, srv.URL, "s1")
	require.NoError(t, err)
	defer ws.CloseNow()
	require.NoError(t, ws.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`)))
	_, _, err = ws.Read(ctx)
	require.NoError(t, err)
	sess := <-attached

	// Leave the TCP peer open without another Read: it cannot acknowledge the
	// close frame. Manager.Close must return before the bounded peer wait.
	shutdownReturned := make(chan struct{})
	go func() { manager.Close(); close(shutdownReturned) }()
	waitLSPCloseEvent(t, shutdownReturned, time.Second, "manager waited for the nonreading peer")
	assert.True(t, sess.isDead())
	waitLSPCloseEvent(t, sess.done, time.Second, "done waited for the nonreading peer")
	_, err = manager.start(ctx, "later", services.WorkspaceSSHConnectionInfo{}, services.LanguageServerLaunch{}, revocation.Principal{})
	require.ErrorIs(t, err, errLSPManagerClosed)
	waitLSPCloseEvent(t, returned, 8*time.Second, "HTTP close exceeded the library's bounded peer wait")
	select {
	case <-sess.closeFinished:
	default:
		t.Error("HTTP handler returned before close completion")
	}
	// Read only after the peer wait has timed out. The original typed close
	// must still be buffered on the wire, rather than an unexplained EOF.
	_, _, err = ws.Read(ctx)
	var closeErr websocket.CloseError
	require.True(t, errors.As(err, &closeErr), "shutdown close missing after peer timeout: %v", err)
	assert.Equal(t, websocket.StatusGoingAway, closeErr.Code)
	assert.Equal(t, "server shutting down", closeErr.Reason)
}

func TestLSPSessionRun_CloseWithoutAttachedSocket(t *testing.T) {
	for _, destroyFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "run destroys", true: "already destroyed"}[destroyFirst], func(t *testing.T) {
			manager, _ := newLSPRelayManager(t, 0, true)
			sess, err := manager.start(context.Background(), "unattached", services.WorkspaceSSHConnectionInfo{}, services.LanguageServerLaunch{}, revocation.Principal{})
			require.NoError(t, err)
			if destroyFirst {
				sess.destroy(websocket.StatusGoingAway, "server shutting down")
			}
			returned := make(chan struct{})
			go func() { sess.run(context.Background()); close(returned) }()
			waitLSPCloseEvent(t, returned, time.Second, "unattached relay waited for a nonexistent socket")
			assert.True(t, sess.isDead())
			waitLSPCloseEvent(t, sess.done, time.Second, "unattached relay did not signal done")
			waitLSPCloseEvent(t, sess.closeFinished, time.Second, "unattached relay did not complete close")
			code, reason := sess.closeStatus()
			if destroyFirst {
				assert.Equal(t, websocket.StatusGoingAway, code)
				assert.Equal(t, "server shutting down", reason)
			} else {
				assert.Equal(t, websocket.StatusInternalError, code)
				assert.Equal(t, "no client attached", reason)
			}
		})
	}
}
