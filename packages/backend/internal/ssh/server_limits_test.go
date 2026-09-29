package ssh

// Tests for the SSH DoS-hardening limits: connection idle/lifetime deadlines
// (plue#107/#109), per-connection session caps (plue#108), the receive-pack
// drain path for stalled clients (plue#98), and the detached push audit
// context (plue#118).

import (
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestIdleTimeout_DerivedFromPackTimeouts(t *testing.T) {
	t.Parallel()

	defaults := &Server{}
	assert.Equal(t, repohost.DefaultReceivePackMaxDuration+idleTimeoutSlack, defaults.idleTimeout(),
		"unset idle timeout should derive from the pack timeouts plus slack")

	longerUpload := &Server{UploadPackTimeout: 30 * time.Minute}
	assert.Equal(t, 30*time.Minute+idleTimeoutSlack, longerUpload.idleTimeout(),
		"idle timeout should follow the largest pack timeout")

	explicit := &Server{IdleTimeout: 3 * time.Minute}
	assert.Equal(t, 3*time.Minute, explicit.idleTimeout())
}

func TestMaxConnTimeout_DefaultAndIdleFloor(t *testing.T) {
	t.Parallel()

	defaults := &Server{}
	assert.Equal(t, defaultMaxConnTimeout, defaults.maxConnTimeout())

	explicit := &Server{MaxTimeout: 4 * time.Hour}
	assert.Equal(t, 4*time.Hour, explicit.maxConnTimeout())

	belowIdle := &Server{MaxTimeout: time.Minute, IdleTimeout: 5 * time.Minute}
	assert.Equal(t, 5*time.Minute, belowIdle.maxConnTimeout(),
		"lifetime cap must never undercut the idle deadline")
}

func TestSessionSlots_PerConnectionCapAndRelease(t *testing.T) {
	t.Parallel()

	srv := &Server{MaxSessionsPerConn: 2}

	require.True(t, srv.acquireSessionSlot("conn-a"))
	require.True(t, srv.acquireSessionSlot("conn-a"))
	assert.False(t, srv.acquireSessionSlot("conn-a"), "third session on one connection must be rejected")
	assert.True(t, srv.acquireSessionSlot("conn-b"), "other connections keep their own budget")

	srv.releaseSessionSlot("conn-a")
	assert.True(t, srv.acquireSessionSlot("conn-a"), "released slot becomes available again")

	srv.releaseSessionSlot("conn-b")
	srv.connMu.Lock()
	_, tracked := srv.activeSessionsPerConn["conn-b"]
	srv.connMu.Unlock()
	assert.False(t, tracked, "fully released connections must not leak map entries")
}

func TestSessionHandler_RejectsSessionsOverPerConnCap(t *testing.T) {
	t.Parallel()

	uploadCalls := 0
	srv := &Server{
		MaxSessionsPerConn: 1,
		Authorizer:         &mockSSHAuthorizer{},
		RepoHostClient: &mockRepoHostGitProxy{
			proxyUploadPackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer) error {
				uploadCalls++
				return nil
			},
		},
	}

	sess := newTestSession("git-upload-pack 'alice/repo.git'", "")
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})

	// Occupy the single slot for this connection (testSSHContext.SessionID()
	// is "session" for every testSession).
	require.True(t, srv.acquireSessionSlot(sess.Context().SessionID()))

	srv.sessionHandler(sess)

	assert.Equal(t, 0, uploadCalls, "capped session must not reach the git proxy")
	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "too many concurrent sessions")

	// The rejected session must not release the slot it never acquired.
	assert.False(t, srv.acquireSessionSlot(sess.Context().SessionID()))
}

// stallingReader serves a fixed prefix, then blocks until unblock is closed —
// modeling a git client that sends the start of a receive-pack request and
// then goes silent while keeping the channel open.
type stallingReader struct {
	prefix  io.Reader
	unblock <-chan struct{}
}

func (r *stallingReader) Read(p []byte) (int, error) {
	if r.prefix != nil {
		n, err := r.prefix.Read(p)
		if n > 0 {
			return n, nil
		}
		if err != io.EOF {
			return n, err
		}
		r.prefix = nil
	}
	<-r.unblock
	return 0, io.ErrUnexpectedEOF
}

// closableSession is a testSession whose Close unblocks its stalled reader,
// mirroring how closing a real SSH channel unblocks pending reads.
type closableSession struct {
	*testSession
	closeOnce sync.Once
	closed    chan struct{}
}

func (s *closableSession) Close() error {
	s.closeOnce.Do(func() { close(s.closed) })
	return nil
}

func newStalledReceivePackSession(rawCommand, prefix string) *closableSession {
	closed := make(chan struct{})
	return &closableSession{
		testSession: newTestSessionWithReader(rawCommand, &stallingReader{
			prefix:  strings.NewReader(prefix),
			unblock: closed,
		}),
		closed: closed,
	}
}

func TestProxyReceivePack_StalledClientAfterProxyReturns_DoesNotHang(t *testing.T) {
	t.Parallel()

	proxyErr := assert.AnError
	srv := &Server{
		drainTimeout: 20 * time.Millisecond,
		Queries: &mockSSHPrincipalQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 109}, nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			// Consume everything the client sent so far, then fail: the
			// client-copy goroutine has flushed its buffered bytes into the
			// pipe and is now blocked reading from the stalled client, where
			// closing the pipe cannot unblock it.
			proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
				buf := make([]byte, 4)
				_, err := io.ReadFull(stdin, buf)
				require.NoError(t, err, "flush pkt should be replayed into the proxy body")
				return proxyErr
			},
		},
	}

	// A flush-only command list followed by a stalled read: Peek(1) succeeds,
	// no ref-update commands, then the copy goroutine blocks on the client.
	sess := newStalledReceivePackSession("git-receive-pack 'alice/repo.git'", "0000")

	done := make(chan error, 1)
	go func() {
		done <- srv.proxyReceivePack(context.Background(), sess, "alice", "repo", sshPrincipal{UserID: 1, Username: "alice"})
	}()

	select {
	case err := <-done:
		assert.ErrorIs(t, err, proxyErr)
	case <-time.After(5 * time.Second):
		t.Fatal("proxyReceivePack hung on a stalled client after the proxy call returned")
	}

	select {
	case <-sess.closed:
	default:
		t.Fatal("stalled session should have been closed to unblock the client read")
	}
}

func TestSessionHandler_SuccessAuditSurvivesCanceledSessionContext(t *testing.T) {
	t.Parallel()

	// The session context is already canceled, as happens when the client
	// disconnects immediately after a successful push.
	canceledCtx, cancel := context.WithCancel(context.Background())
	cancel()

	audit := &mockSSHAuditQuerier{
		insertAuditLogFn: func(ctx context.Context, arg db.InsertAuditLogParams) error {
			assert.NoError(t, ctx.Err(), "audit write must use a detached, non-canceled context")
			return ctx.Err()
		},
	}

	srv := &Server{
		Authorizer:     &mockSSHAuthorizer{},
		RepoHostClient: &mockRepoHostGitProxy{},
		AuditService:   services.NewAuditService(audit),
	}

	sess := newTestSession("git-upload-pack 'alice/repo.git'", "")
	sess.ctx = newTestSSHContextWithContext(canceledCtx)
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})

	srv.sessionHandler(sess)

	require.Equal(t, 1, audit.insertCalls, "successful fetch must be audited even after session cancel")
	assert.Equal(t, "ssh.fetch", audit.lastInsertArg.EventType)
	assert.Equal(t, "success", audit.lastInsertArg.Action)
	assert.Equal(t, 0, sess.exitCode)
}
