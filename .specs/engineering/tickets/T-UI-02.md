# T-UI-02 Setup and Settings views

Stage S1 · Size M · Depends on T-UI-01, T-APP-19b · Unblocks T-APP-03, T-FLW-12, T-REL-02 · Issue: [#3539](https://github.com/smithersai/smithers/issues/3539)
Spec: spec.md §14.2.1, §12.1.1, §14.3 (Setup / Settings), §8.2.1 · Delta: delta.md §9 · Product: mvp.md J1, §6.1 · Props: [ui-components.md § T-UI-02](../ui-components.md)

## Goal

`SetupView` and `SettingsView` exist as props-only Views matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-03 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- Use SetupCard and SettingsCard reconciled by T-APP-19b. The seven step ids are address, app_manifest, sign_in, repository, models, source and machine. Include blocked with blocked.line and blocked.fix_url; this_mac.limit with capacity 0; Settings health (process, postgres_bytes, disk_free_gb, GitHub sync and rate budget) and Obsidian last_sync_at. Check: C-UI-12.
- Render the third model role as "Decisions"; keep "AI Gateway key" on its key field. When This Mac has capacity 0, render "No machine fits", the supplied limiting term and its fix link on one line. Add the zero-capacity story; it is absent from the mock. Check: C-UI-12.
- `SetupView`: the seven steps in §16.2 order (`address`, `app_manifest` with the owning account, `sign_in`, `repository` with the squash check, `models`, `source`, `machine`), each pending, running, done, blocked with its fix link, or failed with Retry; Address; This Mac with the limiting term and its fix when capacity is 0; the three model roles ("Fast model", "Coding model" and "Decisions" with its "AI Gateway key") with each key's state and error; Source and Machine percentages. `SettingsView`: the same plus the Machines and TODOs at once steppers, the laptop-agent lines, health (process, PostgreSQL size, disk free, GitHub sync and rate budget), "Notifications need HTTPS ↗" on a plain-HTTP origin, and the Obsidian folder with its last sync (S2 data, built now from fixtures).
- Props exactly as `ui-components.md` § T-UI-02 with the zod type reconciled by T-APP-19b from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Do not export a new clipboard helper or change rpc schemas in this UI lane. Consume copyText exported by T-UI-01 (follow-up); T-APP-19b owns all schema gaps. Check: C-UI-08.
- Topic subscriptions, Containers, command dispatch, permission decisions and product copy changes. Will decides copy changes; smithers-06 reviews their presentation (§14.6b).
- Installation, GitHub App manifest exchange, OAuth, key validation or storage, toolchain detection, image builds, capacity calculation, Obsidian sync and browser notification permission. This ticket renders their supplied states; T-APP-03 and T-FLW-12 own wiring.

## Changes

- Copy uses copyText exported by T-UI-01 (follow-up) from `@smthrs/ui`, backed by the existing internal `copyToClipboard` helper with its `execCommand` fallback for plain HTTP. T-UI-01 owns that export and fallback. Render the reconciled Setup/Settings fields. Check: C-UI-12.

- Render the third model role as "Decisions"; keep "AI Gateway key" on its key field. When This Mac has capacity 0, render "No machine fits", the supplied limiting term and its fix link on one line. Add the zero-capacity story; it is absent from the mock. Check: C-UI-12.

- Setup and Settings rows, unencrypted mark, This Mac, Obsidian row and Add to machine image. Check: C-UI-12.


- Add `apps/app/src/mainview/cards/views/SetupView.tsx` and `SettingsView.tsx` (new) and CSS. Consume T-APP-19b types through `@smthrs/rpc/SetupCard` and `@smthrs/rpc/SettingsCard`; fixtures remain in `packages/rpc/test/fixtures/`. Each handler calls `onAction` with `data-flow`, `onView`, or local presentation state.
- Fixtures from `@smthrs/rpc/fixtures/Setup` and `@smthrs/rpc/fixtures/Settings` (`packages/rpc/test/fixtures/`, reconciled with T-APP-19b).

## Tests

- Assert the literal seven-step order with app_manifest, blocked fix URL, zero-capacity limit and fix, health values and Obsidian last sync. Exercise Copy with navigator.clipboard unavailable through copyText exported by T-UI-01 (follow-up) and with a refused native write; assert the shared `execCommand` fallback and one copy with no setup or key-storage effect. Check: C-UI-12.

- Assert the literal Decisions role label and key label. Render the zero-capacity story at 390 px and assert "No machine fits", the limiting term and fix link on one line. Retain setup-step and key-error coverage (J1 s1–30; States s42–s43). Check: C-UI-12.

- C-UI-12, named case `SetupView and SettingsView render setup and settings states`: render the production exports in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (new harnesses), in light and dark at 1280 and 390 px; each supplied action carries `data-flow`, disabled controls show their supplied reason and do not dispatch, and each enabled press calls only its agreed callback once. Cover the seven steps in order, every step state, zero capacity and its fix, all model key states, health and HTTPS notices, and the optional Obsidian fixture. Compare button tags and submitted field values with committed literal expectations. Omit controls when the supplied action is absent, including the S2 docs link in S1.
- Commit reviewed literal expected strings, tags, argument objects, patches and tone token names independently of the implementation. No test reads `.specs/` or derives expectations from schemas, action arrays, rendering helpers or other production code at runtime. C-UI-08 checks the production presentation files and seeded seam violations.
- smithers-06 records copy approval from the screenshots. C-UI-02 includes these fixtures when T-CAT-01 supplies the lint; that downstream audit does not block this props-only ticket.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19b's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- T-UI-01 and T-APP-19b are the landing prerequisites. Local props and fixtures allow drafting before the contracts land, not completion. No service dependency is needed: all setup and S2 Settings states are fixtures, and unavailable actions stay absent. This ticket adds its own C-UI-12 harness coverage with smithers-b8 pre-review.
- smithers-06 decides visuals and accepts screenshots. Will decides product copy and behavior changes. Tech lead smithers-8a accepts any ADR or spec-field change after smithers-b8 approves the app callback seam and smithers-38 approves the shared TypeScript API; raise §14.3 and ui-components.md gaps through T-APP-19b before implementation; UI lanes never raise piecemeal schema changes.

## Ready checklist

T-UI-02 through T-UI-14 go Ready together after T-APP-19b lands with smithers-38's §21.1 review. Local props permit drafting only. This UI lane makes no piecemeal schema change. Check: C-UI-08.

1. Dependencies: T-UI-01 supplies shared primitives; T-APP-19b supplies contracts and committed fixtures. No service dependency is needed: all setup and S2 Settings states are fixtures, and unavailable actions stay absent.
2. Exclusions: Out names the runtime effects and adjacent surfaces this presentation ticket must not implement.
3. Tests: C-UI-12 case `SetupView and SettingsView render setup and settings states` renders production exports and asserts committed literal output/callback expectations; C-UI-08 checks the seam. No spec or production-derived runtime oracle.
4. Decisions: smithers-06 accepts visuals and screenshots; Will decides product changes; smithers-8a accepts ADR/spec changes after smithers-b8 seam and smithers-38 API approval.
5. Owner pre-review before start: smithers-06: answered 18:10 with these changes (mock 21b445a6) smithers-b8: answered, BLOCKING edits applied (tech lead adopts); smithers-38: answered, BLOCKING edits applied (tech lead adopts). smithers-38: answered 19:4x, changes applied (tech lead adopts). Shared clipboard export and fallback are routed to frozen T-UI-01 as a follow-up; completion requires that follow-up. Check: C-UI-12.
6. Security: This presentation executes no repository code, shell commands or imported tool text. smithers-b8 pre-reviews data-only rendering and absence of RPC/fetch or host execution; wiring that executes repository code requires machine-only execution (M-29) and smithers-3f review.
