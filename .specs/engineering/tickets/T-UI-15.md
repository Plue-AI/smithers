# T-UI-15 Branch view with moved-off controls

Stage S2 · Size L · Depends on T-UI-01 · Unblocks T-APP-10, T-REL-02 · Issue: [#3579](https://github.com/smithersai/smithers/issues/3579)
Spec: spec.md §14.2.1, §8.10, §9.3, §14.3 (Branch) · Delta: delta.md §9 · Product: mvp.md J3, J7 · Props: written by this ticket when S2 starts

## Goal

`BranchView`, with the moved-off controls, exists as a props-only View matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-10, T-COL-05 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `BranchView`: the machine in each §4.2 state (awake, asleep, waking, waiting #n, closed, failed with Retry) with Sleep and Wake; the item with its state, title and place, or scratch with Add to stack after its fork source; the rebase states (Rebase pending with Rebase now and, for the member who pressed it, what it waits for; Rebasing…; a scratch conflict's paths with Resolve and Done); presence for people and agents with where (file and line, terminal, step, branch) and watching; activity, each change entry opening its burst's diff; terminals with owner, agents, watchers and the frozen state; changed files with their authors; the SSH line; and the moved-off Needs you with Return to Tn and Keep for now.
- Presence rows come from T-COL-06's reuse of `packages/smithers/flows/sync/src/BranchPresence.ts` (person-or-agent kind and location); the View keeps no presence state (v1 §4).
- Props: a TypeScript type in `packages/rpc/src/BranchCard.ts`, which this ticket adds back with its ui-components.md section when S2 starts; zod only where data crosses HTTP or storage.
- Stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- Branch card and rebase freeze.
- `apps/app/src/mainview/cards/views/BranchView.tsx` and CSS, or `@smthrs/ui` for shared primitives. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.

## Tests

- Playwright (`view-stories.spec.ts`): in both themes, no overflow at 390 px and no serious or critical axe-core violation.
- copy: T-CAT-01's term-list test renders this ticket's stories. No test reads `.specs/`.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- Copy review: the design reviewer reads every story screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the mock needs but spec §14.3 lacks is a spec change: raise it with the tech lead before building around it.
