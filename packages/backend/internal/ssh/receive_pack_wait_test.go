package ssh

import (
	"context"
	stdErrors "errors"
	"io"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// runPush runs one SSH receive-pack whose repo-host call is push, on a
// session whose connection ends when closeConn is called. It returns when
// the handler does.
func runPush(t *testing.T, push func(ctx context.Context, meta repohost.ReceivePackMetadata) error) (closeConn func(), done <-chan struct{}) {
	t.Helper()
	connCtx, closeConnection := context.WithCancel(context.Background())
	server := &Server{
		Authorizer: &mockSSHAuthorizer{authorizeFn: func(context.Context, int64, string, string, services.AccessMode) error { return nil }},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(context.Context, string, string) ([]byte, error) { return []byte("0000"), nil },
			proxyReceivePackFn: func(ctx context.Context, _, _ string, stdin io.Reader, _ io.Writer, meta ...repohost.ReceivePackMetadata) error {
				_, _ = io.Copy(io.Discard, stdin)
				return push(ctx, meta[0])
			},
		},
	}
	sess := newTestSession("git-receive-pack 'alice/demo.git'", "0000receive-pack-request")
	sess.ctx = newTestSSHContextWithContext(connCtx)
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})
	finished := make(chan struct{})
	go func() {
		server.sessionHandler(sess)
		close(finished)
	}()
	return closeConnection, finished
}

// A push still waiting for its repository stops waiting when the client's
// connection goes away.
func TestSSHReceivePackWaitEndsWithTheConnection(t *testing.T) {
	waiting := make(chan struct{})
	closeConn, done := runPush(t, func(ctx context.Context, _ repohost.ReceivePackMetadata) error {
		close(waiting)
		<-ctx.Done()
		return ctx.Err()
	})
	<-waiting
	closeConn()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the push kept waiting after its connection closed")
	}
}

// Once repo-host has started the push, it runs to its end whatever the
// connection does.
func TestSSHReceivePackStartedPushOutlivesTheConnection(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var pushErr error
	closeConn, done := runPush(t, func(ctx context.Context, _ repohost.ReceivePackMetadata) error {
		repohost.PushStarted(ctx)
		close(started)
		select {
		case <-ctx.Done():
			pushErr = ctx.Err()
		case <-release:
		}
		return pushErr
	})
	<-started
	closeConn()
	select {
	case <-done:
		t.Fatal("a started push stopped with its connection")
	case <-time.After(300 * time.Millisecond):
	}
	close(release)
	<-done
	assert.False(t, stdErrors.Is(pushErr, context.Canceled))
	assert.NoError(t, pushErr)
}
