package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/cleanup"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestCleanupPolicyCombinations(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	for _, state := range []string{"merged", "dropped", "in_review", "working", "scratch archived", "scratch open"} {
		for _, captured := range []string{"ok", "failed", "ref differs", "incomplete", "unbound", "stale inventory"} {
			for _, inventory := range []string{"quiet", "terminal", "ssh", "service", "unavailable"} {
				for _, age := range []time.Duration{24*time.Hour - time.Minute, 24 * time.Hour} {
					t.Run(fmt.Sprintf("%s/%s/%s/%s", state, captured, inventory, age), func(t *testing.T) {
						settled := now.Add(-age)
						if state == "in_review" || state == "working" || state == "scratch open" {
							settled = time.Time{}
						}
						row := db.Workspace{ID: "branch", Status: "suspended", HeadCommitID: "head"}
						c := WorkspaceDiskReclaimCapture{WorkspaceID: row.ID, CandidateHead: "head", RetainedHead: "head", CaptureID: "capture", Settled: true, Quiet: inventory == "quiet", BindingVerified: true, CaptureComplete: true, InventoryCurrent: true}
						if captured == "failed" {
							c.CaptureID = ""
						}
						if captured == "incomplete" {
							c.CaptureComplete = false
						}
						if captured == "unbound" {
							c.BindingVerified = false
						}
						if captured == "stale inventory" {
							c.InventoryCurrent = false
						}
						if captured == "ref differs" {
							c.RetainedHead = "new"
						}
						want := (state == "merged" || state == "dropped" || state == "scratch archived") && captured == "ok" && inventory == "quiet" && age == 24*time.Hour
						require.Equal(t, want, cleanupCaptureMatches(row, c, settled, now))
					})
				}
			}
		}
	}
}

func TestCleanupSettlementUsesCommittedEvent(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	item := mythicalLanded(db.MythicalItem{}, "merge", now)
	require.Equal(t, now, cleanupSettlement(item))
	checks := mythicalChecksOf(item)
	for _, outcome := range []string{"closed", "commented"} {
		checks.Completion.Outcome = outcome
		item.Checks = checks.encode()
		require.Equal(t, now, cleanupSettlement(item), "completion notice does not unsettle a merge")
	}
	checks.Completion.Outcome = mythicalCompletionOffMain
	item.Checks = checks.encode()
	require.True(t, cleanupSettlement(item).IsZero())
	checks.Completion.Outcome = ""
	item.Checks = checks.encode()
	item.UpdatedAt = pgtype.Timestamptz{Time: now.Add(24 * time.Hour), Valid: true}
	require.Equal(t, now, cleanupSettlement(item))
	item.PendingOp = json.RawMessage(`{"kind":"push"}`)
	require.True(t, cleanupSettlement(item).IsZero())
	item = mythicalDropped(db.MythicalItem{}, todoDrop{At: now})
	require.Equal(t, now, cleanupSettlement(item))
	item.PRNumber = pgtype.Int8{Int64: 1, Valid: true}
	item.PRState = "open"
	require.True(t, cleanupSettlement(item).IsZero())
	item.PRState = "closed"
	require.Equal(t, now, cleanupSettlement(item))
	item.State = "proposed"
	require.True(t, cleanupSettlement(item).IsZero(), "reopen invalidates a retained drop timestamp")
	require.True(t, cleanupSettlement(db.MythicalItem{State: "landed"}).IsZero())
	require.True(t, cleanupSettlement(db.MythicalItem{State: "cancelled"}).IsZero())
}

// This fake stands only for T-MCH-07/T-TRM-07's missing combined capture and
// broker fence. SQL, settlement projection, decisions, scheduler and retries
// use their real production implementations against PostgreSQL.
type cleanupPolicyRuntime struct {
	workspaceapi.WorkspaceRuntime
	capture        WorkspaceDiskReclaimCapture
	calls          []string
	failure        error
	captureFailure error
	before         func()
}

func (r *cleanupPolicyRuntime) WithFinalCapture(_ context.Context, row workspaceapi.CleanupWorkspace, fn func(WorkspaceDiskReclaimCapture) error) error {
	if r.captureFailure != nil {
		return r.captureFailure
	}
	if r.before != nil {
		r.before()
	}
	c := r.capture
	c.WorkspaceID = row.ID
	return fn(c)
}
func (r *cleanupPolicyRuntime) ReclaimWorkspaceDisk(_ context.Context, id string) error {
	r.calls = append(r.calls, id)
	return r.failure
}

func cleanupPolicyTick(t *testing.T, svc *WorkspaceService) {
	t.Helper()
	store := &darkCleanupStore{WorkspaceService: svc, tick: make(chan struct{}, 1)}
	runner := cleanup.NewWorkspaceCleaner(store, 100*time.Millisecond)
	runner.Start(t.Context())
	defer runner.Stop()
	select {
	case <-store.tick:
	case <-time.After(5 * time.Second):
		t.Fatal("cleanup tick timed out")
	}
	runner.Stop()
}

func TestWorkspaceCleanerTransactionalPolicyAndRecovery(t *testing.T) {
	pool := newProductTestPool(t)
	person, repo := setupTestUserAndRepo(t, pool)
	_ = person
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	for _, name := range []string{"merged", "paused settled item", "item rebound elsewhere", "failed capture", "incomplete capture", "unverified binding", "stale inventory", "unavailable inventory", "post capture write", "terminal", "ssh", "service stop failure", "dropped before retention", "in review", "archived scratch", "unfinished removal", "reopened", "missing settlement time", "unarchived scratch", "pending reopen", "pending writer", "pending admission", "pending capture publication", "pending capture reconciliation", "service final writes", "running service final writes"} {
		t.Run(name, func(t *testing.T) {
			branch := "smithers/" + name
			if name == "archived scratch" || name == "unarchived scratch" {
				branch = "scratch/member/" + name
			}
			row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, TargetBookmark: branch, Kind: "container", Status: "suspended"})
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='original',head_commit_id='head',last_activity_at=$2,suspended_at=$2 WHERE id=$1`, row.ID, now.Add(-30*24*time.Hour))
			require.NoError(t, err)
			if name == "running service final writes" {
				_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, row.ID)
				require.NoError(t, err)
			}
			if name == "pending capture reconciliation" {
				_, err = pool.Exec(ctx, `UPDATE workspaces SET capture_pending=$2 WHERE id=$1`, row.ID, []byte(`{"head":"retained-edit","tree":"retained-tree","base":"head","onto":"head","stale":true}`))
				require.NoError(t, err)
			}
			row, err = q.GetWorkspace(ctx, row.ID)
			require.NoError(t, err)
			var item db.MythicalItem
			if name == "archived scratch" {
				_, err = pool.Exec(ctx, `UPDATE workspaces SET branch_archived_at=$2 WHERE id=$1`, row.ID, now.Add(-24*time.Hour))
				require.NoError(t, err)
			} else if name != "unarchived scratch" {
				item, _, err = q.InsertMythicalChatItem(ctx, db.MythicalItem{RepositoryID: repo, IssueTitle: name, WorkspaceID: row.ID, CandidateHead: row.ID})
				require.NoError(t, err)
				_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: row.ID, RepositoryID: repo, ItemID: item.ID, Name: name})
				require.NoError(t, err)
				item = mythicalLanded(item, "merge", now.Add(-24*time.Hour))
				if name == "dropped before retention" {
					item = mythicalDropped(item, todoDrop{At: now.Add(-24*time.Hour + time.Minute)})
				}
				if name == "paused settled item" {
					item.PausedAt = pgtype.Timestamptz{Time: now, Valid: true}
				}
				if name == "item rebound elsewhere" {
					item.WorkspaceID = "replacement"
				}
				if name == "in review" {
					item.State = "proposed"
				}
				if name == "missing settlement time" {
					item.Checks = json.RawMessage(`{}`)
				}
				_, err = pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,paused_at=$4,workspace_id=$5 WHERE id=$1`, item.ID, item.State, item.Checks, item.PausedAt, item.WorkspaceID)
				require.NoError(t, err)
			}
			runtime := &cleanupPolicyRuntime{capture: WorkspaceDiskReclaimCapture{CandidateHead: "head", RetainedHead: "head", CaptureID: "capture", Settled: true, Quiet: true, BindingVerified: true, CaptureComplete: true, InventoryCurrent: true}}
			switch name {
			case "failed capture":
				runtime.capture.CaptureID = ""
			case "incomplete capture":
				runtime.capture.CaptureComplete = false
			case "unverified binding":
				runtime.capture.BindingVerified = false
			case "stale inventory":
				runtime.capture.InventoryCurrent = false
			case "unavailable inventory":
				runtime.captureFailure = errors.New("current broker inventory unavailable")
			case "post capture write":
				runtime.capture.RetainedHead = "new"
			case "service stop failure":
				runtime.captureFailure = errors.New("broker termination was not confirmed")
			case "terminal", "ssh":
				runtime.capture.Quiet = false
			case "unfinished removal":
				runtime.failure = errors.New("host stopped before disk removal")
			case "service final writes", "running service final writes":
				runtime.before = func() {
					_, err := pool.Exec(ctx, `UPDATE workspaces SET head_commit_id='final',status='suspended' WHERE id=$1`, row.ID)
					require.NoError(t, err)
					runtime.capture.CandidateHead = "final"
					runtime.capture.RetainedHead = "final"
				}
			case "reopened":
				runtime.before = func() {
					_, err := pool.Exec(ctx, `UPDATE mythical_items SET state='proposed' WHERE id=$1`, item.ID)
					require.NoError(t, err)
				}
			}
			var svc *WorkspaceService
			var transactions RepositoryJobTransactions = pool
			if name == "pending reopen" || name == "pending writer" || name == "pending admission" || name == "pending capture publication" {
				transactions = &cleanupInterleavingTransactions{RepositoryJobTransactions: pool, beforeRemoval: func() {
					// Writer exclusion precedes this lock, which must cover
					// both the committed archive decision and removal retry.
					svc.runtimeLocks.mutex.Lock()
					entry := svc.runtimeLocks.entries[row.ID]
					svc.runtimeLocks.mutex.Unlock()
					require.NotNil(t, entry)
					unlocked := entry.mutex.TryLock()
					if unlocked {
						entry.mutex.Unlock()
					}
					require.False(t, unlocked, "archive decision and removal share runtime exclusion")
					var err error
					switch name {
					case "pending reopen":
						_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='proposed' WHERE id=$1`, item.ID)
					case "pending writer":
						_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id='new' WHERE id=$1`, row.ID)
					case "pending admission":
						_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, row.ID)
					case "pending capture publication":
						_, err = pool.Exec(ctx, `UPDATE workspaces SET capture_pending=$2 WHERE id=$1`, row.ID, []byte(`{"head":"retained-edit","tree":"retained-tree","base":"head","onto":"head","stale":true}`))
					}
					require.NoError(t, err)
				}}
			}
			svc = NewWorkspaceService(q, WithWorkspaceRuntime(runtime), WithWorkspaceTransactions(transactions), WithTransactionalWorkspaceCleanup(func() time.Time { return now }))
			// Restrict this fixture's candidates; still use the real transactional
			// authority and production cleaner, not a decision-helper call.
			a := svc.diskReclaimAuthority
			svc.diskReclaimAuthority = singleCleanupCandidate{WorkspaceDiskReclaimAuthority: a, id: row.ID}
			cleanupPolicyTick(t, svc)
			stored, err := q.GetWorkspace(ctx, row.ID)
			require.NoError(t, err)
			removed := name == "merged" || name == "archived scratch" || name == "service final writes" || name == "running service final writes"
			require.Equal(t, removed, stored.DiskReclaimedAt.Valid)
			require.False(t, stored.DeletedAt.Valid, "history row retained")
			if name == "paused settled item" || name == "item rebound elsewhere" {
				require.Empty(t, stored.CleanupPendingHead, "refusal must not record a removal decision")
			}
			if name == "service final writes" || name == "running service final writes" {
				require.Equal(t, "final", stored.HeadCommitID)
			} else if name == "pending writer" {
				require.Equal(t, "new", stored.HeadCommitID)
			} else {
				require.Equal(t, "head", stored.HeadCommitID)
			}
			if name == "pending admission" {
				require.Equal(t, "running", stored.Status)
			} else {
				require.Equal(t, "suspended", stored.Status)
			}
			if removed || name == "unfinished removal" {
				require.Equal(t, []string{row.ID}, runtime.calls)
				require.True(t, stored.BranchArchivedAt.Valid)
			} else {
				require.Empty(t, runtime.calls)
			}
			if name == "dropped before retention" {
				now = now.Add(time.Minute)
				cleanupPolicyTick(t, svc)
				after, err := q.GetWorkspace(ctx, row.ID)
				require.NoError(t, err)
				require.True(t, after.DiskReclaimedAt.Valid)
				require.Equal(t, []string{row.ID}, runtime.calls)
				now = now.Add(-time.Minute)
			}
			if name == "unfinished removal" {
				require.Equal(t, "head", stored.CleanupPendingHead)
				require.Equal(t, "capture", stored.CleanupPendingCaptureID)
				runtime.failure = nil
				restarted := NewWorkspaceService(q, WithWorkspaceRuntime(runtime), WithWorkspaceTransactions(pool), WithTransactionalWorkspaceCleanup(func() time.Time { return now }))
				restarted.diskReclaimAuthority = singleCleanupCandidate{restarted.diskReclaimAuthority, row.ID}
				cleanupPolicyTick(t, restarted)
				stored, err = q.GetWorkspace(ctx, row.ID)
				require.NoError(t, err)
				require.True(t, stored.DiskReclaimedAt.Valid)
				require.Empty(t, stored.CleanupPendingHead)
				cleanupPolicyTick(t, restarted)
				require.Len(t, runtime.calls, 2, "completed removal is not repeated")
			}
			if name == "post capture write" || name == "pending writer" {
				// A later complete capture of the changed head makes the retained
				// disk eligible; the previous receipt cannot authorize this removal.
				_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id='new' WHERE id=$1`, row.ID)
				require.NoError(t, err)
				runtime.capture.CandidateHead = "new"
				runtime.capture.RetainedHead = "new"
				runtime.capture.CaptureID = "recaptured"
				cleanupPolicyTick(t, svc)
				after, err := q.GetWorkspace(ctx, row.ID)
				require.NoError(t, err)
				require.True(t, after.DiskReclaimedAt.Valid)
				require.Equal(t, []string{row.ID}, runtime.calls)
			}
			if item.ID.Valid {
				retained, err := q.GetMythicalItem(ctx, item.ID)
				require.NoError(t, err)
				require.Equal(t, item.ID, retained.ID)
			}
		})
	}
}

type singleCleanupCandidate struct {
	WorkspaceDiskReclaimAuthority
	id string
}

func (a singleCleanupCandidate) Candidates(context.Context) ([]string, error) {
	return []string{a.id}, nil
}

// Inject an independent writer/reopen exactly after the archive transaction
// commits and before the removal transaction takes its locks.
type cleanupInterleavingTransactions struct {
	RepositoryJobTransactions
	begins        int
	beforeRemoval func()
}

func (p *cleanupInterleavingTransactions) Begin(ctx context.Context) (pgx.Tx, error) {
	p.begins++
	if p.begins == 3 {
		p.beforeRemoval()
	}
	return p.RepositoryJobTransactions.Begin(ctx)
}

// Only the dependency fence is fake. The running publication uses the same
// generated query as production admission; decisions and retries use PostgreSQL
// and the normal cleaner. This is not microVM reconstruction qualification.
func TestWorkspaceCleanerReclaimsReactivatedRuntime(t *testing.T) {
	pool := newProductTestPool(t)
	_, repo := setupTestUserAndRepo(t, pool)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, TargetBookmark: "scratch/member/reactivated", Kind: "container", Status: "suspended"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='original',head_commit_id='head',branch_archived_at=$2 WHERE id=$1`, row.ID, now.Add(-24*time.Hour))
	require.NoError(t, err)
	runtime := &cleanupPolicyRuntime{capture: WorkspaceDiskReclaimCapture{CandidateHead: "head", RetainedHead: "head", CaptureID: "first capture", Settled: true, Quiet: true, BindingVerified: true, CaptureComplete: true, InventoryCurrent: true}}
	svc := NewWorkspaceService(q, WithWorkspaceRuntime(runtime), WithWorkspaceTransactions(pool), WithTransactionalWorkspaceCleanup(func() time.Time { return now }))
	cleanupPolicyTick(t, svc)
	stored, err := q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	require.True(t, stored.DiskReclaimedAt.Valid)
	require.Equal(t, []string{row.ID}, runtime.calls)
	stored, err = q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{ID: row.ID, Status: "suspended"})
	require.NoError(t, err)
	require.True(t, stored.DiskReclaimedAt.Valid, "a replayed stopped observation does not resurrect a removed disk")
	_, err = pool.Exec(ctx, `UPDATE workspaces SET cleanup_pending_head='obsolete',cleanup_pending_capture_id='obsolete' WHERE id=$1`, row.ID)
	require.NoError(t, err)
	stored, err = q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{ID: row.ID, Status: "running"})
	require.NoError(t, err)
	require.False(t, stored.DiskReclaimedAt.Valid, "running publication begins a new runtime lifecycle")
	require.Empty(t, stored.CleanupPendingHead)
	require.Empty(t, stored.CleanupPendingCaptureID)
	require.True(t, now.Add(-24*time.Hour).Equal(stored.BranchArchivedAt.Time), "admission cannot alter settlement time")
	cleanupPolicyTick(t, svc)
	require.Len(t, runtime.calls, 1, "a running machine is retained")
	_, err = q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{ID: row.ID, Status: "suspended"})
	require.NoError(t, err)
	runtime.capture.CaptureID = "new final capture"
	cleanupPolicyTick(t, svc)
	stored, err = q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	require.True(t, stored.DiskReclaimedAt.Valid)
	require.Equal(t, []string{row.ID, row.ID}, runtime.calls, "a newly captured runtime is reclaimed after its own lifecycle")
	cleanupPolicyTick(t, svc)
	require.Len(t, runtime.calls, 2, "completed removal remains idempotent")
}

// The first transaction resolves an authorized name without holding database
// locks while waiting for the shared runtime lock. Membership is then checked
// again in the transaction that actually archives the branch.
type archiveResolutionTransactions struct {
	RepositoryJobTransactions
	resolved chan struct{}
	count    atomic.Int32
}

func (a *archiveResolutionTransactions) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := a.RepositoryJobTransactions.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if a.count.Add(1) == 1 {
		return &archiveResolutionTx{Tx: tx, resolved: a.resolved}, nil
	}
	return tx, nil
}

type archiveResolutionTx struct {
	pgx.Tx
	resolved chan struct{}
	once     sync.Once
}

func (a *archiveResolutionTx) Rollback(ctx context.Context) error {
	err := a.Tx.Rollback(ctx)
	a.once.Do(func() { close(a.resolved) })
	return err
}
func TestScratchArchiveRechecksMembershipAfterRuntimeWait(t *testing.T) {
	pool := newProductTestPool(t)
	person, repo := setupTestUserAndRepo(t, pool)
	ctx := t.Context()
	q := db.New(pool)
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, person)
	require.NoError(t, err)
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, TargetBookmark: "scratch/member/archive-race", Kind: "container", Status: "suspended"})
	require.NoError(t, err)
	transactions := &archiveResolutionTransactions{RepositoryJobTransactions: pool, resolved: make(chan struct{})}
	svc := NewWorkspaceService(q, WithWorkspaceTransactions(transactions), WithBranchMachineProviders(InstallBranchMachineProviders(nil, nil)))
	info := &middleware.AuthInfo{User: &db.User{ID: person}, SessionHash: "archive-race"}
	callCtx := WithInstallAuthorization(middleware.ContextWithAuthInfo(ctx, info), "branch.archive", InstallAuthorization{UserID: person, Role: InstallOwner})
	unlock := svc.lockRuntimeWorkspace(row.ID)
	locked := true
	defer func() {
		if locked {
			unlock()
		}
	}()
	result := make(chan error, 1)
	go func() { _, err := svc.ArchiveScratchBranch(callCtx, row.ID, repo, person); result <- err }()
	select {
	case <-transactions.resolved:
	case <-time.After(5 * time.Second):
		unlock()
		locked = false
		<-result
		t.Fatal("archive held membership locks while waiting for runtime admission")
	}
	revocation, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = revocation.Rollback(context.WithoutCancel(ctx)) }()
	var id int64
	require.NoError(t, revocation.QueryRow(ctx, `SELECT user_id FROM self_host_owners WHERE singleton FOR UPDATE NOWAIT`).Scan(&id))
	require.Equal(t, person, id)
	_, err = revocation.Exec(ctx, `UPDATE users SET is_active=false WHERE id=$1`, person)
	require.NoError(t, err)
	require.NoError(t, revocation.Commit(ctx))
	unlock()
	locked = false
	select {
	case err := <-result:
		require.ErrorContains(t, err, "not a member of this install")
	case <-time.After(5 * time.Second):
		t.Fatal("archive did not reconsider revoked membership")
	}
	stored, err := q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	require.False(t, stored.BranchArchivedAt.Valid)
	require.False(t, stored.DeletedAt.Valid)
	require.Equal(t, "suspended", stored.Status)
}
