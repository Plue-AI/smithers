package compose

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The composed install owns binding lookup and stop/capture ordering. Only the
// daemon's physical stop receipt and aggregate kernel population are modeled.
type retireFenceRuntime struct {
	*sleepCountRuntime
	alive, confirm, unknown atomic.Bool
	fences                  atomic.Int32
	admission               *microsandbox.Runtime
}

func (r *retireFenceRuntime) StopWorkspace(ctx context.Context, id string) error {
	if err := r.sleepCountRuntime.StopWorkspace(ctx, id); err != nil {
		return err
	}
	if r.stopped.Load() {
		r.admission.ConfirmAdmissionStop(id, false)
	}
	return nil
}

func retireFenceAdmission(t *testing.T) (*microsandbox.Runtime, microsandbox.AdmissionProviders) {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "msb")
	// Only startup inventory is modeled; admission and its capacity accounting
	// use the production runtime. No guest is launched by this adapter.
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\necho '[]'\n"), 0700))
	profile := &microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 10, DiskFreeBytes: 200 << 30}
	r, err := microsandbox.New(t.Context(), microsandbox.Config{Binary: binary, Root: t.TempDir(), CPUs: 2, MemoryMiB: 6144, DiskMiB: 32768, MaxRunningVMs: 1, HostProfile: profile, SkipQualification: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, r.Close()) })
	r.SetCapacityReader(func(context.Context) (int, error) { return 1, nil })
	return r, microsandbox.AdmissionProviders{Ready: func(context.Context, microsandbox.AdmissionRequest) error { return nil }, FreeDisk: func(context.Context) (int64, error) { return 200 << 30, nil }}
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
