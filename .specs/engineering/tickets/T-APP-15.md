# T-APP-15 File card with code intelligence (read-only)

Stage S1 · Size S · Depends on T-INS-02, T-CAT-01, T-INS-06, T-SEC-01 · Unblocks T-APP-02, T-APP-05, T-APP-11, T-APP-14a, T-APP-17, T-FLW-05, T-REL-02, T-UI-16 · Issue: [#3461](https://github.com/smithersai/smithers/issues/3461)
Spec: spec.md §7.6, §14.3 (File) · Delta: delta.md §4, §9 · Product: mvp.md §8 (code intelligence in file cards: Keep), §1.4, J1.5, J9
Ready: 2026-10-05 smithers-8a sha256:0ccc4157ae11

## Goal
The S1 File card keeps today's renderer and code intelligence, and answers before Machine ready. Today's renderer is the read-only CodeMirror `CodeEditorView` that T-APP-14a restored in 6451c97b2 (#3628), with its live-document client dark; this ticket keeps it as landed (8a re-ruling, 2026-10-05, option A).

## Scope
In:
- The card file stays `apps/app/src/mainview/cards/FileCards.tsx`, rendering `cards/views/CodeEditorView.tsx` read-only as landed in 6451c97b2. Port `CodeSurface.test.tsx` to `CodeEditorView` (it is the gesture test), then delete any CSS or adapter left with no importer.
- Code intelligence as landed: hover runs `code.hover` and ⌘/Ctrl-click runs `code.definition` with `{path, line, col}` (6451c97b2 deleted `CodeSurface.tsx`, which carried these gestures, and on main only tests still name them; wire them on `CodeEditorView`); another file's definition dispatches `files.read` through `cardActions` → `flowAction`; a same-file definition reveals the line; `code.diagnostics` dispatches the path and repository without a position.
- Landing dark: build against the specified T-INS-02 launcher, T-CAT-01 catalog, T-INS-06 Source-ready mirror and T-SEC-01 guest-boundary contracts. Until each unavailable dependency passes its checks, expose no dependent action: refuse reads without authenticated repository authority or a ready mirror, and bind no LSP gestures without isolated execution and validated guest boundaries. Never wake a machine or use a host fallback to satisfy a read. Prove these cases in the route and file-intelligence tests below.
- The read-only `GET /api/branches/{b}/files/{path}` content route (§6.3), including `main:.smithers/machine.json`, served from mirrored data without waking a machine or executing repository code. The existing `/workspaces/{id}/files/content` (`router.go:1441`) needs a live workspace, so it cannot serve before Machine ready. Declare it in `docs/api/openapi/branches.yaml` (new) and regenerate the existing client.

Out:
- Editing, `EditorBinding` activation and live documents (T-APP-14, S3). T-APP-15 does not revert T-APP-14a's CodeMirror restore or its pins; the live-document client stays dark. It folds `DiffView` into `DiffSurface` if that fold isn't already on main.
- New diff behavior, which stays on `@pierre/diffs` (`DiffSurface.tsx`); only the existing DiffView fold is included. Also exclude project-wide refactoring, browser extensions and debugging, new language servers, S2 daemon migration and live file states (T-APP-11), and S3 document protocols (T-APP-14).
- Host or browser language-server processes, repository plugin execution outside a machine, automatic machine wake from a read. The existing S1 workspace LSP tunnel stays; T-APP-11 moves it to the daemon in S2.

## Changes
- Reshape existing route/authentication and mirrored-file read plumbing in `packages/backend/internal/routes/` and `packages/backend/internal/compose/router.go` for the branch file-content route. The workspace-content route cannot be reused as the data source because it needs a live workspace. Add only the missing branch-route adapter; do not build a second file store, renderer, LSP client or dispatcher.
- `apps/app/src/mainview/cards/FileCards.tsx`: read file content from the branch route when no workspace is ready. No new Container, no seam module.

## Tests
Folded from C-UI-11 (kept capabilities). Fixture repository, TypeScript: `src/a.ts` declares `export function add(x: number, y: number): number` on line 3; `src/b.ts` calls `add(1, "2")` on line 5.
- Integration (`apps/app/e2e/real/file-intelligence.spec.ts`, new, reference host, TODO T1 Working so its branch is awake): Ben opens `src/b.ts` on T1's branch. Hover on `add` (line 5) shows `add(x: number, y: number): number` within 3 s; the first request may start the language server, and its time is recorded. Go to definition opens `src/a.ts` with the cursor on line 3. Diagnostics mark exactly one error on line 5 naming the argument type mismatch. All steps complete with the keyboard alone.
- Same spec: the gestures pass through `cardActions` → `flowAction` and the registered `code.hover`/`code.definition` dispatcher to the workspace LSP tunnel; the flow log records each request. Expected signature, target and diagnostic values are literals.
- Same spec, webpage reader: `/browser.open` on a static `page.html` titled "Reader canary" shows a reader card with that title and the paragraph "Reader canary body".
- Security: a fixture language-server plugin that attempts a file write runs only inside the branch machine, with no host or browser process or write. With the LSP capability unavailable, no gesture binds and no host fallback starts.
- Integration (`packages/backend/internal/compose/branch_files_integration_test.go`, new, real PostgreSQL): issue authenticated HTTP GETs through the production install router at `/api/branches/{b}/files/{path}`. Resolve `main:.smithers/machine.json` as branch `main` and path `.smithers/machine.json`. Compare both responses to committed literal fixture bytes; an absent path returns 404. Assert unchanged machine count and runtime admission queue count. Unauthenticated, foreign-repository and traversal requests return no file bytes. With the mirror or authority provider unavailable, reads fail closed; with isolated LSP execution or T-SEC-01 validation unavailable, the real-host spec binds no gesture and starts no process.
- All expected bytes, signatures, targets, diagnostics, reader text and refusal cases are committed literals. Tests never read spec Markdown or derive expected values from production code at runtime. C-J1-03 uses its production composer and app-agent dispatch with a held image build; file content comes from the mirror, not a working copy.
- Release build: rerun the spec after S2 lands. Stage 2 moves the language server to the daemon (T-APP-11); a capability the S1 build had must not be lost.

## Acceptance
- [C-COL-01](../checks/C-COL-01.md): passes for this ticket’s phase at its stated layer.
- [C-UI-11](../checks/C-UI-11.md): passes for this ticket’s phase at its stated layer.
- [C-UI-13](../checks/C-UI-13.md): passes for this ticket’s phase at its stated layer.
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.
- [C-J1-03](../checks/C-J1-03.md): a question is answered with File cards before Machine ready.

## Risks and notes
- Risk: S2 replaces the workspace session path (`CloudLspClient`, `workspace/sessions` kind `lsp`) with daemon sessions. The release-build rerun above is the gate.
- Security: language servers and repository plugins execute only as an unprivileged user inside machines (§1.3, M-29), with no sudo; snapshot reads treat files as data. smithers-3f reviews route authorization, path confinement and tunnel confinement. No root step is added by this ticket. Any reused guest setup, command or relay root step consumes the complete R1–R3 input inventory in T-SEC-01: bundle/main helper bytes, digest, interpreter and install paths; install-controlled executable, image, account, machine and transport state; branch/member-derived retained filesystem, cache, env.json, request argv/env/cwd/path/content and stream bytes. T-SEC-01's `TestGuestHelperInstallPinsInterpreterAndEnv`, `TestRootSetupNeverFollowsMemberSymlinks` and `TestRootPreflightParsesOnlyEnvelope` must prove validation before privileged use. Branch-built root executables remain forbidden. Keep LSP execution dark until these checks pass.
- Decisions: smithers-b8 accepts the app dispatch and public HTTP/client contract; smithers-3f accepts the mirror-read, authorization and execution seams; smithers-38 signs off any shared TypeScript adapter or public library API changes under §21.1; smithers-06 accepts renderer, keyboard and DiffView-fold decisions. No new ADR is in scope. Existing owner answers stand; the parallel-build directive allows owner review post hoc.

## Ready checklist
1. Dependencies name launcher isolation, catalog dispatch, Source-ready mirroring and guest-root validation; Scope states dark, fail-closed landing against unavailable contracts. All dependencies are S1.
2. Out explicitly excludes editing, new diff behavior, IDE features, new language servers, host execution, automatic wake, S2 migration and S3 documents; reuse and the existing adapter cleanup remain in scope.
3. Named real-host tests exercise registered dispatch and the production composer; the Go integration exercises the mounted HTTP route with real PostgreSQL. Committed literal expectations never come from spec files or production code.
4. smithers-b8 decides app/public HTTP contracts, smithers-3f backend/security seams, smithers-38 shared library APIs and smithers-06 visual/keyboard behavior; no ADR decision is delegated to the implementer.
5. Owner pre-review (post hoc under the parallel-build directive; recorded answers stand): smithers-b8: Does every gesture reach the catalog dispatcher? Does the branch route/client contract work before Machine ready? smithers-3f: Are mirror authorization and path confinement enforced? Is LSP unavailable until isolated, validated guest execution is available? smithers-38: Does the adapter cleanup retain the shared code-view API without a second implementation? smithers-06: Does the retained renderer preserve keyboard hover/definition and reveal? Does folding DiffView preserve the existing diff presentation?
6. M-29 confines repository/plugin execution to unprivileged machines. smithers-3f reviews the reused root steps and T-SEC-01 R1–R3 inventory and validation tests; branch inputs block privileged use until validated, and branch-built root code is forbidden.
