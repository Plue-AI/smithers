# T-UI-10 Flow view

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-APP-05, T-REL-02 · Issue: [#3547](https://github.com/smithersai/smithers/issues/3547)
Spec: spec.md §14.2.1, §11, §14.3 (Flow) · Delta: delta.md §9 · Product: mvp.md J5, J11 · Props: [ui-components.md § T-UI-10](../ui-components.md)

Landed (214c4feff).

## Goal

`FlowView` renders a flow's source, versions and steps from props, so T-APP-05 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-05.

## Scope

In:
- Landed: the source label, versions with their states, steps with their agent and the supplied `added` mark, and Source, Plan, Run, Edit. The version chip is React local state.
- Remaining: merge `apps/app/src/mainview/styles/views/flow.css` into `styles/cards.css` and drop the `mvp-` prefix (`mvp-version*`) (minimal-code synthesis v1 §6).

Out:
- Flow loading, activation, digests, pinning, source edits and draft execution (T-FLW-03, T-FLW-04, T-APP-05).

## Changes

- Move `styles/views/flow.css` into `styles/cards.css`, renaming `mvp-` classes; delete it and its import in `styles/views.css`.
- Mounting: T-APP-05 mounts `FlowView` through the landed `cards/FlowContainer.tsx` and deletes `cards/WorkflowCards.tsx` in the same change (pair: FlowView; v1 §2).

## Tests

The Flow cases in `apps/app/src/mainview/cards/views/Views.test.tsx` cover:
- active, proposed, merged-syncing, merged-failed and previous versions; built-in and repository source labels;
- `added` true, false and absent, marked relative to the supplied Active version;
- selecting a version changes the display and sends no `onAction` or `onView`;
- Source, Plan, Run and Edit dispatch their literal tags once; omitted actions render no control.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. `styles/views/flow.css` is gone.

## Risks and notes

- Source text is data. FlowView never imports or evaluates a repository flow (M-29).
