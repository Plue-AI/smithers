# T-UI-10 Flow view

Stage S1 · Size M · Depends on T-UI-01, T-APP-19 · Unblocks T-APP-05 · Issue: to file
Spec: spec.md §14.2.1, §11, §14.3 (Flow) · Delta: delta.md §9 · Product: mvp.md J5, J11 · Props: [ui-components.md § T-UI-10](../ui-components.md)

## Goal

`FlowView` exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-05 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `FlowView`: source label, versions with their states, steps with their agent, and Source, Plan, Run, Edit.
- Props exactly as `ui-components.md` § T-UI-10 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- `apps/app/src/mainview/cards/views/<Card>View.tsx` and CSS, or `@smthrs/ui` for shared primitives. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- Fixtures from `@smthrs/rpc` (`packages/rpc/test/fixtures/`, written with T-APP-19).

## Tests

- unit (C-UI-12): every fixture of the card renders with its actions and shows its `expect` strings, in light and dark at 1280 and 390 px; each press calls `onAction` or `onView` once. The View-seam rule passes on the View's file (C-UI-08).
- copy: C-UI-02 (T-CAT-01's term list) renders every card fixture, this View's included once it lands. No test reads `.specs/`.

## Acceptance

- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.
- [C-J5-01](../checks/C-J5-01.md): Flow edit from chat → TODO → merged → Active after sync; running TODOs keep their version, including a retry after a lockfile change
- [C-J11-02](../checks/C-J11-02.md): Flow Source opens on the proposing TODO's branch; Plan and a "draft version" Run on a scratch branch show the edited graph live; a repository flow runs from its slash command with a form and shows its custom view

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
