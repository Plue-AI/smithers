# T-UI-01 Primitives: actor chip, state word, tone

Stage S1 · Size S · Depends on — · Unblocks T-APP-09, T-UI-02, T-UI-03, T-UI-04, T-UI-05, T-UI-06, T-UI-07, T-UI-08, T-UI-09, T-UI-10, T-UI-11, T-UI-12, T-UI-13, T-UI-14, T-UI-15, T-UI-16, T-UI-17, T-UI-18, T-UI-19, T-UI-20 · Issue: to file
Spec: spec.md §14.2.1, §14.6a, §14.5.2, §4.1 · Delta: delta.md §9 · Product: mvp.md §3, B.3 · Props: [ui-components.md § T-UI-01](../ui-components.md)

## Goal

The primitives: actor chip, state word, tone exist as props-only components, matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-09 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `ActorChip` for every §14.6a actor (person, via badges, agent, Smithers and "Smithers, for Ben", @login, outside); `StateWord` for the nine TODO states with the step; the five tones as Paper tokens in light and dark.
- Props exactly as `ui-components.md` § T-UI-01 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
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

- [C-J6-01](../checks/C-J6-01.md) (visual half; the wiring ticket proves the data half).
- [C-UI-08](../checks/C-UI-08.md).

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
