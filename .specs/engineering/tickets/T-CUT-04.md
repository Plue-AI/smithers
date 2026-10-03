# T-CUT-04 Cut card kinds read as tombstones; leftover cut producers in shared files (follow-up of frozen T-CUT-01)

Stage S1 · Size S · Depends on T-CUT-01, T-APP-22 · Unblocks T-REL-02 · Issue: [#3610](https://github.com/smithersai/smithers/issues/3610)
Spec: spec.md §6.1.2, §14.1.5, §14.2 · Delta: delta.md §10 · Product: mvp.md §8 (Cut rows), Appendix B; AGENTS.md "Old sessions and recorded events must remain readable" · Reference: [card-kinds.md](../card-kinds.md) §2, §3

## Goal
Every card kind mvp.md §8 cuts is gone from the live card union and the renderers, its old rows decode as titled tombstones, and no cut producer survives in a file that also holds kept code. This is the follow-up of T-CUT-01, which is frozen while its lane runs (product rule, 2026-10-02).

## Ownership
Engineering only.

## Scope
In:
- The card kinds card-kinds.md §3 marks Cut: `admin-health`, `agent`, `connect`, `grant-confirm`, `notifications`, `registration` and `repository-setup`. Delete each `CurrentCardSchema` option and renderer entry that T-CUT-01 left, and add the kind to `LEGACY_CARD_KINDS` in the same change (T-APP-22, card-kinds.md L3).
- The notifications center (§8 Cut): `cards/NotificationsCard.{tsx,test.tsx}` and the card producer in `state/seams/NotificationsSeam.ts:106`, where T-CUT-01 left them. T-CUT-01 deletes the `notifications.list|read` entries; T-APP-18 adds `notifications.allow` to the same file.
- Admin producers in shared files: `admin-health` (`state/controller/auth-billing.ts:891`) and `grant-confirm` (`:768`, rendered in `cards/BillingCards.tsx`). The billing paths of both files are Deferred and stay (T-CUT-03).
- `packages/rpc/src/catalog/cuts.json` (T-CUT-01) lists each Cut row's card kinds, which C-CUT-01 and C-CUT-02 read.

Out:
- Every other cut surface (T-CUT-01).
- Kinds that card tickets replace (card-kinds.md §3): T-APP-01, T-APP-03, T-APP-10, T-APP-23 and T-CAT-01's follow-up move them. `CommitCards.tsx` goes with T-APP-10 and `BranchesCard.tsx` with T-APP-23.

## Changes
- `packages/rpc/src/Cards.ts`: the seven kinds leave `CurrentCardSchema` and join `LEGACY_CARD_KINDS`.
- `apps/app/src/mainview/cards/CardRenderers.tsx` and the family files: their entries removed.
- The producer deletions in Scope, with their tests and CSS.
- `packages/rpc/src/catalog/cuts.json`: the card kinds of each Cut row.

## Tests
- Unit (`packages/rpc/src/catalog/Cuts.test.ts`, extend): each Cut row's card kinds are absent from `CurrentCardSchema` and the renderer map, and present in `LEGACY_CARD_KINDS`.
- Unit (`packages/rpc/test/cards/LegacyCards.test.ts`, T-APP-22): every pinned row of the seven kinds decodes as a tombstone with its title.
- Unit: `rg -l "NotificationsCard|kind: \"admin-health\"|kind: \"grant-confirm\"" apps/app/src` returns nothing.

## Acceptance
- [C-CUT-01](../checks/C-CUT-01.md): cut card kinds are absent from the live union and the renderers and present in `LEGACY_CARD_KINDS`.
- [C-CUT-02](../checks/C-CUT-02.md) steps 1 and 2.

## Risks and notes
- T-CUT-01 carries a KEEP exception: its lane leaves a cut kind's `Cards.ts` option in place unless it adds the kind to `LEGACY_CARD_KINDS` in the same change, so no conversation fails to decode between the two tickets.
