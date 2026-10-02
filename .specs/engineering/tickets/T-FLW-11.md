# T-FLW-11 One `todo` run per attempt: composition flow over coding steps, ending in `stack.propose`

Stage S1 · Size L · Depends on T-FLW-01, T-STK-01, T-MCH-14 · Unblocks T-STK-05, T-STK-06, T-FLW-03, T-FLW-04, T-FLW-05 · Issue: [#3450](https://github.com/smithersai/smithers/issues/3450)
Spec: spec.md §10.4.1, §10.4.1a, §11.1, §11.4 · Delta: delta.md §6 · Product: mvp.md §6.9, §6.12, J5, M-30

## Goal
A TODO attempt is one durable run of one pinned `todo` flow version, from route to merge or drop. That gives J5's override, version pinning, steering and stop/resume a single run to act on.

## Scope
In:
- `flows/todo/flow.ts` as the built-in composition: `Flow.make("todo", …)` composing step flows exported from `flows/coding/` (route, plan, implement, check, review, package), plus the post-propose event loop in spec §10.4.1.
- The system operation `stack.propose` (packaged, not overridable) that hands a verified candidate to the stack engine.
- The stack engine launches one `todo` run per attempt and signals it (`rebased`, `steer`, `changes_requested`, `merged`, `dropped`) instead of launching `coding/request`, `coding/vibe`, `coding/verify` and `review/change` separately.

Out:
- `/flow.edit` (T-FLW-05).
- Activation and pinning (T-FLW-03, T-FLW-04).
- Learning (T-FLW-06).

## Changes
- `flows/todo/flow.ts` (new): the composition, about 60 lines. It imports steps from `flows/coding/` exports.
- `flows/coding/` → export the step flows the composition needs (from `request/`, `implementation/`, `checks.ts`, `vibe/` packaging, `verify/`), keeping one implementation of each step. Delete the top-level entrypoints that only the Go worker called once nothing launches them.
- `packages/backend/internal/services/mythical_items.go` → replace the launch sites at `:1681` (`coding/request`), `:1775` (`coding/vibe`) and `:1905` (`coding/verify`), and the `mythicalReviewFlow` launch, with one `todo` launch per attempt plus durable signals. Item states keep their meaning as phases the run reports (spec §4.1.0).
- `stack.propose` (new system operation in the host flow runtime, wired to the stack engine's existing propose path, `mythical_items.go` `propose` at `:1951`).
- `flows/repository/registry.ts` → register `todo` as overridable and `stack.propose` as reserved (M-30).
- Tests and fixtures under `flows/test/` that assume four runs → updated in the same change.

## Tests
- Integration (real flow host, fake GitHub): a TODO runs end to end as one run id. A rebase signal re-enters check and re-proposes without a new run, a steer re-enters implement, and `merged` ends the run.
- Fault: kill the host between `stack.propose` and the PR open. On restart the run resumes waiting, and the PR opens exactly once (outbound key, T-GH-09).
- Unit: the composition's step graph equals route → plan → implement → check → review → package → propose.
- Regression: every behavior the four runs had (correction rounds, history cleaning, verification after a rebase, read-only review) is covered by a named test in the new shape.

## Acceptance
- [C-J5-01](../checks/C-J5-01.md): an overridden `todo` applies to TODOs started after activation, and running ones keep their version.
- [C-STK-03](../checks/C-STK-03.md): stop and resume act on this one run.

## Risks and notes
- Risk: long-lived runs (days in review) hold a durable wait per TODO. Confirm with a fault test that 50 waiting runs survive a host restart and resume on signals. This is the engine's existing durable wait (`WaitFor`).
- Risk: today's `coding/verify` runs on the stack tip as a separate run with its own source. Moving it into the TODO run must keep "verify the rebased candidate", not "verify the branch". Prove it with a rebase test whose tip differs from the branch head.
- Decision for the tech lead if it arises: whether `review/change` stays callable outside TODOs for `/review` (Appendix A). The expected answer is yes, as the same `review` flow.
