# T-UI-04 TODO view: states, waits, repair, evidence, PR and merge

Stage S1 · Size M · Depends on T-UI-01 · Unblocks T-APP-02, T-FLW-10, T-GH-06, T-MCH-08, T-REL-02, T-STK-08 · Issue: [#3541](https://github.com/smithersai/smithers/issues/3541), [#3552](https://github.com/smithersai/smithers/issues/3552)
Spec: spec.md §14.2.1, §4.1, §4.1.0a, §8.5, §9.3.8, §10.5.4, §10.6.4, §12.3, §12.5.1, §14.3 (TODO) · Delta: delta.md §9 · Product: mvp.md J2, J4, J7, J10, J10.3, M-32, M-33 · Props: [ui-components.md § T-UI-04](../ui-components.md)

Landed (7d73b0720). Absorbs T-UI-04 (minimal-code synthesis v1 §7).

## Goal

`TodoView` renders every TODO state, wait, repair form, evidence, PR line and merge control from props, so T-APP-02, T-STK-08, T-MCH-08 and T-GH-06 only bind data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-02; T-STK-08, T-MCH-08 and T-GH-06 bind the repair actions.

## Scope

In:
- Landed: the nine states; prompt revisions ("+n"); steers with authors; steps with the current one lit; every open wait in its own row, primary first, with its own actions; question and approval forms with the first answer and Send as steer; failure with Retry and Retry with the current flow; the removed-owner chip and Take over; Add to machine image; evidence per attempt bound to its revision (C-J2-04); the PR line, `merged_via` and the one `merge` control.
- Remaining:
  - Repair waits from T-UI-04, rendered by the existing wait row (`TodoView.tsx:160`) and its actions; no new form components (smithers-06). `conflict`: paths, Resolve, a terminal slot and the SSH line, Done; from S2 Resolve opens the Branch card (§10.5.4). `moved_off` with Resolve (§9.3.8); Return to Tn and Keep for now stay on the Branch card (T-UI-15). `foreign_push`: the pusher, the commit, Bring in and Discard (§12.3, M-33). Bring in and Discard take the ConfirmView treatment when the supplied action asks for confirmation.
  - Fork and Add to stack as supplied card actions (§8.5, M-32).
  - Fold `views/TodoActionView.tsx` (89 lines, one caller) into `TodoView.tsx` (v1 §6).
  - Merge `apps/app/src/mainview/styles/views/todo.css` into `styles/cards.css` and drop the `mvp-` prefix.

Out:
- State and queue derivation, merge readiness, authorization, checks, PR writes and image builds (T-APP-02).
- Conflict-marker validation, wait settlement, precedence, stale-sha checks, history mutation and fork placement (T-STK-08, T-GH-06, T-MCH-08). The View never connects a terminal or runs a command.

## Changes

- `views/TodoView.tsx`: add `conflictTerminal?: ReactNode`, placed in the conflict wait row. `cards/TodoContainer.tsx` supplies it. Inline `TodoActionView`; delete the file.
- Move `styles/views/todo.css` into `styles/cards.css`, renaming `mvp-` classes; delete it and its import in `styles/views.css`.
- Mounting: T-APP-02 mounts `TodoView` through the landed `cards/TodoContainer.tsx`.

## Tests

The TODO cases in `apps/app/src/mainview/cards/views/Views.test.tsx` cover:
- all nine states, two simultaneous waits in supplied order with independent actions, a late answer kept as Send as steer;
- question, approval, Retry, Take over, Edit and Merge each dispatch their literal tag and wait inputs once; a removed action removes its control; a disabled Merge is text;
- conflict: the literal paths and SSH line, the supplied terminal slot, Resolve and Done each once with the wait id; the View opens no terminal connection;
- moved_off with Resolve; foreign_push with the pusher, commit, Bring in and Discard, each carrying the supplied `sha` unchanged; a missing Discard renders no control;
- Fork and Add to stack dispatch their literal tags once;
- the conflict form stacks vertically at 390 px and keyboard order follows reading order;
- hostile path, commit and actor text renders as inert text.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. `TodoActionView.tsx` and `styles/views/todo.css` are gone.

## Risks and notes

- A repair field the wait row lacks is a TodoCard schema change, made in this ticket with the tech lead's approval.
