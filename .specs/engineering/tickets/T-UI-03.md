# T-UI-03 Draft view

Stage S1 · Size S · Depends on T-UI-01, T-APP-19b · Unblocks T-APP-02, T-REL-02 · Issue: [#3540](https://github.com/smithersai/smithers/issues/3540)
Spec: spec.md §14.2.1, §14.3 (TODO), §14.5.1 (private Draft) · Delta: delta.md §9 · Product: mvp.md J2.1, J7 · Props: [ui-components.md § T-UI-03](../ui-components.md)

## Goal

`DraftView` exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-02 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- Use the reconciled Draft fields and command input for title, prompt, acceptance, place, issue fixes and read-only seed. Discard requires a product Appendix B ruling; do not invent its catalog tag. Check: C-UI-12.
- Until Commit, render a small "Only you" lock chip in the Draft header, using the Confirm card treatment. Check: C-UI-12.
- `DraftView`, the §14.3 Draft model: title, prompt, acceptance, the linked issue with its fixes toggle, the place picker (Append, Before Tn, Amend Tn), a read-only seed, Commit and Discard; a private marker until Commit, then the committed receipt.
- Props exactly as `ui-components.md` § T-UI-03 with the zod type reconciled by T-APP-19b from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- No piecemeal rpc or catalog edits. Product rules on Discard before T-APP-19b lands; T-APP-02 owns string decoding and TODO admission. Check: C-UI-08.
- Topic subscriptions, Containers, command dispatch, permission decisions and product copy changes. Will decides copy changes; smithers-06 reviews their presentation (§14.6b).
- TODO admission or amendment, placement calculation, seed patch application or execution, idempotency storage, audience filtering and publishing private drafts. T-APP-02 owns those runtime effects. The seed stays read-only.

## Changes

- gestures.set sends {field, value} on blur. value is the unchanged string for title/prompt, JSON.stringify(string[]) for acceptance, JSON.stringify({mode, n?}) for place, and the literal string "true" or "false" for fixes. Forward the supplied action args unchanged, merged with these string fields. T-APP-19b reconciles Commit inputs; T-APP-02 owns decoding, persistence and admission. Check: C-UI-12.

- Until Commit, render a small "Only you" lock chip in the Draft header, using the Confirm card treatment. Check: C-UI-12.

- Draft place picker and Closes #i. Check: C-UI-12.


- Add `apps/app/src/mainview/cards/views/DraftView.tsx` (new) and CSS. Consume `@smthrs/rpc/DraftCard` and its committed fixtures through module subpaths. Every handler calls `onAction` with `data-flow`, `onView`, or local presentation state.
- Fixtures from `@smthrs/rpc/fixtures/Draft` (`packages/rpc/test/fixtures/`, reconciled with T-APP-19b).

## Tests

- Assert literal blur payloads: acceptance value '["passes checks","keeps edits"]', place value '{"mode":"before","n":12}', append value '{"mode":"append"}', and fixes value "true"/"false". Commit forwards the full supplied Draft input once, including issue fixes and seed; Discard forwards only its product-approved supplied action. No seed executes. Check: C-UI-12.

- Assert the header lock chip before Commit and its absence on the committed receipt. Retain read-only seed previews (J5 s2) and "+1" amendment receipts (J7 s3–4). Check: C-UI-12.

- C-UI-12, named case `DraftView submits fields and renders private and committed drafts`: render the production exports in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (new harnesses), in light and dark at 1280 and 390 px; each supplied action carries `data-flow`, disabled controls show their supplied reason and do not dispatch, and each enabled press calls only its agreed callback once. Cover append, before and amend, issue fixes on/off, a read-only seed, private and committed receipts. Blur each editable field and press Commit and Discard; compare tags, merged arguments and field values with committed literal objects. Remove Commit and assert no Commit control.
- Commit reviewed literal expected strings, tags, argument objects, patches and tone token names independently of the implementation. No test reads `.specs/` or derives expectations from schemas, action arrays, rendering helpers or other production code at runtime. C-UI-08 checks the production presentation files and seeded seam violations.
- smithers-06 records copy approval from the screenshots. C-UI-02 includes these fixtures when T-CAT-01 supplies the lint; that downstream audit does not block this props-only ticket.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19b's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- T-UI-01 and T-APP-19b are the landing prerequisites. Local props and fixtures allow drafting before the contracts land, not completion. T-APP-02 supplies persistence and audience enforcement later; private styling is not a security boundary. This ticket adds its own C-UI-12 harness coverage with smithers-b8 pre-review.
- smithers-06 decides visuals and accepts screenshots. Will decides product copy and behavior changes. Tech lead smithers-8a accepts any ADR or spec-field change after smithers-b8 approves the app callback seam and smithers-38 approves the shared TypeScript API; raise §14.3 and ui-components.md gaps through T-APP-19b before implementation; UI lanes never raise piecemeal schema changes.

## Ready checklist

T-UI-02 through T-UI-14 go Ready together after T-APP-19b lands with smithers-38's §21.1 review. Local props permit drafting only. This UI lane makes no piecemeal schema change. Check: C-UI-08.

1. Dependencies: T-UI-01 supplies shared primitives; T-APP-19b supplies contracts and committed fixtures. T-APP-02 supplies persistence and audience enforcement later; private styling is not a security boundary.
2. Exclusions: Out names the runtime effects and adjacent surfaces this presentation ticket must not implement.
3. Tests: C-UI-12 case `DraftView submits fields and renders private and committed drafts` renders production exports and asserts committed literal output/callback expectations; C-UI-08 checks the seam. No spec or production-derived runtime oracle.
4. Decisions: smithers-06 accepts visuals and screenshots; Will decides product changes; smithers-8a accepts ADR/spec changes after smithers-b8 seam and smithers-38 API approval.
5. Owner pre-review before start: smithers-06: answered 18:10 with these changes (mock 21b445a6) smithers-b8: answered, BLOCKING edits applied (tech lead adopts); smithers-38: answered, BLOCKING edits applied (tech lead adopts).
6. Security: This presentation executes no repository code, shell commands or imported tool text. smithers-b8 pre-reviews data-only rendering and absence of RPC/fetch or host execution; wiring that executes repository code requires machine-only execution (M-29) and smithers-3f review.
