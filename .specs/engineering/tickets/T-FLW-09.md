# T-FLW-09 Reconcile before retry for push, GitHub write and shell steps

Stage S2 · Size M · Depends on T-GH-09 · Unblocks T-REL-04 · Issue: to file
Spec: spec.md §4.1 (`starting|working → failed` on `uncertain`, `failed → queued`), §6.2.3, §12.4.1, §19.1, §19.2, §19.3 · Delta: delta.md §8 (flows row; research gap 1–2) · Product: mvp.md §6.1 Restart, §9 Durability and Honesty

## Goal
After the host, PostgreSQL or a machine dies mid-run, no completed step runs again, every interrupted external action is looked up before it repeats, and a step whose outcome can't be known shows the run as interrupted with Retry.

## Scope
In:
- A per-action `reconcile` hook in the flow engine, consulted before an `intended` irreversible crossing is re-dispatched.
- The rules of §19.2: a GitHub write is looked up by its key (T-GH-09's lookups); a model call is retried; a shell step re-runs only when it declares itself idempotent, and otherwise fails with "interrupted, retry?"; a push compares the remote ref first.
- One product state `interrupted` for an unresolvable crossing, shown on the run and TODO cards with Retry. The TODO moves to `failed{class: interrupted, retryable: true}` (§4.1).
- Retry of an interrupted TODO is a new attempt from the first step of the pinned version, and the earlier attempt and its evidence stay (§4.1). Re-running finished steps is intended there, unlike recovery.

Out:
- The GitHub lookup functions and outbound idempotency keys (T-GH-09).
- The monitor views (T-FLW-07); the kill-point suite across bursts and rebases (T-REL-04).
- Capture and burst durability inside the machine (T-COL-03).

## Changes
- `packages/smithers/flows/flow/src/Action/make.ts:116-125` → new option `reconcile?: (payload, key) => Effect<Option<Success>, ReconcileError>`, and `idempotent?: true` for shell actions.
- `packages/smithers/flows/engine-store/src/internal/ActionPersistence.ts:2014-2040` → for `effectCrossing === "intended"`, call `reconcile` when declared. Found: seal the attempt with the found outcome, and the body doesn't run. Not found: re-execute with the key. With no `reconcile`, no key and no `idempotent`, keep the `IrreversibleRetryRequiresIdempotencyKey` refusal and record it as `interrupted`.
- Shell steps: check commands run on an immutable source export (`flows/coding/checks.ts:71`), so declare them `idempotent`. Every other shell action in the `todo` flow states `idempotent` or `reconcile` explicitly; a lint test lists any that state neither.
- Model calls → re-run (no outside effect); confirm their tier isn't `irreversible`.
- Push: `packages/backend/internal/services/mythical_items.go:2066-2074` (`pushProposal`) → on retry after a crash, `git ls-remote` the branch first. Equal to the intended head means done. Equal to the expected head means push with the existing `--force-with-lease`. Anything else is `needs_you{foreign_push}` (T-GH-06), never a push.
- Go jobs: `packages/backend/jobs/claims.go:437-450` (`uncertain`) → project as run state `interrupted`, and the TODO moves to `failed{class: interrupted, retryable: true}` from `starting` or `working` (§4.1).
- `apps/app/src/mainview/cards/RunTraceStatus.ts` → the word "Interrupted" with Retry (`/todo.retry Tn` or `runs.rerun`); the toast settles on this terminal event (§19.3).

## Tests
- Unit, `packages/smithers/flows/engine-store/test/ReconcileBeforeRetry.test.ts` (new): reconcile found → body not invoked, attempt sealed with the found value; not found → body invoked once with the same key; no hook and no key → typed refusal and `interrupted`.
- Unit, `packages/backend/internal/services/mythical_items_test.go` (extend): a push retry with the remote at the intended head pushes nothing; at the expected head pushes once; at a third sha raises `foreign_push`.
- Fault, `packages/smithers/test/faults/engine/` (new case, beside `case01-kill-engine-mid-action.test.ts`): SIGKILL between `intended` and `succeeded` for a GitHub-write action with a lookup, a shell action with `idempotent`, and one with neither.
- Fault (host and machine, reference host): [C-DUR-01](../checks/C-DUR-01.md) and [C-DUR-02](../checks/C-DUR-02.md).

## Acceptance
- [C-DUR-01](../checks/C-DUR-01.md): killing the host mid-run re-runs no completed step and the run resumes.
- [C-DUR-02](../checks/C-DUR-02.md): killing a machine mid-run resumes the run or shows it interrupted with Retry.
- [C-DUR-03](../checks/C-DUR-03.md) (with T-GH-09): a host kill during a GitHub write or push reconciles without duplication.

## Risks and notes
- Risk: the coding agent's own tool calls inside one implement turn aren't engine actions. A kill mid-turn re-runs the turn's model call and may repeat a file write. Confirmed by a duplicate write in the burst log after a kill. Acceptable because writes land in the jj working copy and are recoverable (§9.3.4); state it in the evidence.
- Risk: until T-GH-09 lands, the Go path repeats keyed commands blindly; research found no test that a GitHub write interrupted mid-call is reconciled (`research/flows-engine.md`).
