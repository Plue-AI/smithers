# T-UI-22 Debug API view

Stage S2 · Size S · Depends on T-UI-01 · Unblocks T-APP-21, T-REL-02 · Issue: [#3584](https://github.com/smithersai/smithers/issues/3584)
Spec: spec.md §14.2.1 · Delta: delta.md §9 · Product: mvp.md M-36 · Props: written by this ticket when S2 starts

## Goal

`DebugApiView` exists as a props-only View matching the design mock, so T-APP-21 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. smithers-b8 wires it in T-APP-21.

## Scope

In:
- `DebugApiView` (props as a TypeScript type this ticket adds back in `packages/rpc/src/DebugApiCard.ts`, with its ui-components.md section, when S2 starts): operation list, the request form from the Send action's generated `input`, the in-card confirmation for mutations, response pane (status, headers, body, duration) and the typed failure state.
- Stories for every state, light and dark, desktop and 390 px.

Out:
- Content loading, routing, requests and authorization (T-APP-21).

## Changes

- `apps/app/src/mainview/cards/views/DebugApiView.tsx` and CSS. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.

## Tests

- Playwright (`view-stories.spec.ts`): in both themes, no overflow at 390 px and no serious or critical axe-core violation.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- Copy review: the design reviewer reads every story screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the View needs but spec §14.3 lacks is a spec change: raise it with the tech lead.
