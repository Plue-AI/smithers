package services

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// QA matrix: every inbound GitHub event (spec §12.3) against every stored
// TODO state (§4.1). Oracles are the spec text cited on each row, never the
// implementation. A cell whose outcome the spec does not decide is "gap": it
// logs what the code does (QACELL lines) and asserts nothing.
//
// Pure seams used: Transition, ProjectItemState, todoItemPath (together the
// pure core of TodoService.projectItem), mythicalAuthorize, mythicalAdmission
// and, through httptest, the label history reader. Paths that need
// PostgreSQL are listed in the QA report, not tested here.

const qaGap = "gap"

var qaStates = []TodoState{TodoQueued, TodoStarting, TodoWorking, TodoNeedsYou, TodoPaused, TodoFailed, TodoInReview, TodoMerged, TodoDropped}

func qaOutcome(from TodoState, trigger TodoTrigger, g TodoGuard) string {
	ev, err := Transition(from, trigger, g)
	if err != nil {
		return "refused"
	}
	return string(ev.To)
}

func qaCheck(t *testing.T, event string, from TodoState, want, got, spec string) {
	t.Helper()
	status := "PASS"
	switch {
	case want == qaGap:
		status = "GAP"
	case want != got:
		status = "FAIL"
	}
	t.Logf("QACELL|%s|%s|want=%s|got=%s|%s|%s", event, from, want, got, status, spec)
	if want != qaGap {
		assert.Equal(t, want, got, "%s while %s (%s)", event, from, spec)
	}
}

func qaMember() TodoActor    { return TodoPerson(7, "github") }
func qaNonMember() TodoActor { return TodoActor{System: "github"} } // {github: login} is never a member

func qaGuard(actor TodoActor) TodoGuard {
	return TodoGuard{Actor: actor, Cause: "github", Now: todoTestNow, PRHeadVerified: true, HasPR: true, OnMain: true,
		WaitKind: TodoWaitForeignPush, OpenWaitKind: TodoWaitForeignPush,
		DroppedAt: todoTestNow.Add(-24 * time.Hour), HeadCaptured: true}
}

// §12.3 "TODO PR merged -> merged" and §4.1 row "in_review, working,
// needs_you, paused -> merged ... a merge on GitHub counts from any unmerged
// state (M-22)"; tech lead ruling 2026-10-02.
func TestQAGitHubPRMergedAcrossStates(t *testing.T) {
	spec := "spec §4.1 in_review,working,needs_you,paused -> merged"
	want := map[TodoState]string{
		TodoQueued: qaGap, TodoStarting: qaGap, TodoFailed: qaGap, // spec lists four states; "any unmerged state" prose covers these
		TodoWorking: "merged", TodoNeedsYou: "merged", TodoPaused: "merged", TodoInReview: "merged",
		TodoMerged: qaGap, TodoDropped: qaGap, // duplicate / merge after close: undecided
	}
	for _, s := range qaStates {
		qaCheck(t, "pr_merged", s, want[s], qaOutcome(s, TodoPRMerged, qaGuard(TodoActor{System: "github"})), spec)
	}
	// "and main contains the commit": until it does, nothing moves.
	g := qaGuard(TodoActor{System: "github"})
	g.OnMain = false
	for _, s := range []TodoState{TodoWorking, TodoNeedsYou, TodoPaused, TodoInReview} {
		qaCheck(t, "pr_merged_main_lacks_commit", s, "refused", qaOutcome(s, TodoPRMerged, g), "spec §4.1 guard: main contains the commit")
	}
}

// The same transition ends the work: "cancels the attempt's run, settles
// every open wait and clears needs_you and paused_at" (§4.1).
func TestQAGitHubMergeAndCloseEndTheWork(t *testing.T) {
	for _, s := range []TodoState{TodoWorking, TodoNeedsYou, TodoPaused, TodoInReview} {
		ev, err := Transition(s, TodoPRMerged, qaGuard(TodoActor{System: "github"}))
		require.NoError(t, err, s)
		assert.True(t, ev.EndsWork, "merge from %s ends the work", s)
		assert.False(t, ev.VoidApprovals)
	}
	for _, s := range []TodoState{TodoQueued, TodoStarting, TodoWorking, TodoNeedsYou, TodoPaused, TodoFailed, TodoInReview} {
		ev, err := Transition(s, TodoPRClosed, qaGuard(TodoActor{System: "github"}))
		require.NoError(t, err, s)
		assert.True(t, ev.EndsWork, "close from %s ends the work", s)
	}
}

// §12.3 "TODO PR closed unmerged -> dropped" and §4.1 "any unmerged -> dropped".
func TestQAGitHubPRClosedAcrossStates(t *testing.T) {
	spec := "spec §4.1 any unmerged -> dropped; §12.3 closed unmerged"
	want := map[TodoState]string{TodoQueued: "dropped", TodoStarting: "dropped", TodoWorking: "dropped", TodoNeedsYou: "dropped",
		TodoPaused: "dropped", TodoFailed: "dropped", TodoInReview: "dropped", TodoMerged: qaGap, TodoDropped: qaGap}
	for _, s := range qaStates {
		qaCheck(t, "pr_closed", s, want[s], qaOutcome(s, TodoPRClosed, qaGuard(TodoActor{System: "github"})), spec)
	}
	g := qaGuard(TodoActor{System: "github"})
	g.HasPR = false
	for _, s := range []TodoState{TodoWorking, TodoInReview} {
		qaCheck(t, "pr_closed_no_pr", s, qaGap, qaOutcome(s, TodoPRClosed, g), "a close event always names a PR; spec silent")
	}
}

// §4.1 "dropped -> in_review: reopened on GitHub within 7 days"; §12.3.
func TestQAGitHubPRReopened(t *testing.T) {
	g := qaGuard(TodoActor{System: "github"})
	for _, s := range qaStates {
		want := qaGap // a reopen of a PR that is not closed (reopen before close): undecided
		if s == TodoDropped {
			want = "in_review"
		}
		qaCheck(t, "pr_reopened_1d", s, want, qaOutcome(s, TodoPRReopened, g), "spec §4.1 dropped -> in_review within 7 days")
	}
	cases := []struct {
		name string
		age  time.Duration
		head bool
		want string
	}{
		{"6d23h", 7*24*time.Hour - time.Hour, true, "in_review"},
		{"exactly 7d", 7 * 24 * time.Hour, true, "in_review"}, // "within 7 days" includes the boundary
		{"7d+1s", 7*24*time.Hour + time.Second, true, "refused"},
		{"30d", 30 * 24 * time.Hour, true, "refused"},
		{"1d no captured head", 24 * time.Hour, false, "refused"}, // branch cannot be recreated
	}
	for _, c := range cases {
		g := qaGuard(TodoActor{System: "github"})
		g.DroppedAt, g.HeadCaptured = todoTestNow.Add(-c.age), c.head
		qaCheck(t, "pr_reopened_"+c.name, TodoDropped, c.want, qaOutcome(TodoDropped, TodoPRReopened, g), "spec §4.1/§12.3 7-day window")
	}
}

// §12.3 review row: from a member "in_review -> working", one steer per
// submission; elsewhere the steer is delivered with no state change. From a
// non-member: "shown in activity ... and never delivered as a steer".
func TestQAGitHubReviewChangesRequestedMemberVsNonMember(t *testing.T) {
	// Member: Transition(ChangesRequested) when in review, else a steer.
	member := func(s TodoState) string {
		if got := qaOutcome(s, TodoChangesRequested, qaGuard(qaMember())); got != "refused" {
			return got
		}
		return qaOutcome(s, TodoSteer, qaGuard(qaMember()))
	}
	want := map[TodoState]string{TodoQueued: "queued", TodoStarting: "starting", TodoWorking: "working", TodoNeedsYou: "needs_you",
		TodoPaused: "paused", TodoInReview: "working", TodoFailed: qaGap, TodoMerged: qaGap, TodoDropped: qaGap}
	for _, s := range qaStates {
		qaCheck(t, "review_changes_requested_member", s, want[s], member(s), "spec §12.3 review row; §10.7.3 steer held/delivered")
	}
	// Non-member: the TODO must not move. A refusal is an acceptable seam
	// outcome (the caller records activity only); a transition is not.
	for _, s := range qaStates {
		got := qaOutcome(s, TodoChangesRequested, qaGuard(qaNonMember()))
		ok := "unchanged"
		if got != "refused" && got != string(s) {
			ok = got
		}
		qaCheck(t, "review_changes_requested_nonmember", s, "unchanged", ok, "spec §12.3: non-member review never delivered as a steer")
	}
}

func TestQAGitHubReviewCommentMemberVsNonMember(t *testing.T) {
	for _, s := range qaStates {
		want := qaGap
		if s == TodoInReview {
			want = "working"
		}
		qaCheck(t, "review_comment_member", s, want, qaOutcome(s, TodoReviewComment, qaGuard(qaMember())), "spec §12.3 member comment: in_review -> working")
	}
	for _, s := range qaStates {
		got := qaOutcome(s, TodoReviewComment, qaGuard(qaNonMember()))
		if got == string(s) {
			got = "refused"
		}
		qaCheck(t, "review_comment_nonmember", s, "refused", got, "spec §12.3 non-member comment is activity only")
	}
}

// §12.3 "Review approved -> recorded on the PR card. Not a Smithers approval":
// no trigger may move a TODO for an approve.
func TestQAGitHubApproveIsNotATransition(t *testing.T) {
	for _, trigger := range TodoTriggers {
		assert.NotContains(t, string(trigger), "approv", "spec §12.3: a GitHub approval has no TODO trigger")
	}
}

// §12.3 "Checks finished on a TODO PR head -> Evidence updated" with no state
// qualifier; §4.1 says a steer never converts the PR to draft, so a PR with
// checks exists in working, needs_you and paused as well. A refusal here is
// the bug class: an event refused in a state the author did not anticipate.
func TestQAGitHubChecksUpdatedAcrossStates(t *testing.T) {
	for _, s := range qaStates {
		want := qaGap
		switch s {
		case TodoInReview:
			want = "in_review"
		case TodoWorking, TodoNeedsYou, TodoPaused:
			want = string(s) // evidence updates, state stays
		}
		qaCheck(t, "checks_updated", s, want, qaOutcome(s, TodoChecksUpdated, qaGuard(TodoActor{System: "github"})), "spec §12.3 checks row (no state qualifier); §4.1 steer keeps PR ready")
	}
}

// §12.3 "Push to smithers/<slug> by anyone other than Smithers ->
// needs_you{foreign_push}, whether the TODO is working or in review".
func TestQAGitHubForeignPushAcrossStates(t *testing.T) {
	for _, s := range qaStates {
		want := qaGap
		if s == TodoWorking || s == TodoInReview {
			want = "needs_you"
		}
		qaCheck(t, "foreign_push", s, want, qaOutcome(s, TodoWaitOpened, qaGuard(TodoActor{System: "github"})), "spec §12.3 foreign push row")
	}
	// A second push while the first wait is open (duplicate delivery, or a
	// second commit): §4.1 gives needs_you no wait_opened edge; the spec is
	// silent, observed refusal logged.
	qaCheck(t, "foreign_push_second_while_open", TodoNeedsYou, qaGap, qaOutcome(TodoNeedsYou, TodoWaitOpened, qaGuard(TodoActor{System: "github"})), "spec silent")
}

// Duplicates through the projection: the engine writes level state (§12.2.4
// "the fetch is the final state"), so a second identical item write must be a
// no-op with no new events, never a refusal.
func qaProject(from TodoState, item db.MythicalItem) (TodoState, []TodoEvent, error) {
	todo := db.Todo{State: string(from)}
	// Fixture correction to the copied p2 matrix: a reopen a day after
	// its drop has a captured PR head (§4.1 line 235 / §12.3 line 1128
	// at 2be05ba6). The original helper omitted both guard inputs. Keep
	// the expected outcomes and production reopen guards unchanged.
	if from == TodoDropped && item.State == "proposed" {
		todo.DroppedAt = pgtype.Timestamptz{Time: todoTestNow.Add(-24 * time.Hour), Valid: true}
		if item.PRHead == "" {
			item.PRHead = "qa-captured-head"
		}
	}
	target := ProjectItemState(item, todo)
	if target == from {
		return from, nil, nil
	}
	path := todoItemPath(from, target, item)
	if path == nil {
		return from, nil, &TodoTransitionRefused{From: from, Trigger: TodoTrigger("item:" + item.State), Reason: "no transition reaches " + string(target)}
	}
	s := from
	var events []TodoEvent
	for _, trig := range path {
		ev, err := Transition(s, trig, TodoGuard{Actor: todoStackActor, Now: todoTestNow, MachineGranted: true,
			PRHeadVerified: item.CandidateVerified, HasPR: item.PRNumber.Valid, OnMain: item.PRMergeCommit != "",
			DroppedAt: todo.DroppedAt.Time, HeadCaptured: item.PRHead != ""})
		if err != nil {
			return from, nil, err
		}
		events = append(events, ev)
		s = ev.To
	}
	return s, events, nil
}

func qaPR() pgtype.Int8 { return pgtype.Int8{Int64: 42, Valid: true} }

// What a merged PR does to the item (follow: mythicalLanded) projected onto
// every TODO state. Terminal item states win (ruling 2026-10-02).
func TestQAGitHubMergedItemProjectsOntoEveryTodoState(t *testing.T) {
	landed := mythicalLanded(db.MythicalItem{State: "proposed", PRNumber: qaPR(), CandidateVerified: true, VibeRunID: "r"}, "abc123", todoTestNow)
	for _, s := range qaStates {
		got, _, err := qaProject(s, landed)
		out := string(got)
		if err != nil {
			out = "refused"
		}
		want := "merged"
		if s == TodoQueued || s == TodoStarting || s == TodoFailed || s == TodoDropped {
			want = qaGap
		}
		qaCheck(t, "item_landed_projection", s, want, out, "ruling 2026-10-02 any unmerged non-terminal -> merged; terminal item state wins")
		if s == TodoMerged {
			_, events, err := qaProject(s, landed)
			require.NoError(t, err)
			assert.Empty(t, events, "duplicate merge delivery appends no event")
		}
	}
}

// Closed unmerged (follow sets state rejected) projected onto every state.
func TestQAGitHubClosedItemProjectsOntoEveryTodoState(t *testing.T) {
	rejected := db.MythicalItem{State: "rejected", PRState: "closed", PRNumber: qaPR()}
	for _, s := range qaStates {
		got, events, err := qaProject(s, rejected)
		out := string(got)
		if err != nil {
			out = "refused"
		}
		want := "dropped"
		if s == TodoMerged {
			want = qaGap
		}
		qaCheck(t, "item_rejected_projection", s, want, out, "spec §4.1 any unmerged -> dropped")
		if s.unmerged() && err == nil {
			require.Len(t, events, 1)
			assert.Equal(t, TodoPRClosed, events[0].Kind, "closed on GitHub is pr_closed, not drop")
		}
	}
}

// Reorderings and duplicates. close-before-merge: item rejected, then the
// merge is observed (follow never reads a settled item, so the item write
// is landed after rejected). Terminal wins: the projection of landed over a
// dropped TODO must be merged; today the path does not exist.
func TestQAGitHubOutOfOrderAndDuplicateDelivery(t *testing.T) {
	landed := mythicalLanded(db.MythicalItem{State: "proposed", PRNumber: qaPR(), CandidateVerified: true}, "abc", todoTestNow)
	rejected := db.MythicalItem{State: "rejected", PRState: "closed", PRNumber: qaPR()}

	// duplicates: merge x3, close x3 against every unmerged state converge and the 2nd/3rd append nothing.
	for _, from := range []TodoState{TodoWorking, TodoNeedsYou, TodoPaused, TodoInReview} {
		state, ev1, err := qaProject(from, landed)
		require.NoError(t, err)
		require.Len(t, ev1, 1)
		for i := 0; i < 2; i++ {
			next, ev, err := qaProject(state, landed)
			require.NoError(t, err, "duplicate merge #%d from %s", i+2, from)
			assert.Empty(t, ev)
			assert.Equal(t, TodoMerged, next)
		}
	}
	for _, from := range []TodoState{TodoQueued, TodoStarting, TodoWorking, TodoNeedsYou, TodoPaused, TodoFailed, TodoInReview} {
		state, _, err := qaProject(from, rejected)
		require.NoError(t, err)
		for i := 0; i < 2; i++ {
			next, ev, err := qaProject(state, rejected)
			require.NoError(t, err, "duplicate close #%d from %s", i+2, from)
			assert.Empty(t, ev)
			assert.Equal(t, TodoDropped, next)
		}
	}

	// close before merge: the TODO is dropped, then GitHub says merged
	// (webhook for the close beat the poll that saw the merge; or a PR closed
	// and the commit reached main another way). Spec 12.3 says the fetch is
	// the final state; M-22 says GitHub merge counts from any unmerged
	// state. A dropped TODO is terminal, so the spec is silent.
	_, _, err := qaProject(TodoDropped, landed)
	t.Logf("QACELL|close_then_merge|dropped|want=gap|got=%v|GAP|spec silent; todoItemPath(dropped,merged)=nil so projectItem's restart branch adopts a SECOND TODO (needs DB to confirm)", err)
	// merge then close: merged is terminal, close must not undo it.
	state, _, err := qaProject(TodoMerged, rejected)
	t.Logf("QACELL|merge_then_close|merged|want=gap|got=%s err=%v|GAP|spec silent", state, err)
	if err == nil {
		assert.Equal(t, TodoMerged, state, "a merged TODO never becomes dropped")
	}
	// reopen before close: dropped-only edge; reopening a TODO still
	// unmerged has no transition. Level-based: item back to proposed
	// projects in_review with no event for an in_review TODO.
	proposed := db.MythicalItem{State: "proposed", PRNumber: qaPR(), CandidateVerified: true}
	st, ev, err := qaProject(TodoInReview, proposed)
	require.NoError(t, err)
	assert.Equal(t, TodoInReview, st)
	assert.Empty(t, ev, "reopen delivered before close changes nothing")
	// reopen after close, within 7 days (spec 12.3): in_review again.
	_, _, err = qaProject(TodoDropped, proposed)
	t.Logf("QACELL|reopen_after_drop_via_item_path|dropped|want=in_review|got=%v|%s|spec §4.1 dropped -> in_review; todoItemPath has no dropped->in_review edge, projectItem restarts as a new TODO", err, map[bool]string{true: "FAIL", false: "PASS"}[err != nil])
	assert.NoError(t, err, "reopen within 7 days restores in_review through the item projection")
	if err == nil {
		st, _, _ = qaProject(TodoDropped, proposed)
		assert.Equal(t, TodoInReview, st)
	}
}

// Merge from a state the author did not anticipate must not need a new edge
// per state: todoItemPath and Transition agree for every (from) with a landed item.
func TestQAGitHubItemPathAndTransitionAgreeOnMerge(t *testing.T) {
	for _, from := range qaStates {
		path := todoItemPath(from, TodoMerged, db.MythicalItem{State: "landed", PRMergeCommit: "m", PRNumber: qaPR()})
		_, err := Transition(from, TodoPRMerged, TodoGuard{OnMain: true})
		qaCheck(t, "merge_edge_agreement", from, map[bool]string{true: "has-path", false: "no-path"}[err == nil], map[bool]string{true: "has-path", false: "no-path"}[path != nil], "todoItemPath must agree with Transition")
	}
	// merged_via accepts every unmerged state while pr_merged refuses three of them.
	for _, from := range []TodoState{TodoQueued, TodoStarting, TodoFailed} {
		via := qaOutcome(from, TodoMergedVia, TodoGuard{OnMain: true})
		direct := qaOutcome(from, TodoPRMerged, TodoGuard{OnMain: true})
		qaCheck(t, "merged_via_vs_pr_merged", from, via, direct, "same fact (main contains the item), same outcome expected")
	}
}

// §10.2.1 / §12.3 todo label: a member's label creates the TODO; a
// non-member's is reverted and never creates one. Removed and re-added: only
// a member's application counts; a removal by a named maintainer opts out.
func TestQAGitHubTodoLabelAuthorization(t *testing.T) {
	policy := factoryGitHubPolicy{Maintainers: []string{"alice"}}
	issue := mythicalIssue{Number: 5, State: "open", Labels: []string{"todo"}}
	rows := []struct {
		name    string
		applied gitHubLabelApplication
		wantBy  bool
		spec    string
	}{
		{"labeled by member", gitHubLabelApplication{Label: "todo", By: "alice", ByMaintainer: true}, true, "§12.3 labeled todo by a member -> TODO"},
		{"labeled by non-member", gitHubLabelApplication{Label: "todo", By: "mallory", ByMaintainer: true}, false, "§12.3 labels by non-members are reverted"},
		{"labeled by write-access person not in the policy list", gitHubLabelApplication{Label: "todo", By: "bob", ByMaintainer: true}, false, "§12.3 members only"},
		{"labeled by an app (stamp false)", gitHubLabelApplication{Label: "todo", By: "bot", ByMaintainer: false}, false, "§12.3 members only"},
		{"removed by member", gitHubLabelApplication{Label: "todo", By: "alice", Removed: true}, true, "removal by a member counts (opt-out)"},
		{"removed by non-member", gitHubLabelApplication{Label: "todo", By: "mallory", Removed: true}, false, "removal by a non-member counts for nothing"},
	}
	for _, r := range rows {
		got := mythicalAuthorize(policy, r.applied, issue)
		assert.Equal(t, r.wantBy, got.ByMaintainer, "%s (%s)", r.name, r.spec)
		t.Logf("QACELL|label:%s|n/a|want=by_maintainer=%v|got=%v|%s|%s", r.name, r.wantBy, got.ByMaintainer, map[bool]string{true: "PASS", false: "FAIL"}[got.ByMaintainer == r.wantBy], r.spec)
	}
	// Removed and re-added by the same member is a fresh application with a new event id.
	a := mythicalAuthorize(policy, gitHubLabelApplication{Label: "todo", By: "alice", ByMaintainer: true, EventID: 9}, issue)
	assert.True(t, a.ByMaintainer)
	assert.Equal(t, int64(9), a.EventID)
}

// Issue edited / closed: admission is decided before any model. A closed
// issue is never queued (§10.2.1); an open unapproved issue is skipped, an
// approved one queued; PRs are never TODOs.
func TestQAGitHubIssueAdmission(t *testing.T) {
	open := mythicalIssue{Number: 1, State: "open", Labels: []string{"todo"}}
	state, _ := mythicalAdmission(open, true)
	assert.Equal(t, "queued", state, "label by member, text approved")
	state, _ = mythicalAdmission(open, false)
	assert.Equal(t, "skipped", state, "label present but text edited after approval needs a new label")
	closed := open
	closed.State = "closed"
	for _, approved := range []bool{true, false} {
		state, _ = mythicalAdmission(closed, approved)
		assert.Equal(t, "cancelled", state, "closed issue (approved=%v)", approved)
	}
	closed.State = "CLOSED"
	state, _ = mythicalAdmission(closed, true)
	assert.Equal(t, "cancelled", state, "state compare is case-insensitive")
	pr := open
	pr.PullRequest = true
	state, _ = mythicalAdmission(pr, true)
	assert.Equal(t, "skipped", state, "a PR is never a TODO")
	// a cancelled item (closed issue) projects dropped only when it has a TODO (item.TodoID); never a TODO of its own.
	assert.False(t, mythicalItemIsTodo(db.MythicalItem{State: "cancelled"}))
}

// Label history reader: labeled, removed, re-added, by member and non-member,
// delivered in order and replayed. The last event decides who applied it.
func TestQAGitHubLabelHistorySequences(t *testing.T) {
	ev := func(id int64, kind, login string) map[string]any {
		return map[string]any{"id": id, "event": kind, "actor": map[string]any{"login": login}, "label": map[string]any{"name": "todo"}}
	}
	labels := func(present bool) map[string]any {
		if present {
			return map[string]any{"labels": []map[string]any{{"name": "todo"}}}
		}
		return map[string]any{"labels": []map[string]any{}}
	}
	gh := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
		// 1: member labels, removes, re-adds -> present, applier alice, last event 3
		"GET /repos/o/r/issues/1":                            answer(200, labels(true)),
		"GET /repos/o/r/issues/1/events?per_page=100&page=1": answer(200, []map[string]any{ev(1, "labeled", "alice"), ev(2, "unlabeled", "alice"), ev(3, "labeled", "alice")}),
		// 2: member labels, a non-member re-adds after removal -> applier mallory
		"GET /repos/o/r/issues/2":                            answer(200, labels(true)),
		"GET /repos/o/r/issues/2/events?per_page=100&page=1": answer(200, []map[string]any{ev(1, "labeled", "alice"), ev(2, "unlabeled", "alice"), ev(3, "labeled", "mallory")}),
		// 3: duplicate delivery of the same labeled event twice (same id)
		"GET /repos/o/r/issues/3":                            answer(200, labels(true)),
		"GET /repos/o/r/issues/3/events?per_page=100&page=1": answer(200, []map[string]any{ev(7, "labeled", "alice"), ev(7, "labeled", "alice")}),
		// 4: removal event arrives before the label is gone from the issue (history ahead of labels)
		"GET /repos/o/r/issues/4":                            answer(200, labels(true)),
		"GET /repos/o/r/issues/4/events?per_page=100&page=1": answer(200, []map[string]any{ev(1, "labeled", "alice"), ev(2, "unlabeled", "alice")}),
		// 5: never labeled, label absent
		"GET /repos/o/r/issues/5":                            answer(200, labels(false)),
		"GET /repos/o/r/issues/5/events?per_page=100&page=1": answer(200, []map[string]any{}),
	}}
	api := gh.api(t)
	ctx := context.Background()
	a, err := api.LabelApplier(ctx, stackRepo, 1, "todo")
	require.NoError(t, err)
	assert.True(t, a.present())
	assert.Equal(t, "alice", a.Actor.Login)
	assert.Equal(t, int64(3), a.EventID, "re-added label is a new application (new event id), so it acts once more")
	a, err = api.LabelApplier(ctx, stackRepo, 2, "todo")
	require.NoError(t, err)
	assert.Equal(t, "mallory", a.Actor.Login, "the last applier decides, so a non-member's re-add is not the member's")
	a, err = api.LabelApplier(ctx, stackRepo, 3, "todo")
	require.NoError(t, err)
	assert.Equal(t, int64(7), a.EventID, "a replayed event is the same application")
	_, err = api.LabelApplier(ctx, stackRepo, 4, "todo")
	assert.ErrorContains(t, err, "trails", "history and labels disagree: answers nothing, retried later, never a wrong creation")
	a, err = api.LabelApplier(ctx, stackRepo, 5, "todo")
	require.NoError(t, err)
	assert.Nil(t, a)
	assert.False(t, a.present())
}

// Event outcomes with no TODO-level seam, recorded so the report lists them.
func TestQAGitHubEventsWithoutATodoSeam(t *testing.T) {
	// force push to main: stack_attention{force_push} (§12.3); order (§10.6.4).
	// The engine has no TODO trigger for either, by design (§4.1.2a).
	for _, trigger := range TodoTriggers {
		assert.NotContains(t, string(trigger), "force", "force push is stack_attention, not a TODO trigger")
	}
	t.Log("QACELL|force_push_main|all|want=stack_attention|got=needs DB|UNTESTED|spec §12.3")
}
