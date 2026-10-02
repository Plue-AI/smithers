# T-UI-04 TODO view: states, questions, failure, evidence, PR and merge

Stage S1 · Size L · Depends on T-UI-01, T-APP-19 · Unblocks T-STK-08, T-MCH-08, T-APP-02, T-UI-23 · Issue: to file
Spec: spec.md §14.2.1, §4.1, §10.5.4, §10.6.4, §12.5.1, §14.3 (TODO) · Delta: delta.md §9 · Product: mvp.md J2, J4, J7, J10, M-32, M-33 · Props: [ui-components.md § T-UI-04](../ui-components.md)

## Goal

`TodoView`, with every TODO state, the question and approval forms, failure, evidence, the PR line and the merge control, exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-02 and reviews nothing visual. The conflict, moved-off and outside-push forms and Fork and Add to stack moved to T-UI-23 (product-approved split, 2026-10-02). Design reviews engineering's wiring when idle.

## Scope

In:
- `TodoView` in all nine states: prompt revisions ("+n"), steers with their authors, steps with the current one lit, every open wait listed with its own action, primary first, with the question and approval forms, the first answer and Send as steer, failure with Retry and Retry with the current flow, evidence per attempt bound to its revision (diff stat, each machine check with its duration and log link, each GitHub check with `required`, the review summary or "reviewing", an earlier generation's review, usage, flow version and model access; C-J2-04), the PR line with draft and "merges after Tn", `merged_via`, and the one `merge` control in each state and reason. The conflict, moved-off and outside-push forms and Fork and Add to stack are T-UI-23.
- Props exactly as `ui-components.md` § T-UI-04 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
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
- [C-J2-01](../checks/C-J2-01.md): Make TODO from an issue: drafted from the discussion, edited, placed, committed, issue labeled and commented
- [C-J4-02](../checks/C-J4-02.md): Answer, merge next, move up, retry with steer, all while chatting
- [C-J7-03](../checks/C-J7-03.md): Conflict on rebase: agent resolves once, else Needs you with Resolve
- [C-J9-01](../checks/C-J9-01.md): Ask the repository: answer with file and wiki cards; Make TODO and Save to wiki
- [C-J11-04](../checks/C-J11-04.md): Thrashing: the same failing check 3× in one attempt with no edit in between shows on the TODO card and the Inspect phase; an edit clears it

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
