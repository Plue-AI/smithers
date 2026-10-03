# T-UI-16 File and Diff live states

Stage S2 · Size S · Depends on T-UI-01 · Unblocks T-APP-11 · Issue: [#3580](https://github.com/smithersai/smithers/issues/3580)
Spec: spec.md §14.2.1, §9.2.3, §9.3.5 · Delta: delta.md §9 · Product: mvp.md J3.4, §6.8 · Props: written by this ticket when S2 starts

## Goal

The File and Diff live states exist in the File surface (`cards/CodeSurface.tsx`) and the Diff surface (`cards/DiffSurface.tsx`, where T-APP-15 folds `DiffView`) as props-only states matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-11 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- The deleted banner with Restore and the renamed banner with Follow (`gone`), the snapshot caption, the "Changed outside Smithers" flag with Compare against the outside `version`, and the Compare view.
- Props: the File and Diff props types in `packages/rpc/src/FileCard.ts` and `DiffCard.ts` gain the S2 fields (`gone`, `renamed_to`, `outside`, `version`) as TypeScript types, with their ui-components.md section, when S2 starts. CodeMirror is S3 (T-APP-14a).
- Stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- Reload with no remount, preserving scroll and line; gone banners and Compare; no line-comment affordance.
- The states in `cards/CodeSurface.tsx` and `cards/DiffSurface.tsx` and their existing CSS, or `@smthrs/ui` for shared primitives; no new View file. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.

## Tests

- Playwright (`view-stories.spec.ts`): in both themes, no overflow at 390 px and no serious or critical axe-core violation.
- copy: T-CAT-01's term-list test renders this ticket's stories. No test reads `.specs/`.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- Copy review: the design reviewer reads every story screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the mock needs but spec §14.3 lacks is a spec change: raise it with the tech lead before building around it.
