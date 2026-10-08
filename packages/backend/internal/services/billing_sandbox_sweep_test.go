package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
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
	workspaceID string
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

	// Native capture and the VM are controlled peers: the sweep exercises
	// real durable release transactions while metering uses a virtual clock.
	pool := newProductTestPool(t)
	ctx := t.Context()
	_, err := pool.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES(7,'hours-owner','hours-owner')`)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES(7,'hours','hours') RETURNING id`).Scan(&repo))
	qdb := db.New(pool)
	row, err := qdb.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: 7, TargetBookmark: "main", Kind: "container", Status: "running"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='vm-hours',head_commit_id=$2 WHERE id=$1`, row.ID, strings.Repeat("a", 40))
	require.NoError(t, err)
	f.workspaceID = row.ID
	peer := &hoursSweepPeer{fixture: f, pool: pool, id: row.ID}
	f.workspaces = newWorkspaceServiceForTests(qdb,
		WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()),
		WithBranchCapture(peer), WithBranchHeads(peer), WithWorkspaceRuntime(peer),
		WithWorkspaceBillingPolicy(billing),
		WithWorkspaceAuditService(NewAuditService(f.audits)),
		WithWorkspaceSandboxMetrics(f.metrics))
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
	assert.Equal(t, f.workspaceID, audit.TargetName)
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
	f.workspaces.runtime.(*hoursSweepPeer).stopErr = errors.New("provider down")
	err := f.tick(t, f.started.Add(30*time.Minute))
	require.ErrorContains(t, err, "suspend over-quota workspace "+f.workspaceID)
	assert.Empty(t, f.audits.rows, "only a suspension that happened is audited")
}

func TestSandboxHoursSweep_WithoutAuditServiceStillSuspends(t *testing.T) {
	f := newHoursSweepFixture(t, BillingPlanFree)
	f.workspaces.audit = nil
	require.NoError(t, f.tick(t, f.started.Add(30*time.Minute)))
	assert.Equal(t, []string{"vm-hours"}, f.suspended)
}

// Unused repository reads remain outside this metering fixture's contract.
type hoursSweepPeer struct {
	workspaceapi.WorkspaceRuntime
	workspaceSnapshotStore
	fixture  *hoursSweepFixture
	pool     *pgxpool.Pool
	id       string
	captured bool
	stopErr  error
}

func (p *hoursSweepPeer) Capture(ctx context.Context, id string) (machined.CaptureResult, error) {
	var status string
	if err := p.pool.QueryRow(ctx, `SELECT status FROM workspaces WHERE id=$1`, id).Scan(&status); err != nil {
		return machined.CaptureResult{}, err
	}
	if id != p.id || status != "releasing" {
		return machined.CaptureResult{}, errors.New("capture outside release")
	}
	p.captured = true
	return machined.CaptureResult{Head: strings.Repeat("a", 40), Tree: strings.Repeat("b", 40)}, nil
}
func (p *hoursSweepPeer) InfoRefsUploadPack(ctx context.Context, owner, repo string) ([]byte, error) {
	return scratchHeads{repohost.BranchHeadRef(p.id): strings.Repeat("a", 40)}.InfoRefsUploadPack(ctx, owner, repo)
}
func (p *hoursSweepPeer) GetChange(context.Context, string, string, string) (repohost.Change, error) {
	return repohost.Change{CommitID: strings.Repeat("a", 40)}, nil
}
func (p *hoursSweepPeer) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	state := workspaceapi.WorkspaceRunning
	if !p.fixture.running {
		state = workspaceapi.WorkspaceStopped
	}
	return workspaceapi.Workspace{ID: id, State: state}, nil
}
func (p *hoursSweepPeer) StopWorkspace(_ context.Context, id string) error {
	if id != p.id || !p.captured {
		return errors.New("stop before capture")
	}
	if p.stopErr != nil {
		return p.stopErr
	}
	p.fixture.running = false
	p.fixture.suspendedAt = p.fixture.now
	p.fixture.suspended = append(p.fixture.suspended, "vm-hours")
	return nil
}
