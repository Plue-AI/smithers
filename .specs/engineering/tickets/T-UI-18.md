# T-UI-18 Secrets view

Stage S2 · Size S · Depends on T-UI-01 · Unblocks T-APP-13, T-REL-02 · Issue: [#3582](https://github.com/smithersai/smithers/issues/3582)
Spec: spec.md §14.2.1, §8.9, §14.3 (Secrets) · Delta: delta.md §9 · Product: mvp.md J1 · Props: written by this ticket when S2 starts

## Goal

`SecretsView` exists as a props-only View matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-13 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `SecretsView`: names, scope ("all branches" or "main only") and the optional Hosts field in Add and Replace.
- Props: a TypeScript type in `packages/rpc/src/SecretsCard.ts`, which this ticket adds back with its ui-components.md section when S2 starts; zod only where data crosses HTTP or storage.
- Stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- Secrets without Hosts count or Bind.
- `apps/app/src/mainview/cards/views/SecretsView.tsx` and CSS, or `@smthrs/ui` for shared primitives. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- `apps/app/src/mainview/cards/views/SecretsView.stories.tsx`: one story per state, with literal expected strings and actions.

## Tests

- unit (`cards/views/Views.test.tsx` over `*View.stories.tsx`): each story renders in both themes with no console error and shows its literal expected strings; each press calls `onAction` with its literal tag and arguments, or `onView` with its literal patch, once; a story with its first action removed shows no control for it. The View-seam rule (`flows/parity.test.ts`) passes on the View's file.
- Playwright (`view-stories.spec.ts`): in both themes, no overflow at 390 px and no serious or critical axe-core violation.
- copy: T-CAT-01's term-list test renders this ticket's stories. No test reads `.specs/`.

## Acceptance

- Copy review: the design reviewer reads every story screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the mock needs but spec §14.3 lacks is a spec change: raise it with the tech lead before building around it.
