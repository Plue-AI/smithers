# T-UI-09 Members view

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-APP-06 · Issue: to file
Spec: spec.md §14.2.1, §5, §14.3 (Members) · Delta: delta.md §9 · Product: mvp.md J1.5 · Props: [ui-components.md § T-UI-09](../ui-components.md)

## Goal

The members view exist as props-only components, matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-06 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `MembersView`: rows with role, needs access and suspended, and Add by username.
- Props exactly as `ui-components.md` § T-UI-09 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
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

- [C-J1-05](../checks/C-J1-05.md) (visual half; the wiring ticket proves the data half).
- [C-UI-08](../checks/C-UI-08.md).

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
