# T-UI-23 TODO view: conflict, moved-off and outside-push forms; Fork and Add to stack

Stage S1 · Size M · Depends on T-UI-04, T-APP-19 · Unblocks T-GH-06, T-MCH-08, T-REL-02, T-STK-08 · Issue: [#3552](https://github.com/smithersai/smithers/issues/3552)
Spec: spec.md §14.2.1, §4.1.0a, §8.5, §9.3.8, §10.5.4, §12.3, §14.3 (TODO) · Delta: delta.md §9 · Product: mvp.md J7, J10.3, M-32, M-33 · Props: [ui-components.md § T-UI-23](../ui-components.md)

## Goal

The TODO card's branch-repair forms and stack controls exist in `TodoView` as props-only parts matching the design mock and ui-components.md, so T-STK-08, T-MCH-08 and T-GH-06 only bind data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-STK-08, T-MCH-08 and T-GH-06 and reviews nothing visual. Design reviews engineering's wiring when idle. Split from T-UI-04 (product-approved, 2026-10-02): stage S1, off the J1/J2 path.

## Scope

In:
- The `conflict` wait: the conflicted paths, the S1 conflict view (terminal and SSH line) and Done; from S2, Resolve opens the Branch card (§10.5.4).
- The `moved_off` wait with Resolve (§9.3.8). Return to Tn and Keep for now are on the Branch card (T-UI-15).
- The `foreign_push` wait: the pusher, the commit, **Bring in** and **Discard** (§12.3, M-33).
- Fork and Add to stack on the TODO card (§8.5, M-32).
- Props exactly as `ui-components.md` § T-UI-04 (TodoModel `waits[]` and the card's actions) until T-APP-19 lands, then the zod type from `packages/rpc/src/TodoCard.ts`.
- Fixture stories for each of these states, light and dark, desktop and 390 px.

Out:
- The TODO states, the question and approval forms, failure, evidence, the PR line and the merge control (T-UI-04).
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- `apps/app/src/mainview/cards/views/TodoView.tsx` parts and CSS. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- Fixtures from `@smthrs/rpc` (`packages/rpc/test/fixtures/Todo.ts`, written with T-APP-19): conflict, moved off, outside push, and two open waits at once.

## Tests

- unit (C-UI-12): every conflict, moved-off and outside-push fixture renders with its actions and shows its `expect` strings, in light and dark at 1280 and 390 px; each press calls `onAction` or `onView` once. The View-seam rule passes on the View's file (C-UI-08).
- copy: C-UI-02 (T-CAT-01's term list) renders every card fixture, these included once they land. No test reads `.specs/`.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md): every View fixture passes visual and copy review.

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
