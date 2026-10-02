# C-UI-08 Views are props-only; containers own data and actions

Proves: spec.md §14.2.1 (Will's ownership ruling, 2026-10-02) · Layer: unit · Stage: S1 · Tickets: T-APP-19, T-UI-01, T-UI-02, T-UI-03, T-UI-04, T-UI-05, T-UI-06, T-UI-07, T-UI-08, T-UI-09, T-UI-10, T-UI-11, T-UI-12, T-UI-13, T-UI-14, T-UI-15, T-UI-16, T-UI-17, T-UI-18, T-UI-19, T-UI-20
Automation: `apps/app/src/mainview/Architecture.test.ts` and `packages/rpc/src/*Card.test.ts` · Runs in: CI

## Setup
The app tree at the commit under test.

## Steps
1. List every `*View.tsx` under `apps/app/src/mainview/` and `packages/smithers/ui/src/`, and resolve its imports.
2. Parse every fixture in `apps/app/src/mainview/cards/fixtures/` with its card schema.
3. Compare each card schema's field set with spec §14.3's field list for that card.

## Pass when
- No View imports a topic subscription, store, controller, RPC client or command module.
- Every card in §14.3 has a View, a Container and a schema.
- Every fixture parses, and every §14.3 field is present in its schema.

## Fail when
- A View fetches, subscribes or calls a command directly.
- A schema field is missing from §14.3, or a §14.3 field is missing from the schema.

## Evidence
The CI test log and the commit.
