# C-STK-07 One merge predicate and an in-flight fence: races against Merge merge nothing stale

Proves: mvp.md §4.2 Merging and Rebase ("any earlier approval no longer applies"), §6.10 PR card ("approval of the exact revision they reviewed"), M-05, M-22 · spec.md §4.1, §10.4.5, §10.6.2, §10.6.2a, §10.6.2b, §10.6.2c, §10.7.3, §16.4 · Layer: integration · Stage: S1 · Tickets: T-STK-04, T-STK-12, T-STK-06
Automation: `packages/backend/internal/services/todo_merge_race_db_test.go` (new) · Runs in: CI (real PostgreSQL, real git and jj, a real flow host, the fake GitHub server)

## Setup
- Stack T1 and T2 `in_review`, T3 `queued`; T1 first. T1's accepted generation g has base = `main`'s tip and PR head H; its required checks are green and GitHub reports it mergeable.
- Maintainers Ben and Maya and member Alice have sessions.
- The fake GitHub server records every request. It can hold a merge call until the test releases it with 200 or 405.
- T1's machine is awake, and the test can write into its working copy under another uid.
- Each step starts from this fixture.

## Steps
1. For each `MergeReady` row 1-9 (§10.6.2a), violate that row alone. Read T1's `merge_block`, then have Ben merge T1 with H.
2. Steer first: Alice steers T1. Then Ben merges T1 with H.
3. Steer during dispatch: Ben merges T1 with H. While the fake holds the call, Alice steers T1 and a poll brings Ben's review comment on T1's PR. Release with 200.
4. As step 3, but release with 405.
5. Edit before merge: write `src/a.ts` in T1's working copy, then Ben merges T1 with H before the next periodic capture.
6. Edit during dispatch: Ben merges T1 with H. While the fake holds the call, write `src/c.ts`. Release with 200, then read the branch's final capture.
7. Rebase pending with an unchanged PR head: move `main` on the fake and let the mirror follow, so T1 has `rebase_pending` while its PR head is still H. Ben merges T1 with H.
8. `main` moves after the transaction: a hook moves `main` on the fake right after the fence transaction commits. Ben merges T1 with H.
9. Reorder during dispatch: Ben merges T1 with H. While the fake holds the call, Alice moves T2 up, places T3 Before T1, amends T1 and drops T1. Release with 200.
10. Concurrent merges: Ben and Maya merge T1 with H at the same instant.
11. Restart: stop the engine after the fake answers 200 and before the result is recorded. Start a new engine on the same database.

## Pass when
- Step 1: each refusal carries that row's reason code, `merge_block` names the same reason, and the fake records zero merge calls.
- Step 2: refused with `state`; zero merge calls.
- Step 3: T1 is `merged`. The steer and the comment are recorded with activity entries and never delivered: no `steer` signal reaches the run and no `in_review → working` event exists. The run is cancelled.
- Step 4: the fence clears, then the steer and the comment are each delivered once and T1 is `working`.
- Step 5: refused with `pending_work` from the fresh capture; zero merge calls; the run gets one `edited` signal.
- Step 6: one merge call; T1 is `merged`; `src/c.ts` is in the branch's final capture.
- Step 7: refused with `rechecking`; zero merge calls.
- Step 8: refused with `rechecking` after the `ls-remote` recheck; the fence is cleared; zero merge calls.
- Step 9: Move, Before, amend and Drop each get `409 {code: merging}` while the fence is set; after the merge, T2 is first.
- Step 10: exactly one merge call; the other request gets `merging`.
- Step 11: one merge call in total; T1 is `merged`; no fence stays set.
- Every merge call carries `sha = H` and `merge_method = squash`, and each `todo_approvals` row names g and H.

## Fail when
- A refused request reaches GitHub's merge endpoint.
- A steer, edit or rebase committed before the fence doesn't refuse the merge.
- A held steer is delivered to a merged TODO, or lost when the merge fails.
- A reorder changes T1's position while its merge is in flight.
- `merge_block` and the route disagree on a reason.

## Evidence
`.artifacts/checks/C-STK-07/<UTC>/`: `go test -json`, the fake GitHub request log, and per step the `todos.merging`, `todo_events`, `todo_approvals` and activity dumps; the final-capture file list for step 6; the commit SHA.
