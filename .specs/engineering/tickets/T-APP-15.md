# T-APP-15 File card on CodeMirror 6 with code intelligence (read-only)

Stage S1 · Size L · Depends on T-COL-10, T-UI-11, T-APP-19 · Unblocks T-APP-11, T-APP-14 · Issue: [#3461](https://github.com/smithersai/smithers/issues/3461)
Spec: spec.md §7.6, §14.3 (File) · Delta: delta.md §4, §9 · Product: mvp.md §6.8 Live co-editing, J1.5, J9, M-02

## Goal
The File card renders code with CodeMirror 6, the editor that stage 3 binds Yjs to, while keeping today's code intelligence and look.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: the `CodeEditorView` component in `@smthrs/ui` (CodeMirror 6 surface, Paper theme, annotation and hover visuals). Engineering wires them: the code-intelligence gestures (`code.hover`, `code.definition`, `code.diagnostics`) and file data. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
In:
- Replace the File card's read-only Pierre file view with a read-only CodeMirror 6 view.
- Port hover, go-to-definition and diagnostics to CodeMirror extensions.
- Highlighting that matches the Paper palette in light and dark.

Out:
- Editing (stage 3, T-APP-14).
- Reload on outside change and gone states (stage 2, T-APP-11).
- Name flags (stage 3).
- Diffs, which stay on `@pierre/diffs` (`DiffSurface.tsx`, `pierre-diff-view.tsx`).

## Changes
- `packages/smithers/ui/src/adapters/code-editor/` (new): `CodeEditorView` over `@codemirror/view` and `@codemirror/state` (read-only in this ticket). Language from the file name, Paper-palette highlight theme, line annotations API equivalent to today's `CodeLineAnnotation`.
- `apps/app/src/mainview/cards/CodeSurface.tsx` → render `CodeEditorView` instead of `CodeFileView` (`@smthrs/ui/adapters/code-view`). Bind the `code.hover`, `code.definition` and `code.diagnostics` gestures through CodeMirror hover tooltips, a click/keymap handler and lint diagnostics, still raising the same flows (`flowGestureProps`) so the three-door law holds.
- `packages/smithers/ui/src/adapters/code-view/` → delete once no consumer remains (`rg "adapters/code-view"`). Keep `@pierre/diffs` for diffs only.
- `apps/app/package.json` / `packages/smithers/ui/package.json` → add `@codemirror/*` and pin versions. `y-codemirror.next` is added in T-APP-14, not here.
- Package docs for `@smthrs/ui` (colocated `docs/`) → document the new adapter; run `pnpm docs:sync` and `pnpm docs:check`.

## Tests
- Unit (`CodeSurface.test.tsx`): hover over a symbol raises `code.hover` with the same args as today. Definition and diagnostics likewise. The rendered text equals the file content for UTF-8, CRLF and a 1 MiB file.
- Unit: light and dark themes resolve palette tokens. No hard-coded colours (existing conformance lint).
- Playwright (`apps/app/e2e/playwright/file-card.spec.ts`, new or existing): open a file card, hover, jump to definition, maximize. Keyboard only.
- e2e: C-J1-03's answer still shows file cards with working code intelligence.
- Performance: a 1 MiB file renders its first viewport in under 300 ms on the reference host (logged, not gated).

## Acceptance
- [C-COL-01](../checks/C-COL-01.md): the File card renders with CodeMirror 6, and `adapters/code-view` has no consumer.

## Risks and notes
- Risk: CodeMirror's Lezer highlighting looks different from today's Shiki output. Confirmed by a screenshot diff on five languages. If it fails the design review, use a Shiki-backed CodeMirror highlighter; the decision belongs to the design agent.
- Risk: the LSP gesture payloads assume Pierre token positions (`CodeTokenPosition`). Confirmed by the hover unit test. Convert at the adapter boundary, not in the flows.
