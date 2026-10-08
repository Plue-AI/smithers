package microsandbox

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestMaintenanceAdmissionFencesGrantsAndReservedLaunches(t *testing.T) {
	r, p := admissionFixture()
	_, err := r.Request("person", "workspace:one", "member", "terminal")
	require.NoError(t, err)
	grant, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "workspace:one", grant.Holder)
	require.NoError(t, r.DrainMachineAdmission(t.Context()))
	require.ErrorIs(t, r.admitMachineLocked(WithAdmissionHolder(t.Context(), grant.Holder), 1, "machine"), ErrAdmissionFrozen)
	require.ErrorIs(t, r.admitMachineLocked(t.Context(), 1, "auxiliary"), ErrAdmissionFrozen)
	_, err = r.Request("person", "workspace:two", "other", "terminal")
	require.ErrorIs(t, err, ErrAdmissionFrozen)
	_, err = r.GrantNext(t.Context(), p)
	require.ErrorIs(t, err, ErrAdmissionFrozen)
	_, err = r.WaitAdmission(t.Context(), p, "person", grant.Holder, "member", "terminal")
	require.ErrorIs(t, err, ErrAdmissionFrozen)
	require.True(t, r.AdmissionHeld(grant.Holder), "freeze cannot claim a stop")
	require.NoError(t, r.ResumeMachineAdmission(t.Context()))
	require.True(t, r.admissionGranted(grant.Holder, "member"))
	require.NoError(t, r.admitMachineLocked(WithAdmissionHolder(t.Context(), grant.Holder), 1, "machine"))
}

func TestMaintenanceAdmissionWaitsForBootAndAuxiliaryRemoval(t *testing.T) {
	for _, kind := range []string{"boot", "auxiliary"} {
		t.Run(kind, func(t *testing.T) {
			r, _ := admissionFixture()
			if kind == "boot" {
				r.workspaces["one"] = &workspace{booting: true}
			} else {
				r.auxVMs = map[string]struct{}{"prepare": {}}
			}
			ctx, cancel := context.WithCancel(t.Context())
			cancel()
			require.ErrorIs(t, r.DrainMachineAdmission(ctx), context.Canceled)
			done := make(chan error, 1)
			go func() { done <- r.StopMachineAdmission(t.Context()) }()
			select {
			case err := <-done:
				t.Fatalf("drain completed without a boundary: %v", err)
			case <-time.After(30 * time.Millisecond):
			}
			r.mu.Lock()
			if kind == "boot" {
				r.workspaces["one"].booting = false
			} else {
				delete(r.auxVMs, "prepare")
			}
			r.mu.Unlock()
			require.NoError(t, <-done)
			require.ErrorIs(t, r.ResumeMachineAdmission(ctx), context.Canceled)
			require.NoError(t, r.ResumeMachineAdmission(t.Context()))
		})
	}
}

func TestMaintenanceAdmissionFencesReadinessRace(t *testing.T) {
	r, p := admissionFixture()
	_, err := r.Request("person", "workspace:one", "member", "terminal")
	require.NoError(t, err)
	p.Ready = func(ctx context.Context, _ AdmissionRequest) error { return r.DrainMachineAdmission(ctx) }
	_, err = r.GrantNext(t.Context(), p)
	require.ErrorIs(t, err, ErrAdmissionFrozen)
	require.False(t, r.AdmissionHeld("workspace:one"))
}
