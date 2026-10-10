package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type hoursCapPolicy struct {
	BillingPolicy
	entitlements map[int64]SandboxEntitlement
	errors       map[int64]error
	reads        map[int64]int
}

func (p *hoursCapPolicy) SandboxEntitlement(_ context.Context, owner int64) (SandboxEntitlement, error) {
	p.reads[owner]++
	return p.entitlements[owner], p.errors[owner]
}

// sleepRefusal is how a pass reports a selected workspace since c240bd3cf7
// (#3568): sleep needs a verified final capture, which a hosted sandbox lacks,
// so the workspace keeps running and the next pass tries again.
func sleepRefusal(id string) string {
	return "suspend over-quota workspace " + id + ": branch sleep requires verified capture, runtime binding and state publication"
}

// A pass selects every owner at or past the daily cap, reads each owner's
// entitlement once, and leaves an owner it cannot read running. Since
// c240bd3cf7 (#3568) a hosted sandbox cannot be put to sleep, so each
// selected workspace is refused and keeps its VM, status and open interval.
func TestWorkspaceService_CleanupOverQuotaWorkspaces(t *testing.T) {
	workspace := func(id string, owner int64) db.Workspace {
		ws := sampleDBWorkspace(id)
		ws.UserID = owner
		ws.VmID = "vm-" + id
		// These workspaces are active and cannot be selected by the idle sweep.
		return ws
	}
	rows := []db.Workspace{
		workspace("at-cap-a", 1), workspace("at-cap-b", 1),
		workspace("below-cap", 2), workspace("unlimited", 3),
		workspace("bad-entitlement", 4), workspace("other-owner", 5),
		workspace("zero-allowance", 6), workspace("negative-meter", 7),
	}
	policy := &hoursCapPolicy{
		entitlements: map[int64]SandboxEntitlement{
			1: {HoursPerDay: 4, SecondsUsedToday: 4 * 3600},
			2: {HoursPerDay: 4, SecondsUsedToday: 4*3600 - 1},
			3: {HoursPerDay: -1, SecondsUsedToday: 100 * 3600},
			5: {HoursPerDay: 4, SecondsUsedToday: 5 * 3600},
			6: {HoursPerDay: 0, SecondsUsedToday: 0},
			7: {HoursPerDay: 0, SecondsUsedToday: -1},
		},
		errors: map[int64]error{4: errors.New("meter unavailable")},
		reads:  map[int64]int{},
	}
	var suspended []string
	var statuses []string
	q := &mockWorkspaceQuerier{
		listRunningWorkspacesFn: func(context.Context) ([]db.Workspace, error) { return rows, nil },
		suspendRunningWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			statuses = append(statuses, id)
			ws := workspace(id, 1)
			ws.Status = "suspended"
			return ws, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceBillingPolicy(policy), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		suspendVMFn: func(_ context.Context, id string) (sandbox.SuspendResult, error) {
			suspended = append(suspended, id)
			return sandbox.SuspendResult{}, nil
		},
	}))
	err := svc.CleanupOverQuotaWorkspaces(context.Background())
	require.ErrorContains(t, err, "meter unavailable")
	for _, id := range []string{"at-cap-a", "at-cap-b", "other-owner", "zero-allowance"} {
		assert.ErrorContains(t, err, sleepRefusal(id))
	}
	for _, id := range []string{"below-cap", "unlimited", "bad-entitlement", "negative-meter"} {
		assert.NotContains(t, err.Error(), "suspend over-quota workspace "+id+":")
	}
	assert.Empty(t, suspended, "no VM is stopped without a verified capture")
	assert.Empty(t, statuses)
	assert.Equal(t, map[int64]int{1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1}, policy.reads)
	assert.Empty(t, q.closes)
}

func TestWorkspaceService_CleanupOverQuotaWorkspacesListFailureAndNoBilling(t *testing.T) {
	listCalls := 0
	q := &mockWorkspaceQuerier{listRunningWorkspacesFn: func(context.Context) ([]db.Workspace, error) {
		listCalls++
		return nil, errors.New("listing unavailable")
	}}
	withoutBilling := newWorkspaceServiceForTests(q)
	require.NoError(t, withoutBilling.CleanupOverQuotaWorkspaces(context.Background()))
	assert.Zero(t, listCalls)

	withBilling := newWorkspaceServiceForTests(q, WithWorkspaceBillingPolicy(&hoursCapPolicy{reads: map[int64]int{}}))
	require.ErrorContains(t, withBilling.CleanupOverQuotaWorkspaces(context.Background()), "listing unavailable")
	assert.Equal(t, 1, listCalls)
}

// A refused sleep leaves the workspace running and is retried on the next
// pass with a fresh entitlement read.
func TestWorkspaceService_CleanupOverQuotaWorkspacesRetriesRefusedSleep(t *testing.T) {
	ws := sampleDBWorkspace("retry")
	policy := &hoursCapPolicy{
		entitlements: map[int64]SandboxEntitlement{ws.UserID: {HoursPerDay: 4, SecondsUsedToday: 14400}},
		reads:        map[int64]int{},
	}
	var attempts, statusWrites int
	q := &mockWorkspaceQuerier{
		listRunningWorkspacesFn: func(context.Context) ([]db.Workspace, error) { return []db.Workspace{ws}, nil },
		suspendRunningWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			statusWrites++
			out := ws
			out.Status = "suspended"
			return out, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceBillingPolicy(policy), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		suspendVMFn: func(context.Context, string) (sandbox.SuspendResult, error) {
			attempts++
			return sandbox.SuspendResult{}, nil
		},
	}))
	for pass := 1; pass <= 2; pass++ {
		require.ErrorContains(t, svc.CleanupOverQuotaWorkspaces(context.Background()), sleepRefusal(ws.ID))
		assert.Equal(t, pass, policy.reads[ws.UserID], "the entitlement must be refreshed on retry")
	}
	assert.Zero(t, attempts)
	assert.Zero(t, statusWrites)
	assert.Empty(t, q.closes)
}

func TestWorkspaceService_CleanupOverQuotaWorkspacesRetriesEntitlementRead(t *testing.T) {
	ws := sampleDBWorkspace("retry-meter")
	policy := &hoursCapPolicy{
		entitlements: map[int64]SandboxEntitlement{ws.UserID: {HoursPerDay: 4, SecondsUsedToday: 14400}},
		errors:       map[int64]error{ws.UserID: errors.New("meter unavailable")},
		reads:        map[int64]int{},
	}
	suspends := 0
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listRunningWorkspacesFn: func(context.Context) ([]db.Workspace, error) { return []db.Workspace{ws}, nil },
	}, WithWorkspaceBillingPolicy(policy), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		suspendVMFn: func(context.Context, string) (sandbox.SuspendResult, error) {
			suspends++
			return sandbox.SuspendResult{}, nil
		},
	}))
	err := svc.CleanupOverQuotaWorkspaces(context.Background())
	require.ErrorContains(t, err, "meter unavailable")
	assert.NotContains(t, err.Error(), "suspend over-quota workspace")
	delete(policy.errors, ws.UserID)
	// Once the meter reads, the pass selects the workspace; its sleep is
	// refused without a verified capture (c240bd3cf7, #3568).
	require.ErrorContains(t, svc.CleanupOverQuotaWorkspaces(context.Background()), sleepRefusal(ws.ID))
	assert.Equal(t, 2, policy.reads[ws.UserID])
	assert.Zero(t, suspends)
}

func TestWorkspaceService_CleanupOverQuotaWorkspacesCanceledBeforeEntitlement(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ws := sampleDBWorkspace("canceled")
	policy := &hoursCapPolicy{reads: map[int64]int{}}
	suspends := 0
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listRunningWorkspacesFn: func(context.Context) ([]db.Workspace, error) { return []db.Workspace{ws}, nil },
	}, WithWorkspaceBillingPolicy(policy), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		suspendVMFn: func(context.Context, string) (sandbox.SuspendResult, error) {
			suspends++
			return sandbox.SuspendResult{}, nil
		},
	}))
	require.ErrorIs(t, svc.CleanupOverQuotaWorkspaces(ctx), context.Canceled)
	assert.Empty(t, policy.reads)
	assert.Zero(t, suspends)
}

func TestWorkspaceService_CleanupOverQuotaWorkspacesReadsNewDayAllowance(t *testing.T) {
	ws := sampleDBWorkspace("daily-reset")
	ws.UserID = 7
	policy, billingQ := sandboxTestBilling(BillingPlanFree)
	now := time.Date(2026, 9, 15, 23, 59, 59, 0, time.UTC)
	policy.now = func() time.Time { return now }
	billingQ.countActiveSandboxesFn = func(context.Context, int64) (int, error) { return 0, nil }
	billingQ.countActiveAgentsFn = func(context.Context, int64) (int64, error) { return 0, nil }
	billingQ.sumSandboxSecondsFn = func(_ context.Context, owner int64, since time.Time) (int64, error) {
		assert.Equal(t, ws.UserID, owner)
		assert.Equal(t, now.Truncate(24*time.Hour), since)
		if now.Day() == 15 {
			return 14400, nil
		}
		return 0, nil
	}
	suspends := 0
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listRunningWorkspacesFn: func(context.Context) ([]db.Workspace, error) { return []db.Workspace{ws}, nil },
	}, WithWorkspaceBillingPolicy(policy), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		suspendVMFn: func(context.Context, string) (sandbox.SuspendResult, error) {
			suspends++
			return sandbox.SuspendResult{}, nil
		},
	}))
	// The spent allowance selects the workspace; its sleep is refused without a
	// verified capture (c240bd3cf7, #3568).
	require.ErrorContains(t, svc.CleanupOverQuotaWorkspaces(context.Background()), sleepRefusal(ws.ID))
	assert.Zero(t, suspends)
	var refusal *pkgerrors.APIError
	require.ErrorAs(t, policy.AuthorizeSandboxStart(context.Background(), ws.UserID), &refusal)
	assert.Equal(t, "sandbox_hours_per_day", refusal.LimitKind)
	require.NotNil(t, refusal.ResetAt)
	assert.Equal(t, time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC), refusal.ResetAt.UTC())

	// The midnight boundary resets the daily meter and permits a new start.
	now = now.Add(time.Second)
	require.NoError(t, svc.CleanupOverQuotaWorkspaces(context.Background()), "a new day selects nothing")
	assert.Zero(t, suspends)
	require.NoError(t, policy.AuthorizeSandboxStart(context.Background(), ws.UserID))
}
