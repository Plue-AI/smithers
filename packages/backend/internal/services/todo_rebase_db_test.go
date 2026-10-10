package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// rebaseFixture is the install with TODO publication composed (GitHub fake
// over a real bare repository, real git and PostgreSQL) and a recording
// launcher, so integrate's rebase and its coding/verify launch are real
// up to the run, which the test answers as flowdispatch would.
type rebaseFixture struct {
	*publicationFixture
	launcher *fakeMythicalLauncher
}

func newRebaseFixture(t *testing.T) *rebaseFixture {
	f := newPublicationFixture(t, false)
	launcher := &fakeMythicalLauncher{}
	f.service.SetLauncher(launcher)
	f.service.SetPolicyReader(policyHost{mythicalPolicy("")})
	return &rebaseFixture{publicationFixture: f, launcher: launcher}
}

// candidate files a TODO whose verified candidate on base adds path, run on
// its own branch machine with the plan's checks, as a finished run leaves it.
func (f *rebaseFixture) candidate(title, base, path, content string) db.MythicalItem {
	f.t.Helper()
	item := f.todo(title, title, base, path, content)
	item.WorkspaceID = uuid.NewString()
	item.Plan = json.RawMessage(`{"checks":[{"id":"checks/fast","tier":"fast","required":true},{"id":"checks/slow","tier":"slow","required":true}]}`)
	item, err := db.New(f.pool).SaveMythicalItem(context.Background(), item)
	require.NoError(f.t, err)
	return item
}

// verify answers item's latest coding/verify launch passed.
func (f *rebaseFixture) verify(item db.MythicalItem) flowdispatch.LaunchRequest {
	f.t.Helper()
	var request flowdispatch.LaunchRequest
	for _, launched := range f.launcher.all("coding/verify") {
		if strings.HasPrefix(launched.RequestID, "mythical:"+uuidString(item.ID)+":") {
			request = launched
		}
	}
	require.NotEmpty(f.t, request.RequestID, "a verification was launched")
	output := `{"status":"passed","failed":[],"receipts":[]}`
	runID := "run-" + uuid.NewString()
	update := flowdispatch.ProjectionUpdate{State: jobs.StateCompleted, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: request.Projection, RunID: runID,
		Run: &flowruntime.FlowRuntimeRun{RunID: runID, FinalOutput: &output}}}
	require.NoError(f.t, f.service.ProjectFlowRuntime(context.Background(), update))
	return request
}

// verifies counts the coding/verify launches of item.
func (f *rebaseFixture) verifies(item db.MythicalItem) int {
	count := 0
	for _, request := range f.launcher.all("coding/verify") {
		if strings.HasPrefix(request.RequestID, "mythical:"+uuidString(item.ID)+":") {
			count++
		}
	}
	return count
}

// rebasedActivity is item's "Rebased onto …" activity entries, in order.
func (f *rebaseFixture) rebasedActivity(item db.MythicalItem) []string {
	f.t.Helper()
	rows, err := f.pool.Query(context.Background(), `SELECT data->>'text' FROM product_job_events
		WHERE principal_id = $1 AND event_type = 'todo.rebased' ORDER BY sequence`, "todo:"+uuidString(item.ID))
	require.NoError(f.t, err)
	defer rows.Close()
	var out []string
	for rows.Next() {
		var text string
		require.NoError(f.t, rows.Scan(&text))
		out = append(out, text)
	}
	return out
}

// TestTodoRebaseOntoEarlierVerifiedHead is J7.1d: a later TODO built beside an
// earlier one rebases onto the earlier TODO's verified head, its checks run
// once on the rebased commit, and its draft PR includes the earlier TODO.
func TestTodoRebaseOntoEarlierVerifiedHead(t *testing.T) {
	f := newRebaseFixture(t)
	// This fixture retains three coding workspaces. Leave each a slot to
	// verify its rebase; capacity refusal is covered separately.
	_, err := f.pool.Exec(context.Background(), `UPDATE mythical_stacks SET max_parallel = 3 WHERE repository_id = $1`, f.repoID)
	require.NoError(t, err)
	first := f.candidate("Add a greeting to JOURNEY.md", f.main, "JOURNEY.md", "Hello from T1\n")
	second := f.candidate("Wave goodbye", f.main, "GOODBYE.md", "Bye from T2\n")
	// A plan that found no checks (No checks found) verifies with none.
	third := f.candidate("Say thanks", f.main, "THANKS.md", "Thanks from T3\n")
	third.Plan = json.RawMessage(`{"title":"Say thanks","checks":null}`)
	third, err = db.New(f.pool).SaveMythicalItem(context.Background(), third)
	require.NoError(t, err)

	// One claim proposes T1, finds T2 built beside it (rebase_pending onto
	// T1) and, due at once, rebases T2 onto T1's verified head.
	f.wake()
	require.Equal(t, "proposed", f.item(first.Number.Int64).State)
	t2 := f.item(second.Number.Int64)
	require.Equal(t, "verifying", t2.State, t2.Reason)
	assert.Equal(t, "working", f.card(second.Number.Int64)["state"], "no pull request yet: it is working")
	assert.Equal(t, first.CandidateHead, t2.CandidateBase, "T2's base is T1's verified head")
	assert.NotEqual(t, second.CandidateHead, t2.CandidateHead)
	assert.Equal(t, second.Generation+1, t2.Generation)
	assert.Nil(t, f.card(second.Number.Int64)["rebase_pending"], "rebased: its checks run")
	var verify flowdispatch.LaunchRequest
	for _, launched := range f.launcher.all("coding/verify") {
		if strings.HasPrefix(launched.RequestID, "mythical:"+uuidString(t2.ID)+":") {
			verify = launched
		}
	}
	assert.Contains(t, string(verify.Payload), t2.CandidateHead)
	assert.Contains(t, string(verify.Payload), `"writes":["GOODBYE.md"]`)
	assert.Equal(t, t2.CandidateHead, f.hostRef("refs/smithers/workspaces/"+t2.WorkspaceID+"/sources/"+t2.CandidateHead), "the lane can import the rebased commit")
	assert.Equal(t, []string{"Rebased onto T1"}, f.rebasedActivity(t2))
	t3 := f.item(third.Number.Int64)
	require.Equal(t, "verifying", t3.State, t3.Reason)
	assert.Equal(t, first.CandidateHead, t3.CandidateBase, "T2 is not verified yet: T3's prefix is T1's head")
	assert.Contains(t, string(f.verify(t3).Payload), `"checks":[]`)

	f.verify(t2)
	f.wake()
	t2 = f.item(second.Number.Int64)
	require.Equal(t, "proposed", t2.State, t2.Reason)
	assert.Equal(t, 1, f.verifies(t2), "one verification")
	head := f.githubRef(mythicalChecksOf(t2).Branch)
	assert.Equal(t, t2.PRHead, head)
	assert.Equal(t, "Hello from T1", f.git(f.github, "show", head+":JOURNEY.md"), "the draft includes T1's change")
	assert.Equal(t, "Bye from T2", f.git(f.github, "show", head+":GOODBYE.md"))
	card := f.card(second.Number.Int64)
	assert.Equal(t, "in_review", card["state"])
	pr := card["pr"].(map[string]any)
	assert.Equal(t, true, pr["draft"])
	assert.Equal(t, []any{float64(first.Number.Int64), float64(second.Number.Int64)}, pr["included_items"])
	assert.Nil(t, mythicalChecksOf(t2).Rebase, "proposing the rebuilt generation ends the rebase")
}

// TestTodoRebaseWhenMainMoves is J7.4a: main moves under TODOs in review. The
// first rebuilds on the new main with one verification, its PR head moves and
// its approval is cleared; the one after it waits, then rebases once onto the
// first's new verified head. Both stay in review while they rebuild.
func TestTodoRebaseWhenMainMoves(t *testing.T) {
	f := newRebaseFixture(t)
	first := f.candidate("Add a greeting to JOURNEY.md", f.main, "JOURNEY.md", "Hello from T1\n")
	f.wake()
	t1 := f.item(first.Number.Int64)
	require.Equal(t, "proposed", t1.State, t1.Reason)
	second := f.candidate("Wave goodbye", t1.CandidateHead, "GOODBYE.md", "Bye from T2\n")
	f.wake()
	t2 := f.item(second.Number.Int64)
	require.Equal(t, "proposed", t2.State, t2.Reason)
	t1 = f.item(first.Number.Int64)
	oldHead1, oldHead2 := t1.PRHead, t2.PRHead
	// An approval of T1's head that GitHub refused stays as its receipt.
	checks := mythicalChecksOf(t1)
	checks.Land = &mythicalLand{By: "smithers-canary", Account: f.userID, Generation: t1.Generation, Session: "owner-session", Head: t1.PRHead,
		Refused: &mythicalMergeRefusal{Code: "github", Class: "github", Message: "Required status check is expected"}}
	t1.Checks = checks.encode()
	_, err := db.New(f.pool).SaveMythicalItem(context.Background(), t1)
	require.NoError(t, err)
	// In review, a TODO holds no lane (releaseLane); a rebuild verifies on a
	// fresh one, which the lanes from here on provide.
	_, err = f.pool.Exec(context.Background(), `UPDATE mythical_items SET workspace_id = '', lane = NULL, lane_started_at = NULL WHERE repository_id = $1`, f.repoID)
	require.NoError(t, err)
	lanes := &fakeMythicalLanes{}
	f.service.SetOrchestration(f.service.github, f.launcher, lanes)

	// main moves on GitHub with an unrelated change; the install folds it.
	f.git(f.work, "checkout", "-q", "main")
	f.commit("🔧 chore: outside", "OUTSIDE.md", "outside\n")
	newMain := f.publish()
	for i := 0; i < 4 && f.item(first.Number.Int64).State == "proposed"; i++ {
		f.wake()
	}
	t1 = f.item(first.Number.Int64)
	require.Contains(t, []string{"integrating", "verifying"}, t1.State, t1.Reason)
	card := f.card(first.Number.Int64)
	assert.Equal(t, "in_review", card["state"], "the PR stays in review while it rebuilds")
	assert.Equal(t, true, card["approval_cleared"])
	assert.Equal(t, map[string]any{"state": "waiting", "reason": "rechecking", "on_github": true}, card["merge"])
	assert.Nil(t, mythicalChecksOf(t1).Land, "the new generation voids the old head's approval")
	t2 = f.item(second.Number.Int64)
	assert.Equal(t, "integrating", t2.State, t2.Reason)
	assert.Equal(t, map[string]any{"onto": "T1", "onto_revision": newMain}, f.card(second.Number.Int64)["rebase_pending"], "T2 waits for T1's rebase")
	assert.Equal(t, "in_review", f.card(second.Number.Int64)["state"])

	f.wake()
	t1 = f.item(first.Number.Int64)
	require.Equal(t, "verifying", t1.State, t1.Reason)
	assert.Equal(t, newMain, t1.CandidateBase)
	assert.Contains(t, lanes.created, t1.WorkspaceID, "the rebuild verifies on a fresh lane")
	assert.Equal(t, 0, f.verifies(t2), "T2 does not rebase onto a prefix about to move")
	f.verify(t1)
	f.wake()
	t1 = f.item(first.Number.Int64)
	require.Equal(t, "proposed", t1.State, t1.Reason)
	assert.Equal(t, 1, f.verifies(t1), "one verification for the moved main")
	assert.NotEqual(t, oldHead1, t1.PRHead)
	head1 := f.githubRef(mythicalChecksOf(t1).Branch)
	assert.Equal(t, t1.PRHead, head1, "the PR head is updated")
	assert.Equal(t, newMain, f.git(f.github, "rev-parse", head1+"^"), "one commit on the new main")
	assert.Equal(t, "outside", f.git(f.github, "show", head1+":OUTSIDE.md"))
	assert.Nil(t, mythicalChecksOf(t1).Land)
	assert.Equal(t, []string{"Rebased onto main"}, f.rebasedActivity(t1))
	card = f.card(first.Number.Int64)
	assert.Equal(t, true, card["approval_cleared"], "until someone presses Merge again")
	assert.Equal(t, "ready", card["merge"].(map[string]any)["state"])

	// T2 now rebases once, onto T1's new verified head.
	t2 = f.item(second.Number.Int64)
	require.Equal(t, "verifying", t2.State, t2.Reason)
	assert.Equal(t, t1.CandidateHead, t2.CandidateBase)
	f.verify(t2)
	f.wake()
	t2 = f.item(second.Number.Int64)
	require.Equal(t, "proposed", t2.State, t2.Reason)
	assert.Equal(t, 1, f.verifies(t2))
	assert.NotEqual(t, oldHead2, t2.PRHead)
	head2 := f.githubRef(mythicalChecksOf(t2).Branch)
	assert.Equal(t, "Hello from T1", f.git(f.github, "show", head2+":JOURNEY.md"))
	assert.Equal(t, "outside", f.git(f.github, "show", head2+":OUTSIDE.md"))
	assert.Equal(t, []string{"Rebased onto T1"}, f.rebasedActivity(t2))
	assert.Nil(t, f.card(second.Number.Int64)["approval_cleared"], "T2 had no approval to clear")
}

// A moved prefix waits across polls while a person is editing, or the roster
// cannot prove who is present. Departure permits exactly one verification.
func TestTodoRebaseWaitsForPresence(t *testing.T) {
	f := newRebaseFixture(t)
	first := f.candidate("First", f.main, "FIRST.md", "first\n")
	second := f.candidate("Second", f.main, "SECOND.md", "second\n")
	presence := RebasePresenceUnknown
	f.service.SetRebasePresence(func(ctx context.Context, repository int64, workspace string) (RebasePresence, error) {
		require.Equal(t, f.repoID, repository)
		require.Equal(t, second.WorkspaceID, workspace)
		return presence, nil
	})
	for _, state := range []RebasePresence{RebasePresenceUnknown, RebasePresencePeople, RebasePresencePeople} {
		presence = state
		f.wake()
		held := f.item(second.Number.Int64)
		require.Equal(t, second.CandidateHead, held.CandidateHead)
		require.Equal(t, second.Generation, held.Generation)
		require.Equal(t, "rebase_pending", held.Reason)
		require.Equal(t, map[string]any{"onto": "T1", "onto_revision": first.CandidateHead}, f.card(second.Number.Int64)["rebase_pending"])
		require.Zero(t, f.verifies(held))
		require.Empty(t, f.rebasedActivity(held))
	}
	presence = RebasePresenceAgent
	f.wake()
	rebased := f.item(second.Number.Int64)
	require.Equal(t, first.CandidateHead, rebased.CandidateBase)
	require.NotEqual(t, second.CandidateHead, rebased.CandidateHead)
	require.Equal(t, "verifying", rebased.State)
	require.Equal(t, 1, f.verifies(rebased))
	f.wake()
	require.Equal(t, 1, f.verifies(rebased))
}

// A commit-only move of main still changes the candidate's ancestry contract.
// Equal trees cannot reuse the old generation, checks or merge approval.
func TestTodoRebaseEqualTreeNewBaseRequiresFreshVerification(t *testing.T) {
	f := newRebaseFixture(t)
	first := f.candidate("Greet", f.main, "JOURNEY.md", "Hello\n")
	f.wake()
	old := f.item(first.Number.Int64)
	require.Equal(t, "proposed", old.State, old.Reason)
	checks := mythicalChecksOf(old)
	checks.Land = &mythicalLand{By: "smithers-canary", Account: f.userID, Generation: old.Generation, Session: "owner-session", Head: old.PRHead}
	old.Checks = checks.encode()
	old.WorkspaceID = ""
	old.Lane = pgtype.Int4{}
	_, err := db.New(f.pool).SaveMythicalItem(context.Background(), old)
	require.NoError(t, err)
	f.service.SetOrchestration(f.service.github, f.launcher, &fakeMythicalLanes{})
	f.git(f.work, "checkout", "-q", "main")
	f.git(f.work, "commit", "-q", "--allow-empty", "-m", "main metadata changes")
	moved := f.publish()
	require.NotEqual(t, f.main, moved)
	require.Equal(t, f.hostTree(f.main), f.hostTree(moved))
	for range 4 {
		f.wake()
		if f.item(first.Number.Int64).State == "verifying" {
			break
		}
	}
	next := f.item(first.Number.Int64)
	require.Equal(t, "verifying", next.State, next.Reason)
	require.Equal(t, moved, next.CandidateBase)
	require.Equal(t, old.Generation+1, next.Generation)
	require.NotEqual(t, old.CandidateHead, next.CandidateHead)
	require.Equal(t, f.hostTree(old.CandidateHead), f.hostTree(next.CandidateHead))
	require.False(t, next.CandidateVerified)
	require.Nil(t, mythicalChecksOf(next).Land)
	require.Equal(t, 1, f.verifies(next))
	require.Equal(t, old.PRHead, f.githubRef(mythicalChecksOf(old).Branch), "retain the last verified publication while new checks run")
	f.verify(next)
	f.wake()
	published := f.item(first.Number.Int64)
	require.Equal(t, "proposed", published.State, published.Reason)
	require.True(t, published.CandidateVerified)
	require.Equal(t, next.Generation, published.Generation)
	require.Equal(t, 1, f.verifies(published))
	require.Equal(t, moved, f.git(f.github, "rev-parse", published.PRHead+"^"))
	require.Equal(t, f.hostTree(published.CandidateHead), f.git(f.github, "rev-parse", published.PRHead+"^{tree}"))
	require.Equal(t, "Hello", f.git(f.github, "show", published.PRHead+":JOURNEY.md"))
	// A retired review's checkpoint must not attach to the new review just
	// because both measure this generation. Production checkpoints carry
	// the dispatcher's existing machine/workspace target.
	review := mythicalChecksOf(published).Review
	require.NotNil(t, review)
	request := f.launcher.last(mythicalReviewFlow)
	require.Contains(t, request.RequestID, ":lane:"+review.Lane)
	var projected mythicalProjection
	require.NoError(t, json.Unmarshal(request.Projection, &projected))
	require.Equal(t, published.Generation, projected.Generation)
	staleTarget := request.Target
	staleTarget.WorkspaceID = "retired-review-lane"
	output := "approve"
	require.NoError(t, f.service.ProjectFlowRuntime(context.Background(), flowdispatch.ProjectionUpdate{
		State: jobs.StateCompleted,
		Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: request.Projection, Target: staleTarget, RunID: "stale-review",
			Run: &flowruntime.FlowRuntimeRun{RunID: "stale-review", FinalOutput: &output}},
	}))
	require.Equal(t, review, mythicalChecksOf(f.item(first.Number.Int64)).Review)
}

// A review machine reads an immutable PR; it cannot become the TODO's coding
// branch when main moves. Real database rows retain both machine identities.
func TestMainMoveUsesCodingBranchDuringIsolatedReview(t *testing.T) {
	for _, mode := range []string{"stopped", "suspended", "pending capture", "changed capture", "running", "completed coding"} {
		t.Run(mode, func(t *testing.T) {
			f := newRebaseFixture(t)
			item := f.candidate("Coding branch", f.main, "TODO.md", "work\n")
			f.wake()
			item = f.item(item.Number.Int64)
			require.Equal(t, "proposed", item.State)
			q := db.New(f.pool)
			status := "stopped"
			if mode == "running" || mode == "suspended" {
				status = mode
			}
			coding, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, Name: "coding", TargetBookmark: "mythical", Kind: "vm", Status: status})
			require.NoError(t, err)
			_, _, err = q.BindMythicalLane(t.Context(), db.MythicalLane{WorkspaceID: coding.ID, RepositoryID: f.repoID, ItemID: item.ID, Name: "TODO retained"})
			require.NoError(t, err)
			_, err = f.pool.Exec(t.Context(), `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, coding.ID, item.CandidateHead)
			require.NoError(t, err)
			// A retained branch's capture is published at its head ref; an asleep
			// rebase replaces exactly that ref (5ce63231ff).
			f.git(f.hostDir, "update-ref", repohost.BranchHeadRef(coding.ID), item.CandidateHead)
			if mode == "pending capture" {
				_, err = f.pool.Exec(t.Context(), `UPDATE workspaces SET capture_pending='{}' WHERE id=$1`, coding.ID)
				require.NoError(t, err)
			}
			review, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, Name: "review", TargetBookmark: "mythical", Kind: "vm", Status: "running"})
			require.NoError(t, err)
			_, _, err = q.BindMythicalLane(t.Context(), db.MythicalLane{WorkspaceID: review.ID, RepositoryID: f.repoID, ItemID: item.ID, Name: "TODO review g1"})
			require.NoError(t, err)
			item.WorkspaceID = review.ID
			checks := mythicalChecksOf(item)
			checks.Review = &mythicalReview{Lane: review.ID, Head: item.PRHead}
			if mode == "completed coding" {
				item.WorkspaceID = coding.ID
				item.RequestOutcome = "completed"
				checks.Review.Verdict = "approve"
			}
			item.Checks = checks.encode()
			_, err = q.SaveMythicalItem(t.Context(), item)
			require.NoError(t, err)
			lanes := &fakeMythicalLanes{}
			f.service.SetBranchRebaseExecutor(reviewRebaseRefusal{})
			f.service.SetOrchestration(f.service.github, f.launcher, lanes)
			f.service.SetRebasePresence(func(_ context.Context, repo int64, workspace string) (RebasePresence, error) {
				require.Equal(t, f.repoID, repo)
				require.Equal(t, coding.ID, workspace)
				return RebasePresenceEmpty, nil
			})
			f.git(f.work, "checkout", "-q", "main")
			f.commit("main moves", "OUTSIDE.md", "outside\n")
			main := f.publish()
			if mode == "changed capture" {
				_, err = f.pool.Exec(t.Context(), `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, coding.ID, main)
				require.NoError(t, err)
			}
			for range 2 {
				f.wake()
			}
			next := f.item(item.Number.Int64)
			switch mode {
			case "stopped", "suspended", "completed coding":
				require.Equal(t, "verifying", next.State, next.Reason)
				require.Equal(t, main, next.CandidateBase)
				require.NotEqual(t, review.ID, next.WorkspaceID)
				require.Equal(t, 1, f.verifies(next))
				if mode == "completed coding" {
					lane, err := q.GetMythicalLane(t.Context(), coding.ID)
					require.NoError(t, err)
					require.True(t, lane.RetiredAt.Valid, "main invalidation must not suppress completed coding retirement")
				}
			case "running":
				require.Equal(t, "integrating", next.State, next.Reason)
				require.Equal(t, coding.ID, next.WorkspaceID)
				require.Equal(t, 0, f.verifies(next))
				// 6acdad5848: restoring the coding branch retires the review
				// machine but keeps its attestation; verification of the rebased
				// patch decides whether it still applies.
				retained := mythicalChecksOf(next).Review
				require.NotNil(t, retained)
				require.Equal(t, item.PRHead, retained.Head)
				lane, err := q.GetMythicalLane(t.Context(), review.ID)
				require.NoError(t, err)
				require.True(t, lane.RetiredAt.Valid, "the stale isolated review machine is retired")
			default:
				require.Equal(t, "integrating", next.State, next.Reason)
				require.Equal(t, "rebase_pending", next.Reason)
				require.Equal(t, item.CandidateHead, next.CandidateHead)
				require.Equal(t, 0, f.verifies(next))
			}
		})
	}
}

// This refusal port proves the asleep path never contacts a daemon; the
// composed HTTP rehearsal supplies the real authenticated native provider.
type reviewRebaseRefusal struct{ failure error }

func (r reviewRebaseRefusal) Rebase(context.Context, string, int64, string, string, func(pgx.Tx) error, func(func() error) error) (machined.RewriteResult, error) {
	if r.failure != nil {
		return machined.RewriteResult{}, r.failure
	}
	return machined.RewriteResult{}, machined.ErrNotReady
}
func (reviewRebaseRefusal) Capture(context.Context, string) (machined.CaptureResult, error) {
	return machined.CaptureResult{}, machined.ErrNotReady
}

func TestNativeRebaseBoundaryChangeRetainsPendingSnapshot(t *testing.T) {
	item := db.MythicalItem{WorkspaceID: "coding", State: "integrating", Reason: "rebase_pending", CandidateBase: "before", CandidateHead: "captured", Attempt: 2, Generation: 3}
	step := mythicalItemStep{s: &MythicalService{branchRebase: reviewRebaseRefusal{failure: fmt.Errorf("native rebase: %w", db.ErrMythicalItemMoved)}}, r: &mythicalRun{row: db.MythicalStack{ActorUserID: pgtype.Int8{Int64: 1, Valid: true}}}}
	next, saved, err := step.executeNativeRebase(t.Context(), item, "main")
	require.ErrorIs(t, err, db.ErrMythicalItemMoved)
	require.Nil(t, next, "a stale presence boundary cannot persist an outage or overwrite the item")
	require.False(t, saved)
	now := time.Now()
	require.Equal(t, now, mythicalStepFailedDue(err, now), "fresh state is read at the next claim, within the follow-main bound")
}

func TestNativeRebaseFenceReadsPresenceBeforeWorkspaceMutationLock(t *testing.T) {
	f := newRebaseFixture(t)
	item := f.candidate("Native boundary", f.main, "TODO.md", "work\n")
	q := db.New(f.pool)
	branch, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, Name: "coding", TargetBookmark: "mythical", Kind: "vm", Status: "running"})
	require.NoError(t, err)
	item.WorkspaceID = branch.ID
	item, err = q.SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `UPDATE mythical_stacks SET running=true,claim=claim+1,lease_expires_at=NOW()+INTERVAL '5 minutes' WHERE repository_id=$1`, f.repoID)
	require.NoError(t, err)
	stack, err := q.GetMythicalStack(t.Context(), f.repoID)
	require.NoError(t, err)
	reads := 0
	f.service.SetRebasePresence(func(ctx context.Context, repository int64, workspace string) (RebasePresence, error) {
		reads++
		require.Equal(t, f.repoID, repository)
		require.Equal(t, branch.ID, workspace)
		// Host resolution independently takes this SHARE lock. It must not
		// wait for the native fence's own mutation transaction to finish.
		read, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		tx, err := f.pool.Begin(read)
		if err != nil {
			return RebasePresenceUnknown, err
		}
		defer tx.Rollback(context.WithoutCancel(read))
		var id string
		err = tx.QueryRow(read, `SELECT id FROM workspaces WHERE id=$1 FOR SHARE`, workspace).Scan(&id)
		if err != nil {
			return RebasePresenceUnknown, err
		}
		return RebasePresenceEmpty, nil
	})
	tx, err := f.pool.Begin(t.Context())
	require.NoError(t, err)
	defer tx.Rollback(context.WithoutCancel(t.Context()))
	step := mythicalItemStep{s: f.service, r: &mythicalRun{row: stack, owner: "rehearsal-owner", repo: "app", mainTip: f.main}}
	require.NoError(t, step.lockNativeRebase(t.Context(), tx, item, f.main))
	require.Equal(t, 2, reads, "presence is rechecked before and under the native fence")
}

func TestNativeRebaseFencePreservesObservedPause(t *testing.T) {
	f := newRebaseFixture(t)
	item := f.candidate("Native boundary", f.main, "TODO.md", "work\n")
	q := db.New(f.pool)
	branch, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, Name: "coding", TargetBookmark: "mythical", Kind: "vm", Status: "running"})
	require.NoError(t, err)
	item.WorkspaceID = branch.ID
	item, err = q.SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `UPDATE mythical_stacks SET running=true,claim=claim+1,lease_expires_at=NOW()+INTERVAL '5 minutes' WHERE repository_id=$1`, f.repoID)
	require.NoError(t, err)
	stack, err := q.GetMythicalStack(t.Context(), f.repoID)
	require.NoError(t, err)
	reads := 0
	f.service.SetRebasePresence(func(ctx context.Context, repository int64, workspace string) (RebasePresence, error) {
		reads++
		require.Equal(t, f.repoID, repository)
		require.Equal(t, branch.ID, workspace)
		// Host resolution independently takes this SHARE lock. It must not
		// wait for the native fence's own mutation transaction to finish.
		read, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		tx, err := f.pool.Begin(read)
		if err != nil {
			return RebasePresenceUnknown, err
		}
		defer tx.Rollback(context.WithoutCancel(read))
		var id string
		err = tx.QueryRow(read, `SELECT id FROM workspaces WHERE id=$1 FOR SHARE`, workspace).Scan(&id)
		if err != nil {
			return RebasePresenceUnknown, err
		}
		return RebasePresenceEmpty, nil
	})
	for _, c := range []struct {
		name, observed, current string
		allow                   bool
	}{
		{"unchanged-running", "NULL", "NULL", true},
		{"unchanged-paused", "'2026-10-02T12:00:00Z'", "'2026-10-02T12:00:00Z'", true},
		{"new-pause", "NULL", "'2026-10-02T12:00:00Z'", false},
		{"resumed", "'2026-10-02T12:00:00Z'", "NULL", false},
		{"new-pause-time", "'2026-10-02T12:00:00Z'", "'2026-10-02T12:00:01Z'", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, err = f.pool.Exec(t.Context(), `UPDATE mythical_items SET paused_at=`+c.observed+` WHERE id=$1`, item.ID)
			require.NoError(t, err)
			snapshot, err := q.GetMythicalItem(t.Context(), item.ID)
			require.NoError(t, err)
			_, err = f.pool.Exec(t.Context(), `UPDATE mythical_items SET paused_at=`+c.current+` WHERE id=$1`, item.ID)
			require.NoError(t, err)
			tx, err := f.pool.Begin(t.Context())
			require.NoError(t, err)
			defer tx.Rollback(context.WithoutCancel(t.Context()))
			step := mythicalItemStep{s: f.service, r: &mythicalRun{row: stack, owner: "rehearsal-owner", repo: "app", mainTip: f.main}}
			err = step.lockNativeRebase(t.Context(), tx, snapshot, f.main)
			if c.allow {
				require.NoError(t, err)
			} else {
				require.ErrorIs(t, err, db.ErrMythicalItemMoved)
			}
		})
	}
}
