# T-UI-17 Terminal view

Stage S2 · Size S · Depends on T-UI-01 · Unblocks T-APP-12 · Issue: [#3581](https://github.com/smithersai/smithers/issues/3581)
Spec: spec.md §14.2.1, §14.3 (Terminal) · Delta: delta.md §9 · Product: mvp.md J3.3, J6 · Props: written by this ticket when S2 starts

## Goal

`TerminalView` exists as a props-only View matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-12 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `TerminalView`: owner, agents working in it with their own avatars and "for Ben" (M-34), watchers, running command, the frozen "Rebasing…" state, and the Watching state for non-owners.
- Props: a TypeScript type in `packages/rpc/src/TerminalCard.ts`, which this ticket adds back with its ui-components.md section when S2 starts; zod only where data crosses HTTP or storage.
- Stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- Watched terminals never take input focus; ⌘K opens the palette. No Ask to type or Add to machine image.
- `apps/app/src/mainview/cards/views/TerminalView.tsx` and CSS, or `@smthrs/ui` for shared primitives. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.

## Tests

- Playwright (`view-stories.spec.ts`): in both themes, no overflow at 390 px and no serious or critical axe-core violation.
- copy: T-CAT-01's term-list test renders this ticket's stories. No test reads `.specs/`.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- Copy review: the design reviewer reads every story screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the mock needs but spec §14.3 lacks is a spec change: raise it with the tech lead before building around it.
