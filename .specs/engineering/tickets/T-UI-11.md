# T-UI-11 Code editor and Diff views (read-only)

Stage S1 · Size L · Depends on T-UI-01, T-APP-19b · Unblocks T-APP-15, T-REL-02 · Issue: [#3548](https://github.com/smithersai/smithers/issues/3548)
Spec: spec.md §14.2.1, §7.6, §14.3 (File, Diff) · Delta: delta.md §9 · Product: mvp.md J1.5, J9, M-02 · Props: [ui-components.md § T-UI-11](../ui-components.md)

## Goal

`CodeEditorView` (read-only) and `DiffView` exist as props-only Views matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-15 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- T-APP-19b supplies File content kinds text/too_large/binary, digest, mode, hover, reveal and github_url, plus Diff against, burst, change and binary fields. Name the new editor export @smthrs/ui/adapters/code-editor. Record exact direct @codemirror/* pins and the compatible y-codemirror.next pin with smithers-38 before Ready; the compatibility gate covers T-APP-14's later binding. Check: C-UI-08, C-UI-12.
- Render binary and too-large content as one muted line: "Binary file · 1.2 MB" or "Too large to show · 4.1 MB" for the corresponding fixtures, plus "on GitHub ↗". Use supplied byte sizes and GitHub URLs. Provide keyboard equivalents for the CodeMirror Ctrl-hover tooltip and F12 definition gesture; opening either preserves the text cursor. Check: C-UI-12.
- `CodeEditorView` in `@smthrs/ui` (CodeMirror 6, Paper theme, hover and diagnostics visuals) in read-only mode: text, too-large and binary contents, the hover result, `reveal`, the `hover` and `definition` gestures with `{path, line, col}`, the cursor line through `onView`, and a changed text applied as one minimal transaction with no remount. `DiffView` with hunks and line numbers against an item base, a fork revision or one burst, with Restore this file on a burst diff.
- Props exactly as `ui-components.md` § T-UI-11 with the zod type reconciled by T-APP-19b from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- No second diff engine, live document binding, repository execution or app-local editor schema. No declaration of Ready while the exact editor pins or y-codemirror.next compatibility review is missing. Check: C-UI-08, C-UI-12.
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).
- File writes, live document binding, save acknowledgements and recovery (S3, T-UI-19); presence and deleted/renamed live states (T-UI-16); language-server startup and execution, file fetching and Restore mutation (engineering wiring). Diffs retain `@pierre/diffs` (§7.6); this ticket does not replace the diff engine.

## Changes

- Reuse PierreDiffView from @smthrs/ui/adapters/pierre-diff-view. Serialize supplied hunks into a unified patch: file headers for old/new paths, /dev/null for added/deleted sides, and @@ ranges whose counts equal context plus removed/added lines respectively. Preserve line op and text. Binary diffs render supplied sizes without a text editor. Name the CodeEditorView source packages/smithers/ui/src/adapters/code-editor/index.tsx and its package export. Pin direct editor dependencies without ranges; smithers-38 records the exact CodeMirror and y-codemirror.next versions before Ready under §21.1. Check: C-UI-12.

- Render binary and too-large content as one muted line: "Binary file · 1.2 MB" or "Too large to show · 4.1 MB" for the corresponding fixtures, plus "on GitHub ↗". Use supplied byte sizes and GitHub URLs. Provide keyboard equivalents for the CodeMirror Ctrl-hover tooltip and F12 definition gesture; opening either preserves the text cursor. Check: C-UI-12.

- Paper highlight theme, hover tooltip, diagnostics, definition keymap and `@codemirror/*` pins; update `@smthrs/ui` docs. Check: C-UI-12.


- New File and Diff wrappers in `apps/app/src/mainview/cards/views/`; new shared `CodeEditorView` under `packages/smithers/ui/src/`, with a per-module export agreed by smithers-38. Add CSS and retain the existing Pierre diff adapter. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- Fixtures from `@smthrs/rpc/fixtures/File` and `@smthrs/rpc/fixtures/Diff` (`packages/rpc/test/fixtures/`, reconciled with T-APP-19b).

## Tests

- Compare committed literal unified patches for modified, added, deleted and renamed files, including zero-length ranges and multiple hunks; render them through the production Pierre adapter and assert line numbers. Cover binary sizes, all against bases, File github_url, digest/mode, hover and reveal. C-UI-12 checks editor identity and hostile content; record exact dependency pins and shared export approval in criterion 4 before Ready.

- Assert the literal binary and too-large lines, muted treatment and supplied GitHub link. Open hover and definition from the keyboard and assert exact supplied gesture tags and coordinates once, with the text cursor unchanged. Retain read-only and diff coverage (States s25–30). Check: C-UI-12.

- C-UI-12: committed TypeScript, JavaScript, Go, Rust and Python fixtures render through the production CodeEditorView in Chromium. Compare committed screenshots approved by smithers-06. On the reference host, time mount to the first painted viewport for a committed 1 MiB UTF-8 fixture; log browser version, hardware and elapsed time, which must be under 300 ms. No language server runs in this fixture test.


- unit (C-UI-12): every fixture of the card renders with its actions and shows its `expect` strings, in light and dark at 1280 and 390 px; each press calls `onAction` or `onView` once. The View-seam rule passes on the View's file (C-UI-08).
- copy: use committed literal expected strings for these Views under C-UI-12. C-UI-02 is a downstream T-CAT-01 audit, not a prerequisite for landing these Views. No test reads `.specs/` or derives expected strings, tags, payloads or tone tokens from production code at runtime.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19b's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- smithers-06 approves visual and copy conformance and five-language screenshot baselines; Will decides product changes. Tech lead smithers-8a accepts schema or seam changes with smithers-b8 and smithers-38 before implementation; raise §14.3 and ui-components.md gaps through T-APP-19b; UI lanes never raise piecemeal schema changes. smithers-38 signs off the shared editor API, subpath and CodeMirror pins.

## Ready checklist

T-UI-02 through T-UI-14 go Ready together after T-APP-19b lands with smithers-38's §21.1 review. Local props permit drafting only. This UI lane makes no piecemeal schema change. Check: C-UI-08.

1. Dependencies: T-UI-01 supplies primitives; T-APP-19b supplies landed FileCard and DiffCard schemas and committed File/Diff fixtures. No backend, language server or document service is needed to land the read-only Views.
2. Exclusions: Scope excludes writes, live binding, save recovery, presence, later live file states, backend reads, language-server execution and Restore mutation; Pierre remains the diff engine.
3. Tests: C-UI-12 mounts the production CodeEditorView and DiffView in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (both new). Literal assertions cover text, too-large and binary states; diagnostics; reveal; hover/definition payloads with 1-based lines and UTF-16 columns; unchanged editor identity, scroll and cursor after a minimal text transaction; diff line numbers and all three bases; absent Restore on non-burst diffs; omitted gestures; read-only input; keyboard access. Expected results are committed independently of spec files and production code. T-APP-15 owns real File-card routing and C-UI-11; T-APP-11 owns later Restore dispatch.
4. Decisions: smithers-06 approves visual/copy and language baselines, Will decides product changes, smithers-8a accepts seam changes, and smithers-38 approves the shared API and pins with smithers-b8 reviewing app integration. Editor export: `@smthrs/ui/adapters/code-editor`. Exact direct CodeMirror pins: `@codemirror/autocomplete` 6.20.3, `@codemirror/commands` 6.11.0, `@codemirror/lang-go` 6.0.1, `@codemirror/lang-javascript` 6.2.5, `@codemirror/lang-python` 6.2.1, `@codemirror/lang-rust` 6.0.2, `@codemirror/language` 6.12.4, `@codemirror/lint` 6.9.7, `@codemirror/state` 6.7.2, `@codemirror/view` 6.43.11. Before Ready, smithers-38 records the exact compatible `y-codemirror.next` pin for T-APP-14's binding and signs the pin set under §21.1. C-UI-12 records the manifest pins and editor identity/compatibility evidence.
5. Pre-review before start: smithers-06: answered 18:10 with these changes (mock 21b445a6) smithers-b8: answered 18:2x, ok; smithers-38: answered, BLOCKING edits applied (tech lead adopts).
6. Security: Code, diff text, diagnostics and hover Markdown are untrusted data, never executable content. C-UI-12 includes hostile text/Markdown fixtures and proves they cannot execute scripts or dispatch commands. Views start no language server or repository process; M-29 requires those processes in machines. smithers-b8 and smithers-38 review rendering safety; smithers-3f reviews machine-only language-server execution in T-APP-15/T-APP-11. C-UI-08 enforces the View seam.

