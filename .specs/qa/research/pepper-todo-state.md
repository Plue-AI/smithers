# p1 QA report
File: ~/qa-pepper/p1/packages/backend/internal/services/todo_state_qa_property_test.go (no product code touched)
Run: go test -run 'QA|TodoTransition|ProjectItemState' ./internal/services/ -> ok, all pass (~18 s).

| Test | Asserts | Result |
|---|---|---|
| TestQAModelRandomWalkMatchesSpecTable | hand-authored spec model (row-by-row spec citations); 6,000 seeded sequences (seed 1..6000, <=40 steps, 45,509 steps, 24,167 allowed); verdict+target match; one event with matching from/to/actor/cause; refused => *TodoTransitionRefused, zero event; merged absorbing except learning_done; dropped leaves only via reopen <=7d; retry -> queued only from failed; EndsWork/VoidApprovals/SteerHeld/Failure flags | pass |
| TestQAExhaustiveGuardGridMatchesModel | 10 states x 24 triggers x actors x failures x wait kinds x open-wait kinds x 64 guard masks = 4,147,200 cases vs model | pass |
| TestQASteerFromEveryState | steer from all 10 states x 3 actors (held flag, void approvals) | pass |
| TestQANeedsYouAnswerTargets | needs_you -> queued (machine released), working, in_review; auth still enforced; MachineReleased answer refused from other states | pass |
| TestQAGitHubMergeFromEveryUnmergedState | pr_merged from in_review/working/needs_you/paused with/without OnMain; refused from draft/merged/dropped; EndsWork | pass |
| TestQAGuardBoundaries | reopen at exactly 7d ok, +1s refused, zero DroppedAt, no head; coding agent answers only conflict; merge w/o OnMain on all unmerged states; wait kinds; PR closed without PR | pass |
| TestQATerminalAndDropEdges | drop/merged_via from every unmerged state; terminal states refuse drop/close; learning_done | pass |
| TestQAProjectItemStateTotalDeterministicTerminalWins | 15 item states x run x 5 needs_you encodings x paused x 11 current states = 3,000 cases: total (stored states only), deterministic, terminal wins over needs_you/paused, spec §4.1.0 table where current is neutral | pass |

## Failures
Product bugs: none. This copy already implements all four fixed behaviors.
Test bugs found and fixed while writing (3): walk threshold too high; projection oracle fed non-stored current "draft"; oracle ignored the documented "skipped leaves admitted TODO as is" rule.

## Notes / spec gaps (not failures)
- Answer with NoNewWork and MachineReleased both set: spec silent (impl picks in_review). Walk never sets both.
- steer from starting: SteerHeld=false in impl; spec says only queued/paused held; not asserted beyond allowed.
- steer from failed refused (spec routes via Retry-with-steer); model assumes refused.
- Mutation check against the four original bugs not run (product code frozen); each is asserted directly in QASteer*, QANeedsYou*, QAGitHubMerge*, QAProject*.

## Rulings 2026-10-02 16:40
Model, steer table, answer test and grid updated (grid now also sets NoNewWork+MachineReleased together; walk too).

| # | Ruling | Test | Result |
|---|---|---|---|
| 1 | answer needing no new work -> in_review even if machine released; queued only when new work AND released | TestQANeedsYouAnswerTargets, grid, walk | PASS (impl already checks NoNewWork first; unverified head is refused, not queued) |
| 2 | steer to starting: self-loop with SteerHeld=true | TestQASteerFromEveryState/starting | FAIL (product gap): Transition(starting, steer) allowed, to=starting, SteerHeld=false. Repro: from=starting, trigger=steer, any member guard. Fix: todo_state.go Transition `SteerHeld` case must include TodoStarting. |
| 3a | steer to failed = Retry with that steer: failed -> queued | /steer from failed, grid, walk (seed=15 step=11 reproduces) | FAIL (product gap): refused "not allowed from this state". Repro: from=failed, trigger=steer, member actor. Needs failed->queued in the steer case (new attempt, same identity, steer as first input; SteerHeld stays false in my model). |
| 3b | steer to merged/dropped refused with reason todo_closed | TestQASteerFromEveryState/merged, /dropped | FAIL (product gap): refused, but Reason is the generic "not allowed from this state", not todo_closed. Repro: from=merged or dropped, trigger=steer. |

Totals: 3 failing tests (TestQAModelRandomWalk..., TestQAExhaustiveGuardGrid..., TestQASteerFromEveryState with 4 failing subtests: starting, failed, merged, dropped); all others pass. No test bugs. Stale: existing TestTodoTransitionAllowsExactlyTheSpecTable still encodes the old steer rows (starting self-loop only, no failed steer) and passes; the stk lane must update it with the fix.
Assumption to confirm: reason match is substring "todo_closed"; SteerHeld on failed->queued is false.
