# T-UI-07 Conversation shell: branch tree, entry rows, Context line, Earlier archive

Stage S1 · Size L · Depends on T-UI-01 · Unblocks T-APP-16, T-APP-17 · Issue: to file
Spec: spec.md §14.2.1, §14.1, §14.5.1, §15.1.2 · Delta: delta.md §9 · Product: mvp.md §6.3, M-08 · Props: [ui-components.md § T-UI-07](../ui-components.md)

## Goal

The conversation shell: branch tree, entry rows, Context line, Earlier archive exist as props-only components, matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-16, T-APP-17 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- The crumbs and `BranchTree` with presence, `EntryRow` with author, title, summary, tone and derived action, private-entry styling, `ContextLine` chips and the preflight cell in Inspect, and the read-only Earlier archive node.
- Props exactly as `ui-components.md` § T-UI-07 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
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

- [C-UI-06](../checks/C-UI-06.md) (visual half; the wiring ticket proves the data half).
- [C-UI-07](../checks/C-UI-07.md) (visual half; the wiring ticket proves the data half).
- [C-UI-08](../checks/C-UI-08.md).

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
