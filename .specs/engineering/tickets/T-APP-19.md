# T-APP-19 Card view-model schemas and fixtures from `ui-components.md`: the seam between design's views and engineering's containers

Stage S1 · Size S · Depends on — · Unblocks T-STK-08, T-GH-08, T-FLW-08, T-FLW-06, T-FLW-07, T-MCH-08, T-COL-05, T-APP-01, T-APP-02, T-APP-03, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-APP-09, T-APP-18, T-APP-15, T-APP-16, T-APP-17, T-APP-10, T-APP-11, T-APP-12, T-APP-13, T-APP-14, T-CAT-01 · Issue: to file
Spec: spec.md §14.2.1, §14.3 · Delta: delta.md §9 · Product: mvp.md §6 (cards), design `.specs/design/`

## Goal

Design builds every card view against a typed contract on day one, and engineering wires containers to the same contract, so neither side waits on the other or edits the other's files.

## Ownership (Will, 2026-10-02)

Engineering writes the schemas and fixtures. Design reviews field names against its mocks before merge. A field a view needs and §14.3 lacks is a spec change raised with the tech lead, then added here.

## Scope

In:
- One zod schema and inferred type per card in `packages/rpc/src/<Card>Card.ts`, following `SubagentCard.ts`: Home, Todo, Draft, Setup, Settings, Confirm (`one_click`, `review_merge`), Flow, Members, Branch, File, Diff, Terminal, Secrets, Agent, Proposal, Monitor, Commands, plus the shell parts: timeline entry, toast, actor chip, Context line, branch tree node.
- Field names and enums copied from spec §14.3 in snake_case. Callbacks are typed as `(input) => void` per catalog command the card fires (§6.1), never as RPC clients.
- Fixtures per card in `apps/app/src/mainview/cards/fixtures/<Card>.ts`: each state §14.3 lists (for Todo: every one of the eight states; for Confirm: both kinds, waiting, receipt).
- A schema test per card: each fixture parses, and an unknown state fails to parse.
- `Action` with `tag: CatalogTag` (the tag union exported by T-CAT-01's catalog source; until that lands, a placeholder union of Appendix A tags that T-CAT-01 replaces in the same change).
- The Container helper `cardActions(…)`: builds `actions[]` from catalog tags and binds `onAction` to `flowAction`, so every View button is a catalog flow with three doors.
- `flows/parity.test.ts` (with T-CUT-01's parity edit): leave `cards/views/` out of the pinned handler table; add the View-seam rule (every handler is `onAction(<action>.tag)` with `data-flow`) and the Container rule (every `*Container.tsx` builds `actions[]` through `cardActions`).

Out:
- Views and CSS (design). Containers and topic mapping (each card's own ticket).

## Changes

- `packages/rpc/src/<Card>Card.ts` (new, one per card) and their exports in `packages/rpc/src/index.ts`.
- `apps/app/src/mainview/cards/fixtures/<Card>.ts` (new).
- `packages/rpc/docs/`: one page listing the card schemas; `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/rpc:docs`.

## Tests

- unit (`packages/rpc/src/<Card>Card.test.ts`): fixtures parse; unknown enum values fail; every §14.3 field appears in the schema (a table test generated from §14.3's field lists).
- unit (`apps/app/src/mainview/Architecture.test.ts`): `cards/views/*View.tsx` files import nothing from topic, store, controller or command modules (C-UI-08).
- unit (`flows/parity.test.ts`): a View with a handler not routed through `onAction(action.tag)`, or without `data-flow`, fails; a Container building `actions[]` without `cardActions` fails.

## Acceptance

- [C-UI-08](../checks/C-UI-08.md).

## Risks and notes

- Order of delivery follows design's port order and the critical path: Confirm, Todo, Draft, Home, Setup, Members, Flow, File, branch tree and Context line, timeline and toasts first; the S2 and S3 cards after.
