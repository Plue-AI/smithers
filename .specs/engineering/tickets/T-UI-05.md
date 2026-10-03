# T-UI-05 Confirm view

Stage S1 · Size S · Depends on T-UI-01, T-APP-19b · Unblocks T-APP-04, T-MNT-03, T-REL-02 · Issue: [#3542](https://github.com/smithersai/smithers/issues/3542)
Spec: spec.md §14.2.1, §5.4, §14.3 (Confirm) · Delta: delta.md §9 · Product: mvp.md §6.2, B.6 · Props: [ui-components.md § T-UI-05](../ui-components.md)

## Goal

`ConfirmView` exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-04 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- Accept only todo, branch, flow, agent and wiki subjects; secret, member and settings subjects are forbidden. Receipts are done, cancelled or expired; stale describes an approval revision, not a receipt enum. T-APP-19b removes forbidden schema subjects and fixtures. Check: C-UI-08, C-UI-12.
- `ConfirmView` in `one_click` (verb, the exact text sent, Cancel, receipt) and `review_merge` (title, place, PR link, the subject revision's evidence with each check, a stale approval "You approved <rev>", the `merge` control, on GitHub ↗, Cancel).
- Props exactly as `ui-components.md` § T-UI-05 with the zod type reconciled by T-APP-19b from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- No confirmation path for Members, Secrets or Settings. No relaunch of the initiating command, audience filtering, approval persistence or expiry timers in the View. Product rules on Cancel; T-APP-04 owns private delivery and authorization. Check: C-UI-08, C-UI-13.
- Topic subscriptions, Containers, command dispatch, permission decisions and product copy changes. Will decides copy changes; smithers-06 reviews their presentation (§14.6b).
- Confirmation creation, audience filtering, session/role authorization, expiry timers, approval persistence, subject revision checks and merge execution. T-APP-04 owns those effects. Do not add agent confirmation paths for Members, Secrets or Settings.

## Changes

- The verb, Merge / Review & merge and Cancel controls dispatch their supplied actions[] entries, with T-APP-04's approve/deny bindings and subject/revision in args. model.action supplies only the verb label. Never dispatch model.action.tag to confirm; that relaunches the command. Cancel needs a product Appendix B ruling. Check: C-UI-12.

- Both Confirm kinds and receipts render supplied props. T-APP-04 proves that other viewers receive no private card, placeholder or subject at the production confirmation/topic boundary (C-ACC-02). Check for this View: C-UI-12.


- Add `apps/app/src/mainview/cards/views/ConfirmView.tsx` (new) and CSS. Consume `@smthrs/rpc/ConfirmCard` and committed fixtures through module subpaths. Every handler calls `onAction` with `data-flow`, `onView`, or local presentation state.
- Fixtures from `@smthrs/rpc/fixtures/Confirm` (`packages/rpc/test/fixtures/`, reconciled with T-APP-19b).

## Tests

- Press actions[] approval, merge and Cancel controls. Assert literal bound subject/revision arguments and one approve/deny callback; give model.action a different initiating tag and assert it never dispatches. Cover expired receipts and stale approvals separately. C-UI-08 rejects secret/member/settings subjects. C-UI-12 proves the controls; C-UI-13 proves T-APP-04 bindings.

- C-UI-12, named case `ConfirmView renders exact subjects, stale approvals and receipts`: render the production exports in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (new harnesses), in light and dark at 1280 and 390 px; each supplied action carries `data-flow`, disabled controls show their supplied reason and do not dispatch, and each enabled press calls only its agreed callback once. Cover one_click and review_merge, exact sent text, stale approved revision, every merge state and done/cancelled/expired receipts. Press the supplied verb, Cancel and merge controls and compare literal tags and subject/revision arguments. An absent approval action has no approval control. Other-viewer privacy is a production confirmation/topic test in T-APP-04 (C-ACC-02), not a fixture-only claim.
- Commit reviewed literal expected strings, tags, argument objects, patches and tone token names independently of the implementation. No test reads `.specs/` or derives expectations from schemas, action arrays, rendering helpers or other production code at runtime. C-UI-08 checks the production presentation files and seeded seam violations.
- smithers-06 records copy approval from the screenshots. C-UI-02 includes these fixtures when T-CAT-01 supplies the lint; that downstream audit does not block this props-only ticket.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19b's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- T-UI-01 and T-APP-19b are the landing prerequisites. Local props and fixtures allow drafting before the contracts land, not completion. No confirmation service is required to land the View; T-APP-04 must enforce private delivery and authorization at its production boundary. This ticket adds its own C-UI-12 harness coverage with smithers-b8 pre-review.
- smithers-06 decides visuals and accepts screenshots. Will decides product copy and behavior changes. Tech lead smithers-8a accepts any ADR or spec-field change after smithers-b8 approves the app callback seam and smithers-38 approves the shared TypeScript API; raise §14.3 and ui-components.md gaps through T-APP-19b before implementation; UI lanes never raise piecemeal schema changes.

## Ready checklist

T-UI-02 through T-UI-14 go Ready together after T-APP-19b lands with smithers-38's §21.1 review. Local props permit drafting only. This UI lane makes no piecemeal schema change. Check: C-UI-08.

1. Dependencies: T-UI-01 supplies shared primitives; T-APP-19b supplies contracts and committed fixtures. No confirmation service is required to land the View; T-APP-04 must enforce private delivery and authorization at its production boundary.
2. Exclusions: Out names the runtime effects and adjacent surfaces this presentation ticket must not implement.
3. Tests: C-UI-12 case `ConfirmView renders exact subjects, stale approvals and receipts` renders production exports and asserts committed literal output/callback expectations; C-UI-08 checks the seam. No spec or production-derived runtime oracle.
4. Decisions: smithers-06 accepts visuals and screenshots; Will decides product changes; smithers-8a accepts ADR/spec changes after smithers-b8 seam and smithers-38 API approval.
5. Owner pre-review before start: smithers-06: answered 18:10, ok (mock 21b445a6) smithers-b8: answered, BLOCKING edits applied (tech lead adopts); smithers-38: answered, BLOCKING edits applied (tech lead adopts).
6. Security: This presentation executes no repository code, shell commands or imported tool text. smithers-b8 pre-reviews data-only rendering and absence of RPC/fetch or host execution; wiring that executes repository code requires machine-only execution (M-29) and smithers-3f review.
