# T-CUT-04 Cut card kinds read as tombstones; leftover cut producers in shared files (follow-up of frozen T-CUT-01)

Stage S1 · Size S · Depends on T-CUT-01, T-APP-22, T-APP-23 · Unblocks T-REL-02 · Issue: [#3610](https://github.com/smithersai/smithers/issues/3610)
Spec: spec.md §6.1.2, §14.1.5, §14.2 · Delta: delta.md §10 · Product: mvp.md §8 (Cut rows), Appendix B; AGENTS.md "Old sessions and recorded events must remain readable" · Reference: [card-kinds.md](../card-kinds.md) §2, §3

## Goal
Every card kind mvp.md §8 cuts is gone from the live card union and the renderers, its old rows decode as titled tombstones, and no cut producer survives in a file that also holds kept code. This is the follow-up of T-CUT-01, which is frozen while its lane runs (product rule, 2026-10-02).

## Ownership
Engineering owns schema, producer and renderer wiring. Before start, smithers-b8 approves app seam changes, smithers-38 approves the public CardSchema compatibility contract, and smithers-06 approves visual component/CSS removals and tombstone presentation. Design owns *View.tsx and CSS; this ticket adds no View.

## Scope
In:
- The card kinds card-kinds.md §3 marks Cut: `admin-health`, `agent`, `connect`, `grant-confirm`, `notifications`, `registration` and `repository-setup`. Delete each `CurrentCardSchema` option and renderer entry that T-CUT-01 left, and add the kind to `LEGACY_CARD_KINDS` in the same change (T-APP-22, card-kinds.md L3).
- The notifications center (§8 Cut): `cards/NotificationsCard.{tsx,test.tsx}` and the card producer in `state/seams/NotificationsSeam.ts:106`, where T-CUT-01 left them. T-CUT-01 deletes the `notifications.list|read` entries; T-APP-18 adds `notifications.allow` to the same file.
- Admin producers in shared files: `admin-health` (`state/controller/auth-billing.ts:891`) and `grant-confirm` (`:768`, rendered in `cards/BillingCards.tsx`). The billing paths of both files are Deferred and stay (T-CUT-03).
- `packages/rpc/src/catalog/cuts.json` (T-CUT-01) lists each Cut row's card kinds, which C-CUT-01 and C-CUT-02 read.

Out:
- Every other cut surface (T-CUT-01).
- Deferred billing cards (balance, billing-plans, anonymous-ceiling), deferred repository/trigger/Machine cards and hidden sync-ops; browser notifications.allow (T-APP-18); deleting notification storage/backend plumbing or archived facts; changing archive privacy, model inputs or repository execution. No retained kind is added to LEGACY_CARD_KINDS.
- Kinds that card tickets replace (card-kinds.md §3): T-APP-01, T-APP-03, T-APP-10, T-APP-23 and T-CAT-01's follow-up move them. `CommitCards.tsx` goes with T-APP-10 and `BranchesCard.tsx` with T-APP-23.

## Changes
- `packages/rpc/src/Cards.ts`: the seven kinds leave `CurrentCardSchema` and join `LEGACY_CARD_KINDS`.
- `apps/app/src/mainview/cards/CardRenderers.tsx` and the family files: their entries removed.
- The producer deletions in Scope and their tests. Remove only CSS rules smithers-06 identifies as unused after these deletions; preserve shared billing styles and code. T-APP-23 must have mounted the archive/shell entry rows before removing these kinds, so tombstone titles remain visible at landing.
- `packages/rpc/src/catalog/cuts.json`: the card kinds of each Cut row.

## Tests
- Unit: `packages/rpc/src/catalog/Cuts.test.ts` (extend, C-CUT-01) pins the seven names directly: admin-health, agent, connect, grant-confirm, notifications, registration, repository-setup. Assert their absence from the current public CardSchema options and renderer map and their presence in LEGACY_CARD_KINDS. Compare cuts.json with these literals; never use that manifest or production schema/legacy sets to derive expectations.
- Unit: `packages/rpc/test/cards/LegacyCards.test.ts` (T-APP-22, C-CUT-02) calls the production exported `CardSchema.parse` on the committed old rows. For each of the seven pinned kinds, expect a literal retired result with the stored title, matching payload.was, no body or old payload, and preserved id/ordinal/createdAt. Expected kinds/results are fixture literals, not a conditional computed from LEGACY_CARD_KINDS. Read no spec file at runtime.
- Boundary regression: `apps/app/e2e/playwright/legacy-archive.spec.ts` (C-CUT-02) loads the seven pinned old rows through production browser persistence and server-journal archive loaders after T-APP-23. Ben opens Earlier and sees each stored title with no body, action, maximize or reopen; Alice sees none of Ben's archives. Recording model requests contain no old payload/body. The test uses the shipped shell/entry-row wiring, not a standalone renderer.
- Supplement: the source scan for NotificationsCard and live admin-health/grant-confirm producers returns no match under apps/app/src. Retained billing and notification-allow boundary regressions stay green when their owning tickets supply them; no later S2 feature is required to land this S1 removal.
## Acceptance
- [C-CUT-01](../checks/C-CUT-01.md): cut card kinds are absent from the live union and the renderers and present in `LEGACY_CARD_KINDS`.
- [C-CUT-02](../checks/C-CUT-02.md): pinned decoder results and production archive-loader/rendering cases for the seven removed kinds.

## Risks and notes
- T-CUT-01 carries a KEEP exception: its lane leaves a cut kind's `Cards.ts` option in place unless it adds the kind to `LEGACY_CARD_KINDS` in the same change, so no conversation fails to decode between the two tickets.
- smithers-38 signs off persisted-history compatibility and public schema changes; smithers-b8 signs off producer/loader seams; smithers-06 signs off visual removals. Will decides any change to the seven-kind Cut list or title-only rule; smithers-8a resolves spec conflicts. No fixture is rewritten to make removal pass.

## Ready checklist
1. Dependencies: T-CUT-01 removes cut doors and supplies cuts.json; T-APP-22 supplies the decoder and pinned legacy rows; T-APP-23 mounts the production archive/shell with T-APP-16's Containers and T-UI-07's title-only entry rows before removal.
2. Exclusions: deferred/hidden live kinds, browser notification permission, notification backend/storage, archived facts, replacement kinds and archive/model/execution policy changes are explicit.
3. Tests: fixed seven-kind expectations call the public CardSchema decoder and production archive loaders/shell; literal stored titles and payload.was assertions do not derive expected behavior from runtime code or spec files (C-CUT-01/02).
4. Decisions: smithers-38 approves schema compatibility; smithers-b8 approves app seams; smithers-06 approves visual removals; Will decides Cut-list/title-only policy changes and smithers-8a resolves spec conflicts.
5. Owner pre-review before start: smithers-38: Do all seven old rows decode with pinned titles and identity? Are live and legacy options disjoint without retiring reused names? smithers-b8: Can any shared producer still emit a cut kind? Do real persistence/journal loaders preserve the tombstones? Are billing and notification permission seams intact? smithers-06: Do archive entry rows show title alone? Which removed CSS/component rules are shared with retained views?
6. Security: this ticket executes no repository code and adds no execution route; M-29/M-30 machine-only execution remains unchanged. Old card payloads stay inert and reach neither actions nor model requests; smithers-b8 reviews this data boundary before start (C-CUT-02).
