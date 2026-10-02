# T-UI-22 Debug API view

Stage S2 · Size S · Depends on T-UI-01 · Unblocks T-APP-21 · Issue: to file
Spec: spec.md §14.2.1 · Delta: delta.md §9 · Product: mvp.md M-36 · Props: [ui-components.md § T-UI-22](../ui-components.md)

## Goal

The debug api view exists as a props-only component matching the design system, so T-APP-21 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. smithers-b8 wires it in T-APP-21.

## Scope

In:
- `DebugApiView`: operation list, request form generated from the operation schema, the in-card confirmation for mutations, response pane (status, headers, body, duration) and the typed failure state.
- Fixture stories for every state, light and dark, desktop and 390 px.

Out:
- Content loading, routing, requests and authorization (T-APP-21).

## Changes

- `apps/app/src/mainview/cards/views/DebugApiView.tsx` and CSS. Every handler calls `onAction(action.tag)` with `data-flow={action.tag}`.

## Tests

- unit: each fixture renders; the View imports no topic, store, controller or command module (C-UI-08).

## Acceptance

- [C-UI-08](../checks/C-UI-08.md).

## Risks and notes

- A prop the View needs but ui-components.md lacks is a spec change: raise it with the tech lead.
