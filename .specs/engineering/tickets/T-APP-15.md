# T-APP-15 File card on CodeMirror 6 with code intelligence (read-only)

Stage S1 · Size M · Depends on T-COL-10, T-UI-11, T-APP-19 · Unblocks T-APP-11, T-APP-14a, T-REL-02 · Issue: [#3461](https://github.com/smithersai/smithers/issues/3461)
Spec: spec.md §7.6, §14.3 (File) · Delta: delta.md §4, §9 · Product: mvp.md §6.8 Live co-editing, J1.5, J9, M-02

## Goal
The File card renders code with CodeMirror 6, the editor that stage 3 binds Yjs to, while keeping today's code intelligence and look.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `CodeEditorView` (CodeMirror 6 surface, Paper theme, hover and diagnostics visuals), with the CSS, in T-UI-11. This ticket builds no View, CSS or editor presentation. It owns the File Container, its code-intelligence gestures and the editor seam module ([card-kinds.md §1](../card-kinds.md)). The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope
In:
- The File card renders T-UI-11's read-only `CodeEditorView` in place of the read-only Pierre file view.
- Code intelligence keeps working: the View raises `gestures.hover` and `gestures.definition` with `{path, line, col}` (1-based line, col in UTF-16 units); the Container runs today's `code.hover` and `code.definition` flows and answers through the model's `hover`, and definition opens the target's File card or sets `reveal` for a target in the same file; `code.diagnostics` fills the model's `diagnostics` (ui-components.md § T-UI-11).

Out:
- The editor surface, its theme and its highlighting (T-UI-11).
- Editing (stage 3, T-APP-14); reload on outside change and gone states (stage 2, T-APP-11); name flags (stage 3).
- Diffs, which stay on `@pierre/diffs` (`DiffSurface.tsx`, `pierre-diff-view.tsx`; the `DiffView` is T-UI-11's).

## Changes

- `packages/smithers/ui/src/adapters/code-editor/seam.ts` (new, design reviews): `EditorBinding {extensions}` and `authorRanges` (T-UI-19). Design owns the read-only surface and visual extensions (T-UI-11). Check: C-UI-11.

- `apps/app/src/mainview/cards/containers/FileContainer.tsx` (new; T-APP-11 and T-APP-14 extend it): the `FileCard` model (path, branch, language, digest, content as text, too large or binary, mode, last writer, diagnostics, hover, reveal) for `CodeEditorView`; builds `gestures.hover` and `gestures.definition` through `cardActions` and answers them; converts `{line, col}` to the language server's `CodeTokenPosition` at this boundary, never in the flows.
- `packages/smithers/ui/src/adapters/code-editor/seam.ts` (new; design reviews it): the `EditorBinding` type and the `authorRanges` facet of ui-components.md § T-UI-19, with no visual code. T-APP-14 fills them.
- `apps/app/src/mainview/cards/CodeSurface.tsx`: mounts the FileContainer and stops rendering `CodeFileView` (`@smthrs/ui/adapters/code-view`).
- `packages/smithers/ui/src/adapters/code-view/`: delete once no consumer remains (`rg "adapters/code-view"`). Keep `@pierre/diffs` for diffs only.

## Tests
- Unit (`FileContainer.test.tsx`): a hover gesture `{path, line, col}` runs `code.hover` with the same arguments as today's flow and sets `hover`; a same-file definition sets `reveal` and another file's opens its File card; diagnostics fill the model; the position conversion round-trips for multi-byte UTF-8 (UTF-16 columns) and CRLF files.
- Unit, same file: the model's text equals the file content for UTF-8, CRLF and a 1 MiB file.
- Playwright (`apps/app/e2e/playwright/file-card.spec.ts`, new or existing): open a file card, hover, jump to definition, maximize, keyboard only.
- e2e: C-J1-03's answer still shows file cards with working code intelligence.
- Theme tokens, the five-language screenshot comparison and the 1 MiB first-viewport timing are T-UI-11's.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.



- [C-COL-01](../checks/C-COL-01.md): the File card renders with CodeMirror 6, and `adapters/code-view` has no consumer.
- [C-UI-11](../checks/C-UI-11.md): hover, definition and diagnostics work on an awake branch's File card, on the S1 build and again on the release build; the webpage reader card still works.
- [C-J1-03](../checks/C-J1-03.md): A question is answered with file cards before Machine ready
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- CodeMirror's Lezer highlighting may look different from today's Shiki output. The choice of highlighter is T-UI-11's (design).
- Risk: the LSP gesture payloads assume Pierre token positions (`CodeTokenPosition`). Confirmed by the hover unit test. Convert at the Container boundary, not in the flows.
- Risk: stage 2 replaces today's workspace session path (`CloudLspClient`, `workspace/sessions` kind `lsp`) with daemon sessions and per-member users (§9.1.2, §5.5). Confirmed if C-UI-11 passes on the S1 build and fails on the release build. T-APP-11 moves the language server onto the daemon; C-UI-11's release run is the gate.
