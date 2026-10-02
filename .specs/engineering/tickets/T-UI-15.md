# T-UI-15 Branch view with moved-off controls

Stage S2 · Size L · Depends on T-UI-01, T-APP-19 · Unblocks T-COL-05, T-APP-10 · Issue: to file
Spec: spec.md §14.2.1, §8.10, §9.3, §14.3 (Branch) · Delta: delta.md §9 · Product: mvp.md J3, J7 · Props: [ui-components.md § T-UI-15](../ui-components.md)

## Goal

`BranchView`, with the moved-off controls, exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-10, T-COL-05 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `BranchView`: the machine in each §4.2 state (awake, asleep, waking, waiting #n, closed, failed with Retry) with Sleep and Wake; the item with its state, title and place, or scratch with Add to stack after its fork source; the rebase states (Rebase pending with Rebase now and, for the member who pressed it, what it waits for; Rebasing…; a scratch conflict's paths with Resolve and Done); presence for people and agents with where (file and line, terminal, step, branch) and watching; activity, each change entry opening its burst's diff; terminals with owner, agents, watchers and the frozen state; changed files with their authors; the SSH line; and the moved-off Needs you with Return to Tn and Keep for now.
- Props exactly as `ui-components.md` § T-UI-15 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
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
- [C-J3-01](../checks/C-J3-01.md): Branch card presence: people, the agent and an SSH editor, each with where
- [C-J3-03](../checks/C-J3-03.md): Outside change: one grouped entry attributed to the only active session (else "changed outside Smithers"), opens the diff, Restore this file works, open cards update, agent re-reads
- [C-J3-09](../checks/C-J3-09.md): Hand-run `git checkout main` or `jj new main` → Needs you through the metadata watch; Return to Tn and Keep for now

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
