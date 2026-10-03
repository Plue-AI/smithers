# T-APP-22 Legacy card decoder: removed card kinds read as titled tombstones

Stage S1 · Size S · Depends on T-UI-07 · Unblocks T-APP-01, T-APP-03, T-APP-04, T-APP-10, T-APP-11, T-APP-13, T-APP-16, T-CUT-04, T-FLW-07, T-FLW-08, T-REL-02 · Issue: [#3608](https://github.com/smithersai/smithers/issues/3608)
Spec: spec.md §14.1.5, §14.2 · Delta: delta.md §9, §10 · Product: mvp.md §8; AGENTS.md "Old sessions and recorded events must remain readable", "Preserve decoding of existing persisted history" · Reference: [card-kinds.md §2](../card-kinds.md)

## Goal
Every persisted card still decodes after any card kind is removed: a removed kind reads as a one-line, read-only tombstone with its stored title. One retired set, one card model per kind (minimal-code synthesis v1 §2).

## Scope
In:
- One set: fold `RETIRED_CARD_KINDS` (`apps/app/src/mainview/state/CardAvailability.ts:1`, 20 names including `retired`) into `retiredKinds` (`packages/rpc/src/Cards.ts:3040`, 14 names), exported as `LEGACY_CARD_KINDS`, plus `explain`, which has had no producer since Explainer mode was removed.
- The preprocessor (`Cards.ts:3072`) keeps the stored title (today it blanks it), drops `body` and the payload, and sets `payload: {was}` to the row's kind. Flow-form, Linear and cloud `agents` rows take the same path.
- Delete the `CurrentCardSchema` options for legacy kinds, including `agent` (`Cards.ts:2632`), which `retiredKinds` already makes unreachable.
- Kinds the rpc card schemas duplicate (smithers-38L): after T-APP-19, only `HomeCard` and the stored kind `factory.home` (`Cards.ts:742`) remain as two models of one card. `factory.home` joins `LEGACY_CARD_KINDS` in T-APP-01's change that deletes its producers; `branches` (`:2063`) joins in T-APP-16's change that deletes `BranchesCard.tsx`. `file`, `diff`, `secrets` and `run-trace` keep their live producers in S1 and stay current kinds; T-APP-19 deletes or converts their duplicate rpc schemas. A kind becomes legacy only in the change that deletes its last producer (card-kinds.md L3).
- One availability rule: `cardAvailable(kind)` is `kind !== "retired"`, so no flow reopens a tombstone and no turn sends one to a model.

Out:
- The entry row that shows a tombstone (T-UI-07) and Earlier (T-APP-16).
- Removing live producers (T-CUT-01, T-CUT-04 and the card tickets card-kinds.md §3 names); migrating archives; replaying saved actions.

## Changes
- `packages/rpc/src/Cards.ts`: export `LEGACY_CARD_KINDS`; the preprocessor above; the `retired` payload becomes `{was?: string}` (old tombstones have no `was`); delete the legacy options.
- `apps/app/src/mainview/state/CardAvailability.ts`: delete `RETIRED_CARD_KINDS`; `cardAvailable` reads the tombstone. `cards/CardRenderers.tsx`: `isRetiredCard(card)` is `card.kind === "retired"`. `ChatCards.tsx:156-157` renders a titled tombstone through T-UI-07's title-only `EntryRow`; an empty title renders nothing. `state/useCardRows.ts:26` keeps titled tombstones.
- `apps/app/src/mainview/cards/AgentCards.tsx`: delete `ExplainCardBody` (`:216`) and the `explain` family entry (`:256`).
- `packages/rpc/docs/cards.md`: the decoder and rules L3 and L4; `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/rpc:docs`.

## Tests
Folded from C-CUT-02.
- Unit (`packages/rpc/test/cards/LegacyCards.test.ts`, new): one stored row per kind `CurrentCardSchema` held when this lands and per name in both old retired sets, copied from producer output or `apps/app/src/mainview/cards/fixtures/`, each with literal `expectedKind`, `expectedTitle` and `expectedWas`. Every row parses through `CardSchema` without throwing and matches its literals; a tombstone has no `body` and its payload has only `was`. Include old tombstones without `was`, retired flow forms and Linear rows. Expected values never come from querying `LEGACY_CARD_KINDS` or the schema.
- Unit, same file: the rows cover every `CurrentCardSchema` option and every `LEGACY_CARD_KINDS` name; the two sets are disjoint; `CARD_RENDERERS` registers no legacy kind.
- Unit (`state/CardAvailability.test.ts`): `cardAvailable("retired")` is false; `frames.ts:77` and `tabs.ts:49` refuse to reopen a tombstone.
- Integration (`apps/app/src/mainview/state/LegacyCards.test.tsx`, new): restore the rows through the production AppStore decoder and render the transcript. A titled tombstone shows only its title, an empty one shows nothing, maximize and open-tab open nothing, and a recorded model request contains no tombstone payload.
- e2e, after T-APP-16's cutover: Ben opens Earlier and opens a browser-store conversation and a journal conversation (`/api/agent/conversations`) holding one card entry per row. Both open read-only with no composer or actions; prompts and answers show their text; each tombstone shows its title alone; the console has no decode error. Tab reaches every row and ⌘K maximize opens no tombstone. Alice sees none of Ben's archives. Ben's prompt "what did my old conversations say?" sends no archive text to the model.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

## Risks and notes
- A reused kind's schema can tighten by accident; the pinned row fails first.
- Saved rows are inert data: no import, command replay or repository execution follows decoding.
