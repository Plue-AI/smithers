package services

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// sweepMetrics records the sandbox-hours metering errors the sweep reports.
type sweepMetrics struct {
	mu             sync.Mutex
	meteringErrors int
}

func (*sweepMetrics) ObserveSandboxVMCreate(string, string, float64) {}
func (*sweepMetrics) AddSandboxActiveVMs(string, float64)            {}
func (*sweepMetrics) ObserveSandboxVMSuspend(float64)                {}
func (m *sweepMetrics) AddSandboxHoursMeteringError() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.meteringErrors++
}

// hoursSweepFixture is owner 7's single workspace metered against the real
// BillingService on a virtual clock. The owner used 3h50m before the
// workspace started at 20:00 UTC; the workspace is awake while running.
type hoursSweepFixture struct {
	now         time.Time
	started     time.Time
	suspendedAt time.Time
	running     bool
	meterErr    error
	billing     *BillingService
	workspaces  *WorkspaceService
	audits      *operationAuditFake
	metrics     *sweepMetrics
	suspended   []string
}

func newHoursSweepFixture(t *testing.T, plan string) *hoursSweepFixture {
	t.Helper()
	f := &hoursSweepFixture{
		started: time.Date(2026, 9, 15, 20, 0, 0, 0, time.UTC),
		running: true,
		audits:  &operationAuditFake{},
		metrics: &sweepMetrics{},
	}
	f.now = f.started
	billing, q := sandboxTestBilling(plan)
	billing.now = func() time.Time { return f.now }
	earlier := [2]time.Time{time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC), time.Date(2026, 9, 15, 15, 50, 0, 0, time.UTC)}
	q.sumSandboxSecondsFn = func(_ context.Context, owner int64, since time.Time) (int64, error) {
		require.Equal(t, int64(7), owner)
		if f.meterErr != nil {
			return 0, f.meterErr
		}
		end := f.now
		if !f.running {
			end = f.suspendedAt
		}
		return awakeSeconds(earlier[0], earlier[1], since, f.now) + awakeSeconds(f.started, end, since, f.now), nil
	}
	q.countActiveSandboxesFn = func(context.Context, int64) (int, error) {
		if f.running {
			return 1, nil
		}
		return 0, nil
	}
	f.billing = billing

	row := sampleDBWorkspace("hours-ws")
	row.UserID, row.VmID = 7, "vm-hours"
	wq := &mockWorkspaceQuerier{
		listRunningWorkspacesFn: func(context.Context) ([]db.Workspace, error) {
			if !f.running {
				return nil, nil
			}
			return []db.Workspace{row}, nil
		},
		suspendRunningWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			f.running, f.suspendedAt = false, f.now
			suspended := row
			suspended.Status = "suspended"
			return suspended, nil
		},
	}
	f.workspaces = newWorkspaceServiceForTests(wq,
		WithWorkspaceBillingPolicy(billing),
		WithWorkspaceAuditService(NewAuditService(f.audits)),
		WithWorkspaceSandboxMetrics(f.metrics),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			suspendVMFn: func(_ context.Context, vmID string) (sandbox.SuspendResult, error) {
				f.suspended = append(f.suspended, vmID)
				return sandbox.SuspendResult{}, nil
			},
		}))
	return f
}

// awakeSeconds is the part of [start, end) after since and before now.
func awakeSeconds(start, end, since, now time.Time) int64 {
	if start.Before(since) {
		start = since
	}
	if end.After(now) {
		end = now
	}
	if !end.After(start) {
		return 0
	}
	return int64(end.Sub(start) / time.Second)
}

func (f *hoursSweepFixture) tick(t *testing.T, at time.Time) error {
	t.Helper()
	f.now = at
	return f.workspaces.CleanupOverQuotaWorkspaces(context.Background())
}

func TestSandboxHoursSweep_SuspendsAtTheDailyCapAndResumesAfterReset(t *testing.T) {
	f := newHoursSweepFixture(t, BillingPlanFree)

	require.NoError(t, f.tick(t, f.started.Add(5*time.Minute)))
	assert.Empty(t, f.suspended, "3h55m used is under the Free plan's 4 hours")
	assert.Empty(t, f.audits.rows)

	require.NoError(t, f.tick(t, f.started.Add(10*time.Minute)))
	assert.Equal(t, []string{"vm-hours"}, f.suspended, "the first tick at 4h suspends the running workspace")
	require.Len(t, f.audits.rows, 1)
	audit := f.audits.rows[0]
	assert.Equal(t, "workspace.suspend", audit.EventType)
	assert.Equal(t, "sandbox_hours_per_day", audit.Action)
	assert.Equal(t, "system", audit.ActorName)
	assert.Equal(t, "user", audit.TargetType)
	assert.Equal(t, int64(7), audit.TargetID.Int64)
	assert.Equal(t, "hours-ws", audit.TargetName)
	var metadata map[string]any
	require.NoError(t, json.Unmarshal(audit.Metadata, &metadata))
	assert.Equal(t, "2026-09-16T00:00:00Z", metadata["reset_at"])
	assert.Equal(t, string(pkgerrors.CodePlanLimitExceeded), metadata["code"])
	assert.Equal(t, "sandbox_hours_per_day", metadata["limit_kind"])
	assert.Equal(t, BillingPlanFree, metadata["plan_key"])
	assert.Equal(t, BillingPlanPro, metadata["upgrade_plan_key"])
	assert.EqualValues(t, 4, metadata["limit"])
	assert.Equal(t, "vm-hours", metadata["vm_id"])
	assert.Contains(t, metadata["message"], "try again after 2026-09-16T00:00:00Z")

	// Resuming before reset_at returns the same plan-limit error.
	f.now = f.started.Add(3 * time.Hour)
	err := f.billing.AuthorizeSandboxStart(context.Background(), 7)
	var limit *pkgerrors.APIError
	require.ErrorAs(t, err, &limit)
	assert.Equal(t, "sandbox_hours_per_day", limit.LimitKind)
	require.NotNil(t, limit.ResetAt)
	assert.Equal(t, time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC), limit.ResetAt.UTC())

	require.NoError(t, f.tick(t, f.started.Add(15*time.Minute)))
	assert.Len(t, f.suspended, 1, "a suspended workspace is not swept again")

	// After the UTC day resets the owner may resume.
	f.now = time.Date(2026, 9, 16, 0, 5, 0, 0, time.UTC)
	require.NoError(t, f.billing.AuthorizeSandboxStart(context.Background(), 7))
	assert.Zero(t, f.metrics.meteringErrors)
}

func TestSandboxHoursSweep_MeteringErrorSuspendsNothing(t *testing.T) {
	f := newHoursSweepFixture(t, BillingPlanFree)
	f.meterErr = errors.New("meter unavailable")

	err := f.tick(t, f.started.Add(time.Hour))
	require.ErrorContains(t, err, "sandbox hours for user 7")
	require.ErrorContains(t, err, "meter unavailable")
	assert.Empty(t, f.suspended, "unknown usage never suspends a running workspace")
	assert.Empty(t, f.audits.rows)
	assert.Equal(t, 1, f.metrics.meteringErrors)
	assert.True(t, f.running)

	// The next tick with metering back suspends the over-cap workspace.
	f.meterErr = nil
	require.NoError(t, f.tick(t, f.started.Add(time.Hour+5*time.Minute)))
	assert.Equal(t, []string{"vm-hours"}, f.suspended)
	assert.Equal(t, 1, f.metrics.meteringErrors)
}

func TestSandboxHoursSweep_UnlimitedPlansAreNeverSwept(t *testing.T) {
	for _, plan := range []string{BillingPlanPro, BillingPlanMax} {
		t.Run(plan, func(t *testing.T) {
			f := newHoursSweepFixture(t, plan)
			require.NoError(t, f.tick(t, f.started.Add(3*time.Hour)))
			assert.Empty(t, f.suspended)
			assert.Empty(t, f.audits.rows)
			assert.True(t, f.running)
		})
	}
}

func TestSandboxHoursSweep_SuspendFailureWritesNoAudit(t *testing.T) {
	f := newHoursSweepFixture(t, BillingPlanFree)
	f.workspaces.sandbox = &mockWorkspaceSandboxVMClient{
		suspendVMFn: func(context.Context, string) (sandbox.SuspendResult, error) {
			return sandbox.SuspendResult{}, errors.New("provider down")
		},
	}
	err := f.tick(t, f.started.Add(30*time.Minute))
	require.ErrorContains(t, err, "suspend over-quota workspace hours-ws")
	assert.Empty(t, f.audits.rows, "only a suspension that happened is audited")
}

func TestSandboxHoursSweep_WithoutAuditServiceStillSuspends(t *testing.T) {
	f := newHoursSweepFixture(t, BillingPlanFree)
	f.workspaces.audit = nil
	require.NoError(t, f.tick(t, f.started.Add(30*time.Minute)))
	assert.Equal(t, []string{"vm-hours"}, f.suspended)
}
