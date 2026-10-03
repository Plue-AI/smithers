# T-UI-08 Toasts, edge map and timeline

Stage S1 · Size M · Depends on T-UI-01, T-APP-19b · Unblocks T-APP-07, T-APP-18, T-REL-02 · Issue: [#3545](https://github.com/smithersai/smithers/issues/3545)
Spec: spec.md §14.2.1, §14.4, §14.5.4, §14.6 · Delta: delta.md §9 · Product: mvp.md §6.4 · Props: [ui-components.md § T-UI-08](../ui-components.md)

## Goal

`ToastStack`, `EdgeMap` and `Timeline` exist as props-only components matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-07, T-APP-18 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- Use the shared ShellView type for toast_hidden, jump_to, on_screen and timeline_visible patches from T-APP-19b. Check: C-UI-12.
- Cap visible notices at three. Render "+N more" for hidden entries; opening it reveals every hidden entry. Keep the timeline breakpoint at ≥1180 px (.specs/design/mock/src/AppFrame.tsx:96; G6). Check: C-UI-12.
- `ToastStack` (three plus "+N more", one action each, hide), `EdgeMap` (two rows plus a count per edge, one pill on narrow screens), `Timeline` with the band, and the Allow notifications toast variant (S2).
- Props exactly as `ui-components.md` § T-UI-08 with the zod type reconciled by T-APP-19b from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- T-APP-07 owns deletion of ToastStack.tsx and migration of its consumers. This UI ticket does not delete the live entry point, request browser permission or add a local schema. Check: C-UI-08.
- Topic subscriptions, Containers, command dispatch, permission decisions and product copy changes. Will decides copy changes; smithers-06 reviews their presentation (§14.6b).
- Event delivery, audience selection, debounce scheduling, timeline summarization or lease persistence, live adaptation, ChatRunTimeline cutover, browser permission requests and notification delivery. T-APP-07 owns wiring and cutover; T-APP-18 owns secure-context and person-only notification behavior. No service worker, push, email or phone notifications.

## Changes

- Extend the seam and Architecture.test.ts import-rule scope to apps/app/src/mainview/ToastStackView.tsx, EdgeMap.tsx and Timeline.tsx in this change. Exclude them from legacy handler pins and include them in the three-handler scan. Keep ToastStack.tsx and its consumers until T-APP-07 owns live cutover and deletion. Check: C-UI-08.

- Cap visible notices at three. Render "+N more" for hidden entries; opening it reveals every hidden entry. Keep the timeline breakpoint at ≥1180 px (.specs/design/mock/src/AppFrame.tsx:96; G6). Check: C-UI-12.

- Timeline, band, pins, pills, 1,180 px breakpoint, props-only toast presentation and the fixture-only Allow notifications variant. Land the new presentation beside the existing ToastStack until T-APP-07 cuts over; T-APP-18 invokes browser permission. Check: C-UI-12.


- Add props-only `ToastStack` in `apps/app/src/mainview/ToastStackView.tsx`, `EdgeMap` in `EdgeMap.tsx` and `Timeline` in `Timeline.tsx` (new), with CSS. These are shell parts, not cards under `cards/views/`. Keep the current `ToastStack.tsx` entry point and consumers until T-APP-07 supplies live adaptation and cuts over both toasts and `ChatRunTimeline.tsx`. Every handler calls `onAction` with `data-flow`, `onView`, or local presentation state.
- Fixtures from `@smthrs/rpc/fixtures/Toast` and `@smthrs/rpc/fixtures/TimelineEntry`, reconciled in T-APP-19b.

## Tests

- Assert literal shared ShellView patches for Hide, jump, entry band and timeline visibility. Seed forbidden imports and illegal handlers for each of the three shell files and assert rejection. C-UI-12 retains the existing toast/breakpoint cases; C-UI-08 checks real files and seeds.

- Supply more than three notices, assert exactly three initially and the exact hidden count, then open "+N more" by pointer and keyboard and assert every hidden entry is available. Retain edge counts, the visible band, and 1179/1180 px cases. Check: C-UI-12.

- C-UI-12, named case `ToastStack, EdgeMap and Timeline render actions, band and breakpoint`: render the production exports in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (new harnesses), in light and dark at 1280 and 390 px; each supplied action carries `data-flow`, disabled controls show their supplied reason and do not dispatch, and each enabled press calls only its agreed callback once. Cover three toasts plus +N more, hide without deleting supplied timeline/edge entries, two edge rows plus count, absent summaries and the visible band. Click a line and assert a literal jump_to patch. At 1179 px the timeline is absent and edges are pills; at 1180 px it is present. Press each supplied action once and compare literal tags/args. The S2 Allow fixture forwards notifications.allow; an action-absent fixture has no Allow control and the View never calls Notification.requestPermission.
- Commit reviewed literal expected strings, tags, argument objects, patches and tone token names independently of the implementation. No test reads `.specs/` or derives expectations from schemas, action arrays, rendering helpers or other production code at runtime. C-UI-08 checks the production presentation files and seeded seam violations.
- smithers-06 records copy approval from the screenshots. C-UI-02 includes these fixtures when T-CAT-01 supplies the lint; that downstream audit does not block this props-only ticket.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19b's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- T-UI-01 and T-APP-19b are the landing prerequisites. Local props and fixtures allow drafting before the contracts land, not completion. S2 Allow presentation is fixture-only; secure-origin gating and delivery land in T-APP-18. Keep the current ToastStack entry point and consumers until T-APP-07 wires the new shell. This ticket adds its own C-UI-12 harness coverage with smithers-b8 pre-review.
- smithers-06 decides visuals and accepts screenshots. Will decides product copy and behavior changes. Tech lead smithers-8a accepts any ADR or spec-field change after smithers-b8 approves the app callback seam and smithers-38 approves the shared TypeScript API; raise §14.3 and ui-components.md gaps through T-APP-19b before implementation; UI lanes never raise piecemeal schema changes.

## Ready checklist

T-UI-02 through T-UI-14 go Ready together after T-APP-19b lands with smithers-38's §21.1 review. Local props permit drafting only. This UI lane makes no piecemeal schema change. Check: C-UI-08.

1. Dependencies: T-UI-01 supplies shared primitives; T-APP-19b supplies contracts and committed fixtures. S2 Allow presentation is fixture-only; secure-origin gating and delivery land in T-APP-18. Keep the current ToastStack entry point and consumers until T-APP-07 wires the new shell.
2. Exclusions: Out names the runtime effects and adjacent surfaces this presentation ticket must not implement.
3. Tests: C-UI-12 case `ToastStack, EdgeMap and Timeline render actions, band and breakpoint` renders production exports and asserts committed literal output/callback expectations; C-UI-08 checks the seam. No spec or production-derived runtime oracle.
4. Decisions: smithers-06 accepts visuals and screenshots; Will decides product changes; smithers-8a accepts ADR/spec changes after smithers-b8 seam and smithers-38 API approval.
5. Owner pre-review before start: smithers-06: answered 18:10 with these changes (mock 21b445a6) smithers-b8: answered, BLOCKING edits applied (tech lead adopts); smithers-38: answered, BLOCKING edits applied (tech lead adopts).
6. Security: This presentation executes no repository code, shell commands or imported tool text. smithers-b8 pre-reviews data-only rendering and absence of RPC/fetch or host execution; wiring that executes repository code requires machine-only execution (M-29) and smithers-3f review.
