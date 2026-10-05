package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
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
	first := f.candidate("Add a greeting to JOURNEY.md", f.main, "JOURNEY.md", "Hello from T1\n")
	second := f.candidate("Wave goodbye", f.main, "GOODBYE.md", "Bye from T2\n")
	// A plan that found no checks (No checks found) verifies with none.
	third := f.candidate("Say thanks", f.main, "THANKS.md", "Thanks from T3\n")
	third.Plan = json.RawMessage(`{"title":"Say thanks","checks":null}`)
	third, err := db.New(f.pool).SaveMythicalItem(context.Background(), third)
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
	assert.Equal(t, map[string]any{"onto": "T1"}, f.card(second.Number.Int64)["rebase_pending"], "T2 waits for T1's rebase")
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
