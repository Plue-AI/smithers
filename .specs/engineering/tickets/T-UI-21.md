# T-UI-21 Docs view

Stage S2 · Size S · Depends on T-UI-01, T-APP-19 · Unblocks T-APP-20, T-REL-02 · Issue: [#3583](https://github.com/smithersai/smithers/issues/3583)
Spec: spec.md §14.2.1 · Delta: delta.md §9 · Product: mvp.md M-35 · Props: [ui-components.md § T-UI-21](../ui-components.md)

## Goal

`DocsView` exists as a props-only View matching the design mock and ui-components.md, so T-APP-20 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. smithers-b8 wires it in T-APP-20.

## Scope

In:
- `DocsView`: toc rail and page view (`DocsModel`, ui-components.md § T-UI-21), wrapping the wiki's read-only Markdown renderer; heading anchors; the not-found state. A toc entry or an in-page link raises the `open` gesture with `{page: "<slug>#<anchor>"}`.
- Fixture stories for every state, light and dark, desktop and 390 px.

Out:
- Content loading, routing, requests and authorization (T-APP-20).

## Changes

- Sanitized Markdown; no raw HTML or script survives. Check: C-UI-12.


- `apps/app/src/mainview/cards/views/DocsView.tsx` and CSS. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.

## Tests

- unit (C-UI-12): every fixture of the card renders with its actions and shows its `expect` strings, in light and dark at 1280 and 390 px; each press calls `onAction` or `onView` once. The View-seam rule passes on the View's file (C-UI-08).

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the View needs but ui-components.md lacks is a spec change: raise it with the tech lead.
