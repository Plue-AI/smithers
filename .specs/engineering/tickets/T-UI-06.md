# T-UI-06 Home view with the main sync row

Stage S1 · Size M · Depends on T-UI-01 · Unblocks T-GH-08, T-APP-01 · Issue: to file
Spec: spec.md §14.2.1, §4.1.2a, §12.6, §14.3 (Home) · Delta: delta.md §9 · Product: mvp.md J4, J10.6 · Props: [ui-components.md § T-UI-06](../ui-components.md)

## Goal

The home view with the main sync row exist as props-only components, matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-01, T-GH-08 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `HomeView`: the `main` row (synced ago, gold when stale, cause, Retry), attention rows, stack rows with their one action and presence, counts as filters, merged since last look, machines vs capacity, background runs with Retry and Dismiss.
- Props exactly as `ui-components.md` § T-UI-06 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- `apps/app/src/mainview/cards/<Card>View.tsx` and CSS, or `@smthrs/ui` for shared primitives (design decides the file layout within these trees).
- Fixtures in `apps/app/src/mainview/cards/fixtures/` (shared with T-APP-19).

## Tests

- unit: each fixture renders without error; the View imports no topic, store, controller or command module (C-UI-08).
- copy: `.specs/design/mock/copy.mjs` rules on the View's strings (C-UI-02).

## Acceptance

- [C-J4-01](../checks/C-J4-01.md) (visual half; the wiring ticket proves the data half).
- [C-J10-06](../checks/C-J10-06.md) (visual half; the wiring ticket proves the data half).
- [C-UI-08](../checks/C-UI-08.md).

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
