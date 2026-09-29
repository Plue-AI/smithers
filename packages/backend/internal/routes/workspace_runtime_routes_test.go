package routes

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type countingRuntimeTerminal struct{ closes atomic.Int32 }

func (*countingRuntimeTerminal) Read([]byte) (int, error)        { return 0, io.EOF }
func (*countingRuntimeTerminal) Write(value []byte) (int, error) { return len(value), nil }
func (t *countingRuntimeTerminal) Close() error {
	t.closes.Add(1)
	return nil
}
func (*countingRuntimeTerminal) Resize(context.Context, uint16, uint16) error { return nil }

func TestRuntimeTerminalBackendClosesSharedTerminalOnce(t *testing.T) {
	terminal := &countingRuntimeTerminal{}
	client, session, err := newRuntimeTerminalBackend(terminal, func() {})
	require.NoError(t, err)
	require.NoError(t, session.Close())
	require.NoError(t, client.Close())
	require.EqualValues(t, 1, terminal.closes.Load())
}

type revocationRuntimeService struct {
	*mockWorkspaceTerminalService
	open func(context.Context) (workspaceapi.Terminal, error)
}

func (*revocationRuntimeService) WorkspaceRuntimeTerminalAvailable() bool { return true }
func (s *revocationRuntimeService) OpenWorkspaceTerminal(ctx context.Context, _ string, _, _ int64, _, _ uint16) (workspaceapi.Terminal, error) {
	return s.open(ctx)
}

type heldRuntimeTerminal struct {
	closed chan struct{}
	once   sync.Once
}

func (t *heldRuntimeTerminal) Read([]byte) (int, error) {
	<-t.closed
	return 0, io.EOF
}
func (*heldRuntimeTerminal) Write(value []byte) (int, error) { return len(value), nil }
func (t *heldRuntimeTerminal) Close() error {
	t.once.Do(func() { close(t.closed) })
	return nil
}
func (*heldRuntimeTerminal) Resize(context.Context, uint16, uint16) error { return nil }

func TestRuntimeTerminalOpenCancellationAndLiveLifetime(t *testing.T) {
	info := services.WorkspaceSSHConnectionInfo{RuntimeTerminal: true, Kind: "container", SessionID: "s1", RepositoryID: 1, RequesterUserID: 7}
	t.Run("canceled opening", func(t *testing.T) {
		entered := make(chan context.Context, 1)
		service := &revocationRuntimeService{mockWorkspaceTerminalService: &mockWorkspaceTerminalService{}}
		service.open = func(ctx context.Context) (workspaceapi.Terminal, error) {
			entered <- ctx
			<-ctx.Done()
			return nil, ctx.Err()
		}
		manager := (&WorkspaceTerminalHandler{Service: service}).terminalSessionManager()
		defer manager.Close()
		ctx, cancel := context.WithCancel(context.Background())
		result := make(chan error, 1)
		go func() {
			_, _, err := manager.getOrCreate(ctx, "s1", info, 80, 24, revocation.Principal{TokenHash: "token"})
			result <- err
		}()
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("runtime opening did not begin")
		}
		cancel()
		select {
		case err := <-result:
			require.True(t, errors.Is(err, context.Canceled), "runtime opening must stop on revocation: %v", err)
		case <-time.After(2 * time.Second):
			t.Fatal("runtime opening continued after cancellation")
		}
	})
	t.Run("nil terminal releases lifetime", func(t *testing.T) {
		var terminalCtx context.Context
		service := &revocationRuntimeService{mockWorkspaceTerminalService: &mockWorkspaceTerminalService{}}
		service.open = func(ctx context.Context) (workspaceapi.Terminal, error) {
			terminalCtx = ctx
			return nil, nil
		}
		manager := (&WorkspaceTerminalHandler{Service: service}).terminalSessionManager()
		defer manager.Close()
		_, _, err := manager.getOrCreate(context.Background(), "s1", info, 80, 24, revocation.Principal{TokenHash: "token"})
		require.ErrorContains(t, err, "nil terminal")
		require.NotNil(t, terminalCtx)
		select {
		case <-terminalCtx.Done():
		default:
			t.Fatal("nil terminal leaked its lifetime context")
		}
	})
	t.Run("live terminal outlives request", func(t *testing.T) {
		terminal := &heldRuntimeTerminal{closed: make(chan struct{})}
		var terminalCtx context.Context
		service := &revocationRuntimeService{mockWorkspaceTerminalService: &mockWorkspaceTerminalService{}}
		service.open = func(ctx context.Context) (workspaceapi.Terminal, error) {
			terminalCtx = ctx
			return terminal, nil
		}
		manager := (&WorkspaceTerminalHandler{Service: service}).terminalSessionManager()
		manager.keepaliveInterval = 0
		defer manager.Close()
		ctx, cancel := context.WithCancel(context.Background())
		sess, created, err := manager.getOrCreate(ctx, "s1", info, 80, 24, revocation.Principal{TokenHash: "token"})
		require.NoError(t, err)
		require.True(t, created)
		require.NotNil(t, sess)
		cancel()
		select {
		case <-terminalCtx.Done():
			t.Fatal("request completion canceled a durable runtime terminal")
		default:
		}
		require.False(t, sess.isDead())
		manager.Close()
		select {
		case <-terminalCtx.Done():
		case <-time.After(2 * time.Second):
			t.Fatal("manager close did not cancel the runtime terminal lifetime")
		}
		select {
		case <-terminal.closed:
		case <-time.After(2 * time.Second):
			t.Fatal("manager close did not close the runtime terminal")
		}
	})
}
