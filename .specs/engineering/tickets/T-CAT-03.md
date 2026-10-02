# T-CAT-03 Reject replaced flow tags after the TODO composition lands

Stage S1 · Size S · Depends on T-CAT-01 · Unblocks — · Issue: to file
Spec: spec.md §6.1.1–§6.1.4 (incl. §6.1.2a–c), §14.2, §15.1.4, §15.1.5, §15.3 · Delta: delta.md §9 (Add one catalog source; Hide/Delete every command not in Appendix A) · Product: mvp.md §2 rule 1, §6.4 "Commands", §6.13, §6.14 (Advanced group), §8 (CLI and skill), §11 stage 1 item 8, M-21, Appendix A, Appendix B (B.1, B.2, B.4, B.6), Appendix C (`actions.md`)

## Goal

Reject Appendix C tags marked Replaced once T-FLW-11 lands.

## Scope

In:
  - Flow tags: every `Flow.make`, `Action.make` and `AgentAction.make` tag registered in shipped flows and std tools has an Appendix C row (`.specs/product/actions.md`, 386 rows), and none is marked Cut or, from T-FLW-11's change on, Replaced. Defer and Internal ops rows pass. A ticket that adds a tag adds its row in the same change.

Out:
- The landed scope of T-CAT-01, except the follow-up changes stated here.

## Changes

- Extend `packages/rpc/src/catalog/AppendixC.test.ts` with the conditional Replaced rejection from the scope.

## Tests

- Unit: C-CAT-01 step 8 rejects Replaced tags after T-FLW-11 lands and retains its existing Cut-tag rejection.

## Acceptance

- [C-CAT-01](../checks/C-CAT-01.md): step 8 rejects Replaced tags once T-FLW-11 lands.

## Risks and notes

- Gate Replaced rejection on T-FLW-11; do not reject the composition it replaces before that change lands.
