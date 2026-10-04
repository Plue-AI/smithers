package routes

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type workspaceTerminalZService struct {
	sessionFn func(context.Context, string, int64, int64) (services.WorkspaceSessionResponse, error)
	sshFn     func(context.Context, string, int64, int64) (services.WorkspaceSSHConnectionInfo, error)
	touchFn   func(context.Context, string) error
}

func (s workspaceTerminalZService) ResolveLanguageServer(ctx context.Context, sessionID string, repositoryID, userID int64) (services.LanguageServerLaunch, error) {
	spec, _ := services.LanguageServerFor("typescript")
	return services.LanguageServerLaunch{SessionID: sessionID, Language: spec.Language, Spec: spec, Command: spec.LaunchCommand("/home/developer/workspace")}, nil
}

func (s workspaceTerminalZService) GetSession(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error) {
	if s.sessionFn != nil {
		return s.sessionFn(ctx, sessionID, repositoryID, userID)
	}
	return services.WorkspaceSessionResponse{ID: sessionID, RepositoryID: repositoryID, UserID: userID, Status: "running", Cols: 80, Rows: 24}, nil
}

func (s workspaceTerminalZService) GetSSHConnectionInfo(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
	if s.sshFn != nil {
		return s.sshFn(ctx, sessionID, repositoryID, userID)
	}
	return services.WorkspaceSSHConnectionInfo{WorkspaceID: "77", VMID: "vm-z", Host: "ssh.example", Username: "root"}, nil
}

func (s workspaceTerminalZService) TouchSessionActivity(ctx context.Context, sessionID string) error {
	if s.touchFn != nil {
		return s.touchFn(ctx, sessionID)
	}
	return nil
}

func workspaceTerminalZRouter(handler *WorkspaceTerminalHandler) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
				User: &db.User{ID: 9, Username: "alice", LowerUsername: "alice"},
			})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "alice",
				Repository: &db.Repository{ID: 42, Name: "demo", LowerName: "demo"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)
	return r
}

func TestWorkspaceTerminal_Z_TerminalWebSocketDurableSessionSuccess(t *testing.T) {
	oldKeepAlive := terminalKeepAliveInterval
	oldActivity := terminalActivityRefreshInterval
	terminalKeepAliveInterval = time.Millisecond
	terminalActivityRefreshInterval = time.Millisecond
	t.Cleanup(func() {
		terminalKeepAliveInterval = oldKeepAlive
		terminalActivityRefreshInterval = oldActivity
	})

	fake := newFakeTerminalSSH()
	go func() {
		_, _ = io.Copy(io.Discard, fake.session.stdinR)
	}()
	manager := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
		return fake.client, fake.session, nil
	})
	manager.keepaliveInterval = 0
	manager.idleTimeout = time.Minute
	t.Cleanup(manager.Close)

	var touches atomic.Int32
	handler := &WorkspaceTerminalHandler{
		Service: workspaceTerminalZService{
			touchFn: func(context.Context, string) error {
				touches.Add(1)
				return errors.New("touch failed")
			},
		},
		AllowedOrigins:   []string{"https://smithers.sh"},
		TerminalSessions: manager,
	}
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		workspaceTerminalZRouter(handler).ServeHTTP(w, r)
		close(done)
	}))
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):]+"/repos/alice/demo/workspace/sessions/sess-z/terminal", &websocket.DialOptions{
		HTTPHeader:   http.Header{"Origin": []string{"https://smithers.sh"}},
		Subprotocols: []string{"terminal"},
	})
	require.NoError(t, err)

	msgType, msg, err := ws.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, websocket.MessageText, msgType)
	require.JSONEq(t, `{"type":"replay-complete"}`, string(msg))
	require.NoError(t, ws.Write(ctx, websocket.MessageBinary, []byte("abc")))
	require.NoError(t, ws.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":100,"rows":40}`)))
	require.Eventually(t, func() bool { return touches.Load() >= 2 }, time.Second, 5*time.Millisecond)
	require.NoError(t, ws.Close(websocket.StatusNormalClosure, "done"))

	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("terminal websocket handler did not return")
	}
}

func TestWorkspaceTerminal_Z_TerminalWebSocketKeepaliveContextExit(t *testing.T) {
	oldKeepAlive := terminalKeepAliveInterval
	oldActivity := terminalActivityRefreshInterval
	terminalKeepAliveInterval = time.Hour
	terminalActivityRefreshInterval = time.Hour
	t.Cleanup(func() {
		terminalKeepAliveInterval = oldKeepAlive
		terminalActivityRefreshInterval = oldActivity
	})

	fake := newFakeTerminalSSH()
	manager := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
		return fake.client, fake.session, nil
	})
	manager.keepaliveInterval = 0
	t.Cleanup(manager.Close)

	handler := &WorkspaceTerminalHandler{
		Service:          workspaceTerminalZService{},
		AllowedOrigins:   []string{"https://smithers.sh"},
		TerminalSessions: manager,
	}
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		workspaceTerminalZRouter(handler).ServeHTTP(w, r)
		close(done)
	}))
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):]+"/repos/alice/demo/workspace/sessions/sess-ctx/terminal", &websocket.DialOptions{
		HTTPHeader:   http.Header{"Origin": []string{"https://smithers.sh"}},
		Subprotocols: []string{"terminal"},
	})
	require.NoError(t, err)
	_, _, err = ws.Read(ctx)
	require.NoError(t, err)
	require.NoError(t, ws.Close(websocket.StatusNormalClosure, "done"))

	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("terminal websocket handler did not return")
	}
}

func TestWorkspaceTerminal_Z_TerminalWebSocketAcceptAndAttachErrors(t *testing.T) {
	t.Run("manager error before upgrade", func(t *testing.T) {
		handler := &WorkspaceTerminalHandler{
			Service:          workspaceTerminalZService{},
			AllowedOrigins:   []string{"https://smithers.sh"},
			TerminalSessions: NewTerminalSessionManager(nil),
		}
		req := httptest.NewRequest(http.MethodGet, "/repos/alice/demo/workspace/sessions/sess-z/terminal", nil)
		req.Header.Set("Origin", "https://smithers.sh")
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "sess-z"})
		req = withAuth(req, 9, "alice")
		ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
			Owner:      "alice",
			Repository: &db.Repository{ID: 42, Name: "demo"},
		}, middleware.PermissionWrite)
		req = req.WithContext(ctx)
		rec := httptest.NewRecorder()

		handler.TerminalWebSocket(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("accept error after terminal is ready", func(t *testing.T) {
		fake := newFakeTerminalSSH()
		manager := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
			return fake.client, fake.session, nil
		})
		manager.keepaliveInterval = 0
		t.Cleanup(manager.Close)
		handler := &WorkspaceTerminalHandler{
			Service:          workspaceTerminalZService{},
			AllowedOrigins:   []string{"https://smithers.sh"},
			TerminalSessions: manager,
		}
		req := httptest.NewRequest(http.MethodGet, "/repos/alice/demo/workspace/sessions/sess-z/terminal", nil)
		req.Header.Set("Origin", "https://smithers.sh")
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "sess-z"})
		req = withAuth(req, 9, "alice")
		ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
			Owner:      "alice",
			Repository: &db.Repository{ID: 42, Name: "demo"},
		}, middleware.PermissionWrite)
		req = req.WithContext(ctx)
		rec := httptest.NewRecorder()

		handler.TerminalWebSocket(rec, req)

		require.NotEqual(t, http.StatusOK, rec.Code)
	})

	t.Run("attach error closes upgraded websocket", func(t *testing.T) {
		fake := newFakeTerminalSSH()
		manager := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
			return fake.client, fake.session, nil
		})
		manager.keepaliveInterval = 0
		t.Cleanup(manager.Close)
		handler := &WorkspaceTerminalHandler{
			Service:          workspaceTerminalZService{},
			AllowedOrigins:   []string{"https://smithers.sh"},
			TerminalSessions: manager,
			beforeTerminalAttach: func(sess *terminalSession) {
				sess.markDead(errors.New("session died before attach"))
			},
		}
		done := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			workspaceTerminalZRouter(handler).ServeHTTP(w, r)
			close(done)
		}))
		t.Cleanup(srv.Close)

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		ws, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):]+"/repos/alice/demo/workspace/sessions/sess-dead/terminal", &websocket.DialOptions{
			HTTPHeader:   http.Header{"Origin": []string{"https://smithers.sh"}},
			Subprotocols: []string{"terminal"},
		})
		require.NoError(t, err)
		_, _, err = ws.Read(ctx)
		require.Error(t, err)

		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal("terminal websocket attach-error handler did not return")
		}
	})
}

func TestWorkspaceTerminal_Z_LazyManagerDialAndDialSSHErrors(t *testing.T) {
	t.Run("lazy manager propagates dial error and default port", func(t *testing.T) {
		handler := &WorkspaceTerminalHandler{}
		manager := handler.terminalSessionManager()

		sess, _, err := manager.getOrCreate(context.Background(), "sess-lazy", services.WorkspaceSSHConnectionInfo{
			Host:     "127.0.0.1",
			Username: "root",
		}, 80, 24, revocation.Principal{})

		require.Nil(t, sess)
		require.ErrorIs(t, err, errNoAdvertisedHostKeys)
	})

	t.Run("new session failure closes client", func(t *testing.T) {
		hostKey := newTestHostKey(t)
		host, port := startSessionRejectingSSHServer(t, hostKey.signer)
		client, session, err := (&WorkspaceTerminalHandler{}).dialSSH(context.Background(), services.WorkspaceSSHConnectionInfo{
			VMID:        "vm-test",
			Host:        host,
			Port:        port,
			Username:    "root",
			AccessToken: "token",
			HostKeys:    []services.WorkspaceSSHHostKey{hostKey.advertise},
		}, 80, 24)

		require.Nil(t, client)
		require.Nil(t, session)
		require.ErrorContains(t, err, "ssh new session")
	})

	t.Run("lazy manager successful dial", func(t *testing.T) {
		hostKey := newTestHostKey(t)
		host, port, _ := startTestSSHServer(t, hostKey.signer)
		handler := &WorkspaceTerminalHandler{}
		manager := handler.terminalSessionManager()
		manager.keepaliveInterval = 0
		t.Cleanup(manager.Close)

		sess, _, err := manager.getOrCreate(context.Background(), "sess-lazy-ok", services.WorkspaceSSHConnectionInfo{
			VMID:        "vm-test",
			Host:        host,
			Port:        port,
			Username:    "root",
			AccessToken: "token",
			HostKeys:    []services.WorkspaceSSHHostKey{hostKey.advertise},
		}, 80, 24, revocation.Principal{})

		require.NoError(t, err)
		require.NotNil(t, sess)
	})
}

func TestWorkspaceTerminal_Z_HostKeyCallbackMoreValidation(t *testing.T) {
	t.Run("rejects empty advertised public key", func(t *testing.T) {
		_, err := buildPinnedHostKeyCallback("ssh.example", 22, []services.WorkspaceSSHHostKey{{Algorithm: "ssh-ed25519"}})

		require.ErrorContains(t, err, "empty public_key")
	})

	t.Run("rejects unparseable advertised public key bytes", func(t *testing.T) {
		_, err := buildPinnedHostKeyCallback("ssh.example", 22, []services.WorkspaceSSHHostKey{{
			PublicKey: "bm90LWFuLXNzaC1wdWJsaWMta2V5",
		}})

		require.ErrorContains(t, err, "parse public_key")
	})
}

func TestWorkspaceTerminal_Z_PipeSSHToWSErrors(t *testing.T) {
	t.Run("logs non eof read error", func(t *testing.T) {
		(&WorkspaceTerminalHandler{}).pipeSSHToWS(context.Background(), &websocket.Conn{}, terminalZErrReader{err: errors.New("read failed")}, "sess", func() {
			t.Fatal("activity should not fire without bytes")
		})
	})

	t.Run("returns on websocket write error", func(t *testing.T) {
		done := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			require.NoError(t, err)
			ws.CloseNow()
			(&WorkspaceTerminalHandler{}).pipeSSHToWS(r.Context(), ws, bytes.NewBufferString("data"), "sess", func() {})
			close(done)
		}))
		t.Cleanup(srv.Close)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		client, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], nil)
		require.NoError(t, err)
		defer client.CloseNow()
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal("pipe did not return after websocket write error")
		}
	})
}

func TestWorkspaceTerminal_Z_PipeWSToSSHErrors(t *testing.T) {
	t.Run("context cancellation is a websocket read error", func(t *testing.T) {
		done := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			require.NoError(t, err)
			defer ws.CloseNow()
			ctx, cancel := context.WithCancel(r.Context())
			cancel()
			(&WorkspaceTerminalHandler{}).pipeWSToSSH(ctx, ws, &terminalSessionManagerCovWriteCloser{}, nil, "sess", func() {})
			close(done)
		}))
		t.Cleanup(srv.Close)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		client, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], nil)
		require.NoError(t, err)
		defer client.CloseNow()
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal("pipe did not return after context cancellation")
		}
	})

	t.Run("stdin write error returns", func(t *testing.T) {
		done := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			require.NoError(t, err)
			defer ws.CloseNow()
			stdin := &terminalSessionManagerCovWriteCloser{err: errors.New("broken pipe")}
			(&WorkspaceTerminalHandler{}).pipeWSToSSH(r.Context(), ws, stdin, nil, "sess", func() {})
			close(done)
		}))
		t.Cleanup(srv.Close)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		client, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], nil)
		require.NoError(t, err)
		require.NoError(t, client.Write(ctx, websocket.MessageBinary, []byte("x")))
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal("pipe did not return after stdin write error")
		}
		client.CloseNow()
	})

	t.Run("window change error is logged", func(t *testing.T) {
		hostKey := newTestHostKey(t)
		host, port, _ := startTestSSHServer(t, hostKey.signer)
		sshClient, sshSess, err := (&WorkspaceTerminalHandler{}).dialSSH(context.Background(), services.WorkspaceSSHConnectionInfo{
			VMID:        "vm-test",
			Host:        host,
			Port:        port,
			Username:    "root",
			AccessToken: "token",
			HostKeys:    []services.WorkspaceSSHHostKey{hostKey.advertise},
		}, 80, 24)
		require.NoError(t, err)
		require.NoError(t, sshSess.Close())
		t.Cleanup(func() { _ = sshClient.Close() })

		done := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			require.NoError(t, err)
			defer ws.CloseNow()
			(&WorkspaceTerminalHandler{}).pipeWSToSSH(r.Context(), ws, &terminalSessionManagerCovWriteCloser{}, sshSess, "sess", func() {})
			close(done)
		}))
		t.Cleanup(srv.Close)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		client, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], nil)
		require.NoError(t, err)
		require.NoError(t, client.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":100,"rows":40}`)))
		require.NoError(t, client.Close(websocket.StatusNormalClosure, "done"))
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal("pipe did not return after resize")
		}
	})
}

func TestWorkspaceTerminal_Z_PipeWSToTerminalSessionErrors(t *testing.T) {
	t.Run("context cancellation is a websocket read error", func(t *testing.T) {
		sshSess := terminalSessionManagerCovNewSSHSession()
		sess := newTerminalSession("sess", &terminalSessionManagerCovSSHClient{}, sshSess, sshSess.stdin, bytes.NewBuffer(nil), bytes.NewBuffer(nil), 1024, time.Hour, 0, nil)
		done := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			require.NoError(t, err)
			defer ws.CloseNow()
			ctx, cancel := context.WithCancel(r.Context())
			cancel()
			registerTerminalOwnerFixture(sess, ws)
			(&WorkspaceTerminalHandler{}).pipeWSToTerminalSession(ctx, ctx, ws, sess, "sess", func() {})
			close(done)
		}))
		t.Cleanup(srv.Close)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		client, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], nil)
		require.NoError(t, err)
		defer client.CloseNow()
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal("pipe did not return after context cancellation")
		}
	})

	t.Run("stdin write error returns", func(t *testing.T) {
		sshSess := terminalSessionManagerCovNewSSHSession()
		sshSess.stdin.err = errors.New("broken pipe")
		sess := newTerminalSession("sess", &terminalSessionManagerCovSSHClient{}, sshSess, sshSess.stdin, bytes.NewBuffer(nil), bytes.NewBuffer(nil), 1024, time.Hour, 0, nil)
		done := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			require.NoError(t, err)
			defer ws.CloseNow()
			registerTerminalOwnerFixture(sess, ws)
			(&WorkspaceTerminalHandler{}).pipeWSToTerminalSession(r.Context(), r.Context(), ws, sess, "sess", func() {})
			close(done)
		}))
		t.Cleanup(srv.Close)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		client, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], nil)
		require.NoError(t, err)
		require.NoError(t, client.Write(ctx, websocket.MessageBinary, []byte("x")))
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal("pipe did not return after stdin write error")
		}
		client.CloseNow()
	})

	t.Run("resize error is logged", func(t *testing.T) {
		sshSess := terminalSessionManagerCovNewSSHSession()
		sshSess.windowErr = errors.New("window denied")
		sess := newTerminalSession("sess", &terminalSessionManagerCovSSHClient{}, sshSess, sshSess.stdin, bytes.NewBuffer(nil), bytes.NewBuffer(nil), 1024, time.Hour, 0, nil)
		done := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			require.NoError(t, err)
			defer ws.CloseNow()
			registerTerminalOwnerFixture(sess, ws)
			(&WorkspaceTerminalHandler{}).pipeWSToTerminalSession(r.Context(), r.Context(), ws, sess, "sess", func() {})
			close(done)
		}))
		t.Cleanup(srv.Close)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		client, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], nil)
		require.NoError(t, err)
		require.NoError(t, client.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":100,"rows":40}`)))
		require.NoError(t, client.Close(websocket.StatusNormalClosure, "done"))
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal("pipe did not return after resize")
		}
	})
}

type terminalZErrReader struct {
	err error
}

func (r terminalZErrReader) Read([]byte) (int, error) {
	return 0, r.err
}

func startSessionRejectingSSHServer(t *testing.T, signer gossh.Signer) (string, int) {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { _ = ln.Close() })

	cfg := &gossh.ServerConfig{
		PasswordCallback: func(gossh.ConnMetadata, []byte) (*gossh.Permissions, error) {
			return nil, nil
		},
	}
	cfg.AddHostKey(signer)

	go func() {
		conn, acceptErr := ln.Accept()
		if acceptErr != nil {
			return
		}
		sshConn, chans, reqs, serverErr := gossh.NewServerConn(conn, cfg)
		if serverErr != nil {
			_ = conn.Close()
			return
		}
		go gossh.DiscardRequests(reqs)
		go func() {
			for ch := range chans {
				_ = ch.Reject(gossh.Prohibited, "sessions disabled")
			}
		}()
		t.Cleanup(func() { _ = sshConn.Close() })
	}()

	host, portStr, err := net.SplitHostPort(ln.Addr().String())
	require.NoError(t, err)
	port, err := strconv.Atoi(portStr)
	require.NoError(t, err)
	return host, port
}
