# T-APP-19 Card view-model schemas and fixtures from `ui-components.md`: the seam between design's views and engineering's containers

Stage S1 · Size S · Depends on — · Unblocks T-APP-01, T-APP-02, T-APP-03, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-APP-09, T-APP-10, T-APP-11, T-APP-12, T-APP-13, T-APP-14a, T-APP-15, T-APP-16, T-APP-17, T-APP-18, T-APP-19b, T-APP-20, T-APP-21, T-CAT-01, T-COL-05, T-FLW-06, T-FLW-07, T-FLW-08, T-FLW-12, T-GH-08, T-MCH-08, T-MNT-01, T-MNT-04, T-REL-02, T-STK-08, T-STK-10, T-UI-01, T-UI-15, T-UI-16, T-UI-17, T-UI-18, T-UI-19, T-UI-20, T-UI-21, T-UI-22, T-UI-23 · Issue: [#3474](https://github.com/smithersai/smithers/issues/3474)
Spec: spec.md §14.2.1, §14.3 · Delta: delta.md §9 · Product: mvp.md §6 (cards), design `.specs/design/`

## Goal

Design builds every card view against a typed contract on day one, and engineering wires containers to the same contract, so neither side waits on the other or edits the other's files.

## Ownership (Will, 2026-10-02)

Engineering writes the schemas and fixtures. Design reviews field names against its mocks before merge. A field a view needs and §14.3 lacks is a spec change raised with the tech lead, then added here.

## Scope

In:
- One zod schema and inferred type per §14.3 row in `packages/rpc/src/<Card>Card.ts`, following `SubagentCard.ts`: Home, Todo, Draft, Setup, Settings, Confirm (`one_click`, `review_merge`), Flow, Members, Branch, File, Diff, Terminal, Secrets, Agent, Proposal, Run, Commands, Docs, DebugApi, plus the shell parts: entry row, timeline line, toast, actor chip, Context line, branch tree node. The shared types (`Actor`, `Merge`, `Evidence`, `MachineState`, `Action`, `FormField`, `CardProps`) live in `packages/rpc/src/CardShared.ts`. Schemas follow ui-components.md v0.4.
- Field names and enums copied from spec §14.3 in snake_case. Callbacks are the `CardProps` callbacks of ui-components.md: `onAction(tag, input?)`, `onView(patch)` and the named `gestures`, never RPC clients. `onView` stays: it carries per-member view state (§14.1.2).
- Fixtures per card in `packages/rpc/test/fixtures/<Card>.ts`, exported through `@smthrs/rpc` subpaths so the app imports them (a package never depends on an app). Each fixture is `{name, model, actions, gestures, view, expect}`, where `expect` lists the strings its View must show (C-UI-12). They cover each state §14.3 lists: for Todo, every one of the nine states, two open waits at once, a late answer, a failed and a passing required GitHub check, a `previous` review and each `merge` state; for Confirm, both kinds, a stale approval and each receipt; for Draft, append, before, amend, from an issue with and without `fixes`, with a seed, committed; for Setup, each step state including blocked and failed; for Home, each sync health and each background-run state; for Branch, each machine state and each rebase state; for File, text, too large and binary contents, deleted, renamed, outside and unsaved; for Run, two attempts with a retried step and a settled wait; for Docs, a not-found page; for DebugApi, a pending mutation and a typed failure.
- The retained cards (§14.3.0) get no new schema. A snapshot test pins each one's existing zod schema as JSON Schema, so a field change fails until §14.3 adds its row.
- A schema test per card: each fixture parses, and an unknown state fails to parse.
- `Action` with `tag: CatalogTag` (the tag union exported by T-CAT-01's catalog source; until that lands, a placeholder union of Appendix A tags and Appendix B.4 in-card control ids that T-CAT-01 replaces in the same change) and `args` for the arguments a Container binds.
- The Container helper `cardActions(…)`: builds `actions[]` and `gestures` from catalog tags with their `args`, and binds `onAction` to `flowAction`, so every View button and gesture is a catalog flow with three doors.
- `flows/parity.test.ts` (with T-CUT-01's parity edit): leave `cards/views/` out of the pinned handler table; add the View-seam rule and the Container rule. View-seam rule (frontend lead, 2026-10-02): a handler (1) calls `onAction(action.tag, …)` from a control carrying `data-flow`, (2) calls `onView(patch)`, or (3) touches only React local state, DOM focus or the clipboard through `copyText`; anything else fails, and so does a View that imports state, flows or RPC or calls `fetch`. Container rule: every `*Container.tsx` builds `actions[]` and `gestures` through `cardActions`. Both rules run on seeded violations in `flows/fixtures/seam/`, so they are proven before any View or Container exists.

Out:
- Views and CSS (design, C-UI-12). Containers and topic mapping (each card's own ticket, C-UI-13 part A). The stage audit (C-UI-13 part B).

## Changes

- `packages/rpc/src/<Card>Card.ts` (new, one per card), each exported as its own subpath (`@smthrs/rpc/TodoCard`); no barrel export.
- `packages/rpc/test/fixtures/<Card>.ts` (new).
- Superseded kinds: a table in this ticket mapping each `packages/rpc/src/Cards.ts` card kind a view model replaces (`factory.home`, `branches`, `file`, `diff`, `secrets`, `agent`, `agents`, `run-trace`, `search-results` and the rest) to the ticket that removes its producer. Its decoder moves to the read-only legacy decoder that keeps old conversations readable (spec §14.1.5), so rpc never ships two live card models. The table is filled before the first container lands (fix wave 2, 2026-10-02).
- `packages/rpc/docs/`: one page listing the card schemas; `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/rpc:docs`.

## Tests

- unit (`packages/rpc/test/cards/<Card>Card.test.ts`): fixtures parse; unknown enum values fail; every fixture state the Scope lists exists. The §14.3 field coverage is checked by C-UI-08's spec script in CI, never by a test that reads `.specs/*.md` at runtime.
- unit (`apps/app/src/mainview/Architecture.test.ts`): `cards/views/*View.tsx` files import nothing from topic, store, controller or command modules (C-UI-08).
- unit (`flows/parity.test.ts`): each seeded violation fails (a handler that is none of the three kinds, an `onAction` control without `data-flow`, a View importing a store or calling `fetch`, a Container building `actions[]` without `cardActions`), and a seeded compliant View with all three kinds passes.
- unit (`packages/rpc/test/cards/RetainedCards.test.ts`, new): the JSON Schema of each retained card kind §14.3.0 names (`issue`, `pr`, `change` with `ChangeReviewSchema` and `ChangeFindingSchema`, `world`, `wiki-history`, `wiki-links`, `wiki-graph`, `flow-form`, `browser`, `flow-plan`, `run-list`, `search-results`, `approval`) equals its committed snapshot.

## Acceptance

- [C-UI-08](../checks/C-UI-08.md).
- [C-J1-04](../checks/C-J1-04.md): First TODO to merged PR, unassisted, within 60 minutes of starting the install

## Risks and notes

- Order of delivery follows ui-components.md Order of need (J1 first): primitives, Setup and Settings, the conversation shell, Home, File and Diff, Draft, Todo, toasts and timeline, Confirm, Members, Commands, Flow, Run, Agent; then the S2 and S3 cards.
- Completion: this ticket closes on C-UI-08 alone. It needs no View or Container (ui-components.md Completion gates).
