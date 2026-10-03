# T-UI-05 Confirm view

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-APP-04, T-MNT-03 · Issue: [#3542](https://github.com/smithersai/smithers/issues/3542)
Spec: spec.md §14.2.1, §5.4, §14.3 (Confirm) · Delta: delta.md §9 · Product: mvp.md §6.2, B.6 · Props: [ui-components.md § T-UI-05](../ui-components.md)

Landed (c90e3383a, 97d3874b1).

## Goal

`ConfirmView` renders both confirmation kinds and their receipts from props, so T-APP-04 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-04.

## Scope

In:
- Landed: `one_click` (verb, the exact text sent, Cancel, receipt) and `review_merge` (title, place, PR link, the subject revision's evidence, a stale approval "You approved <rev>", the `merge` control, on GitHub ↗, Cancel). Subjects are todo, branch, flow, agent and wiki only. Receipts are done, cancelled or expired. Controls dispatch their supplied `actions[]` entries, never `model.action.tag`. Cancel binds `confirm.cancel` with `{confirmation, revision}`.
- Remaining: merge `apps/app/src/mainview/styles/views/confirm.css` into `styles/cards.css`.

Out:
- Confirmation creation, audience filtering, authorization, expiry timers, approval persistence, revision checks and merge execution (T-APP-04). No confirmation for Members, Secrets or Settings.

## Changes

- Move `styles/views/confirm.css` into `styles/cards.css`; delete it and its import in `styles/views.css`.
- Mounting: T-APP-04 mounts `ConfirmView` and deletes `cards/ApprovalCard.tsx` and `cards/ApprovalAnswer.tsx` in the same change (pair: ConfirmView; v1 §2).

## Tests

The Confirm cases in `apps/app/src/mainview/cards/views/Views.test.tsx` cover:
- approval and Cancel dispatch their literal supplied bindings once, never the initiating command;
- Cancel emits `confirm.cancel` once with the literal `{confirmation, revision}`;
- merge binds the reviewed revision once; a disabled action shows its reason and cannot dispatch;
- a missing approval action leaves only the supplied controls;
- a stale approval is distinct from an expired receipt; receipts have no controls;
- hostile command text renders exact and inert.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. `styles/views/confirm.css` is gone.

## Risks and notes

- Other-viewer privacy is a production test in T-APP-04 ([C-ACC-02](../checks/C-ACC-02.md)), not a View claim.
