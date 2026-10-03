# T-UI-06 Home view with the main sync row

Stage S1 · Size M · Depends on T-UI-01, T-APP-19b · Unblocks T-APP-01, T-GH-08, T-REL-02 · Issue: [#3543](https://github.com/smithersai/smithers/issues/3543)
Spec: spec.md §14.2.1, §4.1.2a, §12.6, §14.3 (Home) · Delta: delta.md §9 · Product: mvp.md J4, J10.6 · Props: [ui-components.md § T-UI-06](../ui-components.md)
Ready: 2026-10-02 smithers-8a sha256:5cef43513343

## Goal

`HomeView`, with the `main` sync row, exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-01, T-GH-08 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- Consume actions on both attention[] and background_runs[]. Render the supplied owner/non-owner main.reset-to-github fixtures. Check: C-UI-12.
- `HomeView`: the `main` row in each sync health (fresh: synced ago; stale: gold with Retry; limited: when it retries; refused: the cause with Fix), attention rows, stack rows with their actions, `present` avatars (agents included), elapsed, Rebase pending and the `merge` reason, counts as filters, merged since last look, machine slots with who holds each, and background runs queued, running, waiting or failed with Retry and Dismiss.
- Props exactly as `ui-components.md` § T-UI-06 with the zod type reconciled by T-APP-19b from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- No schema changes, role decisions, sync reset, background-run admission or dismissal persistence. T-APP-19b supplies contracts; the existing Home wiring owns effects. Check: C-UI-08.
- Topic subscriptions, Containers, command dispatch, permission decisions and product copy changes. Will decides copy changes; smithers-06 reviews their presentation (§14.6b).
- Polling or retry scheduling, computing sync health, machine admission, background-run launch or dismissal storage, last-look persistence, attention authorization and Reset to GitHub main execution. T-APP-01 and T-GH-08 own runtime wiring.

## Changes

- The 1 s elapsed clock uses useClock from @smthrs/ui/clock; mainview .tsx imports no useEffect. Forward row actions only, including reset-to-GitHub when supplied. Check: C-UI-08, C-UI-12.

- Home `mvp-stack*`, `mvp-filter*`, `mvp-machines` and synced N s ago from `last_success_at` on a 1 s clock. Check: C-UI-12.


- Add `apps/app/src/mainview/cards/views/HomeView.tsx` (new) and CSS. Consume `@smthrs/rpc/HomeCard` and committed fixtures through module subpaths. Every handler calls `onAction` with `data-flow`, `onView`, or local presentation state.
- Fixtures from `@smthrs/rpc/fixtures/Home` (`packages/rpc/test/fixtures/`, reconciled with T-APP-19b).

## Tests

- Assert attention and failed-background Retry/Dismiss literal tags and arguments. Owner reset-to-GitHub dispatches the supplied action once; non-owner fixture has no reset control. Advance the shared 1 s clock and assert elapsed display without a new command. Check: C-UI-12.

- C-UI-12, named case `HomeView renders sync health, attention and background runs`: render the production exports in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (new harnesses), in light and dark at 1280 and 390 px; each supplied action carries `data-flow`, disabled controls show their supplied reason and do not dispatch, and each enabled press calls only its agreed callback once. Cover fresh/stale/limited/refused, order and force_push attention, all background-run states, agent presence, queue reasons and capacity zero. With a fixed clock and literal last_success_at, assert literal synced-age text before and after one second. Click a count and assert its literal onView patch; press Retry, Dismiss and attention actions once. The owner-only reset fixture supplies its action; the non-owner fixture omits it.
- Commit reviewed literal expected strings, tags, argument objects, patches and tone token names independently of the implementation. No test reads `.specs/` or derives expectations from schemas, action arrays, rendering helpers or other production code at runtime. C-UI-08 checks the production presentation files and seeded seam violations.
- smithers-06 records copy approval from the screenshots. C-UI-02 includes these fixtures when T-CAT-01 supplies the lint; that downstream audit does not block this props-only ticket.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19b's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- T-UI-01 and T-APP-19b are the landing prerequisites. Local props and fixtures allow drafting before the contracts land, not completion. The sync row and background states use fixtures; T-APP-01/T-GH-08 do not block props-only landing. This ticket adds its own C-UI-12 harness coverage with smithers-b8 pre-review.
- smithers-06 decides visuals and accepts screenshots. Will decides product copy and behavior changes. Tech lead smithers-8a accepts any ADR or spec-field change after smithers-b8 approves the app callback seam and smithers-38 approves the shared TypeScript API; raise §14.3 and ui-components.md gaps through T-APP-19b before implementation; UI lanes never raise piecemeal schema changes.

## Ready checklist

T-UI-02 through T-UI-14 go Ready together after T-APP-19b lands with smithers-38's §21.1 review. Local props permit drafting only. This UI lane makes no piecemeal schema change. Check: C-UI-08.

1. Dependencies: T-UI-01 supplies shared primitives; T-APP-19b supplies contracts and committed fixtures. The sync row and background states use fixtures; T-APP-01/T-GH-08 do not block props-only landing.
2. Exclusions: Out names the runtime effects and adjacent surfaces this presentation ticket must not implement.
3. Tests: C-UI-12 case `HomeView renders sync health, attention and background runs` renders production exports and asserts committed literal output/callback expectations; C-UI-08 checks the seam. No spec or production-derived runtime oracle.
4. Decisions: smithers-06 accepts visuals and screenshots; Will decides product changes; smithers-8a accepts ADR/spec changes after smithers-b8 seam and smithers-38 API approval.
5. Owner pre-review before start: smithers-06: answered 18:10, ok (mock 21b445a6) smithers-b8: answered 18:2x, ok; smithers-38: answered, BLOCKING edits applied (tech lead adopts).
6. Security: This presentation executes no repository code, shell commands or imported tool text. smithers-b8 pre-reviews data-only rendering and absence of RPC/fetch or host execution; wiring that executes repository code requires machine-only execution (M-29) and smithers-3f review.
