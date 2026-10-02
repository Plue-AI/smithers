# T-UI-07 Conversation shell: branch tree, entry rows, Context line, Earlier archive

Stage S1 · Size L · Depends on T-UI-01, T-APP-19 · Unblocks T-APP-16, T-APP-17 · Issue: to file
Spec: spec.md §14.2.1, §14.1, §14.5.1, §15.1.2 · Delta: delta.md §9 · Product: mvp.md §6.3, M-08 · Props: [ui-components.md § T-UI-07](../ui-components.md)

## Goal

The conversation shell (`BranchTree`, `EntryRow`, `ContextLine` and the Earlier archive) exists as props-only components matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

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

- `apps/app/src/mainview/cards/views/<Card>View.tsx` and CSS, or `@smthrs/ui` for shared primitives. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- Fixtures from `@smthrs/rpc` (`packages/rpc/test/fixtures/`, written with T-APP-19).

## Tests

- unit (C-UI-12): every fixture of the card renders with its actions and shows its `expect` strings, in light and dark at 1280 and 390 px; each press calls `onAction` or `onView` once. The View-seam rule passes on the View's file (C-UI-08).
- copy: C-UI-02 (T-CAT-01's term list) renders every card fixture, this View's included once it lands. No test reads `.specs/`.

## Acceptance

- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.
- [C-UI-06](../checks/C-UI-06.md): Two members on one branch see the same entries, keep their own scroll and card state; a prompt runs with its author's rights; UI-only flows touch only the author's screen; no private entry reaches any turn; removing a member cancels their queued and running turns
- [C-UI-07](../checks/C-UI-07.md): Every answer has a stored context list and a Context line; Inspect shows preflight first; only selected context and shared entries reach the answer step, never a private entry

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
