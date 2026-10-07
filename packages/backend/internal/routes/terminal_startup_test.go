package routes

import (
	"context"
	"errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
	"sync/atomic"
	"testing"
	"time"
)

func TestTerminalStartupSingleOwnerAndCanceledWaiter(t *testing.T) {
	fake := newFakeTerminalSSH()
	var calls atomic.Int32
	entered := make(chan struct{})
	release := make(chan struct{})
	manager := NewTerminalSessionManager(func(ctx context.Context, _ services.WorkspaceSSHConnectionInfo, _, _ int32) (terminalSSHClient, terminalSSHSession, error) {
		calls.Add(1)
		close(entered)
		select {
		case <-release:
			return fake.client, fake.session, nil
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		}
	})
	manager.keepaliveInterval = 0
	defer manager.Close()
	result := make(chan *terminalSession, 1)
	go func() {
		session, _, err := manager.getOrCreate(t.Context(), "owned", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{UserID: 7})
		if err != nil {
			result <- nil
			return
		}
		result <- session
	}()
	<-entered
	_, err := manager.getExisting("owned")
	require.Error(t, err, "watchers must not create an owner process")
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	_, _, err = manager.getOrCreate(ctx, "owned", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{UserID: 7})
	require.True(t, errors.Is(err, context.DeadlineExceeded))
	other := make(chan *terminalSession, 1)
	go func() {
		session, _, _ := manager.getOrCreate(t.Context(), "owned", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{UserID: 7})
		other <- session
	}()
	close(release)
	owner := <-result
	require.NotNil(t, owner)
	require.Same(t, owner, <-other)
	require.EqualValues(t, 1, calls.Load())
	existing, err := manager.getExisting("owned")
	require.NoError(t, err)
	require.Same(t, owner, existing)
	require.EqualValues(t, 7, manager.Presence("owned").Owner)
	manager.Close()
	require.Zero(t, manager.Presence("owned").Owner)
}
