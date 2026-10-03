# T-UI-19 Co-editing visuals

Stage S3 · Size M · Depends on T-UI-01, T-APP-14a · Unblocks T-APP-14, T-MNT-02, T-MNT-04, T-REL-02 · Issue: [#3589](https://github.com/smithersai/smithers/issues/3589)
Spec: spec.md §14.2.1, §7.3, §7.6, §14.3 (File S3) · Delta: delta.md §9 · Product: mvp.md J3.2, J8, §6.8 · Props: written by this ticket when S3 starts

## Goal

The co-editing visuals exist on `CodeEditorView`, which T-APP-14a restores from `4a36b0cfb`, as props-only visual extensions matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-14 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- On `CodeEditorView` in live mode: install the `EditorBinding` extensions; author colours from the `authorRanges` facet and `authors`; gutter name flags from `editors`, agents included; the Saved state; and "N edits weren't saved" with Reapply and Copy. Design writes every visual extension, and engineering's binding (T-APP-14) adds none.
- Props: the File props type in `packages/rpc/src/FileCard.ts` gains the S3 fields (`binding`, `authors`, `editors`, `saved`, `unsaved`) as TypeScript types, with their ui-components.md section, when S3 starts.
- Name flags draw awareness `{actor, line}` and presence from T-COL-06's reuse of `packages/smithers/flows/sync/src/BranchPresence.ts` (a person-or-agent kind and a location); no new presence system (v1 §4). Before writing presence rendering, check `2753d2e3` for deleted client presence code.
- Stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- Author colours, gutter flags, saved text, outside flag and too large to co-edit; no `.cm-ySelection`.
- Visual extensions on the restored `apps/app/src/mainview/cards/views/CodeEditorView.tsx` and the File card's existing CSS, or `@smthrs/ui` for shared primitives. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- `apps/app/src/mainview/cards/views/CodeEditorView.stories.tsx`: one story per state, with literal expected strings and actions.

## Tests

- unit (`cards/views/Views.test.tsx` over `*View.stories.tsx`): each story renders in both themes with no console error and shows its literal expected strings; each press calls `onAction` with its literal tag and arguments, or `onView` with its literal patch, once; a story with its first action removed shows no control for it. The View-seam rule (`flows/parity.test.ts`) passes on the View's file.
- Playwright (`view-stories.spec.ts`): in both themes, no overflow at 390 px and no serious or critical axe-core violation.
- copy: T-CAT-01's term-list test renders this ticket's stories. No test reads `.specs/`.

## Acceptance

- Copy review: the design reviewer reads every story screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the mock needs but spec §14.3 lacks is a spec change: raise it with the tech lead before building around it.
