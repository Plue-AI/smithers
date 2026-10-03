# T-UI-11 File and Diff views (read-only)

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-APP-15, T-REL-02 · Issue: [#3548](https://github.com/smithersai/smithers/issues/3548)
Spec: spec.md §14.2.1, §7.6, §14.3 (File, Diff) · Delta: delta.md §9 · Product: mvp.md J1.5, J9, M-02 · Props: [ui-components.md § T-UI-11](../ui-components.md)

Rework of landed 4a36b0cfb (minimal-code synthesis v1 §3, v2 "Reverts and reworks").

## Goal

The File card renders read-only code through the existing `CodeFileView`, and diffs render through one Pierre wrapper, `cards/DiffSurface.tsx`. Stage 1 ships no CodeMirror.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns the visuals. Engineering wires the File card in T-APP-15.

## Scope

In:
- Revert the CodeMirror half of 4a36b0cfb. Stage 1 needs read-only code with hover and definition, which `packages/smithers/ui/src/adapters/code-view/CodeFileView.tsx` already renders through `cards/CodeSurface.tsx`.
- Fold `views/DiffView.tsx` into `cards/DiffSurface.tsx`. DiffSurface already takes the server patch through `gitPatch` (`DiffSurface.tsx:21`); DiffView's client-side `unifiedPatch` serializer goes. Keep its additions as DiffSurface props: the against line (item base, fork revision or one burst), binary sizes as one muted line, and Restore this file on a burst diff as a supplied action.
- The File card's binary and too-large contents render as one muted line, "Binary file · 1.2 MB" or "Too large to show · 4.1 MB", plus "on GitHub ↗", in `CodeSurface.tsx`.
- CodeMirror returns at T-APP-14 (S3) by restoring from 4a36b0cfb.

Out:
- File writes, live binding, save recovery and presence (S3, T-APP-14, T-UI-19); language-server execution and Restore mutation (T-APP-15, T-APP-11). `@pierre/diffs` stays the only diff engine (§7.6).

## Changes

- Delete from 4a36b0cfb: `packages/smithers/ui/src/adapters/code-editor/index.tsx` (147 lines) and its `./adapters/code-editor` export, `packages/smithers/ui/tests/code-editor.test.tsx`, its section in `packages/smithers/ui/docs/concepts/adapters.md`, `apps/app/src/mainview/cards/views/CodeEditorView.tsx` and `CodeEditorView.stories.tsx`, and `views/Editor.ts` (its only importer is `CodeEditorView.tsx`; verified).
- Remove the ten `@codemirror/*` pins, `y-codemirror.next` and `yjs` from `packages/smithers/ui/package.json` (no `@smthrs/ui` source imports `yjs`; verified) and update `pnpm-lock.yaml`.
- Delete the 20 five-language screenshots under `apps/app/e2e/playwright/view-stories.spec.ts-snapshots/` and their cases in `view-stories.spec.ts`.
- Move `DiffView`'s against line, binary line and Restore into `cards/DiffSurface.tsx`; delete `views/DiffView.tsx`, `DiffView.stories.tsx` and `DiffAction.tsx`. Keep the `unsafeCSS` option in `pierre-diff-view.tsx` only if DiffSurface uses it; otherwise revert it. Byte sizes use the existing `formatBytes` (`views/formatBytes.ts`); `CodeEditorView`'s second formatter, `fileSize`, goes with it.
- Merge the remaining rules of `apps/app/src/mainview/styles/views/code.css` into `styles/cards.css`; drop the `.code-editor` and `.cm-*` rules; delete the file and its import in `styles/views.css`.
- Pair (v1 §2): File ↔ `FileCards.tsx` + `CodeSurface.tsx`, Diff ↔ `ChangeCards.tsx` + `DiffSurface.tsx`. Both stay; nothing new is mounted.

## Tests

`apps/app/src/mainview/cards/views/Views.test.tsx` loses the editor cases. The DiffSurface tests cover:
- a server patch for a modified, added, deleted and renamed file renders through the Pierre adapter with its line numbers;
- each against base renders its literal line; a binary diff renders the literal sizes and no text view;
- Restore renders only on a burst diff and dispatches its supplied action once.
The FileCards tests cover the literal binary and too-large lines with the supplied GitHub link, and hover and definition from the keyboard with `{path, line, col}`.

## Acceptance

- The tests above pass in CI at the landed SHA.
- `git grep -E "@codemirror|y-codemirror|adapters/code-editor|CodeEditorView|views/DiffView"` over `apps/` and `packages/` returns nothing.

## Risks and notes

- T-APP-15 must keep the File card on `CodeSurface.tsx`; its CodeMirror swap moves to T-APP-14.
