# C-UI-08 Card schemas match §14.3, fixtures parse, and the seam rules hold

Proves: spec.md §14.2.1 (Will's ownership ruling, 2026-10-02), §14.3, §14.3.0 (inventory and retained cards) · Layer: unit · Stage: S1 · Tickets: T-APP-19
Automation: `packages/rpc/test/cards/<Card>Card.test.ts`, `packages/rpc/test/cards/RetainedCards.test.ts`, the §14.3 field script `scripts/spec-card-fields.mjs` (CI only; no test reads `.specs/`), `apps/app/src/mainview/Architecture.test.ts` and `flows/parity.test.ts` (View-seam and Container rules) · Runs in: CI

## Setup
The repository at the commit under test. No View or Container needs to exist: the seam rules run on every file that exists and on the seeded violations in `flows/fixtures/seam/`.

## Steps
1. For each §14.3 row and each shell part, parse every fixture in `packages/rpc/test/fixtures/<Card>.ts` with its schema. Parse a copy of each with one enum value changed to an unknown value.
2. Run the field script: read the §14.3 table from spec.md and compare each row's field list, nested objects included, with its schema's field set.
3. Export the JSON Schema of each retained card kind (§14.3.0: `issue`, `pr`, `change` with `ChangeReviewSchema` and `ChangeFindingSchema`, `world`, `wiki-history`, `wiki-links`, `wiki-graph`, `flow-form`, `browser`, `flow-plan`, `run-list`, `search-results`, `approval`). Compare each with its committed snapshot.
4. Run the View-seam rule on every `*View.tsx` under `apps/app/src/mainview/cards/views/` and `packages/smithers/ui/src/`, and on four seeded Views: one importing a store, one calling `fetch`, one with a handler of none of the three kinds, and one with an `onAction` control lacking `data-flow`. Run it on a seeded compliant View that uses all three kinds.
5. Run the Container rule on every `*Container.tsx`, and on a seeded Container that builds `actions[]` without `cardActions`.

## Pass when
- Step 1: every fixture parses, every changed copy fails, and each card has a fixture for every state T-APP-19's fixture list names.
- Step 2: every §14.3 field is in its schema, and every schema field is in §14.3.
- Step 3: every retained schema equals its snapshot.
- Step 4: in every real View, each handler calls `onAction(action.tag, …)` from a control carrying `data-flow={action.tag}`, calls `onView(patch)`, or touches only React local state, DOM focus or the clipboard through `copyText` (ui-components.md Rules). No View imports state, store, topic, controller, flow, RPC client or command modules, or calls `fetch`. Each seeded violation fails, and the compliant View passes.
- Step 5: every Container builds `actions[]` and `gestures` through `cardActions`, and the seeded Container fails.

## Fail when
- A schema field is missing from §14.3, or a §14.3 field is missing from the schema.
- A fixture fails to parse, or an unknown enum value parses.
- A retained card's schema changed without a §14.3 row.
- A seam rule passes a seeded violation or fails a compliant file.

## Evidence
The CI test log and the commit.
