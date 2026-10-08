package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

// Only the daemon is substituted here to inject inspection/capture failures.
// Native execution is covered by the composed process rehearsal.
type rebaseExecutionFixture struct {
	f           *rebaseFixture
	result      machined.RewriteResult
	calls       int
	captures    int
	failCapture bool
}

func (r *rebaseExecutionFixture) Rebase(ctx context.Context, branch string, member int64, onto string, _ func(pgx.Tx) error, guard func(func() error) error) (machined.RewriteResult, error) {
	err := guard(func() error { r.calls++; return nil })
	return r.result, err
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
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET candidate_verified=false,checks=jsonb_set(checks,'{capture}',$2::jsonb) WHERE workspace_id=$1`, branch, raw)
	return machined.CaptureResult{Head: head, Tree: tree}, err
}
func TestBranchRebaseNowOccupiedRecovery(t *testing.T) { testOccupiedRebase(t, nil) }
func TestBranchRebaseNowOccupiedConflictHandoff(t *testing.T) {
	testOccupiedRebase(t, []string{"SECOND.md"})
}
func testOccupiedRebase(t *testing.T, paths []string) {
	f := newRebaseFixture(t)
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
	executor := &rebaseExecutionFixture{f: f, result: machined.RewriteResult{Head: head, Inspected: true, Paths: paths}, failCapture: true}
	f.service.SetBranchRebaseExecutor(executor)
	_, err = f.service.RebaseBranch(session, f.repoID, f.userID, branch, BranchRebaseInput{Rebase: true, Request: "press"})
	require.NoError(t, err)
	f.wake()
	pending := f.item(second.Number.Int64)
	require.Equal(t, head, mythicalChecksOf(pending).Rebase.Native.Head)
	require.Equal(t, held.CandidateHead, pending.CandidateHead)
	require.Equal(t, 1, executor.calls)
	if len(paths) > 0 {
		f.wake()
		conflicted := f.item(second.Number.Int64)
		require.Equal(t, "rebase_conflict_pending", conflicted.Reason)
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
	f.wake()
	next := f.item(second.Number.Int64)
	require.Equal(t, "verifying", next.State, next.Reason)
	require.Equal(t, held.Generation+1, next.Generation)
	require.Equal(t, head, next.CandidateHead)
	require.Equal(t, f.main, next.CandidateBase)
	require.Equal(t, workspace.ID, next.WorkspaceID)
	require.Equal(t, 1, f.verifies(next))
	require.Equal(t, 1, executor.calls)
	require.Nil(t, mythicalChecksOf(next).Capture)
	require.Equal(t, map[string]string{"person": owner.Username}, rebaseRequester(next))
}
