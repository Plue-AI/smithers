# C-STK-03 Stop then Resume continues from the last finished step; Retry keeps the earlier attempt

Proves: mvp.md §4.1 (Paused, Failed "earlier attempts and evidence kept"), §6.6 Stop and resume, rule 5 · spec.md §4.1, §10.4.1, §10.7.1, §11.4.2, §19.3 · Layer: integration · Stage: S1 · Tickets: T-STK-05, T-FLW-11
Automation: `packages/backend/internal/services/todo_control_db_test.go` (new) · Runs in: CI (real PostgreSQL, a real flow host as in `packages/backend/flowdispatch/real_host_test.go`)

## Setup
- Product schema at head; owner Will signed in with a session.
- Fixture `todo` flow with four steps `s1..s4`, run as one run per attempt (T-FLW-11). Each step increments a counter row keyed by (run id, step); `s3` blocks until released; `s4` fails when the TODO's prompt contains `FAIL`.
- T1 with prompt `FAIL`, admitted; flow digest D recorded when T1 entered `starting`.

## Steps
1. Wait until `s1` and `s2` are finished and `s3` is running. Send `stop`.
2. Read the TODO state and the run state until the runtime reports the `paused` wait opened. Record each observed state with its timestamp.
3. Send `resume`. Release `s3`.
4. Let `s4` fail. Read the state and `failure`.
5. Send `retry` with the steer "use the helper in lib/retry.ts".
6. Read `todo_attempts`, and the attempt 2 run's first message, first step and flow digest.

## Pass when
- Step 2: observed TODO states are `working` (with `stop: requested`) then `paused`; `paused` appears only after the runtime's wait-opened event; the run is waiting in a `paused` wait, not cancelled; the lane is released.
- Step 3: the state goes `paused → queued → starting → working` on the same run id; the counters for `s1` and `s2` stay 1; `s3` continues instead of restarting a finished step.
- Step 4: state `failed` with `failure = {step: "s4", class, message, retryable: true}`.
- Step 6: two `todo_attempts` rows. Attempt 1's run id, outcome and evidence are unchanged. Attempt 2 has a new run id that started at `s1` (re-running finished steps is intended for Retry, §4.1), digest D, and the steer as its first message.
- Every transition has a `todo_events` row with actor Will.

## Fail when
- `paused` is shown before the run parks (§19.3), or Stop is lost after a host restart.
- Stop cancels the run, so Resume starts a new run id.
- Resume re-executes `s1` or `s2` (a counter reaches 2).
- Retry overwrites attempt 1 (today's `request_run_id` overwrite) or loads a newer flow version than D.
- The steer is delivered after the first model turn of attempt 2.

## Evidence
`.artifacts/checks/C-STK-03/<UTC>/`: `go test -json`, the state timeline JSON, the counter table, both `todo_attempts` rows, the commit SHA.
