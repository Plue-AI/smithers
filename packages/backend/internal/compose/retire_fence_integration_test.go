package compose

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/smithersai/smithers/packages/backend/workspace"
)

// The composed install owns binding lookup and stop/capture ordering. Only the
// daemon's physical stop receipt and aggregate kernel population are modeled.
type retireFenceRuntime struct {
	*sleepCountRuntime
	alive, confirm, unknown atomic.Bool
	fences                  atomic.Int32
}

func (r *retireFenceRuntime) StopService(_ context.Context, _, name string) error {
	if name != "retire-host" {
		return nil // the test has no head publisher
	}
	if !r.confirm.Load() {
		return workspace.ErrCommandTerminationUnconfirmed
	}
	r.alive.Store(false)
	return nil
}

func (r *retireFenceRuntime) WithCaptureWritersExcluded(ctx context.Context, _ string, visit func(context.Context) error) error {
	r.fences.Add(1)
	if r.alive.Load() || r.unknown.Load() {
		return workspace.ErrCaptureWritersActive
	}
	return visit(ctx)
}

func TestRetireFenceOwnedHostAndUnknownTerminalInstallHTTP(t *testing.T) {
	branchSleepInstall(t, "writer_fence")
}
