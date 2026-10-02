# C-STK-01 Every TODO transition is allowed or refused exactly as spec §4.1 says

Proves: mvp.md §4.1, rule 5 (honest state), M-15, M-16 · spec.md §3.2, §4.1, §4.1.3, §5.2, §10.1, §10.7.3, §12.3 (push row) · Layer: unit · Stage: S1 · Tickets: T-STK-01
Automation: `packages/backend/internal/services/todo_state_test.go` (new) · Runs in: CI (`go test ./packages/backend/internal/services -run TestTodoTransition`)

## Setup
- Part A, the projection: the pure function `ProjectItemState(item, todo)` from `packages/backend/internal/services/todo_state.go` (T-STK-01). Inputs: the 15 `mythical_items.state` values, a launched flag (run started, first step not yet reported), an open `needs_you` (yes or no) and a set `paused_at` (yes or no).
- Part B, the engine guards: the entry points where the engine decides a transition, each calling `Transition(from, trigger, guard)` through `todo_service`: admission, runtime events, the control commands (T-STK-05), answers (T-STK-07), merge (T-STK-04) and GitHub PR events (T-GH-05, T-GH-06). A fake store records the event rows each call would write. No database, network or clock beyond an injected `now`.
- States: `queued`, `starting`, `working`, `needs_you`, `paused`, `failed`, `in_review`, `merged`, `dropped`, plus the client-side `draft` as a source only.

## Steps
1. Write the projection table from spec §4.1.0 only: `queued`, `skipped` → queued; launched before the first step → starting; `running`, `delivering`, `integrating`, `verifying`, `proposing`, `waiting`, `retrying` → working; `proposed` → in_review; `landed` → merged; `blocked` → failed; `cancelled`, `rejected`, `declined` → dropped; an open `needs_you` → needs_you; a set `paused_at` → paused.
2. Call `ProjectItemState` for every input: 15 states × launched × needs_you × paused_at, skipping launched for non-launchable states. Compare with step 1.
3. Write the transition table from spec §4.1 only:
   - `draft→queued` (place); `queued→starting` (admit: a machine granted, the flow version pinned); `starting→working` (run's first step);
   - `starting→failed` (start failed, `failure.step = "start"`); `working→failed` (run failed or uncertain); `failed→queued` (retry, and retry with the current flow);
   - `working→needs_you` (wait opened: question, approval, conflict, moved_off, and foreign_push per §12.3); `in_review→needs_you` (foreign_push, conflict);
   - `needs_you→working` (first accepted answer, including Bring in); `needs_you→in_review` (Discard, or an answer that needs no new work);
   - `working→paused` (stop); `paused→queued` (resume);
   - `working→in_review` (PR opened for the verified revision); `in_review→working` (changes requested, a member's review comment, steer);
   - self-loops that record an event and keep the state: `in_review` (checks updated, rebased); `queued`, `starting`, `working`, `needs_you`, `paused` (steer, held or delivered per §10.7.3);
   - `in_review→merged` (PR merged and `main` contains the commit); every earlier unmerged item a later squash commit contains `→merged` (§10.6.4);
   - every stored unmerged state `→dropped` (drop; PR closed unmerged); `dropped→in_review` (PR reopened within 7 days).
4. Drive every (state, trigger) pair through the engine guards: 10 sources × every trigger the guards accept. Add the guard variants: a wait kind outside its source's list, the coding agent's answer to a non-conflict wait, a merge event without the commit on `main`, a reopen at 7 days + 1 s.
5. Send `learning_done` to a `merged` TODO.

## Pass when
- Step 2: every projected state equals the step 1 table; the test prints the input count.
- Step 4: the allowed (from, trigger) pairs equal the step 3 table exactly, and the test prints both counts.
- Every allowed case writes exactly one `todo_events` row whose `from`, `to` and `actor` match; every refused case returns `todo_transition_refused` with the from-state and trigger and writes no row.
- Each guard variant is refused.
- Step 5 returns a `lessons` increment and no state change (§4.1.3).

## Fail when
- A shortcut is allowed: `queued→working` without `starting`, `paused→working` without `queued`, `queued→in_review`, `failed→working`, `merged→working`, `dropped→queued`, or `stop` from `starting` or `needs_you`.
- An allowed case writes no event row (a state with no event, §3.2), or a refused one writes a row.
- The coding agent's answer settles a `question` or `approval` wait (§5.2 allows only its own conflicts).
- Either expected table is derived from the implementation instead of written from spec §4.1 and §4.1.0 (a tautological test).
- The guards are tested on `Transition` alone, so an engine entry point that skips it goes unseen.

## Evidence
`.artifacts/checks/C-STK-01/<UTC>/`: `go test -json` output, the printed projection and transition counts, the commit SHA.
