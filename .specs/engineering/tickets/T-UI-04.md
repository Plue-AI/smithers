# T-UI-04 TODO view with Needs you, conflict, failure, evidence, PR and fork controls

Stage S1 · Size L · Depends on T-UI-01 · Unblocks T-STK-08, T-MCH-08, T-APP-02 · Issue: to file
Spec: spec.md §14.2.1, §4.1, §10.5.4, §10.6.4, §12.5.1, §14.3 (TODO) · Delta: delta.md §9 · Product: mvp.md J2, J4, J7, J10, M-32, M-33 · Props: [ui-components.md § T-UI-04](../ui-components.md)

## Goal

The tODO view with Needs you, conflict, failure, evidence, PR and fork controls exist as props-only components, matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-02, T-STK-08, T-MCH-08 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `TodoView` in all nine states: prompt revisions, steps with the current one lit, Needs you forms for each kind (question, approval, conflict with paths and Done, moved off, outside push with Bring in and Discard), failure with Retry and Retry with the current flow, evidence per attempt, the PR line with draft and "merges after Tn", `merged_via`, the merge control, Fork and Add to stack.
- Props exactly as `ui-components.md` § T-UI-04 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
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

- [C-J2-01](../checks/C-J2-01.md) (visual half; the wiring ticket proves the data half).
- [C-J4-02](../checks/C-J4-02.md) (visual half; the wiring ticket proves the data half).
- [C-J7-03](../checks/C-J7-03.md) (visual half; the wiring ticket proves the data half).
- [C-J9-01](../checks/C-J9-01.md) (visual half; the wiring ticket proves the data half).
- [C-UI-08](../checks/C-UI-08.md).

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
