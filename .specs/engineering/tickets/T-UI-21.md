# T-UI-21 Docs view

Stage S2 · Size S · Depends on T-UI-01 · Unblocks T-APP-20 · Issue: [#3583](https://github.com/smithersai/smithers/issues/3583)
Spec: spec.md §14.2.1 · Delta: delta.md §9 · Product: mvp.md M-35 · Props: written by this ticket when S2 starts
Ready: 2026-10-03 smithers-8a sha256:240ac2aff3ba

## Goal

`DocsView` exists as a props-only View matching the design mock, so T-APP-20 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns the View, screenshots and copy decisions. smithers-b8 approves the app seam and wires it in T-APP-20; smithers-38 reviews the packages/rpc type change and renderer reuse. smithers-8a accepts changes to the specified props. Private rpc View types require no public-API sign-off (ui-components.md Rules). Owner review is post hoc under the 2026-10-03 directive; unresolved answers do not block Ready.

## Scope

In:
- `DocsView`: toc rail and page view (props `{toc[{slug, title}], page {slug, title, summary, markdown}, anchor?, not_found?}` as a TypeScript type in `packages/rpc/src/DocsCard.ts`, with its ui-components.md section, at S2). Reuse the wiki's shared `Markdown` from `@smthrs/ui`; heading anchors; the not-found state. A toc entry or an in-page `.md` link raises the supplied `gestures.open` action with `{page: "<slug>#<anchor>"}`. Without that gesture, navigation does nothing, including browser navigation.
- Stories for every state, light and dark, 1,440 px and 390 px, using T-UI-01 Paper tone tokens. T-UI-01 is recorded as landed; it remains the only ticket-code dependency.
- Lands dark until T-APP-20: no Docs card mount, command exposure or content loading is added here. T-APP-20 mounts the View through `CardRenderers.tsx` only with bundled content and supplied navigation actions; absent actions remain inert. Build against the specified props contract without adding a temporary provider. C-UI-12 proves inert gestures; T-APP-20 owns C-UI-09 and C-UI-13 for activation.

Out:
- Content loading, routing, requests, catalog dispatch and authorization (T-APP-20); page authoring (T-DOC-01).
- Search, editing, wiki subscriptions, co-editing, version history, a standalone docs site, a second Markdown parser, View-only zod schemas and a separate fixture or golden layer.

## Changes

- Reuse `packages/smithers/ui/src/primitives/markdown.tsx` and its `safeHref` filtering, as used by `apps/app/src/mainview/wiki/WikiPageView.tsx`. HTML and script text stay escaped, never active DOM. Do not import `MarkdownEditorSurface`: it reads controller state even in read-only mode.
- Reshape the existing `packages/rpc/src/DocsCard.ts` into View-only TypeScript types at S2, or restore those types if the staged cut has removed the file. Remove its View-only zod schema and schema-only tests in the same change; retain decoding of old persisted cards. Reuse `cards/MarkdownLinks.ts` link resolution and heading rules where they fit bundled pages. Do not change the shared renderer API.
- Add `apps/app/src/mainview/cards/views/DocsView.tsx` and `DocsView.stories.tsx`; put CSS in the existing `styles/cards.css`. New View code is needed because no Docs renderer exists; the wiki renderer supplies Markdown, not the bundled-page toc or Docs props seam. Every handler follows ui-components.md Rules: `onAction` with `data-flow`, `onView`, or local state. No controller, store, flow or RPC-client imports and no fetch.

## Tests

- C-UI-12: extend `apps/app/src/mainview/cards/views/Views.test.tsx` to mount the production `DocsView` with the real shared Markdown renderer. Use hand-written inputs and literal expected labels, action tags and page arguments; never read the spec or derive expected values from implementation helpers. Assert toc order, page title/body, `not_found`, toc and `.md` link activation, supplied action args, absent-gesture refusal, anchor scrolling after a page change, repeated headings and unknown anchors. Unknown anchors leave the page usable.
- Extend `apps/app/e2e/playwright/view-stories.spec.ts` for Docs stories: keyboard navigation with visible focus, anchor scrolling, no overflow at 1,440 px or 390 px, both themes, and no serious or critical axe-core violation. Render hostile `<script>` and event-handler HTML plus `javascript:`, control-character-obfuscated and `data:` links through the production View: no executable element, script execution, unsafe href or navigation occurs. Keep inert raw text visible.
- These are View-boundary tests, not `/docs` acceptance. T-APP-20 tests the production slash/button/agent dispatcher and `CardRenderers` mount under C-UI-09 and C-UI-13; this ticket adds no bypass route.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- Copy review: the design reviewer reads every story screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the View needs but spec §14.3 lacks is a spec change: smithers-8a accepts it after smithers-b8 and smithers-38 review. smithers-06 approves layout, keyboard behavior and copy.
- Security review: smithers-b8 reviews inert navigation and the props-only boundary; smithers-38 reviews shared renderer safety. Docs are data, never executable repository code. Do not evaluate code blocks, load branch modules, run commands or fetch repository content. Any later repository execution belongs in machines under spec §1.3 and M-29. This ticket introduces no root step and consumes no root inputs from main or a branch. C-UI-12 covers hostile content and missing gestures.

## Ready checklist

1. Dependencies: T-UI-01 supplies reused Paper tokens and is recorded as landed. T-APP-20 is a landing/activation condition, not a code dependency; Scope names the dark landing and inert missing gestures.
2. Exclusions: Scope excludes wiring, content, search, editing, history, co-editing, a docs site, duplicate parsing and View-only schemas/fixture layers.
3. Tests: C-UI-12 mounts the production View and renderer with literal expectations and exercises browser stories; C-UI-09/C-UI-13 remain T-APP-20 production-dispatcher and mount checks.
4. Decisions: smithers-06 approves design/copy; smithers-b8 approves the app seam; smithers-38 reviews package types/reuse; smithers-8a accepts props-spec changes. No public API change is planned.
5. Owner review: smithers-06: Does the toc/page/not-found layout match the mock in both widths/themes? Are focus and copy acceptable? smithers-b8: Do callbacks preserve supplied args and stay inert without gestures? Does T-APP-20 own all loading and production mounting? smithers-38: Can the existing Docs types become TS-only while preserving old decoding? Does shared Markdown reuse meet safety and anchor behavior without an API change? These are the pre-review questions; the directive permits post-hoc review and preserves recorded owner answers.
6. Security: smithers-b8 and smithers-38 review renderer/navigation safety; C-UI-12 exercises hostile content through the production View. No repository code execution or root step is introduced; there are no root inputs.
