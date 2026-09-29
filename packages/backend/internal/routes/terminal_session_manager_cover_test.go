package routes

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestTerminalSessionManager_Cov_GetOrCreateFailurePaths(t *testing.T) {
	t.Run("nil dialer returns error", func(t *testing.T) {
		manager := NewTerminalSessionManager(nil)

		sess, created, err := manager.getOrCreate(context.Background(), "sess-nil", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{})

		require.Nil(t, sess)
		require.False(t, created)
		require.EqualError(t, err, "terminal session manager dialer is nil")
	})

	t.Run("pipe and pty errors close client and session", func(t *testing.T) {
		cases := []struct {
			name          string
			mutate        func(*terminalSessionManagerCovSSHSession)
			wantSubstring string
		}{
			{
				name: "stdin",
				mutate: func(s *terminalSessionManagerCovSSHSession) {
					s.stdinErr = errors.New("stdin denied")
				},
				wantSubstring: "ssh stdin pipe: stdin denied",
			},
			{
				name: "stdout",
				mutate: func(s *terminalSessionManagerCovSSHSession) {
					s.stdoutErr = errors.New("stdout denied")
				},
				wantSubstring: "ssh stdout pipe: stdout denied",
			},
			{
				name: "stderr",
				mutate: func(s *terminalSessionManagerCovSSHSession) {
					s.stderrErr = errors.New("stderr denied")
				},
				wantSubstring: "ssh stderr pipe: stderr denied",
			},
			{
				name: "pty",
				mutate: func(s *terminalSessionManagerCovSSHSession) {
					s.ptyErr = errors.New("pty denied")
				},
				wantSubstring: "ssh request pty: pty denied",
			},
			{
				name: "shell",
				mutate: func(s *terminalSessionManagerCovSSHSession) {
					s.startErr = errors.New("shell denied")
				},
				wantSubstring: "ssh shell: shell denied",
			},
		}

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				client := &terminalSessionManagerCovSSHClient{}
				sshSess := terminalSessionManagerCovNewSSHSession()
				tc.mutate(sshSess)
				manager := NewTerminalSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo, cols, rows int32) (terminalSSHClient, terminalSSHSession, error) {
					return client, sshSess, nil
				})

				sess, created, err := manager.getOrCreate(context.Background(), "sess-"+tc.name, services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{})

				require.Nil(t, sess)
				require.False(t, created)
				require.ErrorContains(t, err, tc.wantSubstring)
				assert.True(t, client.closed)
				assert.True(t, sshSess.closed)
			})
		}
	})
}

func TestTerminalSessionManager_Cov_SessionLifecycleAndIO(t *testing.T) {
	t.Run("write resize wait and dead error paths", func(t *testing.T) {
		var touched int
		sshSess := terminalSessionManagerCovNewSSHSession()
		client := &terminalSessionManagerCovSSHClient{closeDone: make(chan struct{})}
		sess := newTerminalSession("sess-io", client, sshSess, sshSess.stdin, bytes.NewBuffer(nil), bytes.NewBuffer(nil), 1024, time.Hour, 0, nil)
		sink := newTerminalSink(&websocket.Conn{}, 4, time.Millisecond)
		sink.touch = func() { touched++ }
		sess.sinks[sink] = struct{}{}

		require.NoError(t, sess.writeStdin(nil))
		require.NoError(t, sess.writeStdin([]byte("hello")))
		assert.Equal(t, "hello", sshSess.stdin.String())
		assert.Equal(t, 1, touched)

		require.NoError(t, sess.resize(0, 80))
		require.NoError(t, sess.resize(24, 80))
		assert.Equal(t, 24, sshSess.windowRows)
		assert.Equal(t, 80, sshSess.windowCols)
		assert.Equal(t, 2, touched)

		sshSess.windowErr = errors.New("window rejected")
		require.EqualError(t, sess.resize(25, 90), "window rejected")

		// Detach before the session dies: markDead closes every remaining
		// sink's websocket, and this test's sink wraps a zero-value conn.
		sess.detachSink(sink, false, 0, "")

		sshSess.waitErr = errors.New("exit status 7")
		sess.wait()
		require.True(t, sess.isDead())
		require.ErrorContains(t, sess.deadErr(), "session exited: exit status 7")
		select {
		case <-client.closeDone:
		case <-time.After(time.Second):
			t.Fatal("terminal transport cleanup did not finish")
		}
		assert.True(t, client.closed)
		assert.True(t, sshSess.closed)
	})

	t.Run("stdin write failure marks the session dead", func(t *testing.T) {
		sshSess := terminalSessionManagerCovNewSSHSession()
		sshSess.stdin.err = errors.New("broken pipe")
		client := &terminalSessionManagerCovSSHClient{}
		sess := newTerminalSession("sess-stdin", client, sshSess, sshSess.stdin, bytes.NewBuffer(nil), bytes.NewBuffer(nil), 1024, time.Hour, 0, nil)

		err := sess.writeStdin([]byte("x"))

		require.EqualError(t, err, "broken pipe")
		require.ErrorContains(t, sess.deadErr(), "ssh stdin write: broken pipe")
	})

	t.Run("destroy removes manager entry and close destroys all", func(t *testing.T) {
		manager := NewTerminalSessionManager(nil)
		client := &terminalSessionManagerCovSSHClient{}
		sess := newTerminalSession("sess-dead", client, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, bytes.NewBuffer(nil), bytes.NewBuffer(nil), 1024, time.Hour, 0, func() {
			manager.remove("sess-dead")
		})
		manager.sessions["sess-dead"] = sess

		manager.Destroy("sess-dead")

		require.True(t, sess.isDead())
		assert.Empty(t, manager.sessions)

		sess2 := newTerminalSession("sess-close", &terminalSessionManagerCovSSHClient{}, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, bytes.NewBuffer(nil), bytes.NewBuffer(nil), 1024, time.Hour, 0, nil)
		manager.sessions["sess-close"] = sess2
		manager.Close()
		require.True(t, sess2.isDead())
	})
}

func TestTerminalSessionManager_Cov_KeepaliveAndDrain(t *testing.T) {
	t.Run("keepalive disabled returns immediately", func(t *testing.T) {
		sess := newTerminalSession("sess-keepalive-off", &terminalSessionManagerCovSSHClient{}, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, bytes.NewBuffer(nil), bytes.NewBuffer(nil), 1024, 0, 0, nil)

		done := make(chan struct{})
		go func() {
			sess.keepaliveLoop()
			close(done)
		}()

		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("keepaliveLoop should return immediately when disabled")
		}
	})

	t.Run("keepalive send failure marks dead", func(t *testing.T) {
		client := &terminalSessionManagerCovSSHClient{sendErr: errors.New("network down")}
		sess := newTerminalSession("sess-keepalive", client, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, bytes.NewBuffer(nil), bytes.NewBuffer(nil), 1024, 0, time.Millisecond, nil)

		go sess.keepaliveLoop()
		require.Eventually(t, sess.isDead, time.Second, 10*time.Millisecond)
		require.ErrorContains(t, sess.deadErr(), "ssh keepalive failed: network down")
	})

	t.Run("drain records chunks and touch callbacks", func(t *testing.T) {
		var touched int
		sess := newTerminalSession("sess-drain", &terminalSessionManagerCovSSHClient{}, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, bytes.NewBuffer(nil), bytes.NewBuffer(nil), 1024, 0, 0, nil)
		sink := newTerminalSink(&websocket.Conn{}, 4, time.Millisecond)
		sink.touch = func() { touched++ }
		sess.sinks[sink] = struct{}{}

		sess.drain(bytes.NewBufferString("abc"))

		replay, _, _ := sess.ring.Snapshot()
		assert.Equal(t, []byte("abc"), replay)
		assert.Equal(t, 1, touched)
	})
}

func TestTerminalSessionManager_Cov_SinkHelpers(t *testing.T) {
	t.Run("new sink defaults buffer and enqueue reports full", func(t *testing.T) {
		sink := newTerminalSink(&websocket.Conn{}, 0, time.Millisecond)
		assert.Equal(t, defaultTerminalSinkBufferFrames, cap(sink.out))

		tiny := newTerminalSink(&websocket.Conn{}, 1, time.Millisecond)
		assert.True(t, tiny.enqueue(sinkFrame{typ: websocket.MessageText, data: []byte("one")}))
		assert.False(t, tiny.enqueue(sinkFrame{typ: websocket.MessageText, data: []byte("two")}))
		tiny.stop()
		tiny.stop()
	})

	t.Run("add sink rejects dead session", func(t *testing.T) {
		sess := newTerminalSession("sess-dead", &terminalSessionManagerCovSSHClient{}, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, bytes.NewBuffer(nil), bytes.NewBuffer(nil), 1024, time.Millisecond, 0, nil)
		sess.markDead(errors.New("finished"))

		sink, err := sess.addSink(context.Background(), &websocket.Conn{}, nil)

		require.Nil(t, sink)
		require.EqualError(t, err, "finished")
	})

	t.Run("remove sink starts idle timer and detach is idempotent", func(t *testing.T) {
		sess := newTerminalSession("sess-idle", &terminalSessionManagerCovSSHClient{}, terminalSessionManagerCovNewSSHSession(), &terminalSessionManagerCovWriteCloser{}, bytes.NewBuffer(nil), bytes.NewBuffer(nil), 1024, time.Hour, 0, nil)
		sink := newTerminalSink(&websocket.Conn{}, 1, time.Millisecond)
		sess.sinks[sink] = struct{}{}

		sess.removeSink(sink)
		sess.removeSink(sink)

		assert.NotContains(t, sess.sinks, sink)
		assert.NotNil(t, sess.idle)
		sess.destroy("cleanup")
	})
}

type terminalSessionManagerCovWriteCloser struct {
	bytes.Buffer
	err    error
	closed bool
}

func (w *terminalSessionManagerCovWriteCloser) Write(p []byte) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	return w.Buffer.Write(p)
}

func (w *terminalSessionManagerCovWriteCloser) Close() error {
	w.closed = true
	return nil
}

type terminalSessionManagerCovSSHClient struct {
	closed    bool
	sendErr   error
	closeDone chan struct{}
}

func (c *terminalSessionManagerCovSSHClient) NewSession() (*gossh.Session, error) { return nil, nil }
func (c *terminalSessionManagerCovSSHClient) SendRequest(name string, wantReply bool, payload []byte) (bool, []byte, error) {
	return c.sendErr == nil, nil, c.sendErr
}
func (c *terminalSessionManagerCovSSHClient) Close() error {
	c.closed = true
	if c.closeDone != nil {
		close(c.closeDone)
	}
	return nil
}

type terminalSessionManagerCovSSHSession struct {
	stdin      *terminalSessionManagerCovWriteCloser
	stdout     io.Reader
	stderr     io.Reader
	stdinErr   error
	stdoutErr  error
	stderrErr  error
	ptyErr     error
	shellErr   error
	startErr   error
	windowErr  error
	waitErr    error
	closed     bool
	windowRows int
	windowCols int
	startedCmd string
}

func terminalSessionManagerCovNewSSHSession() *terminalSessionManagerCovSSHSession {
	return &terminalSessionManagerCovSSHSession{
		stdin:  &terminalSessionManagerCovWriteCloser{},
		stdout: bytes.NewBuffer(nil),
		stderr: bytes.NewBuffer(nil),
	}
}

func (s *terminalSessionManagerCovSSHSession) StdinPipe() (io.WriteCloser, error) {
	return s.stdin, s.stdinErr
}

func (s *terminalSessionManagerCovSSHSession) StdoutPipe() (io.Reader, error) {
	return s.stdout, s.stdoutErr
}

func (s *terminalSessionManagerCovSSHSession) StderrPipe() (io.Reader, error) {
	return s.stderr, s.stderrErr
}

func (s *terminalSessionManagerCovSSHSession) RequestPty(term string, h, w int, modes gossh.TerminalModes) error {
	return s.ptyErr
}

func (s *terminalSessionManagerCovSSHSession) Shell() error {
	return s.shellErr
}

func (s *terminalSessionManagerCovSSHSession) Start(cmd string) error {
	s.startedCmd = cmd
	return s.startErr
}

func (s *terminalSessionManagerCovSSHSession) WindowChange(h, w int) error {
	s.windowRows = h
	s.windowCols = w
	return s.windowErr
}

func (s *terminalSessionManagerCovSSHSession) Wait() error { return s.waitErr }

func (s *terminalSessionManagerCovSSHSession) Close() error {
	s.closed = true
	return nil
}
