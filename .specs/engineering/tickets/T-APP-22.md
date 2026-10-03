# T-APP-22 Legacy card decoder: removed card kinds read as titled tombstones

Stage S1 · Size S · Depends on — · Unblocks T-APP-01, T-APP-03, T-APP-10, T-APP-11, T-APP-13, T-APP-16, T-APP-23, T-CUT-04, T-FLW-07, T-FLW-08, T-REL-02 · Issue: [#3608](https://github.com/smithersai/smithers/issues/3608)
Spec: spec.md §14.1.5, §14.2, §14.2.1 · Delta: delta.md §9, §10 · Product: mvp.md §8; AGENTS.md "Old sessions and recorded events must remain readable", "Preserve decoding of existing persisted history" · Reference: [card-kinds.md §2](../card-kinds.md)

## Goal
Every persisted card still decodes after any card kind is removed: a removed kind reads as a one-line, read-only tombstone with its title, and no kind has a live schema and a legacy model at once.

## Ownership
Engineering only. The tombstone renders through T-UI-07's entry row without a card; this ticket adds no View.

## Scope
In:
- `LEGACY_CARD_KINDS` in `packages/rpc/src/Cards.ts`: today's `retiredKinds` (`Cards.ts:2952-2962`, 8 names), today's `RETIRED_CARD_KINDS` (`apps/app/src/mainview/state/CardAvailability.ts:1`) without `retired` (13 kinds), and `explain`, which has had no producer since Explainer mode was removed.
- The preprocessor (`Cards.ts:2971-2985`) maps such a row to `{id, ordinal, createdAt, viewKey?, tabId?, kind: "retired", title, status: "acted", loading: false, payload: {was}}`. It keeps the stored title (today it blanks it) and drops `body` and the payload. The existing flow-form and Linear cases map to the same tombstone with `was` set to the row's kind.
- Delete the 14 options of those kinds from `CurrentCardSchema`. The payload schemas `packages/rpc/src/TargetGraph.ts` imports (`GraphCardPayloadSchema` and the four like it) stay where they are; only the card options go.
- One availability rule: `cardAvailable(kind)` is `kind !== "retired"`, so no flow reopens a tombstone and no turn sends one to a model.
- The pinned fixture of card-kinds.md L6 and the rules L3 and L4 for every later ticket.

Out:
- The entry row that shows a tombstone (T-UI-07) and the Earlier archive (T-APP-16).
- Removing any live producer: T-CUT-01, T-CUT-04 and the card tickets card-kinds.md §3 names.

## Changes
- `packages/rpc/src/Cards.ts`: export `LEGACY_CARD_KINDS`; the preprocessor above; the `retired` payload becomes `{was?: string}` (old tombstones have no `was`); delete the 14 options.
- `apps/app/src/mainview/state/CardAvailability.ts`: `cardAvailable` reads the tombstone; delete `RETIRED_CARD_KINDS`. `apps/app/src/mainview/cards/CardRenderers.tsx`: drop the retired-kind exclusion type and list; `isRetiredCard(card)` is `card.kind === "retired"`. `apps/app/src/mainview/ChatCards.tsx:156-157` and `state/useCardRows.ts:26` keep their callers on that one check.
- `apps/app/src/mainview/cards/AgentCards.tsx`: delete `ExplainCardBody` (`:216`) and the `explain` family entry (`:256`).
- `packages/rpc/test/fixtures/LegacyCards.ts` (new): one row per kind in today's `CurrentCardSchema` (67) and per `retiredKinds` name (8), copied from producer output or the app's card fixtures (`apps/app/src/mainview/cards/fixtures/`).
- `packages/rpc/test/cards/LegacyCards.test.ts` (new).
- `packages/rpc/docs/cards.md` (it already names `retired`): the decoder and rules L3 and L4; `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/rpc:docs`.

## Tests
- Unit (`LegacyCards.test.ts`): every fixture row parses with `CardSchema`; a row whose kind is in `LEGACY_CARD_KINDS` yields `kind: "retired"`, `payload.was` equal to its kind, its stored title and no `body`; every other row yields its own kind.
- Unit, same file: the fixture has a row for every option of `CurrentCardSchema` and every name in `LEGACY_CARD_KINDS`; the two sets are disjoint; `CARD_RENDERERS` has no legacy kind.
- Unit, same file: a tombstone's payload has only `was`, so no removed card's data reaches the app.
- Unit (`apps/app/src/mainview/state/CardAvailability.test.ts`): `cardAvailable("retired")` is false; `frames.ts:77` and `tabs.ts:49` refuse to reopen a tombstone.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.


- [C-CUT-01](../checks/C-CUT-01.md): S1 part at its named layer.

- [C-CUT-02](../checks/C-CUT-02.md) steps 1 and 2.

## Risks and notes
- Dropping the payload loses the data a removed card showed. Accepted: cards are projections (spec §14.2), and the facts behind them stay in their own records (runs, TODOs, GitHub). The title says what was there.
- A reused kind's schema can tighten by accident. C-CUT-02 fails on its pinned row before the change lands.
