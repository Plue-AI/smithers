# T-STK-05 Stop, resume, Retry and Retry with the current flow, drop, reopen

Stage S1 · Size M · Depends on T-STK-01, T-FLW-11, T-FLW-03, T-STK-04, T-STK-02, T-MCH-08 (S1), T-FLW-04 · Unblocks T-APP-01, T-APP-02, T-APP-07, T-REL-02, T-STK-06 · Issue: [#3530](https://github.com/smithersai/smithers/issues/3530)
Spec: spec.md §3 (`checks.Attempts`), §4.1, §4.1.0a, §10.4.1, §10.7.1, §10.7.2, §10.7.4, §11.4.2, §12.4.1, §15.1.5, §19.1, §19.3 · Delta: delta.md §6 (Add Stop/Resume, Retry with attempt rows, Drop with PR close) · Product: mvp.md §4.1, §6.6 Stop and resume, J4.2, J7.3, Appendix B.2

## Goal
A member stops a working TODO and it shows Paused only after its run parks at a durable boundary. Resume continues that same run from its last finished step. Retry starts a new attempt of the pinned flow version, and Retry with the current flow starts one on the Active version; the earlier attempt stays readable either way. Drop closes the PR and takes the item off the stack. A PR reopened within 7 days restores the TODO with its last accepted generation, and the first input that needs work starts a new attempt.

## Scope
In:
- `POST /api/todos/{n}` with `stop`, `resume`, `retry {steer?}`, `retry-current-flow {steer?}` and `drop`; catalog `/todo.stop`, `/todo.resume`, `/todo.retry` and `/todo.drop` (drop confirms), plus the `in-card` control `todo.retry-current-flow` (**Retry with the current flow**) on the failed TODO card (Appendix B.4).
- Agent permissions (§15.1.5, Appendix B): stop, resume, retry and Retry with the current flow are `agent: run`; drop is `agent: confirm`, so an agent's drop posts a one-click confirmation the member presses.
- Stop is a durable pause, not a cancel (§4.1, §10.7.1): the run parks in a `paused` wait at its next boundary, and the machine is released once safe-idle. Stop applies only while the attempt's run is executing with no open `question` or `approval` wait; otherwise it is refused with class `conflict`. An open branch wait (`conflict`, `moved_off`, `foreign_push`) doesn't refuse it: the TODO shows needs_you until that wait settles, then paused (§4.1.0a).
- Resume settles the pause wait: `paused → queued`, then `starting` when a machine is granted, and `working` when the coding host reports the run attached (`run_attached`, §4.1), on the same run id. A resumed run never waits for a first step it already finished.
- Retry from `failed` (reached from `starting` or `working`): `failed → queued` with a new `checks.Attempts` row and a new run of the pinned flow version from its first step (§4.1, §11.4.2). The earlier attempt and its evidence stay. An optional steer becomes the first message.
- Retry with the current flow (§4.1): as Retry, but the new attempt pins the currently Active version from `workflow_definitions` (§11.3.2). Same TODO identity and evidence history.
- Drop (§10.7.2): confirm, cancel the run, close the PR with "Dropped in Smithers by @x", mark `dropped`, archive the branch (`branches.archived_at`), and call T-STK-02's `Remove` so later items rebase. A final capture runs before the archive; the attempt closes with outcome `dropped`, and its last accepted generation stays on the record. Before later items rebase, Drop calls T-MCH-08's `FoldIntoForks(item)`, so a TODO forked from the dropped item keeps its change (§8.5.3a, C-J7-02).
- After T-GH-03 restores a reopened TODO with its retained generation and no live run, the first input that needs work starts a new attempt of the dropped attempt’s pinned flow version from its first step, with that input as its first message (§10.7.4). T-GH-03 owns inbound close/reopen restoration; this ticket owns input-triggered restart.

Out:
- Machine release by the S2 admission scheduler (T-MCH-06). S1 Stop uses T-MCH-14's retained-workspace path; it does not delete the workspace or disk.
- Detecting a PR closed or reopened on GitHub and restoring position/generation (T-GH-03); this ticket owns Drop and input-triggered restart, not inbound restoration.
- Evidence contents per attempt (T-STK-01). Steer delivery to a working run (T-STK-06).
- The `todo` run's pause wait and signal handling (T-FLW-11's one-run model); this ticket sends the signals.
- Generic background-run retry/stop, flow activation or loading, changing an existing attempt's flow digest, PR polling, retention-policy changes, terminal/SSH controls, CLI/skill doors and UI Views or Containers.

## Changes
- `packages/backend/internal/services/todo_control.go` (new):
  - Stop → `flowdispatch.Service.Signal` (`packages/backend/flowdispatch/service.go:94`) named `pause` to the attempt's `todo` run, never `Cancel`. The TODO stays `working` with `stop: requested` until the runtime reports the `paused` wait opened, then moves to `paused` (§19.3). Set `mythical_items.paused_at` only on the wait-opened event. S1 releases execution capacity through T-MCH-14 while retaining the workspace and disk; do not call today's destructive `releaseLane` (`services/mythical_items.go:1182`) for Stop.
  - Resume → settle the pause wait; `paused → queued`. Admission grants a machine and the same run continues; the engine replays settled steps and runs only unfinished ones.
  - Retry → `failed → queued`; insert `checks.Attempts(attempt+1)`; pin the attempt's flow digest (`flow: pinned`) or the Active digest (`flow: current`); the new run's first message is the steer.
  - Reopened TODO input → start attempt n+1 as Retry does, with the input first; T-GH-03 has already restored its position and accepted generation without a live run.
  - Drop → confirm; persist `flowdispatch.Service.Cancel` (`:205`), then observe the run stopped before the final capture; `ClosePull` and `Comment` (`mythical_github.go:484`) through `pending_op` (T-GH-09); close the attempt and all open waits, clear `needs_you` and `paused_at`, mark `dropped` and archive the branch. Under T-STK-12's stack lock/fence, call `FoldIntoForks(item)` (T-MCH-08 S1), then `Remove(n)` (T-STK-02), before later rebases. T-MCH-14 retains the final capture and accepted generation for Reopen; today's destructive `retireLane` (`mythical_items.go:1576`) cannot precede retained capture. Checks: C-J7-02, C-STK-08, C-J10-08.
- `packages/backend/internal/services/mythical_github.go` → add `ClosePull(number)` (`PATCH /pulls/{n} {state: closed}`).
- `packages/backend/internal/services/mythical_items.go` → one `checks.Attempts` row per attempt holding the attempt's single `todo` run id and flow digest (T-FLW-11); delete the `request_run_id`/`vibe_run_id`/`verify_run_id` overwrite. Delete the bound-stop resume by re-applying the `todo` label (`:247-258`): Retry is the only way back from `failed`.
- Delete `RetryItem` (`mythical_items.go:2708`), route `POST /mythical/items/{id}/retry` (`internal/compose/router.go:1121`, `routes/mythical.go:274`), its OpenAPI row (`docs/api/openapi/repositories.yaml:12159`), `history.retry` (`apps/app/src/mainview/flows/entries/history.ts:102`) and `retryable` (`packages/rpc/src/StackView.ts:70`). `flow.run.stop` and `runs.resume` stop being TODO doors.
- Catalog descriptors for the four commands and `todo.retry-current-flow` (T-CAT-01 shape).
- `docs/api/openapi/mythical_items.yaml` and `packages/backend/docs/mythical_items.md` (new in the TODO slice), regenerated `packages/smithers/src/internal/backend/ProductApi.ts` (`smthrs run //:openapiClients`), docs gates.

## Tests

C-STK-03 (folded steps and assertions):
- FLW11 QA G02/G03/G14/G16: after s1/s2 finish, Stop in held review and at capture/accept/push boundaries, restart before pause receipt, then Resume with a steer while starting. Race Answer and steer before/after turn dispatch; record stable wait/input ids and model_turn_started.
- FLW11 QA G01/G18/G21/R54/R56/R61: Stop vs external run cancel vs committed Drop vs merge, each working/held; race terminal settlement with pause. Try failed-item steer/Retry with person, delegated and run actors, including no_proposal/proposal_loop/policy stops and an untyped block.
- FLW11 QA R60: exhaust UTC token capacity with a live run, settle its in-flight call and observe the engine pause. Try Resume before capacity, restart, then release capacity/roll UTC and verify same-run recovery. Open an independent person Stop and a branch wait to test their precedence.
1. Wait until `s1` and `s2` are finished and `s3` is running. Send `stop`.
2. Read the TODO state and the run state until the runtime reports the `paused` wait opened. Record each observed state with its timestamp.
3. Send `resume`. Release `s3`.
4. Let `s4` fail. Read the state and `failure`.
5. Send `retry` with the steer "use the helper in lib/retry.ts".
6. Read `checks.Attempts`, and the attempt 2 run's first message, first step and flow digest.
7. In a separate failed TODO pinned to D, activate a literal fixture version D2, then invoke the served Retry with the current flow action.

Pass when:
- Stop succeeds with a live held-review run, unless a question/approval is open; the PR stays open. An in-flight packaged operation settles one durable result before paused opens. Resume restores the prior stack wait or next unfinished boundary, preserving s1/s2 counters and not replaying effects.
- Held starting/resumed steer is consumed once at the next unfinished boundary after run_attached and before model_turn_started. Question steer persists context and steer_received without settling the wait; replacement retains wait identity. Answer and steer consume the committed prefix once.
- Domain merge/drop outcome wins the cancellation/pause race. External run cancel without settlement yields failed/cancelled_external/user/retryable true, preserves branch/PR and offers person Retry with no auto-admission. Held current_step is null. Stale or duplicate events cannot change the first outcome.
- Typed-stop Retry and steer-as-Retry require a person; only an authorized run can Retry an untyped block. Person Retry resets launch/outage/replan/cycle allowances with an audit actor while retaining token spend, prior evidence and ordinary pin; Resume resets none.
- Token exhaustion shows paused only after the engine wait opens, with pause.reason daily_token_budget, install owner id/name and "Paused · daily token budget · <owner>". No generic failure or question/approval is created. The same run retains inputs, releases unused reserve after calls settle and reacquires before recovery. Resume cannot bypass capacity; clearing a budget wait preserves an independent Stop and branch-wait precedence.
- Step 2: observed TODO states are `working` (with `stop: requested`) then `paused`; `paused` appears only after the runtime's wait-opened event; the run is waiting in a `paused` wait, not cancelled; the lane is released.
- Step 3: the state goes `paused → queued → starting → working` on the same run id; the counters for `s1` and `s2` stay 1; `s3` continues instead of restarting a finished step.
- Step 4: state `failed` with `failure = {step: "s4", class, message, retryable: true}`.
- Step 6: two `checks.Attempts` rows. Attempt 1's run id, outcome and evidence are unchanged. Attempt 2 has a new run id that started at `s1` (re-running finished steps is intended for Retry, §4.1), digest D, and the steer as its first message.
- Every transition has a `product_job_events` row with actor Will.
- Step 7 starts a new attempt on D2 with the same TODO identity; the prior attempt, digest D and evidence remain unchanged. Expectations use committed fixture identities, not production pinning code.

Fail when:
- Stop is unavailable during held review, pause appears before an operation settles, resumed starting input repeats s1, or a terminal merge/drop flashes paused.
- External cancellation drops/closes the TODO, typed-stop Retry is delegated, counters reset on Resume, or token exhaustion shows generic failure, omits its owner or resumes without capacity.
- `paused` is shown before the run parks (§19.3), or Stop is lost after a host restart.
- Stop cancels the run, so Resume starts a new run id.
- Resume re-executes `s1` or `s2` (a counter reaches 2).
- Retry overwrites attempt 1 (today's `request_run_id` overwrite) or loads a newer flow version than D without an explicit Retry with the current flow action.
- The steer is delivered after the first model turn of attempt 2.

- Boundary integration, `packages/backend/internal/services/todo_control_db_test.go` (new): send Stop, Resume, Retry, Retry with the current flow and Drop through `POST /api/todos/{n}` on the composed install router and production command dispatcher. Use real PostgreSQL and the real pinned flow host on a microVM, not the direct host-process fixture of `flowdispatch/real_host_test.go:127`. Fixed step counters, state/guard cases, flow digests and expected refusals supply the oracles; no test reads spec files or derives expected results from production code at runtime. Checks: C-STK-03, C-STK-08.
- Same suite: Stop retains the workspace id, disk and unfinished file bytes through Resume; Retry retains attempt 1. Drop acknowledges persisted cancellation before completion, captures after writers stop, closes every wait, folds forked work before successor rebase, and refuses under a merge fence with `409 merging` and no close/cancel/archive writes. Crash after a PR close but before its receipt reconciles by lookup without undoing a later GitHub reopen. Checks: C-J7-02, C-J10-08, C-STK-07, C-GH-09.
- Unit, `todo_control_test.go` (new): literal command/guard fixtures across all nine states, including `needs_you` over an executing, paused or blocked item. Stop requires an executing run and no question/approval; Resume requires `paused_at`; both retries require item `blocked`; Drop permits any unmerged item. Guards read facts, not only the derived state (§4.1.0a).
- Integration with real PostgreSQL and the real flow host inside a microVM, `todo_control_db_test.go` (new): a 4-step fixture flow with per-step execution counters. Stop during step 3 → Paused after the boundary, and the run is waiting, not cancelled. Resume → the same run id; the counters of steps 1-2 stay 1.
- Integration, same file: Retry after a failure at step 4 writes attempt 2 with a new run id that starts at step 1; attempt 1's row, run id and outcome are unchanged; both attempts carry the same flow digest.
- Integration, same file: activate a new flow version after attempt 1 fails. Retry pins the old digest; Retry with the current flow pins the new one; attempt 1's evidence is unchanged in both cases.
- Integration, same file: a failure during `starting` gives `failed`, and Retry returns it to `queued`.
- Integration: an app-agent stop runs at once with the author's rights; an app-agent drop creates a one-click confirmation and drops only after the author presses it.
- Integration with the fake GitHub server: Drop of an `in_review` TODO closes the PR once with the comment, even when the call repeats with the same idempotency key.
- Fault: kill the host between the pause signal and the wait opening. After restart the TODO is `working` with `stop: requested`, then `paused`; never `paused` first.
- Integration, same file, for C-STK-08: Stop with a `question` open is refused; Stop with only a `foreign_push` open sets `paused_at` and keeps needs_you, then shows paused after Discard; Resume after `s1` finished turns `working` on `run_attached` within 5 s of the grant, with `s1`'s counter still 1.
- Integration with the fake GitHub server, for C-J10-08: drop T2, reopen its PR 25 h later, deliver the reopen twice, then a member's review comment. One `dropped → in_review` event; no run until the comment; then attempt 2 on the pinned digest with the comment as its first message.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J7-02](../checks/C-J7-02.md): Drop preserves the change of a TODO forked from the dropped item.

- [C-STK-03](../checks/C-STK-03.md): Stop → Resume continues from the last finished step; Retry keeps the earlier attempt.
- [C-J4-02](../checks/C-J4-02.md): retry with a steer from the home card while chatting.
- [C-STK-08](../checks/C-STK-08.md): Stop and Resume with open waits; resume leaves Starting on `run_attached`.
- [C-J10-08](../checks/C-J10-08.md): reopen restores the generation; a later review comment starts a new attempt that merges.

## Risks and notes

- Tech lead adopts the T-GH-03 restoration / T-STK-05 restart split. Do not add T-STK-05 to T-GH-03 dependencies: that creates T-GH-03 → T-STK-05 → T-STK-04 → T-GH-03. Checks: C-J10-08.
- Risk: a model call in flight delays the boundary past 60 s (§10.7.1). Observation: stop-to-paused time over 60 s in the integration log; then the agent step needs a cancel token.
- Risk: a run parked in `paused` for days holds a durable wait. T-FLW-11's restart test of 50 waiting runs covers it.
- Resolved: the index now lists T-FLW-03 as a dependency.

## Ready checklist
1. Dependencies: add T-STK-02's placement/removal, T-MCH-08's S1 `FoldIntoForks`, T-FLW-04's pinned-closure loader, and T-STK-01's independent-wait/attached-run projection. Existing T-FLW-11/T-FLW-03/T-STK-04 prerequisites supply durable runs, versions, waits, retained machines, the stack fence, authorization/confirmations and T-GH-09 outbound recovery. New edges stay in S1. Concurrent T-FLW-04/T-MCH-08 reverse edges require the cross_group orientation repairs before these dependency edits or start.
2. Exclusions: S2 admission, poll detection, full evidence contents, ordinary steer delivery, flow loading/activation, background-run controls, digest replacement, retention changes, terminal/SSH controls, CLI/skill doors and UI implementation are explicit.
3. Tests: C-STK-03/C-STK-08 enter the composed TODO route and production dispatcher on a real machine with literal state/guard fixtures and counters. C-J10-08 enters the production inbound-poll path when T-GH-03 lands. No direct service call or host-process fixture substitutes for acceptance; no runtime-derived oracle.
4. Decisions: smithers-3f approves pause/cancel ordering, workspace retention, Drop/fork atomicity and reopen recovery; smithers-b8 approves command payloads and deletion of old app doors; smithers-38 signs off removal of the public `retryable` export and any required library change under §21.1. smithers-8a accepts cross-owner seams; Will decides product changes.
5. Owner pre-review before start: smithers-3f: Does Stop release execution without deleting the resumable workspace? Does Drop capture after writers stop and fold forked work under the shared fence before rebase? Does reopen retry use the retained generation and pinned closure exactly once? smithers-b8: Do both Retry doors and Drop confirmations reach one dispatcher, and are old TODO stop/retry doors removed? smithers-38: Are all callers of `retryable` migrated in the same change without weakening persisted-history decoding? Views are excluded.
6. Security: T-INS-02/T-FLW-01 must reject missing isolation before Resume, Retry or reopen launches repository work. The pinned flow, repository checks and capture run only in the branch machine (§1.3, M-29), without sudo or provider keys; the host uses packaged control code. smithers-3f reviews this ordering. C-SEC-02 and the machine-backed control/reopen cases prove it.

