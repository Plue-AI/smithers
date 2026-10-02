# T-FLW-09 Reconcile before retry for push, GitHub write and shell steps

Stage S2 · Size M · Depends on T-GH-09 · Unblocks T-REL-04 · Issue: to file
Spec: spec.md §4.1 (`starting|working → failed` on `uncertain`, `failed → queued`), §6.2.3, §12.4.1, §19.1, §19.2, §19.3 · Delta: delta.md §8 (flows row; research gap 1–2) · Product: mvp.md §6.1 Restart, §9 Durability and Honesty

## Goal
After the host, PostgreSQL or a machine dies mid-run, no completed step runs again, every interrupted external action is looked up before it repeats, and a step whose outcome can't be known shows the run as interrupted with Retry.

## Scope
In:
- No new engine API (spec §19.2, §21.1). Every action in the `todo` flow with an outside effect declares `tier` and `idempotencyKey` explicitly. On an `intended` irreversible crossing with a key, the engine re-executes the body, and the body checks remote state first and returns what it finds.
- The rules of §19.2: a GitHub write is looked up by its key (T-GH-09's lookups); a model call is retried; a check command on an immutable source export declares `tier: "sealed"` and simply re-runs; any other keyless irreversible shell step fails with "interrupted, retry?"; a push compares the remote ref first.
- One product state `interrupted` for an unresolvable crossing, shown on the run and TODO cards with Retry. The TODO moves to `failed{class: interrupted, retryable: true}` (§4.1).
- Retry of an interrupted TODO is a new attempt from the first step of the pinned version, and the earlier attempt and its evidence stay (§4.1). Re-running finished steps is intended there, unlike recovery.

Out:
- The GitHub lookup functions and outbound idempotency keys (T-GH-09).
- The monitor views (T-FLW-07); the kill-point suite across bursts and rebases (T-REL-04).
- Capture and burst durability inside the machine (T-COL-03).

## Changes
- No change to `packages/smithers/flows/flow/src/Action/make.ts` or `ActionPersistence.ts`: with a key, `ActionPersistence.ts:2028-2040` already re-executes an `intended` crossing; without one, its `IrreversibleRetryRequiresIdempotencyKey` refusal is projected as `interrupted`.
- GitHub-write actions: `idempotencyKey` = the T-GH-09 operation key derived from the payload; the body first looks the write up by that key (PR by head branch, comment by its hidden marker) and returns the found result, else writes.
- Shell steps: check commands run on an immutable source export (`flows/coding/checks.ts:71`), so they declare `tier: "sealed"` (or a key derived from the export digest). A lint test fails any shell action in the `todo` flow that doesn't state `tier` and `idempotencyKey` explicitly.
- Model calls → re-run (no outside effect); confirm their tier isn't `irreversible`.
- Push: `packages/backend/internal/services/mythical_items.go:2066-2074` (`pushProposal`) → on retry after a crash, `git ls-remote` the branch first. Equal to the intended head means done. Equal to the expected head means push with the existing `--force-with-lease`. Anything else is `needs_you{foreign_push}` (T-GH-06), never a push.
- Go jobs: `packages/backend/jobs/claims.go:437-450` (`uncertain`) → project as run state `interrupted`, and the TODO moves to `failed{class: interrupted, retryable: true}` from `starting` or `working` (§4.1).
- `apps/app/src/mainview/cards/RunTraceStatus.ts` → the word "Interrupted" with Retry (`/todo.retry Tn` or `runs.rerun`); the toast settles on this terminal event (§19.3).

## Tests
- Unit, `packages/smithers/flows/engine-store/test/KeyedRetryChecksRemote.test.ts` (new): an irreversible keyed action killed after `intended` re-executes once; its body finds the remote result and returns it without a second write, and the journal outcome equals an uninterrupted run's; a keyless irreversible action refuses and projects `interrupted`; a `sealed` check re-runs.
- Unit (lint): every shell action in the `todo` flow states `tier` and `idempotencyKey`.
- Unit, `packages/backend/internal/services/mythical_items_test.go` (extend): a push retry with the remote at the intended head pushes nothing; at the expected head pushes once; at a third sha raises `foreign_push`.
- Fault, `packages/smithers/test/faults/engine/` (new case, beside `case01-kill-engine-mid-action.test.ts`): SIGKILL between `intended` and `succeeded` for a keyed GitHub-write action whose body looks itself up, a `sealed` check command, and a keyless irreversible shell action (refused, `interrupted`).
- Fault (host and machine, reference host): [C-DUR-01](../checks/C-DUR-01.md) and [C-DUR-02](../checks/C-DUR-02.md).

## Acceptance
- [C-DUR-01](../checks/C-DUR-01.md): killing the host mid-run re-runs no completed step and the run resumes.
- [C-DUR-02](../checks/C-DUR-02.md): killing a machine mid-run resumes the run or shows it interrupted with Retry.
- [C-DUR-03](../checks/C-DUR-03.md) (with T-GH-09): a host kill during a GitHub write or push reconciles without duplication.

## Risks and notes
- Risk: the coding agent's own tool calls inside one implement turn aren't engine actions. A kill mid-turn re-runs the turn's model call and may repeat a file write. Confirmed by a duplicate write in the burst log after a kill. Acceptable because writes land in the jj working copy and are recoverable (§9.3.4); state it in the evidence.
- Risk: until T-GH-09 lands, the Go path repeats keyed commands blindly; research found no test that a GitHub write interrupted mid-call is reconciled (`research/flows-engine.md`).
