# C-STK-01 Every TODO transition is allowed or refused exactly as spec §4.1 says

Proves: mvp.md §4.1, rule 5 (honest state), M-15, M-16 · spec.md §3.2, §4.1, §4.1.0a, §4.1.3, §5.2, §10.1, §10.7.1, §10.7.3, §10.7.4, §10.8.0, §12.3 (push row) · Layer: unit+integration · Stage: S1 · Tickets: T-STK-01, T-STK-13, T-STK-14
Automation: `go test ./packages/backend/internal/services -run '^(TestTodoTransition.*|TestProjectItemState.*|TestTodoItemPath.*|TestTodoLearningDone.*)$'` · Runs in: CI
Integration extension: packages/backend/internal/services/todo_projection_db_test.go for production runtime ingestion, wait dispatch and GET /api/todos/{n}; packages/backend/db/product/todo_backfill_db_test.go for product.Apply with real PostgreSQL (T-STK-13, T-STK-14).

## Setup
- Part A, the projection: the pure function `ProjectItemState(item, todo)` from `packages/backend/internal/services/todo_state.go` (T-STK-01). Inputs: the 15 `mythical_items.state` values, a launched flag (launched or re-admitted, not yet attached), the open waits (none, one run wait, one branch wait, one of each) and a set `paused_at` (yes or no).
- Part B, the engine guards: the entry points where the engine decides a transition, each calling `Transition(from, trigger, guard)` through `todo_service`: admission, runtime events, the control commands (T-STK-05), answers (T-STK-07), merge (T-STK-04) and GitHub PR events (T-GH-05, T-GH-06). A fake store records the event rows each call would write. No database, network or clock beyond an injected `now`.
- States: `queued`, `starting`, `working`, `needs_you`, `paused`, `failed`, `in_review`, `merged`, `dropped`, plus the client-side `draft` as a source only.

- Integration extension cases run through production runtime ingestion and product.Apply with real PostgreSQL, independently of the DB-free projection/guard unit fixtures.

Approved Automation declaration (4C-QA): `go test ./packages/backend/internal/services -run '^(TestTodoTransition.*|TestProjectItemState.*|TestTodoItemPath.*|TestTodoLearningDone.*)$'` · Runs in: CI

4C-QA supplies the approved executable command and CI host above. An empty test match is FAIL. Check: C-PRC-03.

## Steps

1. Run TestTodoTransitionLiteralCases over checked-in literal transition and guard cases independent of the production TSV. A mutated production destination must fail the literal behavioral cases. Documentation rendering/parity runs separately and supplies no behavioral expectation.

1a. Load the checked-in literal projection table authored during review, independently of spec files and production code at runtime: `queued`, `skipped` → queued; launched or re-admitted and not yet attached (`run_attached`) → starting; `running`, `delivering`, `integrating`, `verifying`, `proposing`, `waiting`, `retrying` → working; `proposed` → in_review; `landed` → merged; `blocked` → failed; `cancelled`, `rejected`, `declined` → dropped; for a non-terminal item state, the §4.1.0a ranks: any open wait → needs_you, else a set `paused_at` → paused, else `blocked` → failed; terminal states (`landed`, `cancelled`, `rejected`, `declined`) ignore waits and `paused_at`. With several open waits, `needs_you.kind` is the first in the order `moved_off`, `conflict`, `foreign_push`, `approval`, `question`, then the oldest.
2. Call `ProjectItemState` for every input: 15 states × launched × the four wait sets × paused_at, skipping launched for non-launchable states. Compare with the literal projection fixture in step 1a.
3. Load the checked-in literal transition table authored during review, independently of spec files and production code/TSV at runtime:
   - `draft→queued` (place); `queued→starting` (admit: a machine granted, the flow version pinned); `starting→working` (`run_attached`: a new run's first step, or a resumed or re-admitted run continuing);
   - `starting→failed` (start failed, `failure.step = "start"`); `working→failed` (run failed or uncertain); `failed→queued` (retry, and retry with the current flow);
   - `→needs_you` when a wait opens: run waits (question, approval) from `working` only; branch waits (conflict, moved_off, foreign_push) from `queued`, `starting`, `working`, `paused`, `failed` and `in_review`; a wait opening while another is open records an event and keeps needs_you;
   - `needs_you→working` (first accepted answer, including Bring in); `needs_you→queued` (answered after the machine was released at safe-idle; the run resumes when admission grants the machine again); `needs_you→in_review` (Discard, or an answer that needs no new work); `needs_you→paused` and `needs_you→failed` (the last wait settles with `paused_at` set or the item `blocked`); each `needs_you→` row only when the settled wait was the last open one, and settling any other wait records an event and keeps needs_you;
   - `working→paused` (stop, with no run wait open); stop with only a branch wait open sets `paused_at` and keeps needs_you; `paused→queued` (resume); `in_review→queued` (a steer when the machine was released);
   - `working→in_review` (`stack.propose` accepted, §10.4.4); `in_review→working` (changes requested, a member's review comment, steer);
   - self-loops that record an event and keep the state: `in_review` (checks updated, rebased, edited); `queued`, `starting`, `working`, `needs_you`, `paused` (steer, held or delivered per §10.7.3);
   - every unmerged state with an open PR `→merged`: `queued`, `starting`, `working`, `needs_you`, `paused`, `failed`, `in_review` (PR merged on GitHub and `main` contains the commit; the run is cancelled, every wait settled, `needs_you` and `paused_at` cleared); every earlier unmerged item a later squash commit contains `→merged` (§10.6.4);
   - every stored unmerged state `→dropped` (drop; PR closed unmerged); `dropped→in_review` (PR reopened within 7 days; once per reopen event, with no run started, §10.7.4).
4. Drive every (state, trigger) pair through the engine guards: 10 sources × every trigger the guards accept. Add the guard variants: a wait kind outside its source's list, the coding agent's answer to a non-conflict wait, a merge event without the commit on `main`, a reopen at 7 days + 1 s, a second delivery of the same reopen event, a stop while a question is open, an answer to an already-settled wait.
5. Send `learning_done` to a `merged` TODO.

Drive run_attached through production runtime ingestion with literal attempt/run fixtures. Accept only when payload.attempt equals the current attempt and Checkpoint.RunID equals todo_attempts.run_id written in the starting launch transaction. A matching attachment enters working without FirstStep even after a generation change within that attempt. Prior-attempt, wrong-run and empty-binding events change no TODO, event or projection. Run the FirstStep regression and production migration 0105 with existing bound and unbound rows; preserve valid bindings and refuse unbound attachment. Inject failure between TODO/event/projection writes and race wait changes with attachment; assert pgx.BeginFunc rolls back all writes on failure and commits each accepted update atomically.
- Run backfill with literal states and counts, retaining PR heads. Classify `state <> skipped AND NOT (issue AND cancelled AND approved_digest = empty string)` and select missing links with `WHERE mythical_items.todo_id IS NULL`. Include a fixture where migration 0105 already ran.

## Pass when
- Terminal states win: every input with item state `landed` projects merged, and every input with `cancelled`, `rejected` or `declined` projects dropped, for every combination of `needs_you` and `paused_at`.
- After a merge or a drop from any source state, the TODO has no open wait, `needs_you` is null and `paused_at` is null.
- Merged from `working` (a steer in progress) and merged from `needs_you` (a question open) each write one event, close every wait and leave `merging` null.
- Settling one wait never settles another: with a question and a foreign_push open, answering the question leaves needs_you with `needs_you.kind = foreign_push`.
- Step 2: every projected state equals the step 1a literal table; the test prints the input count.
- Step 4: the allowed (from, trigger) pairs equal the step 3 table exactly, and the test prints both counts.
- Every allowed case writes exactly one `todo_events` row whose `from`, `to` and `actor` match; every refused case returns `todo_transition_refused` with the from-state and trigger and writes no row.
- Each guard variant is refused.
- Step 5 returns a `lessons` increment and no state change (§4.1.3).

- Drive run_attached through production runtime ingestion with literal attempt/run fixtures. Accept only when payload.attempt equals the current attempt and Checkpoint.RunID equals todo_attempts.run_id written in the starting launch transaction. A matching attachment enters working without FirstStep even after a generation change within that attempt. Prior-attempt, wrong-run and empty-binding events change no TODO, event or projection. Run the FirstStep regression and production migration 0105 with existing bound and unbound rows; preserve valid bindings and refuse unbound attachment. Inject failure between TODO/event/projection writes and race wait changes with attachment; assert pgx.BeginFunc rolls back all writes on failure and commits each accepted update atomically.
- Backfill attribution is `{"system":"backfill"}`. Literal counts and states match the classification; PR heads are retained. The fixture where migration 0105 already ran creates zero TODO or branch rows. Member-identity fixtures and repeated-Apply idempotency are not acceptance proofs for backfill.

## Fail when
- A shortcut is allowed: `queued→working` without `starting`, `paused→working` without `queued`, `queued→in_review`, `failed→working`, `merged→working`, `dropped→queued`, or `stop` from `starting` or while a `question` or `approval` wait is open.
- An allowed case writes no event row (a state with no event, §3.2), or a refused one writes a row.
- The coding agent's answer settles a `question` or `approval` wait (§5.2 allows only its own conflicts).
- A resumed or re-admitted TODO needs a first-step event to leave `starting`, or settling one wait closes another.
- Either expected table reads spec files or derives expectations from implementation code or the production TSV at runtime.
- The guards are tested on `Transition` alone, so an engine entry point that skips it goes unseen.

## Evidence
`.artifacts/checks/C-STK-01/<UTC>/`: `go test -json` output, the printed projection and transition counts, the commit SHA.
