# T-UI-19 Co-editing visuals

Stage S3 · Size M · Depends on T-UI-01 · Unblocks T-APP-14 · Issue: to file
Spec: spec.md §14.2.1, §7.3, §7.6, §14.3 (File S3) · Delta: delta.md §9 · Product: mvp.md J3.2, J8, §6.8 · Props: [ui-components.md § T-UI-19](../ui-components.md)

## Goal

The co-editing visuals exist as props-only components, matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-14 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- Author colours, gutter name flags, the Saved state and the stale-write flag on `CodeEditorView`.
- Props exactly as `ui-components.md` § T-UI-19 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
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

- [C-J3-04](../checks/C-J3-04.md) (visual half; the wiring ticket proves the data half).
- [C-UI-08](../checks/C-UI-08.md).

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
