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

func TestMaintenanceHealthWakeUsesIsolatedGrantAndConfirmedStop(t *testing.T) {
	r, ws, log := startupRecoveryTransport(t, "recover-files")
	require.NoError(t, r.DrainMachineAdmission(t.Context()))
	providers := AdmissionProviders{Ready: func(context.Context, AdmissionRequest) error { return nil }, FreeDisk: func(context.Context) (int64, error) { return 140 << 30, nil }}
	err := r.MaintenanceHealthWake(t.Context(), ws.ID, "owner-upgrade", providers)
	require.ErrorContains(t, err, "injected recover-files failure")
	require.Equal(t, []string{"list", "install", "kill-all", "recover-files", "stop", "list"}, invocations(t, log))
	require.Zero(t, r.InUse(), "release follows an independent stop observation")
	require.False(t, r.AdmissionHeld("workspace:"+ws.ID))
	_, err = r.Request("person", "workspace:other", "member", "terminal")
	require.ErrorIs(t, err, ErrAdmissionFrozen, "a health failure never reopens normal admission")
	require.Len(t, r.AdmissionSnapshot(), 1)
	require.Equal(t, "released", r.AdmissionSnapshot()[0].State)
}

func TestMaintenanceHealthWakeRefusesMissingAuthorityOrHeldSlots(t *testing.T) {
	for _, kind := range []string{"unfrozen", "ready", "disk", "capacity", "held", "reclaimed", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			r, ws, log := startupRecoveryTransport(t, "recover-files")
			p := AdmissionProviders{Ready: func(context.Context, AdmissionRequest) error { return nil }, FreeDisk: func(context.Context) (int64, error) { return 140 << 30, nil }}
			require.NoError(t, r.DrainMachineAdmission(t.Context()))
			ctx := t.Context()
			switch kind {
			case "unfrozen":
				require.NoError(t, r.ResumeMachineAdmission(ctx))
			case "ready":
				p.Ready = nil
			case "disk":
				p.FreeDisk = func(context.Context) (int64, error) { return 40 << 30, nil }
			case "capacity":
				r.SetCapacityReader(func(context.Context) (int, error) { return 0, nil })
			case "held":
				r.auxVMs = map[string]struct{}{"prepare": {}}
			case "reclaimed":
				ws.Reclaimed = true
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			require.Error(t, r.MaintenanceHealthWake(ctx, ws.ID, "upgrade", p))
			require.Empty(t, invocations(t, log), "refusal precedes the VM boundary")
		})
	}
}

func TestMaintenanceHealthWakeUnconfirmedStopRetainsSlot(t *testing.T) {
	r, ws, _ := startupRecoveryTransport(t, "stop")
	require.NoError(t, r.DrainMachineAdmission(t.Context()))
	p := AdmissionProviders{Ready: func(context.Context, AdmissionRequest) error { return nil }, FreeDisk: func(context.Context) (int64, error) { return 140 << 30, nil }}
	require.Error(t, r.MaintenanceHealthWake(t.Context(), ws.ID, "upgrade", p))
	require.Equal(t, 1, r.InUse())
	require.True(t, r.AdmissionHeld("workspace:"+ws.ID))
	require.Error(t, r.MaintenanceHealthWake(t.Context(), ws.ID, "upgrade", p), "no second isolated grant before confirmed stop")
	_, err := r.Request("person", "workspace:other", "member", "terminal")
	require.ErrorIs(t, err, ErrAdmissionFrozen)
}
