package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/cleanup"
	"github.com/smithersai/smithers/packages/backend/internal/db"
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
	for _, name := range []string{"merged", "failed capture", "post capture write", "terminal", "ssh", "service stop failure", "dropped before retention", "in review", "archived scratch", "unfinished removal", "reopened", "missing settlement time", "unarchived scratch", "pending reopen", "pending writer", "pending admission", "service final writes", "running service final writes"} {
		t.Run(name, func(t *testing.T) {
			branch := "smithers/" + name
			if name == "archived scratch" || name == "unarchived scratch" {
				branch = "scratch/member/" + name
			}
			row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, TargetBookmark: branch, Kind: "container", Status: "suspended"})
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='original',head_commit_id='head' WHERE id=$1`, row.ID)
			require.NoError(t, err)
			if name == "running service final writes" {
				_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, row.ID)
				require.NoError(t, err)
			}
			row, err = q.GetWorkspace(ctx, row.ID)
			require.NoError(t, err)
			var item db.MythicalItem
			if name == "archived scratch" {
				_, err = pool.Exec(ctx, `UPDATE workspaces SET branch_archived_at=$2 WHERE id=$1`, row.ID, now.Add(-24*time.Hour))
				require.NoError(t, err)
			} else if name != "unarchived scratch" {
				item, _, err = q.InsertMythicalChatItem(ctx, db.MythicalItem{RepositoryID: repo, IssueTitle: name, WorkspaceID: row.ID})
				require.NoError(t, err)
				_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: row.ID, RepositoryID: repo, ItemID: item.ID, Name: name})
				require.NoError(t, err)
				item = mythicalLanded(item, "merge", now.Add(-24*time.Hour))
				if name == "dropped before retention" {
					item = mythicalDropped(item, todoDrop{At: now.Add(-24*time.Hour + time.Minute)})
				}
				if name == "in review" {
					item.State = "proposed"
				}
				if name == "missing settlement time" {
					item.Checks = json.RawMessage(`{}`)
				}
				_, err = pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3 WHERE id=$1`, item.ID, item.State, item.Checks)
				require.NoError(t, err)
			}
			runtime := &cleanupPolicyRuntime{capture: WorkspaceDiskReclaimCapture{CandidateHead: "head", RetainedHead: "head", CaptureID: "capture", Settled: true, Quiet: true, BindingVerified: true, CaptureComplete: true, InventoryCurrent: true}}
			switch name {
			case "failed capture":
				runtime.capture.CaptureID = ""
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
			var transactions RepositoryJobTransactions = pool
			if name == "pending reopen" || name == "pending writer" || name == "pending admission" {
				transactions = &cleanupInterleavingTransactions{RepositoryJobTransactions: pool, beforeRemoval: func() {
					var err error
					switch name {
					case "pending reopen":
						_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='proposed' WHERE id=$1`, item.ID)
					case "pending writer":
						_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id='new' WHERE id=$1`, row.ID)
					case "pending admission":
						_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, row.ID)
					}
					require.NoError(t, err)
				}}
			}
			svc := NewWorkspaceService(q, WithWorkspaceRuntime(runtime), WithWorkspaceTransactions(transactions), WithTransactionalWorkspaceCleanup(func() time.Time { return now }))
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
