package services

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestBranchRebaseNowUsesStackPublication(t *testing.T) {
	f := newRebaseFixture(t)
	first := f.candidate("First", f.main, "FIRST.md", "first\n")
	f.wake()
	second := f.candidate("Second", first.CandidateHead, "SECOND.md", "second\n")
	f.wake()
	second = f.item(second.Number.Int64)
	branch := mythicalChecksOf(second).Branch
	require.NotEmpty(t, branch)
	oldPR := second.PRHead
	// The reviewed branch has released its coding and review machines.
	_, err := f.pool.Exec(t.Context(), `UPDATE mythical_items SET workspace_id='',lane=NULL,lane_started_at=NULL WHERE id=$1`, second.ID)
	require.NoError(t, err)
	f.service.SetOrchestration(f.service.github, f.launcher, &fakeMythicalLanes{})
	f.service.SetRebasePresence(func(context.Context, int64, string) (RebasePresence, error) { return RebasePresencePeople, nil })
	// Reorder is an existing production trigger for a pending prefix change.
	owner, err := db.New(f.pool).GetUserByID(t.Context(), f.userID)
	require.NoError(t, err)
	session := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &owner, SessionHash: "owner-session"})
	_, err = f.service.ControlTodo(session, second.Number.Int64, TodoControlInput{Op: "move", Direction: "up", Repository: f.repoID, Actor: f.userID, Request: "move-second"})
	require.NoError(t, err)
	f.wake()
	held := f.item(second.Number.Int64)
	require.Equal(t, "rebase_pending", held.Reason)
	require.Equal(t, second.CandidateHead, held.CandidateHead)
	input := BranchRebaseInput{Rebase: true, Request: "press"}
	receipt, err := f.service.RebaseBranch(session, f.repoID, f.userID, branch, input)
	require.NoError(t, err)
	require.Equal(t, "accepted", receipt.State)
	require.Equal(t, held.CandidateHead, f.item(second.Number.Int64).CandidateHead, "admission returns before the worker executes")
	again, err := f.service.RebaseBranch(session, f.repoID, f.userID, branch, input)
	require.NoError(t, err)
	require.Equal(t, receipt, again)
	input.Request = "second-press"
	_, err = f.service.RebaseBranch(session, f.repoID, f.userID, branch, input)
	require.NoError(t, err)
	// Revoking the admitted credential before the worker runs does not grant
	// a presence override. The durable request remains for an authorized retry.
	_, err = f.pool.Exec(t.Context(), `UPDATE auth_sessions SET expires_at=NOW()-interval '1 hour' WHERE session_key='owner-session'`)
	require.NoError(t, err)
	f.wake()
	require.Equal(t, held.CandidateHead, f.item(second.Number.Int64).CandidateHead)
	require.Zero(t, f.verifies(held))
	_, err = f.pool.Exec(t.Context(), `UPDATE auth_sessions SET expires_at=NOW()+interval '1 hour' WHERE session_key='owner-session'`)
	require.NoError(t, err)
	f.wake()
	rebased := f.item(second.Number.Int64)
	require.Equal(t, "verifying", rebased.State, rebased.Reason)
	require.Equal(t, f.main, rebased.CandidateBase)
	require.NotEqual(t, held.CandidateHead, rebased.CandidateHead)
	require.Equal(t, held.Generation+1, rebased.Generation)
	require.Equal(t, 1, f.verifies(rebased))
	require.Equal(t, map[string]string{"person": owner.Username}, rebaseRequester(rebased))
	f.verify(rebased)
	for range 4 {
		f.wake()
		if f.item(second.Number.Int64).State == "proposed" {
			break
		}
	}
	published := f.item(second.Number.Int64)
	require.Equal(t, "proposed", published.State, published.Reason)
	require.Equal(t, second.PRNumber, published.PRNumber)
	require.NotEqual(t, oldPR, published.PRHead)
	require.Equal(t, published.PRHead, f.githubRef(branch))
	require.Equal(t, 1, f.verifies(published))
	input.Request = "press"
	again, err = f.service.RebaseBranch(session, f.repoID, f.userID, branch, input)
	require.NoError(t, err)
	require.Equal(t, receipt, again, "replay survives completion")
	require.Equal(t, []string{"Rebased onto main"}, f.rebasedActivity(published))
}

func TestRequestedRebaseBindsHeadGenerationAndOnto(t *testing.T) {
	for _, tc := range []struct {
		name    string
		change  func(*db.MythicalItem, *mythicalRebase)
		allowed bool
	}{
		{"bound", func(*db.MythicalItem, *mythicalRebase) {}, true},
		{"new head", func(i *db.MythicalItem, _ *mythicalRebase) { i.CandidateHead = "new" }, false},
		{"new generation", func(i *db.MythicalItem, _ *mythicalRebase) { i.Generation++ }, false},
		{"new target", func(_ *db.MythicalItem, r *mythicalRebase) { r.Onto = "new" }, false},
		{"completed", func(_ *db.MythicalItem, r *mythicalRebase) { r.Rebased = true }, false},
		{"occupied branch", func(i *db.MythicalItem, _ *mythicalRebase) { i.WorkspaceID = "awake" }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pending := &mythicalRebase{Onto: "main", Request: &mythicalRebaseRequest{Head: "candidate", Generation: 2}}
			item := db.MythicalItem{CandidateHead: "candidate", Generation: 2}
			tc.change(&item, pending)
			item.Checks = (mythicalChecks{Rebase: pending}).encode()
			require.Equal(t, tc.allowed, requestedRebase(item, "main"))
		})
	}
}

func TestBranchRebaseNowHandsConflictToExistingPath(t *testing.T) {
	f := newRebaseFixture(t)
	first := f.candidate("First", f.main, "JOURNEY.md", "first\n")
	f.wake()
	f.service.SetRebasePresence(func(context.Context, int64, string) (RebasePresence, error) { return RebasePresencePeople, nil })
	second := f.candidate("Second", f.main, "JOURNEY.md", "second\n")
	checks := mythicalChecksOf(second)
	checks.Branch = "smithers/second"
	second.Checks = checks.encode()
	second.WorkspaceID = ""
	_, err := db.New(f.pool).SaveMythicalItem(t.Context(), second)
	require.NoError(t, err)
	f.wake()
	held := f.item(second.Number.Int64)
	require.Equal(t, "rebase_pending", held.Reason)
	owner, err := db.New(f.pool).GetUserByID(t.Context(), f.userID)
	require.NoError(t, err)
	session := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &owner, SessionHash: "owner-session"})
	_, err = f.service.RebaseBranch(session, f.repoID, f.userID, "smithers/second", BranchRebaseInput{Rebase: true, Request: "conflict-press"})
	require.NoError(t, err)
	f.wake()
	conflict := f.item(second.Number.Int64)
	require.Equal(t, "rebase_conflict_pending", conflict.Reason)
	require.Equal(t, second.CandidateHead, conflict.CandidateHead)
	require.Contains(t, string(conflict.Integration), first.CandidateHead)
	require.Contains(t, string(conflict.Integration), "JOURNEY.md")
	for range 3 {
		f.wake()
	}
	require.Equal(t, conflict.Attempt, f.item(second.Number.Int64).Attempt)
	require.Zero(t, f.verifies(second))
}
