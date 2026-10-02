# T-UI-15 Branch view with moved-off controls

Stage S2 · Size L · Depends on T-UI-01 · Unblocks T-COL-05, T-APP-10 · Issue: to file
Spec: spec.md §14.2.1, §8.10, §9.3, §14.3 (Branch) · Delta: delta.md §9 · Product: mvp.md J3, J7 · Props: [ui-components.md § T-UI-15](../ui-components.md)

## Goal

The branch view with moved-off controls exist as props-only components, matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-10, T-COL-05 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `BranchView`: machine chip with Sleep and Wake, item and place or scratch, presence avatars with where, activity, terminals, changed files, the SSH line, and the moved-off Needs you with Return to Tn and Keep for now.
- Props exactly as `ui-components.md` § T-UI-15 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- `apps/app/src/mainview/cards/views/<Card>View.tsx` and CSS, or `@smthrs/ui` for shared primitives. Every handler calls `onAction(action.tag)` with `data-flow={action.tag}`.
- Fixtures from `@smthrs/rpc` (`packages/rpc/test/fixtures/`, written with T-APP-19).

## Tests

- unit: each fixture renders without error; the View imports no topic, store, controller or command module (C-UI-08).
- copy: `.specs/design/mock/copy.mjs` rules on the View's strings (C-UI-02).

## Acceptance

- [C-J3-01](../checks/C-J3-01.md) (visual half; the wiring ticket proves the data half).
- [C-J3-03](../checks/C-J3-03.md) (visual half; the wiring ticket proves the data half).
- [C-J3-09](../checks/C-J3-09.md) (visual half; the wiring ticket proves the data half).
- [C-UI-08](../checks/C-UI-08.md).

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
