package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

// Only the daemon is substituted here to inject inspection/capture failures.
// Native execution is covered by the composed process rehearsal.
type rebaseExecutionFixture struct {
	f                *rebaseFixture
	result           machined.RewriteResult
	calls            int
	captures         int
	failCapture      bool
	stopOnCapture    bool
	wrongCaptureHead bool
	failRebase       error
}

func (r *rebaseExecutionFixture) Rebase(ctx context.Context, branch string, member int64, onto, base string, _ func(pgx.Tx) error, guard func(func() error) error) (machined.RewriteResult, error) {
	if r.failRebase != nil {
		return machined.RewriteResult{}, r.failRebase
	}
	err := guard(func() error {
		// The authenticated presence reader holds KEY SHARE independently of
		// native admission. It must finish while the worker fences the rewrite.
		read, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		tx, err := r.f.pool.Begin(read)
		if err != nil {
			return err
		}
		defer tx.Rollback(context.WithoutCancel(ctx))
		var observed string
		if err := tx.QueryRow(read, `SELECT id::text FROM workspaces WHERE id=$1 FOR KEY SHARE`, branch).Scan(&observed); err != nil {
			return err
		}
		if observed != branch {
			return errors.New("presence read another branch")
		}
		r.calls++
		return nil
	})
	return r.result, err
}

func TestRetainedConflictHostStartupKeepsItsReservationDue(t *testing.T) {
	now := time.Date(2026, 10, 8, 15, 0, 0, 0, time.UTC)
	checks := mythicalChecks{Rebase: &mythicalRebase{Onto: "main"}, ConflictReservation: &todoConflictReservation{Change: "conflict", Onto: "main", Run: "original", Limit: 1, Reserved: 1}}
	item := db.MythicalItem{State: "integrating", Reason: "rebase_conflict_pending", RequestRunID: "original", Checks: checks.encode(), Integration: json.RawMessage(`{"conflict":{"Head":"conflict","Onto":"main"}}`)}
	step := mythicalItemStep{now: now, s: &MythicalService{branchRebase: &rebaseExecutionFixture{failRebase: machined.ErrNotReady}}, r: &mythicalRun{}}
	next, saved, err := step.executeNativeRebase(t.Context(), item, "main")
	require.NoError(t, err)
	require.False(t, saved)
	require.Equal(t, now.Add(3*time.Second), next.NextAttemptAt.Time)
	require.Equal(t, item.Reason, next.Reason)
	require.Equal(t, checks.ConflictReservation, mythicalChecksOf(*next).ConflictReservation)
	require.Zero(t, mythicalChecksOf(*next).Outages)
}

func TestOpenTodoCaptureRefreshKeepsItsBranch(t *testing.T) {
	f := newRebaseFixture(t)
	item := f.candidate("Retained", f.main, "NEXT.md", "next\n")
	q := db.New(f.pool)
	workspace, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, TargetBookmark: MythicalBookmark, Kind: "vm", Status: "suspended"})
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(t.Context(), db.MythicalLane{WorkspaceID: workspace.ID, RepositoryID: f.repoID, ItemID: item.ID, Name: "TODO 1 attempt 1 g1"})
	require.NoError(t, err)
	lanes := &fakeMythicalLanes{}
	f.service.lanes = lanes
	item.WorkspaceID, item.RequestOutcome = workspace.ID, "completed"
	item.FlowDigest = pgtype.Text{String: "pinned", Valid: true}
	for _, state := range []string{"integrating", "verifying", "proposing", "proposed"} {
		t.Run(state, func(t *testing.T) {
			item.State = state
			retained := f.service.releaseLane(t.Context(), &mythicalRun{row: db.MythicalStack{RepositoryID: f.repoID, ActorUserID: pgtype.Int8{Int64: f.userID, Valid: true}}}, item)
			require.Equal(t, workspace.ID, retained.WorkspaceID)
			require.Empty(t, lanes.deleted)
			bound, err := q.GetMythicalLane(t.Context(), workspace.ID)
			require.NoError(t, err)
			require.False(t, bound.RetiredAt.Valid)
		})
	}
}

func TestAsleepRebasePublicationRecoveryRequiresTheSameResult(t *testing.T) {
	planned := mythicalCommit{ID: "new", ChangeID: "item", Parents: []string{"main"}, Tree: "tree", Message: "message", Author: "author", Committer: "Smithers at now"}
	published := planned
	published.ID, published.Committer = "previous", "Smithers before restart"
	require.True(t, sameAsleepRebaseResult(planned, published))
	for _, change := range []func(*mythicalCommit){
		func(c *mythicalCommit) { c.ChangeID = "" },
		func(c *mythicalCommit) { c.ChangeID = "different item" },
		func(c *mythicalCommit) { c.Parents = []string{"different main"} },
		func(c *mythicalCommit) { c.Parents = []string{"main", "other"} },
		func(c *mythicalCommit) { c.Tree = "edited" },
		func(c *mythicalCommit) { c.Message = "different message" },
		func(c *mythicalCommit) { c.Author = "different author" },
	} {
		moved := published
		change(&moved)
		require.False(t, sameAsleepRebaseResult(planned, moved))
	}
}
func (r *rebaseExecutionFixture) Capture(ctx context.Context, branch string) (machined.CaptureResult, error) {
	r.captures++
	if r.failCapture {
		return machined.CaptureResult{}, errors.New("capture unavailable")
	}
	f := r.f
	head := r.result.Head
	f.git(f.hostDir, "update-ref", "refs/smithers/branches/"+branch+"/captures/"+head, head)
	tree := f.hostTree(head)
	pending := MachineCapturePending{Head: head, Tree: tree, Base: head, Onto: head}
	raw, _ := json.Marshal(pending)
	_, err := f.pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2,capture_pending=$3 WHERE id=$1`, branch, head, raw)
	if err != nil {
		return machined.CaptureResult{}, err
	}
	if r.stopOnCapture {
		_, err = f.pool.Exec(ctx, `UPDATE workspaces SET status='stopped' WHERE id=$1`, branch)
		if err != nil {
			return machined.CaptureResult{}, err
		}
	}
	if r.wrongCaptureHead {
		_, err = f.pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, branch, f.main)
		if err != nil {
			return machined.CaptureResult{}, err
		}
	}
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET candidate_verified=false,checks=jsonb_set(checks,'{capture}',$2::jsonb) WHERE workspace_id=$1`, branch, raw)
	return machined.CaptureResult{Head: head, Tree: tree}, err
}
func TestBranchRebaseNowOccupiedRecovery(t *testing.T) {
	testOccupiedRebase(t, nil, false, false, false)
}
func TestBranchRebaseNowOccupiedConflictHandoff(t *testing.T) {
	testOccupiedRebase(t, []string{"SECOND.md"}, false, false, false)
}
func TestBranchRebaseNowCapturedStoppedReceipt(t *testing.T) {
	testOccupiedRebase(t, nil, true, false, false)
}
func TestBranchRebaseAutomaticPresenceShareFence(t *testing.T) {
	testOccupiedRebase(t, nil, false, true, false)
}
func TestReservedCaptureFollowsMainThroughNativeBranch(t *testing.T) {
	testOccupiedRebase(t, nil, false, true, true)
}
func testOccupiedRebase(t *testing.T, paths []string, stopOnCapture, automatic, reserved bool) {
	f := newRebaseFixture(t)
	if stopOnCapture {
		// A stopped coding branch verifies on a separate execution lane.
		f.service.lanes = &fakeMythicalLanes{}
	}
	first := f.candidate("First", f.main, "FIRST.md", "first\n")
	f.wake()
	second := f.candidate("Second", first.CandidateHead, "SECOND.md", "second\n")
	f.wake()
	second = f.item(second.Number.Int64)
	branch := mythicalChecksOf(second).Branch
	q := db.New(f.pool)
	workspace, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, TargetBookmark: branch, Kind: "vm", Status: "running"})
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(t.Context(), db.MythicalLane{WorkspaceID: workspace.ID, RepositoryID: f.repoID, ItemID: second.ID, Name: "coding"})
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `UPDATE mythical_items SET workspace_id=$2 WHERE id=$1`, second.ID, workspace.ID)
	require.NoError(t, err)
	f.service.SetRebasePresence(func(context.Context, int64, string) (RebasePresence, error) { return RebasePresencePeople, nil })
	owner, err := q.GetUserByID(t.Context(), f.userID)
	require.NoError(t, err)
	session := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &owner, SessionHash: "owner-session"})
	_, err = f.service.ControlTodo(session, second.Number.Int64, TodoControlInput{Op: "move", Direction: "up", Repository: f.repoID, Actor: f.userID, Request: "move"})
	require.NoError(t, err)
	f.wake()
	held := f.item(second.Number.Int64)
	require.Equal(t, "rebase_pending", held.Reason)
	head := f.git(f.hostDir, "commit-tree", f.hostTree(second.CandidateHead), "-p", f.main, "-m", "native rebase result")
	executor := &rebaseExecutionFixture{f: f, result: machined.RewriteResult{Head: head, Inspected: true, Paths: paths}, failCapture: true, stopOnCapture: stopOnCapture}
	f.service.SetBranchRebaseExecutor(executor)
	if reserved {
		checks := mythicalChecksOf(held)
		checks.Capture = &MachineCapturePending{Head: held.CandidateHead, Tree: f.hostTree(held.CandidateHead), Base: held.CandidateBase, Onto: held.CandidateHead, SourceRef: repohost.WorkspaceSourceRef(workspace.ID, held.CandidateHead)}
		checks.ProposalRun, checks.ProposalHead = "sealed-run", held.CandidateHead
		held.RequestRunID, held.RequestOutcome = "sealed-run", ""
		checks.RunAttached = true
		held.Checks = checks.encode()
		held, err = q.SaveMythicalItem(t.Context(), held)
		require.NoError(t, err)
	}
	if automatic {
		f.service.SetRebasePresence(func(ctx context.Context, _ int64, branch string) (RebasePresence, error) {
			read, cancel := context.WithTimeout(ctx, time.Second)
			defer cancel()
			tx, err := f.pool.Begin(read)
			if err != nil {
				return RebasePresenceUnknown, err
			}
			defer tx.Rollback(context.WithoutCancel(ctx))
			var observed string
			err = tx.QueryRow(read, `SELECT id::text FROM workspaces WHERE id=$1 FOR SHARE`, branch).Scan(&observed)
			if err != nil {
				return RebasePresenceUnknown, err
			}
			require.Equal(t, workspace.ID, observed)
			return RebasePresenceEmpty, nil
		})
	} else {
		_, err = f.service.RebaseBranch(session, f.repoID, f.userID, branch, BranchRebaseInput{Rebase: true, Request: "press"})
		require.NoError(t, err)
	}
	f.wake()
	pending := f.item(second.Number.Int64)
	require.Equal(t, head, mythicalChecksOf(pending).Rebase.Native.Head)
	require.Equal(t, held.CandidateHead, pending.CandidateHead)
	require.Equal(t, 1, executor.calls)
	if len(paths) > 0 {
		f.wake()
		conflicted := f.item(second.Number.Int64)
		require.Equal(t, "rebase_conflict_pending", conflicted.Reason)
		require.Equal(t, executor.result, *mythicalChecksOf(conflicted).Rebase.Native, "restart retains the authenticated native conflict receipt")
		require.Equal(t, held.CandidateHead, conflicted.CandidateHead)
		var integration struct {
			Conflict struct {
				Paths      []string
				Head, Onto string
			}
		}
		require.NoError(t, json.Unmarshal(conflicted.Integration, &integration))
		require.Equal(t, paths, integration.Conflict.Paths)
		require.Equal(t, head, integration.Conflict.Head)
		require.Equal(t, f.main, integration.Conflict.Onto)
		for range 3 {
			f.wake()
		}
		require.Equal(t, 1, executor.calls)
		require.Equal(t, 0, executor.captures)
		return
	}
	// A failed capture and another worker pass preserve the inspected receipt.
	f.wake()
	require.Equal(t, 1, executor.calls)
	executor.failCapture = false
	if stopOnCapture {
		executor.wrongCaptureHead = true
		f.wake()
		require.NotEqual(t, "verifying", f.item(second.Number.Int64).State)
		require.Equal(t, 0, f.verifies(f.item(second.Number.Int64)))
		require.Equal(t, 1, executor.calls)
		executor.wrongCaptureHead = false
	}
	f.wake()
	next := f.item(second.Number.Int64)
	require.Equal(t, "verifying", next.State, next.Reason)
	require.Equal(t, held.Generation+1, next.Generation)
	require.Equal(t, head, next.CandidateHead)
	require.Equal(t, f.main, next.CandidateBase)
	if stopOnCapture {
		require.NotEqual(t, workspace.ID, next.WorkspaceID)
		stopped, err := q.GetWorkspace(t.Context(), workspace.ID)
		require.NoError(t, err)
		require.Equal(t, "stopped", stopped.Status)
	} else {
		require.Equal(t, workspace.ID, next.WorkspaceID)
	}
	require.Equal(t, 1, f.verifies(next))
	require.Equal(t, 1, executor.calls)
	require.Nil(t, mythicalChecksOf(next).Capture)
	if reserved {
		var consumed struct{ Kind, Head, Tree string }
		require.NoError(t, json.Unmarshal(next.Integration, &consumed))
		require.Equal(t, "captured", consumed.Kind)
		require.Equal(t, held.CandidateHead, consumed.Head)
		require.Equal(t, f.hostTree(held.CandidateHead), consumed.Tree)
		require.Equal(t, "sealed-run", next.RequestRunID)
	}
	if automatic {
		require.Nil(t, rebaseRequester(next))
	} else {
		require.Equal(t, map[string]string{"person": owner.Username}, rebaseRequester(next))
	}
}

func TestSupersededNativeRebaseRefusesUnboundCapture(t *testing.T) {
	head, tree := "1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"
	cases := map[string]func(*mythicalChecks, *machined.CaptureResult){
		"missing receipt":             func(c *mythicalChecks, _ *machined.CaptureResult) { c.Rebase = nil },
		"missing native result":       func(c *mythicalChecks, _ *machined.CaptureResult) { c.Rebase.Native = nil },
		"uninspected result":          func(c *mythicalChecks, _ *machined.CaptureResult) { c.Rebase.Native.Inspected = false },
		"conflict result":             func(c *mythicalChecks, _ *machined.CaptureResult) { c.Rebase.Native.Paths = []string{"a.txt"} },
		"changed capture head":        func(_ *mythicalChecks, r *machined.CaptureResult) { r.Head = tree },
		"changed capture tree":        func(_ *mythicalChecks, r *machined.CaptureResult) { r.Tree = head },
		"missing retained capture":    func(c *mythicalChecks, _ *machined.CaptureResult) { c.Capture = nil },
		"changed retained head":       func(c *mythicalChecks, _ *machined.CaptureResult) { c.Capture.Head = tree },
		"changed retained tree":       func(c *mythicalChecks, _ *machined.CaptureResult) { c.Capture.Tree = head },
		"stale retained capture":      func(c *mythicalChecks, _ *machined.CaptureResult) { c.Capture.Stale = true },
		"conflicted retained capture": func(c *mythicalChecks, _ *machined.CaptureResult) { c.Capture.Conflict = true },
	}
	for name, damage := range cases {
		t.Run(name, func(t *testing.T) {
			checks := mythicalChecks{Rebase: &mythicalRebase{Onto: tree, Native: &machined.RewriteResult{Head: head, Inspected: true}}, Capture: &MachineCapturePending{Head: head, Tree: tree}}
			capture := machined.CaptureResult{Head: head, Tree: tree}
			damage(&checks, &capture)
			item := db.MythicalItem{Checks: checks.encode()}
			before := string(item.Checks)
			// No storage or executor is provided: every damaged binding must refuse
			// before patch comparison, mutation, verification or any database effect.
			next, saved, err := (&mythicalItemStep{}).retargetCapturedNativeRebase(t.Context(), item, item, capture, tree)
			require.ErrorIs(t, err, machined.ErrNotReady)
			require.Nil(t, next)
			require.False(t, saved)
			require.Equal(t, before, string(item.Checks))
		})
	}
}
