# T-UI-17 Terminal view

Stage S2 · Size S · Depends on T-UI-01 · Unblocks T-APP-12 · Issue: to file
Spec: spec.md §14.2.1, §8.7.1, §14.3 (Terminal) · Delta: delta.md §9 · Product: mvp.md J3.3, J6 · Props: [ui-components.md § T-UI-17](../ui-components.md)

## Goal

The terminal view exist as props-only components, matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-12 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `TerminalView`: owner, watchers, running command, Watching state for non-owners, and the temporary-home header.
- Props exactly as `ui-components.md` § T-UI-17 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
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

- [C-J3-02](../checks/C-J3-02.md) (visual half; the wiring ticket proves the data half).
- [C-UI-08](../checks/C-UI-08.md).

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
