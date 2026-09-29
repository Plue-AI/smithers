package services

import (
	"context"
	"encoding/json"
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
	audits := &hoursCapAuditLog{}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceBillingPolicy(policy), WithWorkspaceAuditService(NewAuditService(audits)), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		suspendVMFn: func(_ context.Context, id string) (sandbox.SuspendResult, error) {
			suspended = append(suspended, id)
			return sandbox.SuspendResult{}, nil
		},
	}))
	err := svc.CleanupOverQuotaWorkspaces(context.Background())
	require.ErrorContains(t, err, "meter unavailable")
	assert.ElementsMatch(t, []string{"vm-at-cap-a", "vm-at-cap-b", "vm-other-owner", "vm-zero-allowance"}, suspended)
	assert.ElementsMatch(t, []string{"at-cap-a", "at-cap-b", "other-owner", "zero-allowance"}, statuses)
	assert.Equal(t, map[int64]int{1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1}, policy.reads)
	assert.ElementsMatch(t, []string{"at-cap-a", "at-cap-b", "other-owner", "zero-allowance"}, audits.targets())
	for _, row := range audits.rows {
		assert.Equal(t, "workspace.suspend", row.EventType)
		assert.Equal(t, "sandbox_hours_per_day", row.Action)
		assert.Equal(t, "system", row.ActorName)
		assert.False(t, row.ActorID.Valid)
	}
	q.requireClose(t, "workspace", "at-cap-a")
	q.requireClose(t, "workspace", "at-cap-b")
	q.requireClose(t, "workspace", "other-owner")
	q.requireClose(t, "workspace", "zero-allowance")
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

func TestWorkspaceService_CleanupOverQuotaWorkspacesRetriesProviderFailure(t *testing.T) {
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
	audits := &hoursCapAuditLog{}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceBillingPolicy(policy), WithWorkspaceAuditService(NewAuditService(audits)), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		suspendVMFn: func(context.Context, string) (sandbox.SuspendResult, error) {
			attempts++
			if attempts == 1 {
				return sandbox.SuspendResult{}, errors.New("provider unavailable")
			}
			return sandbox.SuspendResult{}, nil
		},
	}))
	require.ErrorContains(t, svc.CleanupOverQuotaWorkspaces(context.Background()), "provider unavailable")
	assert.Zero(t, statusWrites)
	assert.Empty(t, q.closes)
	assert.Empty(t, audits.rows, "a failed suspend is not audited as a suspension")
	require.NoError(t, svc.CleanupOverQuotaWorkspaces(context.Background()))
	assert.Equal(t, []string{ws.ID}, audits.targets())
	assert.Equal(t, 2, attempts)
	assert.Equal(t, 2, policy.reads[ws.UserID], "the entitlement must be refreshed on retry")
	assert.Equal(t, 1, statusWrites)
	q.requireClose(t, "workspace", ws.ID)
}

func TestWorkspaceService_CleanupOverQuotaWorkspacesRetriesEntitlementRead(t *testing.T) {
	ws := sampleDBWorkspace("retry-meter")
	policy := &hoursCapPolicy{
		entitlements: map[int64]SandboxEntitlement{ws.UserID: {HoursPerDay: 4, SecondsUsedToday: 14400}},
		errors:       map[int64]error{ws.UserID: errors.New("meter unavailable")},
		reads:        map[int64]int{},
	}
	suspends := 0
	audits := &hoursCapAuditLog{}
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listRunningWorkspacesFn: func(context.Context) ([]db.Workspace, error) { return []db.Workspace{ws}, nil },
	}, WithWorkspaceBillingPolicy(policy), WithWorkspaceAuditService(NewAuditService(audits)), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		suspendVMFn: func(context.Context, string) (sandbox.SuspendResult, error) {
			suspends++
			return sandbox.SuspendResult{}, nil
		},
	}))
	require.ErrorContains(t, svc.CleanupOverQuotaWorkspaces(context.Background()), "meter unavailable")
	assert.Zero(t, suspends)
	assert.Empty(t, audits.rows)
	delete(policy.errors, ws.UserID)
	require.NoError(t, svc.CleanupOverQuotaWorkspaces(context.Background()))
	assert.Equal(t, 2, policy.reads[ws.UserID])
	assert.Equal(t, 1, suspends)
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
	require.NoError(t, svc.CleanupOverQuotaWorkspaces(context.Background()))
	assert.Equal(t, 1, suspends)
	var refusal *pkgerrors.APIError
	require.ErrorAs(t, policy.AuthorizeSandboxStart(context.Background(), ws.UserID), &refusal)
	assert.Equal(t, "sandbox_hours_per_day", refusal.LimitKind)
	require.NotNil(t, refusal.ResetAt)
	assert.Equal(t, time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC), refusal.ResetAt.UTC())

	// The midnight boundary resets the daily meter and permits a new start.
	now = now.Add(time.Second)
	require.NoError(t, svc.CleanupOverQuotaWorkspaces(context.Background()))
	assert.Equal(t, 1, suspends)
	require.NoError(t, policy.AuthorizeSandboxStart(context.Background(), ws.UserID))
}

type hoursCapAuditLog struct {
	rows []db.InsertAuditLogParams
}

func (l *hoursCapAuditLog) InsertAuditLog(_ context.Context, row db.InsertAuditLogParams) error {
	l.rows = append(l.rows, row)
	return nil
}

func (l *hoursCapAuditLog) targets() []string {
	out := make([]string, 0, len(l.rows))
	for _, row := range l.rows {
		out = append(out, row.TargetName)
	}
	return out
}

// A Free workspace swept at the cap is refused on resume with the same
// plan-limit error its audit event records, and resumes after UTC midnight.
func TestWorkspaceService_HoursCapSuspensionAuditsAndResumesNextDay(t *testing.T) {
	ws := sampleDBWorkspace("capped")
	ws.UserID = 7
	ws.VmID = "vm-capped"
	policy, billingQ := sandboxTestBilling(BillingPlanFree)
	now := time.Date(2026, 9, 15, 23, 0, 0, 0, time.UTC)
	policy.now = func() time.Time { return now }
	billingQ.countActiveSandboxesFn = func(context.Context, int64) (int, error) { return 0, nil }
	billingQ.countActiveAgentsFn = func(context.Context, int64) (int64, error) { return 0, nil }
	used := int64(3*3600 + 50*60)
	billingQ.sumSandboxSecondsFn = func(_ context.Context, _ int64, since time.Time) (int64, error) {
		if since.Day() == 15 {
			return used, nil
		}
		return 0, nil
	}
	current := ws
	vmState := sandbox.StateRunning
	q := &mockWorkspaceQuerier{
		listRunningWorkspacesFn: func(context.Context) ([]db.Workspace, error) {
			if current.Status != "running" {
				return nil, nil
			}
			return []db.Workspace{current}, nil
		},
		getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return current, nil },
		suspendRunningWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			current.Status = "suspended"
			return current, nil
		},
		resumeWorkspaceToRunningFn: func(context.Context, string) (db.Workspace, error) {
			current.Status = "running"
			return current, nil
		},
	}
	audits := &hoursCapAuditLog{}
	starts := 0
	svc := newWorkspaceServiceForTests(&countedResumeStore{mockWorkspaceQuerier: q, workspace: ws},
		WithWorkspaceBillingPolicy(policy),
		WithWorkspaceAuditService(NewAuditService(audits)),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{ID: ws.VmID, State: vmState}, nil
			},
			suspendVMFn: func(context.Context, string) (sandbox.SuspendResult, error) {
				vmState = sandbox.StateStopped
				return sandbox.SuspendResult{}, nil
			},
			startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
				starts++
				vmState = sandbox.StateRunning
				return sandbox.StartResult{}, nil
			},
		}))

	// 3h50m used: the sweep leaves the workspace running.
	require.NoError(t, svc.CleanupOverQuotaWorkspaces(context.Background()))
	assert.Equal(t, "running", current.Status)
	assert.Empty(t, audits.rows)

	// The first tick after 4h suspends it and audits the plan-limit error.
	used = 4 * 3600
	require.NoError(t, svc.CleanupOverQuotaWorkspaces(context.Background()))
	assert.Equal(t, "suspended", current.Status)
	require.Len(t, audits.rows, 1)
	row := audits.rows[0]
	assert.Equal(t, "workspace.suspend", row.EventType)
	assert.Equal(t, "sandbox_hours_per_day", row.Action)
	assert.Equal(t, "user", row.TargetType)
	assert.Equal(t, pgtypeInt8(7), row.TargetID)
	assert.Equal(t, ws.ID, row.TargetName)
	var metadata map[string]any
	require.NoError(t, json.Unmarshal(row.Metadata, &metadata))
	assert.Equal(t, "plan_limit_exceeded", metadata["code"])
	assert.Equal(t, "sandbox_hours_per_day", metadata["limit_kind"])
	assert.Equal(t, BillingPlanFree, metadata["plan_key"])
	assert.Equal(t, float64(4), metadata["limit"])
	assert.Equal(t, "2026-09-16T00:00:00Z", metadata["reset_at"])
	assert.Equal(t, float64(ws.RepositoryID), metadata["repository_id"])
	assert.Equal(t, ws.VmID, metadata["vm_id"])

	// A second tick finds nothing running and writes nothing.
	require.NoError(t, svc.CleanupOverQuotaWorkspaces(context.Background()))
	assert.Len(t, audits.rows, 1)

	// Resuming before reset_at returns the same plan-limit error.
	_, err := svc.ensureExistingWorkspaceRunning(context.Background(), current)
	var refusal *pkgerrors.APIError
	require.ErrorAs(t, err, &refusal)
	assert.Equal(t, pkgerrors.CodePlanLimitExceeded, refusal.Code)
	assert.Equal(t, "sandbox_hours_per_day", refusal.LimitKind)
	require.NotNil(t, refusal.ResetAt)
	assert.Equal(t, "2026-09-16T00:00:00Z", refusal.ResetAt.UTC().Format(time.RFC3339))
	assert.Equal(t, metadata["message"], refusal.Message)
	assert.Zero(t, starts)
	assert.Equal(t, "suspended", current.Status)

	// After UTC midnight the same resume succeeds.
	now = time.Date(2026, 9, 16, 0, 0, 1, 0, time.UTC)
	resumed, err := svc.ensureExistingWorkspaceRunning(context.Background(), current)
	require.NoError(t, err)
	assert.Equal(t, "running", resumed.Status)
	assert.Equal(t, 1, starts)
}
