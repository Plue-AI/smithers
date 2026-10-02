# T-UI-21 Docs view

Stage S2 · Size S · Depends on T-UI-01 · Unblocks T-APP-20 · Issue: to file
Spec: spec.md §14.2.1 · Delta: delta.md §9 · Product: mvp.md M-35 · Props: [ui-components.md § T-UI-21](../ui-components.md)

## Goal

The docs view exists as a props-only component matching the design system, so T-APP-20 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. smithers-b8 wires it in T-APP-20.

## Scope

In:
- `DocsView`: toc rail and page view (props: toc, page, anchor, `onNavigate`), wrapping the wiki's read-only Markdown renderer; heading anchors; not-found state.
- Fixture stories for every state, light and dark, desktop and 390 px.

Out:
- Content loading, routing, requests and authorization (T-APP-20).

## Changes

- `apps/app/src/mainview/cards/views/DocsView.tsx` and CSS. Every handler calls `onAction(action.tag)` with `data-flow={action.tag}`.

## Tests

- unit: each fixture renders; the View imports no topic, store, controller or command module (C-UI-08).

## Acceptance

- [C-UI-08](../checks/C-UI-08.md).

## Risks and notes

- A prop the View needs but ui-components.md lacks is a spec change: raise it with the tech lead.
