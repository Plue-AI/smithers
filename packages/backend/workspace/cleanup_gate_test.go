package workspace

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCleanupGatePermitExpiresAndJoinsAdmittedWriters(t *testing.T) {
	var gate CleanupGate
	ctx := t.Context()
	var retained context.Context
	require.NoError(t, gate.Exclude(ctx, "one", func(ctx context.Context) error { retained = ctx; return nil }))
	require.NoError(t, gate.Exclude(ctx, "one", func(context.Context) error {
		_, _, err := gate.Enter(retained, " one ")
		require.ErrorIs(t, err, ErrCleanupBusy)
		return nil
	}))
	entered, returned, finish := make(chan struct{}), make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- gate.Exclude(ctx, "one", func(ctx context.Context) error {
			go func() {
				_, release, err := gate.Enter(ctx, "one")
				if err != nil {
					done <- err
					return
				}
				close(entered)
				<-finish
				release()
			}()
			<-entered
			close(returned)
			return nil
		})
	}()
	<-returned
	_, _, err := gate.Enter(ctx, "one")
	require.ErrorIs(t, err, ErrCleanupBusy, "a detached admitted writer still owns exclusion")
	close(finish)
	require.NoError(t, <-done)
	_, release, err := gate.Enter(ctx, "one")
	require.NoError(t, err)
	release()
}
