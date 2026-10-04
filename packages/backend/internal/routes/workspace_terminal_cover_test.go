package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestWorkspaceTerminal_Cov_ForwardedOriginParsing(t *testing.T) {
	t.Parallel()

	t.Run("uses first forwarded values", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodGet, "/terminal", nil)
		req.Header.Set("X-Forwarded-Proto", " https , http")
		req.Header.Set("X-Forwarded-Host", "smithers.example, internal.example")

		assert.Equal(t, "https", firstForwardedValue(" https , http"))
		assert.Equal(t, "https://smithers.example", forwardedRequestOrigin(req))
	})

	t.Run("rejects unsupported forwarded proto", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodGet, "/terminal", nil)
		req.Header.Set("X-Forwarded-Proto", "ftp")
		req.Header.Set("X-Forwarded-Host", "smithers.example")

		assert.Empty(t, forwardedRequestOrigin(req))
	})

	t.Run("rejects malformed forwarded host", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodGet, "/terminal", nil)
		req.Header.Set("X-Forwarded-Proto", "https")
		req.Header.Set("X-Forwarded-Host", "%zz")

		assert.Empty(t, forwardedRequestOrigin(req))
	})
}

func TestWorkspaceTerminal_Cov_TerminalWebSocketMissingID(t *testing.T) {
	t.Parallel()

	handler := &WorkspaceTerminalHandler{
		Service:        &mockWorkspaceTerminalService{},
		AllowedOrigins: []string{"https://smithers.sh"},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspace/sessions//terminal", nil)
	req.Header.Set("Origin", "https://smithers.sh")
	ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 1, Username: "alice"}})
	ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
		Owner:      "alice",
		Repository: &db.Repository{ID: 42, Name: "demo"},
	}, middleware.PermissionWrite)
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()

	handler.TerminalWebSocket(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "session id is required")
}

func TestWorkspaceTerminal_Cov_TerminalSessionManagerLazyInit(t *testing.T) {
	t.Parallel()

	handler := &WorkspaceTerminalHandler{}
	first := handler.terminalSessionManager()
	second := handler.terminalSessionManager()

	require.NotNil(t, first)
	assert.Same(t, first, second)
	assert.Same(t, first, handler.TerminalSessions)
}

func TestWorkspaceTerminal_Cov_HostKeyCallbackValidation(t *testing.T) {
	t.Parallel()

	t.Run("rejects malformed advertised key", func(t *testing.T) {
		t.Parallel()
		_, err := buildPinnedHostKeyCallback("ssh.example", 2222, []services.WorkspaceSSHHostKey{{
			Algorithm: "ssh-ed25519",
			PublicKey: "%%%not-base64%%%",
		}})

		require.Error(t, err)
		assert.Contains(t, err.Error(), "decode public_key")
	})

	t.Run("rejects algorithm mismatch", func(t *testing.T) {
		t.Parallel()
		key := newTestHostKey(t)
		advertise := key.advertise
		advertise.Algorithm = "ssh-rsa"

		_, err := buildPinnedHostKeyCallback("ssh.example", 2222, []services.WorkspaceSSHHostKey{advertise})

		require.Error(t, err)
		assert.Contains(t, err.Error(), "algorithm")
	})

	t.Run("rejects fingerprint mismatch", func(t *testing.T) {
		t.Parallel()
		key := newTestHostKey(t)
		advertise := key.advertise
		advertise.FingerprintSHA256 = "SHA256:not-the-real-fingerprint"

		_, err := buildPinnedHostKeyCallback("ssh.example", 2222, []services.WorkspaceSSHHostKey{advertise})

		require.Error(t, err)
		assert.Contains(t, err.Error(), "fingerprint")
	})

	t.Run("callback rejects hostname mismatch", func(t *testing.T) {
		t.Parallel()
		key := newTestHostKey(t)
		callback, err := buildPinnedHostKeyCallback("ssh.example", 2222, []services.WorkspaceSSHHostKey{key.advertise})
		require.NoError(t, err)

		err = callback("other.example:2222", nil, key.signer.PublicKey())

		require.Error(t, err)
		assert.Contains(t, err.Error(), "hostname mismatch")
	})
}

func TestWorkspaceTerminal_Cov_PipeWSToSSH(t *testing.T) {
	t.Parallel()

	stdin := &terminalSessionManagerCovWriteCloser{}
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
	t.Cleanup(func() {
		_ = sshSess.Close()
		_ = sshClient.Close()
	})
	var activity atomic.Int32
	done := make(chan error, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			done <- err
			return
		}
		defer conn.CloseNow()
		(&WorkspaceTerminalHandler{}).pipeWSToSSH(r.Context(), conn, stdin, sshSess, "sess", func() {
			activity.Add(1)
		})
		done <- nil
	}))
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], nil)
	require.NoError(t, err)
	require.NoError(t, client.Write(ctx, websocket.MessageBinary, []byte("abc")))
	require.NoError(t, client.Write(ctx, websocket.MessageText, []byte(`{`)))
	require.NoError(t, client.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":100,"rows":25}`)))
	require.NoError(t, client.Write(ctx, websocket.MessageText, []byte(`{"type":"unknown"}`)))
	require.NoError(t, client.Close(websocket.StatusNormalClosure, "done"))

	select {
	case err := <-done:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal("timed out waiting for websocket pipe")
	}

	assert.Equal(t, "abc", stdin.String())
	assert.True(t, stdin.closed)
	assert.GreaterOrEqual(t, activity.Load(), int32(4))
}

func TestWorkspaceTerminal_Cov_PipeWSToTerminalSession(t *testing.T) {
	t.Parallel()

	sshSess := terminalSessionManagerCovNewSSHSession()
	var touched atomic.Int32
	sess := newTerminalSession(
		"sess-terminal",
		&terminalSessionManagerCovSSHClient{},
		sshSess,
		sshSess.stdin,
		sshSess.stdout,
		sshSess.stderr,
		1024,
		time.Hour,
		0,
		nil,
	)
	// Activity callbacks are per-attached-sink; register one like addSink does.
	touchSink := newTerminalSink(&websocket.Conn{}, 8, time.Millisecond)
	touchSink.touch = func() { touched.Add(1) }
	sess.sinks[touchSink] = struct{}{}
	var activity atomic.Int32
	done := make(chan error, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			done <- err
			return
		}
		defer conn.CloseNow()
		registerTerminalOwnerFixture(sess, conn)
		(&WorkspaceTerminalHandler{}).pipeWSToTerminalSession(r.Context(), r.Context(), conn, sess, "sess-terminal", func() {
			activity.Add(1)
		})
		done <- nil
	}))
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], nil)
	require.NoError(t, err)
	require.NoError(t, client.Write(ctx, websocket.MessageBinary, []byte("xyz")))
	require.NoError(t, client.Write(ctx, websocket.MessageText, []byte(`{`)))
	require.NoError(t, client.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":90,"rows":30}`)))
	require.NoError(t, client.Write(ctx, websocket.MessageText, []byte(`{"type":"unknown"}`)))
	require.NoError(t, client.Close(websocket.StatusNormalClosure, "done"))

	select {
	case err := <-done:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal("timed out waiting for terminal session pipe")
	}

	assert.Equal(t, "xyz", sshSess.stdin.String())
	assert.Equal(t, 30, sshSess.windowRows)
	assert.Equal(t, 90, sshSess.windowCols)
	assert.Equal(t, int32(2), touched.Load())
	assert.GreaterOrEqual(t, activity.Load(), int32(4))
}
