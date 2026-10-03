# C-STK-03 Stop then Resume continues from the last finished step; Retry keeps the earlier attempt

Proves: mvp.md §4.1 (Paused, Failed "earlier attempts and evidence kept"), §6.6 Stop and resume, rule 5 · spec.md §4.1, §10.4.1, §10.7.1, §11.4.2, §19.3, §10.4.1a–b, §11.6.1, §15.2 · Layer: integration · Stage: S1 · Tickets: T-STK-05, T-FLW-11, T-STK-13, T-MCH-14
Automation: `packages/backend/internal/services/todo_control_db_test.go` (new) · Runs in: reference host (real PostgreSQL and the real flow host on a microVM)

## Setup
- Additional fixtures hold post-propose stack wait and Candidate/Propose capture, acceptance and outbound dispatch boundaries. A fake host model proxy has a declared UTC budget, 60M run reserve, per-call request log and controllable in-flight response. Literal person/session, delegated and run credentials cover typed-stop authority; a named install owner appears in projection fixtures.
- Product schema at head; owner Will signed in with a session.
- Fixture `todo` flow with four steps `s1..s4`, run as one run per attempt (T-FLW-11). Each step increments a counter row keyed by (run id, step); `s3` blocks until released; `s4` fails when the TODO's prompt contains `FAIL`.
- T1 with prompt `FAIL`, admitted; flow digest D recorded when T1 entered `starting`.

- Send control requests through POST /api/todos/{n} on the composed install router and production command dispatcher. Use fixed state/guard fixtures, counters and digests; do not derive expectations from spec files or production code. Stop releases execution capacity while retaining the workspace id, disk and unfinished bytes.

## Steps
- FLW11 QA G02/G03/G14/G16: after s1/s2 finish, Stop in held review and at capture/accept/push boundaries, restart before pause receipt, then Resume with a steer while starting. Race Answer and steer before/after turn dispatch; record stable wait/input ids and model_turn_started.
- FLW11 QA G01/G18/G21/R54/R56/R61: Stop vs external run cancel vs committed Drop vs merge, each working/held; race terminal settlement with pause. Try failed-item steer/Retry with person, delegated and run actors, including no_proposal/proposal_loop/policy stops and an untyped block.
- FLW11 QA R60: exhaust UTC token capacity with a live run, settle its in-flight call and observe the engine pause. Try Resume before capacity, restart, then release capacity/roll UTC and verify same-run recovery. Open an independent person Stop and a branch wait to test their precedence.
1. Wait until `s1` and `s2` are finished and `s3` is running. Send `stop`.
2. Read the TODO state and the run state until the runtime reports the `paused` wait opened. Record each observed state with its timestamp.
3. Send `resume`. Release `s3`.
4. Let `s4` fail. Read the state and `failure`.
5. Send `retry` with the steer "use the helper in lib/retry.ts".
6. Read `todo_attempts`, and the attempt 2 run's first message, first step and flow digest.

## Pass when
- Stop succeeds with a live held-review run, unless a question/approval is open; the PR stays open. An in-flight packaged operation settles one durable result before paused opens. Resume restores the prior stack wait or next unfinished boundary, preserving s1/s2 counters and not replaying effects.
- Held starting/resumed steer is consumed once at the next unfinished boundary after run_attached and before model_turn_started. Question steer persists context and steer_received without settling the wait; replacement retains wait identity. Answer and steer consume the committed prefix once.
- Domain merge/drop outcome wins the cancellation/pause race. External run cancel without settlement yields failed/cancelled_external/user/retryable true, preserves branch/PR and offers person Retry with no auto-admission. Held current_step is null. Stale or duplicate events cannot change the first outcome.
- Typed-stop Retry and steer-as-Retry require a person; only an authorized run can Retry an untyped block. Person Retry resets launch/outage/replan/cycle allowances with an audit actor while retaining token spend, prior evidence and ordinary pin; Resume resets none.
- Token exhaustion shows paused only after the engine wait opens, with pause.reason daily_token_budget, install owner id/name and "Paused · daily token budget · <owner>". No generic failure or question/approval is created. The same run retains inputs, releases unused reserve after calls settle and reacquires before recovery. Resume cannot bypass capacity; clearing a budget wait preserves an independent Stop and branch-wait precedence.
- Step 2: observed TODO states are `working` (with `stop: requested`) then `paused`; `paused` appears only after the runtime's wait-opened event; the run is waiting in a `paused` wait, not cancelled; the lane is released.
- Step 3: the state goes `paused → queued → starting → working` on the same run id; the counters for `s1` and `s2` stay 1; `s3` continues instead of restarting a finished step.
- Step 4: state `failed` with `failure = {step: "s4", class, message, retryable: true}`.
- Step 6: two `todo_attempts` rows. Attempt 1's run id, outcome and evidence are unchanged. Attempt 2 has a new run id that started at `s1` (re-running finished steps is intended for Retry, §4.1), digest D, and the steer as its first message.
- Every transition has a `todo_events` row with actor Will.

## Fail when
- Stop is unavailable during held review, pause appears before an operation settles, resumed starting input repeats s1, or a terminal merge/drop flashes paused.
- External cancellation drops/closes the TODO, typed-stop Retry is delegated, counters reset on Resume, or token exhaustion shows generic failure, omits its owner or resumes without capacity.
- `paused` is shown before the run parks (§19.3), or Stop is lost after a host restart.
- Stop cancels the run, so Resume starts a new run id.
- Resume re-executes `s1` or `s2` (a counter reaches 2).
- Retry overwrites attempt 1 (today's `request_run_id` overwrite) or loads a newer flow version than D.
- The steer is delivered after the first model turn of attempt 2.

## Evidence
- Also retain literal actor/control matrices, domain outcome transaction and cancellation receipts, operation settlement vs pause timestamps, ordered input-consumption/model_turn_started journal, reset audit with unchanged token ledger and pin, owner-named budget pause snapshots and same-run reacquisition log.
`.artifacts/checks/C-STK-03/<UTC>/`: `go test -json`, the state timeline JSON, the counter table, both `todo_attempts` rows, the commit SHA.
