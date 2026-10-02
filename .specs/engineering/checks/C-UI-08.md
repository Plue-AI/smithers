# C-UI-08 Views are props-only; containers own data and actions

Proves: spec.md §14.2.1 (Will's ownership ruling, 2026-10-02), §14.3.0 (inventory and retained cards) · Layer: unit · Stage: S1 · Tickets: T-APP-19, T-UI-01, T-UI-02, T-UI-03, T-UI-04, T-UI-05, T-UI-06, T-UI-07, T-UI-08, T-UI-09, T-UI-10, T-UI-11, T-UI-12, T-UI-13, T-UI-14, T-UI-15, T-UI-16, T-UI-17, T-UI-18, T-UI-19, T-UI-20
Automation: `apps/app/src/mainview/Architecture.test.ts`, `flows/parity.test.ts` (View-seam and Container rules), `packages/rpc/src/*Card.test.ts` and `packages/rpc/src/RetainedCards.test.ts` · Runs in: CI

## Setup
The app tree at the commit under test.

## Steps
1. List every `*View.tsx` under `apps/app/src/mainview/cards/views/` and `packages/smithers/ui/src/`, and resolve its imports and handlers.
1a. List every `*Container.tsx` and how it builds `actions[]`.
2. Parse every fixture in `packages/rpc/test/fixtures/` with its card schema.
3. Compare each card schema's field set with spec §14.3's field list for that card. The inventory is the rows of the §14.3 table (§14.3.0; on this revision Home, TODO, Draft, Branch, File, Diff, Terminal, Flow, Members / Secrets, Setup / Settings, Proposal, Run, Agent, Confirm and Commands), read by a table test generated from spec.md, plus the shell parts (entry row and Context line, timeline line, toast, branch tree node, actor chip).
4. Export the JSON Schema of each retained card kind (§14.3.0: `issue`, `pr`, `change` with `ChangeReviewSchema` and `ChangeFindingSchema`, `world`, `wiki-history`, `wiki-links`, `wiki-graph`, `flow-form`, `browser`, `flow-plan`, `run-list`, `search-results`, `approval`). Compare each with its committed snapshot.

## Pass when
- No View imports a topic subscription, store, controller, RPC client or command module.
- Every View handler is `onAction(<action>.tag)` and its control carries `data-flow={<action>.tag}` (`flows/parity.test.ts` View-seam rule).
- Every Container builds `actions[]` through `cardActions`, so each tag is a catalog tag bound to `flowAction`.
- Every card in the §14.3.0 inventory has a View, a Container and a schema, and every `*View.tsx` in `cards/views/` renders an inventory card or a shell part.
- Every retained card's JSON Schema equals its committed snapshot.
- Every fixture parses, and every §14.3 field is present in its schema.

## Fail when
- A View fetches, subscribes or calls a command directly, or has a handler outside `onAction`.
- A schema field is missing from §14.3, or a §14.3 field is missing from the schema.
- A card is in the inventory without a View, Container or schema, or a View in `cards/views/` renders a card with no §14.3 row.
- A retained card's schema changed without a §14.3 row.

## Evidence
The CI test log and the commit.
