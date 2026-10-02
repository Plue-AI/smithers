# T-FLW-11 One `todo` run per attempt: composition flow over coding steps, the candidate handshake and the post-propose wait

Stage S1 · Size L · Depends on T-FLW-01, T-STK-01, T-MCH-14, T-STK-12 · Unblocks T-STK-05, T-STK-06, T-FLW-03, T-FLW-04, T-FLW-05 · Issue: [#3450](https://github.com/smithersai/smithers/issues/3450)
Spec: spec.md §10.4.1, §10.4.1a, §10.4.4, §10.4.5, §11.1, §11.4 · Delta: delta.md §6 · Product: mvp.md §6.9, §6.12, J5, M-30

## Goal
A TODO attempt is one durable run of one pinned `todo` flow version, from route to merge or drop. That gives J5's override, version pinning, steering and stop/resume a single run to act on.

## Scope
In:
- `flows/todo/flow.ts` as the built-in composition: `Flow.make("todo", …)` composing step flows exported from `flows/coding/` (route, plan, implement, check, review) and the reserved `candidate` and `propose` steps, plus the post-propose event loop in spec §10.4.1, including `edited` and the propose refusals (§10.4.4).
- The system operations `stack.candidate` and `stack.propose` (T-STK-12; packaged, not overridable) as the composition's reserved steps. Checks run in the working copy between the two captures, and the `review` flow reads the candidate's own diff. The engine writes the item's one commit from the captured tree, so the composition has no package step.
- The stack engine launches one `todo` run per attempt and signals it (`rebased`, `edited`, `steer`, `changes_requested`, `merged`, `dropped`) instead of launching `coding/request`, `coding/vibe`, `coding/verify` and `review/change` separately.
- Delete the registrations of `coding/Request`, `coding/Vibe`, `coding/Verify` and `review/change` (Appendix C: Replaced); their steps stay as exported step flows. C-CAT-01's Replaced assertion turns on in this change (§6.1.2c). `/review` runs the overridable `review` flow (C-J10-09).

Out:
- `/flow.edit` (T-FLW-05).
- Activation and pinning (T-FLW-03, T-FLW-04).
- Learning (T-FLW-06).

## Changes
- `flows/todo/flow.ts` (new): the composition, about 60 lines. It imports steps from `flows/coding/` exports.
- `flows/coding/` → export the step flows the composition needs (from `request/`, `implementation/`, `checks.ts`, `vibe/` packaging, `verify/`), keeping one implementation of each step. Delete the top-level entrypoints that only the Go worker called once nothing launches them.
- `packages/backend/internal/services/mythical_items.go` → replace the launch sites at `:1681` (`coding/request`), `:1775` (`coding/vibe`) and `:1905` (`coding/verify`), and the `mythicalReviewFlow` launch, with one `todo` launch per attempt plus durable signals. Item states keep their meaning as phases the run reports (spec §4.1.0).
- `stack.candidate` and `stack.propose` steps in the host flow runtime, calling T-STK-12's `Candidate` and `Propose`; `Propose` reaches the stack engine's existing propose path (`mythical_items.go` `propose` at `:1951`) only after acceptance.
- `flows/repository/registry.ts` → register `todo` as overridable and `stack.candidate` and `stack.propose` as reserved (M-30).
- Tests and fixtures under `flows/test/` that assume four runs → updated in the same change.

## Tests
- Integration (real flow host, fake GitHub): a TODO runs end to end as one run id. A rebase signal re-enters `candidate` and check and re-proposes without a new run, an `edited` signal re-enters `candidate`, a steer re-enters implement, and `merged` ends the run.
- Integration: C-STK-06 parts A-D on the real composition. An edit during check, an edit during capture, a steer during check and a `main` move during check each refuse `stack.propose`, and the run re-enters `candidate` or `implement` on the same run id.
- Fault: kill the host between `stack.propose` and the PR open. On restart the run resumes waiting, and the PR opens exactly once (outbound key, T-GH-09).
- Unit: the composition's step graph equals route → plan → implement → candidate → check → review → propose, with the loop edges of spec §10.4.1.
- Regression: every behavior the four runs had (correction rounds, one commit per item, now written by `stack.candidate`, verification after a rebase, read-only review) is covered by a named test in the new shape.

## Acceptance
- [C-CAT-01](../checks/C-CAT-01.md): the four Replaced entry points have no registrations.

- [C-J5-01](../checks/C-J5-01.md): an overridden `todo` applies to TODOs started after activation, and running ones keep their version.
- [C-STK-03](../checks/C-STK-03.md): stop and resume act on this one run.
- [C-STK-06](../checks/C-STK-06.md): the PR head's tree is the tree checks ran on.

## Risks and notes
- Risk: long-lived runs (days in review) hold a durable wait per TODO. Confirm with a fault test that 50 waiting runs survive a host restart and resume on signals. This is the engine's existing durable wait (`WaitFor`).
- Resolved by spec §10.4.4: today's `coding/verify` checks the rebased candidate in its own lane. In the one run, checks run in the shared working copy, and `stack.propose` accepts them only when the capture after them has the candidate's tree on the current prefix. C-STK-06 part D proves it with a rebase whose tip differs from the branch head.
- Resolved (product, Appendix C): `review/change` is Replaced; `/review` runs the `review` flow. Check: C-CAT-01.
