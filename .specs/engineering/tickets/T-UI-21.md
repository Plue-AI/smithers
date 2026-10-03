# T-UI-21 Docs view

Stage S2 · Size S · Depends on T-UI-01 · Unblocks T-APP-20, T-REL-02 · Issue: [#3583](https://github.com/smithersai/smithers/issues/3583)
Spec: spec.md §14.2.1 · Delta: delta.md §9 · Product: mvp.md M-35 · Props: written by this ticket when S2 starts

## Goal

`DocsView` exists as a props-only View matching the design mock, so T-APP-20 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. smithers-b8 wires it in T-APP-20.

## Scope

In:
- `DocsView`: toc rail and page view (props `{toc[{slug, title}], page {slug, title, summary, markdown}, anchor?}` as a TypeScript type this ticket adds back in `packages/rpc/src/DocsCard.ts`, with its ui-components.md section, when S2 starts), wrapping the wiki's read-only Markdown renderer; heading anchors; the not-found state. A toc entry or an in-page link raises the `open` gesture with `{page: "<slug>#<anchor>"}`.
- Stories for every state, light and dark, desktop and 390 px.

Out:
- Content loading, routing, requests and authorization (T-APP-20).

## Changes

- Sanitized Markdown; no raw HTML or script survives.
- `apps/app/src/mainview/cards/views/DocsView.tsx` and CSS. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- `apps/app/src/mainview/cards/views/DocsView.stories.tsx`: one story per state, with literal expected strings and actions.

## Tests

- unit (`cards/views/Views.test.tsx` over `*View.stories.tsx`): each story renders in both themes with no console error and shows its literal expected strings; each press calls `onAction` with its literal tag and arguments, or `onView` with its literal patch, once; a story with its first action removed shows no control for it. The View-seam rule (`flows/parity.test.ts`) passes on the View's file.
- Playwright (`view-stories.spec.ts`): in both themes, no overflow at 390 px and no serious or critical axe-core violation.

## Acceptance

- Copy review: the design reviewer reads every story screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the View needs but spec §14.3 lacks is a spec change: raise it with the tech lead.
