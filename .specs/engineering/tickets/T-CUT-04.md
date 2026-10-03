# T-CUT-04 Cut card kinds read as tombstones; leftover cut producers in shared files (follow-up of frozen T-CUT-01)

Stage S1 · Size S · Depends on T-CUT-01, T-APP-22 · Unblocks T-REL-02 · Issue: [#3610](https://github.com/smithersai/smithers/issues/3610)
Spec: spec.md §6.1.2, §14.1.5, §14.2 · Delta: delta.md §10 · Product: mvp.md §8 (Cut rows), Appendix B; AGENTS.md "Old sessions and recorded events must remain readable" · Reference: [card-kinds.md](../card-kinds.md) §2, §3
Ready: 2026-10-03 smithers-8a sha256:9d3c3d0f18e2

## Goal
Every card kind mvp.md §8 cuts is gone from the live card union and the renderers, its old rows decode as titled tombstones, and no cut producer survives in a file that also holds kept code. This is the follow-up of T-CUT-01, which is frozen while its lane runs (product rule, 2026-10-02).

## Ownership
Engineering owns schema, producer and renderer wiring. Owner pre-review names smithers-b8 for app seams, smithers-38 for the public CardSchema compatibility contract, and smithers-06 for visual component/CSS removals and tombstone presentation. Recorded owner answers stand; owners review post hoc under the 2026-10-03 parallel-build directive. Design owns *View.tsx and CSS; this ticket adds no View.

## Scope
In:
- The card kinds card-kinds.md §3 marks Cut: `admin-health`, `agent`, `connect`, `grant-confirm`, `notifications`, `registration` and `repository-setup`. Delete each `CurrentCardSchema` option and renderer entry that T-CUT-01 left, and add the kind to `LEGACY_CARD_KINDS` in the same change (T-APP-22, card-kinds.md L3).
- Verify the notifications and admin card producer removals in shared files. `cards/NotificationsCard.{tsx,test.tsx}`, `state/seams/NotificationsSeam.ts` and `cards/BillingCards.tsx` are already absent; `state/controller/auth-billing.ts` no longer emits `admin-health` or `grant-confirm`. Remove only remaining cut-card producers or renderer entries; do not restore deleted files. Deferred billing code stays (T-CUT-03), and browser notification permission stays with T-APP-18.
- Consume T-CUT-01's `packages/rpc/src/catalog/cuts.json` contract to record the seven Cut kinds. The manifest is not present today; do not build a second catalog.
- Lands dark until T-CUT-01: cut commands remain unregistered and cut card bodies remain unavailable; do not restore a producer while its manifest contract is unavailable.
- Lands dark until T-APP-22: use the existing retirement and availability guards to refuse cut-card rendering, reopen and model inclusion. Preserve persisted rows and their existing decode path; remove schema options only in the atomic change that supplies the title-preserving legacy decoder. Build against the specified decoder contract; do not add a fallback decoder.
- Lands dark until T-APP-16 and its T-UI-07 shell: keep stored rows intact and cut-card bodies/actions unavailable; expose archived titles only through the title-only entry rows when that wiring is available. Missing archive wiring does not enable a legacy renderer. C-CUT-01/02 cover unavailable and integrated states.

Out:
- Every other cut surface (T-CUT-01).
- Deferred billing cards (balance, billing-plans, anonymous-ceiling), deferred repository/trigger/Machine cards and hidden sync-ops; browser notifications.allow (T-APP-18); deleting notification storage/backend plumbing or archived facts; changing archive privacy, model inputs or repository execution. No retained kind is added to LEGACY_CARD_KINDS.
- Kinds that card tickets replace (card-kinds.md §3): T-APP-01, T-APP-03, T-APP-10, T-APP-16 and T-CAT-01's follow-up move them. `CommitCards.tsx` goes with T-APP-10 and `BranchesCard.tsx` with T-APP-16.

## Changes
- `packages/rpc/src/Cards.ts`: the seven kinds leave `CurrentCardSchema` and join `LEGACY_CARD_KINDS`.
- `apps/app/src/mainview/cards/CardRenderers.tsx` and the family files: their entries removed.
- Reuse the landed producer removals and existing retirement guards; reshape the schema and renderer wiring, with no new card, View, Container or decoder. Remove only CSS rules smithers-06 identifies as unused; preserve shared billing styles and code. T-APP-16 supplies archive/shell wiring, not a code dependency for these deletions.
- `packages/rpc/src/catalog/cuts.json`: the card kinds of each Cut row.

## Tests
- Unit: extend `packages/rpc/test/Cards.test.ts`'s removed-presentation compatibility cases (C-CUT-01/02). Pin admin-health, agent, connect, grant-confirm, notifications, registration and repository-setup directly. Parse stored rows through the exported `CardSchema.parse`; expect literal retired results with stored title, payload.was, id/ordinal/createdAt and no body or old payload. Assert the seven names are absent from `CardSchema.options` and present in `LEGACY_CARD_KINDS`; compare cuts.json with these literals. Preserve historical input rows. Expectations come from committed literals, never the manifest, schema, legacy set or a spec file at runtime.
- Unit: extend `apps/app/src/mainview/cards/CardRenderers.test.tsx` to assert the seven literal names are absent from `CARD_RENDERERS`. The existing schema-derived completeness test is supplemental, not this ticket's acceptance oracle.
- Boundary regression: extend `apps/app/src/mainview/state/RetiredCardUpdates.test.ts` through production `createAppStore`, persisted checkpoint/event restore, reload and the real controller. Cover all seven pinned old kinds, including old upsert/update recovery, unchanged identity and inert payloads. Invoke reopen/maximize through the production command dispatcher and record a model request; neither actions nor old payload/body may escape. Extend `cards/CardRenderers.test.tsx` through production `CardView` for unavailable shell wiring: no cut body or action renders. Reuse these suites rather than adding a parallel fixture or decoder suite (delta.md §11).
- Archive integration after T-APP-16: extend `state/ConversationHistory.test.ts` and `apps/app/e2e/playwright/chat.spec.ts` through the shipped Earlier entry, browser persistence and authenticated `GET /api/agent/conversations` and `/api/agent/conversations/replay`. Ben sees each stored title with no body, action, maximize or reopen; Alice sees none of Ben's archives. Record model requests and assert no old payload/body. Use real persistence and server journals; fake only the model endpoint. This integration is a landing condition in Scope, not a dependency edge or a standalone renderer test.
- Supplement: scan production card producers and renderer registrations for the seven names; ignore actor/graph discriminants, comments and historical test rows. A raw search for `kind: "agent"` is not a card-producer oracle. Retained billing regressions stay green; notification-allow regressions run when T-APP-18 supplies them. No S2 feature is required for this S1 removal.

## Acceptance
- [C-CUT-01](../checks/C-CUT-01.md): cut card kinds are absent from the live union and the renderers and present in `LEGACY_CARD_KINDS`.
- [C-CUT-02](../checks/C-CUT-02.md): pinned decoder results and production archive-loader/rendering cases for the seven removed kinds.

## Risks and notes
- T-CUT-01 carries a KEEP exception: its lane leaves a cut kind's `Cards.ts` option in place unless it adds the kind to `LEGACY_CARD_KINDS` in the same change, so no conversation fails to decode between the two tickets.
- smithers-38 signs off persisted-history compatibility and public schema changes; smithers-b8 signs off producer/loader seams; smithers-06 signs off visual removals. Will decides any change to the seven-kind Cut list or title-only rule; smithers-8a resolves spec conflicts. No fixture is rewritten to make removal pass.

## Ready checklist
1. Dependencies: T-CUT-01 supplies the consumed cuts.json contract; T-APP-22 supplies the legacy schema/decoder. Scope names fail-closed landing conditions for both and for T-APP-16/T-UI-07 archive wiring; unavailable contracts do not block Ready. No new table needs an ownership.csv reservation.
2. Exclusions: deferred/hidden live kinds, browser notification permission, notification backend/storage, archived facts, replacement kinds and archive/model/execution policy changes are explicit; no new card, View, Container, decoder or catalog.
3. Tests: literal seven-kind expectations call public CardSchema.parse, production AppStore restore/controller dispatch and CardView; integrated Earlier cases use authenticated history/replay routes. Schema-derived completeness is supplemental; no acceptance expectation comes from runtime code or spec files (C-CUT-01/02).
4. Decisions: smithers-38 approves public schema/history compatibility; smithers-b8 approves app seams; smithers-06 identifies unused CSS and approves title-only presentation. Will decides Cut-list/title-only policy changes; smithers-8a resolves spec conflicts.
5. Owner pre-review: recorded answers stand and owners review post hoc. smithers-38: Do all seven rows retain title and identity? Are schema removal and legacy registration atomic? smithers-b8: Can any production card producer emit a cut kind? Do persistence recovery and controller commands keep old payloads inert? Are billing and notification permission seams preserved? smithers-06: Does unavailable shell wiring hide cut bodies/actions? Does the integrated archive show title alone? Which removed CSS rules are shared with retained views?
6. Security: saved rows are inert data; decoding does not import repository code or replay saved commands. No root step is added or changed, so there are no root inputs to enumerate. M-29 machine-only repository execution remains unchanged; smithers-b8 reviews payload/action/model isolation through the production-boundary regressions (C-CUT-02).
