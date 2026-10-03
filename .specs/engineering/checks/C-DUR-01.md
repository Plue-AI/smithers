# C-DUR-01 Killing the host mid-run re-runs no completed step

Proves: mvp.md §6.1 Restart, §9 Durability · spec.md §19.1, §19.2, §1.2, §3.2 · Layer: fault · Stage: S2 · Tickets: T-FLW-09, T-REL-04
Automation: `packages/smithers/test/faults/host/case40-host-kill-todo-run.test.ts` (new), driving a real `smithers-backend`, PostgreSQL 18 and a coding host · Runs in: CI (test process runtime) and reference host (microVMs), nightly

## Setup
- Install at the commit under test under its launcher supervisor (§1.2), real PostgreSQL 18, fake GitHub server.
- Scratch repository with `test` and `lint` scripts; the `todo` flow's model calls answered by a recorded provider fixture that logs every request.
- Kill points, each in its own run of the suite:
  - K1: after `plan` finishes, before its projection commits;
  - K2: during a model call in `implement`;
  - K3: during the `pnpm test` check;
  - K4: while the run waits on a question;
  - K5: kill PostgreSQL instead of the host, at K2.

## Steps
1. Start a TODO and drive it to the kill point.
2. `SIGKILL` the target process. Let the launcher restart it.
3. For K4, answer the question after the restart.
4. Let the run reach In review, or a terminal state.
5. Read the journal attempt rows per step, `item_events`, the provider fixture log and the `run:<id>` projection.

## Pass when
- For every kill point, each step that had finished before the kill has exactly one attempt row and is not re-dispatched.
- K2: the in-flight model call is re-issued at most once.
- K3: the check re-runs once because it is declared idempotent, and the evidence shows one result.
- K4: the wait survives with the same wait id and "since"; the answer settles it.
- Every run reaches In review, or shows `interrupted` with Retry; none stays `working` with no progress for 5 min.
- No state appears on the TODO card before its `item_events` row exists, before or after the restart.

## Fail when
- A finished step (plan, a passed check) runs a second time.
- The restart re-sends a model call twice or more.
- The run silently stops with no terminal state or Retry.
- The TODO shows `in_review` or a passed check before the event that proves it.

## Evidence
`.artifacts/checks/C-DUR-01/<UTC timestamp>/`: per kill point, the attempt table dump, provider fixture log, `item_events`, launcher restart log with timestamps, `run:<id>` snapshots before and after, and the commit and install version.
