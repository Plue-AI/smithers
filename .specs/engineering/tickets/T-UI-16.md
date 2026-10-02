# T-UI-16 File and Diff live states

Stage S2 · Size S · Depends on T-UI-01 · Unblocks T-APP-11 · Issue: to file
Spec: spec.md §14.2.1, §9.2.3, §9.3.5 · Delta: delta.md §9 · Product: mvp.md J3.4, §6.8 · Props: [ui-components.md § T-UI-16](../ui-components.md)

## Goal

The file and Diff live states exist as props-only components, matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-11 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- Reload on change, the gone and renamed banners, Restore this file, Compare, and the "Changed outside Smithers" flag.
- Props exactly as `ui-components.md` § T-UI-16 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- `apps/app/src/mainview/cards/views/<Card>View.tsx` and CSS, or `@smthrs/ui` for shared primitives. Every handler calls `onAction(action.tag)` with `data-flow={action.tag}`.
- Fixtures in `apps/app/src/mainview/cards/fixtures/` (shared with T-APP-19).

## Tests

- unit: each fixture renders without error; the View imports no topic, store, controller or command module (C-UI-08).
- copy: `.specs/design/mock/copy.mjs` rules on the View's strings (C-UI-02).

## Acceptance

- [C-J3-08](../checks/C-J3-08.md) (visual half; the wiring ticket proves the data half).
- [C-UI-08](../checks/C-UI-08.md).

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
