# T-APP-22 Legacy card decoder: removed card kinds read as titled tombstones

Stage S1 · Size S · Depends on T-UI-07 · Unblocks T-APP-01, T-APP-03, T-APP-04, T-APP-10, T-APP-11, T-APP-13, T-APP-16, T-APP-23, T-CUT-04, T-FLW-07, T-FLW-08, T-REL-02 · Issue: [#3608](https://github.com/smithersai/smithers/issues/3608)
Spec: spec.md §14.1.5, §14.2, §14.2.1 · Delta: delta.md §9, §10 · Product: mvp.md §8; AGENTS.md "Old sessions and recorded events must remain readable", "Preserve decoding of existing persisted history" · Reference: [card-kinds.md §2](../card-kinds.md)

## Goal
Every persisted card still decodes after any card kind is removed: a removed kind reads as a one-line, read-only tombstone with its title, and no kind has a live schema and a legacy model at once.

## Ownership
Engineering only. The tombstone renders through T-UI-07's entry row without a card; this ticket adds no View.

## Scope
In:
- `LEGACY_CARD_KINDS` in `packages/rpc/src/Cards.ts`: today's `retiredKinds` (`Cards.ts:2952-2962`, 8 names), today's `RETIRED_CARD_KINDS` (`apps/app/src/mainview/state/CardAvailability.ts:1`) without `retired` (13 kinds), and `explain`, which has had no producer since Explainer mode was removed.
- The preprocessor (`Cards.ts:2971-2985`) maps such a row to `{id, ordinal, createdAt, viewKey?, tabId?, kind: "retired", title, status: "acted", loading: false, payload: {was}}`. It keeps the stored title (today it blanks it) and drops `body` and the payload. The existing flow-form and Linear cases map to the same tombstone with `was` set to the row's kind.
- Delete the 14 options of those kinds from `CurrentCardSchema`. The payload schemas exported by `packages/rpc/src/TargetGraph.ts` (`GraphCardPayloadSchema` and the four like it) stay where they are; only the card options go.
- One availability rule: `cardAvailable(kind)` is `kind !== "retired"`, so no flow reopens a tombstone and no turn sends one to a model.
- The pinned fixture of card-kinds.md L6 and the rules L3 and L4 for every later ticket.

Out:
- The entry row that shows a tombstone (T-UI-07) and the Earlier archive (T-APP-16).
- Removing any live producer: T-CUT-01, T-CUT-04 and the card tickets card-kinds.md §3 names.
- Migrating archives into shared conversations, replaying saved actions, changing retained/deferred card kinds or loading repository code. The tombstone never exposes its old payload to a command or model.

## Changes
- `packages/rpc/src/Cards.ts`: export `LEGACY_CARD_KINDS`; the preprocessor above; the `retired` payload becomes `{was?: string}` (old tombstones have no `was`); delete the 14 options.
- `apps/app/src/mainview/state/CardAvailability.ts`: `cardAvailable` reads the tombstone; delete `RETIRED_CARD_KINDS`. `apps/app/src/mainview/cards/CardRenderers.tsx`: drop the retired-kind exclusion type and list; `isRetiredCard(card)` is `card.kind === "retired"`. `apps/app/src/mainview/ChatCards.tsx:156-157` renders titled tombstones through T-UI-07's title-only EntryRow; an empty title renders nothing. `state/useCardRows.ts:26` retains titled tombstones in the transcript rather than filtering every `retired` row out. Neither path renders a card body or actions.
- `apps/app/src/mainview/cards/AgentCards.tsx`: delete `ExplainCardBody` (`:216`) and the `explain` family entry (`:256`).
- `packages/rpc/test/fixtures/LegacyCards.ts` (new): one row per kind in today's `CurrentCardSchema` (67) and per `retiredKinds` name (8), copied from producer output or the app's card fixtures (`apps/app/src/mainview/cards/fixtures/`).
- `packages/rpc/test/cards/LegacyCards.test.ts` (new).
- `packages/rpc/docs/cards.md` (it already names `retired`): the decoder and rules L3 and L4; `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/rpc:docs`.

## Tests
- Unit (`LegacyCards.test.ts`): each pinned row carries literal `expectedKind`, `expectedTitle` and optional `expectedWas` recorded when it is copied. Parse it through production `CardSchema` and compare those literals; do not choose the expected result by querying `LEGACY_CARD_KINDS` or the current schema. Include old tombstones without `was`, retired flow forms and Linear rows.
- Unit, same file: compare the actual schema, legacy set and renderer inventory against the fixture's independently pinned manifest; schema and legacy kinds are disjoint, and no renderer is registered for a pinned legacy kind. Introspection is the actual value under test, never the source of expected output. No test reads spec files or derives expected results from production code at runtime.
- Unit, same file: a tombstone's payload has only `was`, so no removed card's data reaches the app.
- Unit (`apps/app/src/mainview/state/CardAvailability.test.ts`): `cardAvailable("retired")` is false; `frames.ts:77` and `tabs.ts:49` refuse to reopen a tombstone.
- Integration (`apps/app/src/mainview/state/LegacyCards.test.tsx`, new): restore pinned rows through the production AppStore persistence decoder and AppController, render the production transcript, and invoke maximize/open-tab through its command dispatcher. A titled tombstone shows only its literal title, an empty one shows nothing, no frame or tab opens, and a recorded model request contains no tombstone body or payload. C-CUT-02's Earlier archive e2e remains T-APP-23's cutover gate, not a dependency on that downstream ticket.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.


- [C-CUT-01](../checks/C-CUT-01.md): S1 part at its named layer.

- [C-CUT-02](../checks/C-CUT-02.md) steps 1 and 2.

## Risks and notes
- Dropping the payload follows spec §14.2 and card-kinds.md L1. smithers-8a decides any disputed legacy/reused-kind classification; smithers-38 signs off decoder compatibility under §21.1, and smithers-b8 accepts restored-history behavior. Preserve the stored title; historical run, TODO and GitHub facts stay in their own records.
- A reused kind's schema can tighten by accident. C-CUT-02 fails on its pinned row before the change lands.

## Ready checklist

1. Depends on T-UI-07 supplies the title-only entry renderer before the decoder lands. Persistence and CardSchema already exist; this ticket wires existing callers and does not wait for the later archive cutover.
2. Out explicitly excludes live-producer removal, archive migration, saved-action execution and changes to retained/deferred kinds; only the listed already-retired kinds and `explain` change.
3. Literal fixture expectations test CardSchema; production AppStore restore, transcript rendering and command dispatch prove titles survive and tombstones cannot reopen or reach model context. Inventory introspection supplies actual values only; no expectation comes from code or spec files at runtime.
4. smithers-8a decides kind classification; smithers-38 accepts RPC compatibility; smithers-b8 accepts restored-history behavior; smithers-06 accepts the existing EntryRow seam.
5. Before start, smithers-38: do all pinned kinds, retired forms and reused names decode without loosening unrelated schemas? smithers-b8: do restore, transcript queries and the dispatcher preserve titled rows while refusing actions/model context? smithers-06: can EntryRow show a title without a card, body, actions or maximize control? Each owner records pre-review in #3608.
6. Saved rows are inert data: no import, command replay or repository execution follows decoding. smithers-b8 reviews the restore/dispatcher boundary; any later repository execution is machine-only (§17.3, M-29), reviewed by smithers-3f. The restore integration verifies zero action dispatch from saved payloads.

