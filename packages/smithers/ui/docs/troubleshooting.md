---
title: "Troubleshooting"
description: "Symptoms this package produces, the cause behind each one, and the change that fixes it: unstyled output, duplicated sheets, an unexpectedly large bundle, silent Radix portals, and refused inputs."
---

Each entry names a symptom you can observe, the cause in the source, and the
fix.

## Everything renders unstyled

**Symptom.** Components appear with no colors, spacing, or borders. The DOM
carries `sui-*` class names, but nothing matches them.

**Cause.** No stylesheet reached the document. Two situations produce it: the
page was server-rendered without `<SmithersUiStyles />`, so the browser
injection fallback never ran; or the host imported a `.css` file expecting one
to exist.

**Fix.** Render `<SmithersUiStyles />` once at the root. There is no CSS file to
import: the sheet is a JavaScript string, because the bundler the Smithers
applications are built with drops CSS artifacts. See
[How styling ships](./concepts/styling.md).

## Colors are wrong, or dark mode shows the light palette

**Symptom.** Components render with structure but the wrong palette, or a
standalone page looks correct in light mode and wrong in dark.

**Cause.** The theme token block is missing, so every `var(--token, fallback)`
expression resolves to its light fallback in both modes.

**Fix.** Pass `withTheme` to add the token block:

```tsx
<SmithersUiStyles withTheme />
```

Leave `withTheme` off only where the host page already inlines the theme, as the
Smithers gateway does.

## Two copies of the stylesheet in `<head>`

**Symptom.** The document contains two `style[data-smithers-ui]` elements.

**Cause.** `SmithersUiStyles` was rendered more than once. It cannot dedupe
itself: it has to work under `renderToStaticMarkup`, where there is no document
to check, so the marker attribute only tells the injection fallback to stand
down. It is not a mutual guard between the two paths.

**Fix.** Render the element exactly once per document, above your routes rather
than inside them.

## The bundle grew by megabytes

**Symptom.** An application's bundle jumped after a change that added no
obvious dependency.

**Cause.** Something reached an adapter. The two pierre surfaces carry Shiki's
grammars and themes and bundle at roughly 10 MB against the base barrel's 500
KB.

**Fix.** Import an adapter only from the module that renders it, and load that
module lazily. Find the offending import in your bundler's production output:
the adapter's dependency belongs to a lazily loaded chunk, not to the entry
chunk. Importing `@smthrs/ui` itself never pulls one in. See
[The adapters boundary](./concepts/adapters.md).

## An import from `@smthrs/ui` does not resolve

**Symptom.** `Terminal`, `ChartContainer`, `CodeFileView`, `PierreDiffView`,
`MarkdownEditor`, or `KnowledgeGraph` is not exported from `@smthrs/ui`.

**Cause.** That is the boundary working. None of the six is on the base barrel.

**Fix.** Import from the adapter's own subpath. The mapping is in
[Installation](./installation.md).

## An import of the unscoped package throws

**Symptom.** The module throws at import time with a deprecation message.

**Cause.** The unscoped `smthrs` package publishes only a deprecation notice.

**Fix.** Import the scoped `@smthrs/ui` specifier.

## A Radix dialog, tooltip, or select renders nothing in tests

**Symptom.** Portal content never appears under `bun test`, even though the
trigger works.

**Cause.** Radix resolves its server-safe `useLayoutEffect` shim at module load
time. With no `globalThis.document` at that moment, every Radix layout effect is
a no-op for the rest of the process. ESM imports hoist above an in-file
registration call, so registering happy-dom inside a test file is too late.

**Fix.** Register happy-dom in a preload:

```toml
[test]
preload = ["./tests/happy-dom-preload.ts"]
```

See [Test a component](./guides/test-a-component.md).

## A test passes alone and fails in the suite

**Symptom.** A rendering assertion behaves differently under `bun test tests`
than when the file runs on its own.

**Cause.** Usually shared document state. Every component injects the
stylesheet into `document.head` on mount, and the document lives for the whole
process, so an earlier test's injection changes whether a later test's injector
runs. The same applies to `data-theme` and `data-palette` attributes on
`<html>`.

**Fix.** Remove `style[data-smithers-ui]` and reset the root attributes in
`afterEach`.

A second cause applies if you bundle inside a test. Bun's bundler shares its
file cache with the test runner's module registry, so an in-process `Bun.build`
running after another suite imported the same modules reads crossed content and
drops modules it cannot parse. Bundle in a fresh subprocess instead.

## A copy button never enters its copied state

**Symptom.** Clicking copy on `CodeBlock`, `Snippet`, or `SecretField` does
nothing visible.

**Cause.** One of two failure codes. `clipboard-unavailable` means no `onCopy`
was supplied and the host has no `navigator.clipboard.writeText`, which is the
case outside a secure context. `clipboard-write-failed` means the write was
attempted and rejected.

**Fix.** Serve over HTTPS or `localhost`, or supply your own `onCopy`. The
copied state is set only after the write fulfills, so a control that says
"Copied" copied something. See
[Failure codes and limits](./reference/contracts.md).

## `PromptInput` silently refuses a file

**Symptom.** A dropped or pasted file does not appear in the attachment strip.

**Cause.** It hit one of five admission checks: `disabled`, `multiple`,
`max-files`, `max-file-size`, or `accept`. Every intake path passes through one
admission point, so the refusal is consistent, but it is reported through
`onError` rather than rendered.

**Fix.** Handle `onError` and surface `error.message`, which is
user-presentable prose.

## An attachment preview is broken after submit

**Symptom.** A stored `url` or `thumbnailUrl` no longer loads.

**Cause.** The component minted that blob URL, and it revokes the URLs it
created once the submit settles.

**Fix.** Copy from the attachment's `file`, which the component does not own.
For a preview that must outlive the prompt, call `URL.createObjectURL` on that
`File` and revoke your own URL. See
[Collect a prompt with attachments](./guides/collect-a-prompt.md).

## The markdown editor shows a plain textarea

**Symptom.** `MarkdownEditor` renders a textarea instead of the rich surface.

**Cause.** Read `data-mode` on the rendered element. `"fallback"` means the
caller passed `fallback` or the host failed the rich-text capability probe.
`"failed"` means the editor tried to start and could not, reporting
`editor-load-failed` or `editor-create-failed` through `onError`.

**Fix.** For `"failed"`, inspect `error.cause`: with the default `loadEditor`
seam, `editor-load-failed` is the dynamic import rejecting. The document is not
lost either way, because the textarea carries the current markdown.

## An unknown status renders as a neutral pill

**Symptom.** A status you expected to be tinted appears muted.

**Cause.** `statusClass` returns `"muted"` both for a deliberately neutral
status and for one the vocabulary does not know.

**Fix.** Call `hasStatusTone` to tell the two apart, and add the spelling to the
vocabulary rather than special-casing it in your component. See
[Render a run status](./guides/render-run-status.md).

## A terminal renders with no colors or a broken layout

**Symptom.** The xterm surface appears unstyled or misaligned.

**Cause.** The xterm base stylesheet did not load. A bare
`import "@xterm/xterm/css/xterm.css"` is dropped by a bundler configured to
discard CSS artifacts.

**Fix.** Remove that import. The adapter vendors the sheet as a string and
injects it through the library's own style seam.

## A diff renders as plain text

**Symptom.** `PierreDiffView` shows the patch verbatim instead of highlighting
it.

**Cause.** The patch did not parse. `@pierre/diffs` names a file from a
`diff --git` line; without one it reads the `---` and `+++` labels as a rename.

**Fix.** Check with `patchToCodeViewItems` before rendering, and prepend a
`diff --git a/<old> b/<new>` line built from the paths you already hold. See
[Use a heavy renderer](./guides/use-a-heavy-renderer.md).

## Related

- [Failure codes and limits](./reference/contracts.md): every code and bound.
- [API reference](./api.md): every public export.
