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
5. Read the journal attempt rows per step, `product_job_events`, the provider fixture log and the `run:<id>` projection.

## Pass when
- For every kill point, each step that had finished before the kill has exactly one attempt row and is not re-dispatched.
- K2: the in-flight model call is re-issued at most once.
- K3: the check re-runs once because it is declared idempotent, and the evidence shows one result.
- K4: the wait survives with the same wait id and "since"; the answer settles it.
- Every run reaches In review, or shows `interrupted` with Retry; none stays `working` with no progress for 5 min.
- No state appears on the TODO card before its `product_job_events` row exists, before or after the restart.

## Fail when
- A finished step (plan, a passed check) runs a second time.
- The restart re-sends a model call twice or more.
- The run silently stops with no terminal state or Retry.
- The TODO shows `in_review` or a passed check before the event that proves it.

## Evidence
`.artifacts/checks/C-DUR-01/<UTC timestamp>/`: per kill point, the attempt table dump, provider fixture log, `product_job_events`, launcher restart log with timestamps, `run:<id>` snapshots before and after, and the commit and install version.

## Recorded TODO crossings

`TestTodoHostRecordedKillThroughInstall` extends the installed rehearsal. Each
`K1`–`K5` case has a `crossing` subtest with its own kill marker and final literal
observation. Setup markers cannot qualify a crossing. The nightly TypeScript
runner requires all five observations as well as the existing keyless Retry
control; a skipped, unreached or partially executed campaign fails qualification.

| Point | Production crossing | Recovery observation |
| --- | --- | --- |
| K1 | PostgreSQL trigger holds the first completed plan projection before commit; kill its coding host. | Route and planner requests remain single; completed run steps retain their keys, outcomes and completion times. |
| K2 | Recorded provider holds the implement model response; kill its coding host. | The identical request is issued at most twice total; later conversation messages are separate requests. |
| K3 | Scratch repository's `pnpm test` runs through the immutable-source check and waits on an external check fixture. | Two check calls total and one accepted result; no finished route or plan repeats. |
| K4 | Served TODO has a real question. | Same run, question ID and since; POST answer settles the retained question. |
| K5 | At K2, SIGKILL only the owned PostgreSQL 18 cluster and restart it on its existing data directory. | Original run and pin remain, finished steps do not repeat, and terminal TODO facts precede the served state. |

The private PostgreSQL controller never signals the shared test server. The
recorded provider logs full request messages to distinguish a retry from a
later turn. Evidence includes before/after TODO and run projections, provider
requests and counts, and durable product events. Completed steps are compared
by their retained production run keys and outcomes, not reconstructed from a
fixture outcome.

`SMITHERS_FAULT_HOST=reference` selects the approved bundle, real microVMs and
the existing owned install-worker process controller. Set
`SMITHERS_FAULT_INSTALL_BUNDLE`; the host kill targets that owned backend worker process group, then reopens
the retained runtime behind the same HTTP listener. Linux crossings use the explicit trusted-process rehearsal and
remain supplemental to the reference campaign. K3's Node recipe requires a real
image builder; the Linux base-only adapter refuses it before dispatch rather
than fabricating a machine-ready receipt. Linux coding-host receipts do not qualify an install backend process-group
kill. The owned reference worker controller does not qualify launchd supervisor
restart; that observation still requires the supervised installed package.

The declared `//packages/smithers:faultsReference` target runs both tiers with
`SMITHERS_FAULT_HOST=reference` and the owner-provisioned bundle at
`.artifacts/fault-install-bundle`. It refuses outside macOS, outside the
committed IOPlatformUUID allowlist, or without the bundle. The empty allowlist
is an outstanding owner prerequisite, not passing reference evidence.
