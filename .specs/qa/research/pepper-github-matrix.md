# P2 report: GitHub-inbound events x TODO states

Test file: ~/qa-pepper/p2/packages/backend/internal/services/mythical_github_qa_matrix_test.go
Raw run (133 QACELL lines): scratchpad/qa/pepper/p2-run.txt. Run time 3.5 s, no DB needed.
Result: 17 tests, 8 cell failures in 5 tests, 76 cell passes, 48 spec-gap cells (logged, not asserted), 1 untested.

## Seams
Pure: Transition, ProjectItemState, todoItemPath (together the pure core of TodoService.projectItem), mythicalAuthorize, mythicalAdmission, label-history reader (httptest).
Entangled with DB or GitHub client: MythicalService.follow (PR merged/closed -> item), ObserveIssue (label, edit, close), liveTodo, projectItem's restart/adopt branch, endRun. No pure function maps "GitHub PR/issue fact -> item change": follow() builds the item mutation inline (mythical_items.go ~2316), so the PR merged/closed -> item step was modelled in the test from mythicalLanded and the literal rejected assignment. No DB reachable (SMITHERS_TEST_DATABASE_URL unset, nothing on 55435); Docker not started.

## Matrix (W = want, spec cite in test comments; G = spec does not decide)
States: queued, starting, working, needs_you, paused, failed, in_review, merged, dropped.

| Event | q | st | wk | ny | pa | fa | ir | mg | dr | Spec |
|---|---|---|---|---|---|---|---|---|---|---|
| PR merged (main has commit) | G refused | G refused | merged PASS | merged PASS | merged PASS | G refused | merged PASS | G refused | G refused | §4.1 row 4 states; ruling 10-02 |
| PR merged, main lacks commit | - | - | refused PASS | refused PASS | refused PASS | - | refused PASS | - | - | §4.1 guard |
| PR closed unmerged | dropped PASS | dropped PASS | dropped PASS | dropped PASS | dropped PASS | dropped PASS | dropped PASS | G refused | G refused | §4.1 any unmerged -> dropped |
| PR reopened <=7d (boundary incl.) | G refused | G | G | G | G | G | G | G | in_review PASS | §4.1, §12.3 |
| PR reopened >7d / no captured head | - | - | - | - | - | - | - | - | refused PASS (3 cells) | §12.3 |
| Review changes requested, member | held PASS | steer PASS | steer PASS | steer PASS | held PASS | G | working PASS | G | G | §12.3, §10.7.3 |
| Review changes requested, non-member | unchanged PASS | PASS | PASS | PASS | PASS | PASS | **FAIL: working** | PASS | PASS | §12.3 |
| Review comment, member | G | G | G | G | G | G | working PASS | G | G | §12.3 |
| Review comment, non-member | refused PASS x9 | | | | | | | | | §12.3 |
| Review approved | no trigger exists, PASS | | | | | | | | | §12.3 |
| Checks updated | G | G | **FAIL: refused** | **FAIL: refused** | **FAIL: refused** | G | in_review PASS | G | G | §12.3 |
| Foreign push | G | G | needs_you PASS | G | G | G | needs_you PASS | G | G | §12.3 |
| Force push to main | stack_attention, no TODO trigger (PASS); behaviour UNTESTED (needs DB) | | | | | | | | | §12.3 |
| Label todo by member / non-member / App | mythicalAuthorize: 6 rows PASS | | | | | | | | | §12.3 |
| Label removed and re-added | history reader: 5 sequences PASS (new event id per re-add, last applier wins, replay = same id, lagging history refused) | | | | | | | | | §12.3 |
| Issue edited / closed | mythicalAdmission PASS (closed -> cancelled, edited text -> skipped); per-item-state effect UNTESTED (needs DB) | | | | | | | | | §10.2.1 |

Duplicates (merge x3, close x3 against every unmerged state via projection): PASS, the 2nd and 3rd append no event.
Reorder: reopen before close PASS (no change); close then merge, merge then close: see Bugs/Gaps.

## Failures (8 cells, 5 tests)
1. review_changes_requested_nonmember / in_review. Transition(in_review, changes_requested, non-member actor) returns working. §12.3: a non-member's review is activity only, never a steer. todo_state.go TodoChangesRequested has no actor guard, while TodoReviewComment does. Repro: Transition(TodoInReview, TodoChangesRequested, TodoGuard{Actor: TodoActor{System:"github"}}). PRODUCT BUG (latent: no production caller of TodoChangesRequested exists yet, so the guard must land with the caller).
2. checks_updated / working, needs_you, paused: refused. §12.3 has no state qualifier ("Evidence updated"); a steer keeps the PR ready (§4.1), so a PR with checks exists in these states. Transition only allows in_review. Repro: Transition(TodoWorking, TodoChecksUpdated, g). PRODUCT BUG of today's class (latent: no production caller yet). Same for TodoRebased.
3. reopen_after_drop_via_item_path / dropped: ProjectItemState(proposed item) over a dropped TODO gives in_review; todoItemPath(dropped, in_review) is nil, so projectItem returns todo_transition_refused (or, via the `restart` branch, adopts a NEW TODO). §4.1/§12.3 want the SAME TODO restored to in_review within 7 days. TodoPRReopened exists in Transition but nothing calls it. PRODUCT BUG (reopen unimplemented; needs DB to see which of refuse/second-TODO fires; the pure path proves no restore edge).
4. merged_via_vs_pr_merged / queued, starting, failed (3 cells): merged_via accepts every unmerged state, pr_merged refuses these three. Same fact (main contains the item), two outcomes. todoItemPath's merged edge also lists only four from-states, so a landed item over a queued/starting/failed TODO is refused. Test oracle is mine (consistency), spec decides only four states: classed as SPEC GAP plus INCONSISTENCY.

## Spec gaps (cells the spec does not decide; code returns "refused")
- PR merged when TODO is queued, starting, failed (a PR can exist after a retry or a held rebuild). Recommend: merged, same as the other unmerged states (GitHub is truth).
- PR merged or closed when TODO already merged or dropped (duplicate delivery, close-before-merge). Transition has no idempotent no-op outcome: every duplicate is TodoTransitionRefused. Projection is level-based so duplicates are safe there, but a webhook-driven caller must treat refusal as no-op. Decide: no-op with an event row.
- Close then merge: item landed over a dropped TODO. todoItemPath(dropped, merged)=nil; projectItem's `restart` (dropped && target != dropped) would adopt a SECOND TODO. Needs DB to confirm. "Terminal item states win" should say what a dropped TODO does.
- Merge then close: merged TODO with a rejected item gives todo_transition_refused, an ERROR out of projectItem (fails the engine's item write). A merged TODO must stay merged and the write must succeed.
- PR reopened while TODO is not dropped (reopen before close): refused; should be no-op.
- Review (changes requested / comment) from a member while failed, merged, dropped: refused (steer from failed has no edge). Review comment (member) while queued..paused: Transition refuses; §12.3 says "delivered as steer", so the caller must use TodoSteer. Say so.
- Foreign push while queued, starting, needs_you (second push), paused, failed: refused; §12.3 only names working and in_review. Second push or duplicate delivery while needs_you{foreign_push} is open: refused, should be recorded on the open wait.
- Checks updated in queued, starting, failed, merged, dropped.
- Reopen after 7 days or with no captured head: refused by design; spec silent on what the user sees.

## Needs DB, untested
- follow(): pull.Merged / closed / foreign head -> item (needs MythicalService, repository, GitHub client); no seam for "PR fact -> item change".
- projectItem restart branch (dropped + non-dropped target creates a second TODO), endRun cancelling the run and settling waits, ClearMythicalItemPause.
- ObserveIssue for edited and closed issue vs started items; label revert write; liveTodo; one TODO per issue under duplicate webhook + poll.
- Force push to main (stack_attention), foreign push needs_you creation: no production writer of todos.needs_you or of TodoWaitForeignPush, TodoChangesRequested, TodoReviewComment, TodoChecksUpdated, TodoPRReopened exists in the lane (grep: only todo_state.go). Most §12.3 review, check, push and reopen rows are unimplemented, not just untested.
- No event creates a second PR or a merge call: only exercised for label history via httptest (Merge call recording not reachable without follow()).
- Testability finding: no pure function maps (PR/issue fact, item) -> item change; extract from follow()/ObserveIssue so the matrix can run without PostgreSQL.
