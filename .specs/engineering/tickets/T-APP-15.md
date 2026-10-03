# T-APP-15 File card with code intelligence (read-only)

Stage S1 · Size S · Depends on T-INS-02, T-CAT-01 · Unblocks T-APP-02, T-APP-05, T-APP-11, T-REL-02 · Issue: [#3461](https://github.com/smithersai/smithers/issues/3461)
Spec: spec.md §7.6, §14.3 (File) · Delta: delta.md §4, §9 · Product: mvp.md §8 (code intelligence in file cards: Keep), §1.4, J1.5, J9

## Goal
The S1 File card keeps today's renderer and code intelligence, and answers before Machine ready. CodeMirror 6 leaves S1: the swap moves to T-APP-14 (S3), its first real user, which restores the CodeMirror adapter from 4a36b0cfb then.

## Scope
In:
- The card file stays `apps/app/src/mainview/cards/FileCards.tsx` with `cards/CodeSurface.tsx`, rendering `@smthrs/ui` `adapters/code-view/CodeFileView.tsx` (Shiki). The code-view adapter stays.
- Code intelligence as landed: hover runs `code.hover` and ⌘/Ctrl-click runs `code.definition` with `{path, line, col}` (`CodeSurface.tsx:95-97`); another file's definition dispatches `files.read` through `cardActions` → `flowAction`; a same-file definition reveals the line; `code.diagnostics` dispatches the path and repository without a position.
- The read-only `GET /api/branches/{b}/files/{path}` content route (§6.3), including `main:.smithers/machine.json`, served from mirrored data without waking a machine or executing repository code. The existing `/workspaces/{id}/files/content` (`router.go:1441`) needs a live workspace, so it cannot serve before Machine ready. Declare it in `docs/api/openapi/branches.yaml` and regenerate the client.

Out:
- CodeMirror 6, `EditorBinding` and editing (T-APP-14, S3). T-UI-11 reverts the CodeMirror adapter, `CodeEditorView` and the `@codemirror/*`, `yjs` and `y-codemirror.next` pins, and folds `DiffView` into `DiffSurface`.
- Diffs, which stay on `@pierre/diffs` (`DiffSurface.tsx`).
- Host or browser language-server processes, repository plugin execution outside a machine, automatic machine wake from a read. The existing S1 workspace LSP tunnel stays; T-APP-11 moves it to the daemon in S2.

## Changes
- `packages/backend/internal/routes/` and `internal/compose/router.go`: the branch file-content route above.
- `apps/app/src/mainview/cards/FileCards.tsx`: read file content from the branch route when no workspace is ready. No new Container, no seam module.

## Tests
Folded from C-UI-11 (kept capabilities). Fixture repository, TypeScript: `src/a.ts` declares `export function add(x: number, y: number): number` on line 3; `src/b.ts` calls `add(1, "2")` on line 5.
- Integration (`apps/app/e2e/real/file-intelligence.spec.ts`, reference host, TODO T1 Working so its branch is awake): Ben opens `src/b.ts` on T1's branch. Hover on `add` (line 5) shows `add(x: number, y: number): number` within 3 s; the first request may start the language server, and its time is recorded. Go to definition opens `src/a.ts` with the cursor on line 3. Diagnostics mark exactly one error on line 5 naming the argument type mismatch. All steps complete with the keyboard alone.
- Same spec: the gestures pass through `cardActions` → `flowAction` and the registered `code.hover`/`code.definition` dispatcher to the workspace LSP tunnel; the flow log records each request. Expected signature, target and diagnostic values are literals.
- Same spec, webpage reader: `/browser.open` on a static `page.html` titled "Reader canary" shows a reader card with that title and the paragraph "Reader canary body".
- Security: a fixture language-server plugin that attempts a file write runs only inside the branch machine, with no host or browser process or write. With the LSP capability unavailable, no gesture binds and no host fallback starts.
- Integration (Go, real PostgreSQL): the branch route returns literal bytes for `src/a.ts` and `main:.smithers/machine.json` with no `machine_requests` row; an absent path returns 404.
- Release build: rerun the spec after S2 lands. Stage 2 moves the language server to the daemon (T-APP-11); a capability the S1 build had must not be lost.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.
- [C-J1-03](../checks/C-J1-03.md): a question is answered with File cards before Machine ready.

## Risks and notes
- Risk: S2 replaces the workspace session path (`CloudLspClient`, `workspace/sessions` kind `lsp`) with daemon sessions. The release-build rerun above is the gate.
- Security: language servers and repository plugins execute only inside machines (§1.3, M-29); snapshot reads treat files as data. smithers-3f reviews the branch route and tunnel confinement before start.
