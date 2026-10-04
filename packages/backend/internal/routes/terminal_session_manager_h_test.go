package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestTerminalSessionManager_H_GetOrCreateBranches(t *testing.T) {
	t.Run("nil sessions map existing and dead sessions", func(t *testing.T) {
		fake := newFakeTerminalSSH()
		manager := &TerminalSessionManager{
			dial: func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
				return fake.client, fake.session, nil
			},
			ringBufferBytes:   1024,
			idleTimeout:       time.Hour,
			keepaliveInterval: 0,
		}
		defer manager.Close()

		sess, created, err := manager.getOrCreate(context.Background(), "sess", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{})
		require.True(t, created)
		require.NoError(t, err)
		same, sameCreated, err := manager.getOrCreate(context.Background(), "sess", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{})
		require.False(t, sameCreated)
		require.NoError(t, err)
		require.Same(t, sess, same)

		dead := newTerminalSession("dead", &terminalSessionManagerCovSSHClient{}, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, strings.NewReader(""), strings.NewReader(""), 1024, 0, 0, nil)
		manager.mu.Lock()
		manager.sessions["dead"] = dead
		manager.mu.Unlock()
		dead.destroy("done")
		again, _, err := manager.getOrCreate(context.Background(), "dead", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{})
		require.Nil(t, again)
		require.ErrorContains(t, err, "done")
	})

	t.Run("dial error and duplicate winner", func(t *testing.T) {
		manager := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
			return nil, nil, errors.New("dial failed")
		})
		sess, _, err := manager.getOrCreate(context.Background(), "dial", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{})
		require.Nil(t, sess)
		require.EqualError(t, err, "dial failed")

		existing := newTerminalSession("dup", &terminalSessionManagerCovSSHClient{}, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, strings.NewReader(""), strings.NewReader(""), 1024, 0, 0, nil)
		fake := newFakeTerminalSSH()
		manager = NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
			manager.mu.Lock()
			manager.sessions["dup"] = existing
			manager.mu.Unlock()
			return fake.client, fake.session, nil
		})
		manager.keepaliveInterval = 0
		got, gotCreated, err := manager.getOrCreate(context.Background(), "dup", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{})
		require.False(t, gotCreated)
		require.NoError(t, err)
		require.Same(t, existing, got)
		existing.destroy("cleanup")

		deadExisting := newTerminalSession("dup-dead", &terminalSessionManagerCovSSHClient{}, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, strings.NewReader(""), strings.NewReader(""), 1024, 0, 0, nil)
		deadExisting.destroy("already dead")
		fake = newFakeTerminalSSH()
		manager = NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
			manager.mu.Lock()
			manager.sessions["dup-dead"] = deadExisting
			manager.mu.Unlock()
			return fake.client, fake.session, nil
		})
		got, _, err = manager.getOrCreate(context.Background(), "dup-dead", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{})
		require.Nil(t, got)
		require.ErrorContains(t, err, "already dead")
	})
}

func TestTerminalSessionManager_H_SessionHelperBranches(t *testing.T) {
	t.Run("dead error fallbacks and add sink dead message", func(t *testing.T) {
		sess := newTerminalSession("dead", &terminalSessionManagerCovSSHClient{}, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, strings.NewReader(""), strings.NewReader(""), 1024, 0, 0, nil)
		sess.dead = true
		require.EqualError(t, sess.deadErr(), "terminal session ended")

		sess.deadMsg = "closed"
		require.EqualError(t, sess.deadErr(), "closed")
		sink, err := sess.addSink(context.Background(), nil, nil, revocation.Principal{})
		require.Nil(t, sink)
		require.EqualError(t, err, "closed")
	})

	t.Run("detach stops existing idle timer", func(t *testing.T) {
		sess := newTerminalSession("idle", &terminalSessionManagerCovSSHClient{}, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, strings.NewReader(""), strings.NewReader(""), 1024, time.Hour, 0, nil)
		sink := newTerminalSink(nil, 1, time.Millisecond)
		sess.sinks[sink] = struct{}{}
		sess.idle = time.AfterFunc(time.Hour, func() {})
		sess.detachSink(sink, false, 0, "")
		require.NotNil(t, sess.idle)
		sess.destroy("cleanup")
	})

	t.Run("detach idle timer destroys session", func(t *testing.T) {
		sess := newTerminalSession("idle-timeout", &terminalSessionManagerCovSSHClient{}, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, strings.NewReader(""), strings.NewReader(""), 1024, time.Millisecond, 0, nil)
		sink := newTerminalSink(nil, 1, time.Millisecond)
		sess.sinks[sink] = struct{}{}
		sess.detachSink(sink, false, 0, "")
		require.Eventually(t, sess.isDead, time.Second, 10*time.Millisecond)
	})

	t.Run("keepalive success exits on done", func(t *testing.T) {
		sess := newTerminalSession("keepalive", &terminalSessionManagerCovSSHClient{}, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, strings.NewReader(""), strings.NewReader(""), 1024, 0, time.Millisecond, nil)
		done := make(chan struct{})
		go func() {
			sess.keepaliveLoop()
			close(done)
		}()
		time.Sleep(5 * time.Millisecond)
		close(sess.done)
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("keepalive loop did not stop")
		}
	})
}

func TestTerminalSessionManager_H_LiveSinkAndShellBranches(t *testing.T) {
	t.Run("workspace shell quoting", func(t *testing.T) {
		sshSess := terminalSessionManagerCovNewSSHSession()
		require.NoError(t, startWorkspaceShell(sshSess, "/tmp/a'b"))
		require.Equal(t, "if [ -d '/tmp/a'\\''b' ]; then cd '/tmp/a'\\''b'; fi; for s in \"$SHELL\" /bin/bash /bin/sh; do if [ -n \"$s\" ] && [ -x \"$s\" ]; then exec \"$s\" -l; fi; done; exec sh -l", sshSess.startedCmd)
		require.Equal(t, "'x'\\''y'", shellSingleQuote("x'y"))
	})

	t.Run("add sink replays ring and detach closes websocket", func(t *testing.T) {
		serverWS, clientWS, cleanup := terminalSessionManagerHWebsocketPair(t)
		defer cleanup()

		sess := newTerminalSession("live", &terminalSessionManagerCovSSHClient{}, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, strings.NewReader(""), strings.NewReader(""), 1024, time.Hour, 0, nil)
		sess.ring.Append([]byte("replay"))
		sess.idle = time.AfterFunc(time.Hour, func() {})

		sink, err := sess.addSink(context.Background(), serverWS, nil, revocation.Principal{})
		require.NoError(t, err)
		typ, msg, err := clientWS.Read(context.Background())
		require.NoError(t, err)
		require.Equal(t, websocket.MessageBinary, typ)
		require.Equal(t, []byte("replay"), msg)
		typ, msg, err = clientWS.Read(context.Background())
		require.NoError(t, err)
		require.Equal(t, websocket.MessageText, typ)
		require.JSONEq(t, `{"type":"replay-complete"}`, string(msg))

		sess.detachSink(sink, true, websocket.StatusGoingAway, "bye")
	})
}

func terminalSessionManagerHWebsocketPair(t *testing.T) (*websocket.Conn, *websocket.Conn, func()) {
	t.Helper()
	ready := make(chan *websocket.Conn, 1)
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		require.NoError(t, err)
		ready <- ws
		<-done
	}))
	client, _, err := websocket.Dial(context.Background(), "ws"+srv.URL[len("http"):], nil)
	require.NoError(t, err)
	server := <-ready
	cleanup := func() {
		close(done)
		client.CloseNow()
		server.CloseNow()
		srv.Close()
	}
	return server, client, cleanup
}
