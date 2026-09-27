---
title: "Use a heavy renderer"
description: "Pick the adapter subpath for a diff, a file, a terminal, a chart, a markdown editor, or a graph, wire its props, and keep its dependency out of your application's initial chunk."
---

Six renderers in this package carry a heavy third-party dependency, and each one
ships behind its own subpath so importing the base library never loads it. This
guide is how to reach one on purpose.

Before you do, check whether the light surface already covers the job: see the
table in [The adapters boundary](../concepts/adapters.md). Rendering markdown, a
plain diff, or fenced code needs no adapter at all.

## Load the module lazily

An adapter import is a chunk boundary. Put the adapter in a module of its own,
import that module lazily from the surface that needs it, and the dependency
stays out of your application's first paint. One module imports
`@smthrs/ui/adapters/pierre-diff-view`, and the card that renders a change
reaches it through `React.lazy`.

```tsx
import { lazy, Suspense } from "react"
import { Skeleton } from "@smthrs/ui"

const DiffSurface = lazy(() => import("./DiffSurface"))

export function ChangeCard({ patch }: { readonly patch: string }) {
  return (
    <Suspense fallback={<Skeleton />}>
      <DiffSurface patch={patch} />
    </Suspense>
  )
}
```

## Render a patch

`PierreDiffView` takes a unified patch string and renders it with per-token
syntax highlighting. `layout` chooses side by side (`"split"`, the default)
against a single unified column (`"inline"`), and `selectedPath` narrows a
multi-file patch to one file.

`patchToCodeViewItems` is the pure seam behind it, exported so you can ask
whether the patch parses before you commit to rendering it:

```tsx
import { patchToCodeViewItems, PierreDiffView } from "@smthrs/ui/adapters/pierre-diff-view"

function readable(patch: string): boolean {
  const items = patchToCodeViewItems(patch)
  return items.length > 0 && items.every((item) => item.type === "diff" && item.fileDiff.hunks.length > 0)
}

export default function DiffSurface({ patch }: { readonly patch: string }) {
  return readable(patch)
    ? <PierreDiffView layout="inline" patch={patch} />
    : <pre>{patch}</pre>
}
```

A patch the renderer cannot read falls back to the verbatim text, which is the
honest outcome: nothing is drawn that the source did not contain.

Theme and palette follow the document by default. Pass `mode` or `palette` only
when you are rendering into a surface that deliberately differs from the page.

## Render one file

`CodeFileView` highlights a whole file on the same engine. The grammar comes
from the file name's extension, and `languageForFile` tells you in advance when
no grammar claims it, so you can keep your own plain text instead:

```tsx
import { CodeFileView, languageForFile } from "@smthrs/ui/adapters/code-view"

export function FileSurface({ contents, line, name }: {
  readonly contents: string
  readonly line?: number
  readonly name: string
}) {
  return languageForFile(name) === null
    ? <pre>{contents}</pre>
    : <CodeFileView contents={contents} line={line} name={name} />
}
```

`line` is 1-based. Setting it marks that line and scrolls it into the middle of
the nearest scrolling ancestor; changing it moves the mark and scrolls again.
Until the highlighter has painted, the component renders a plain `<pre>`, so
there is no blank frame.

`CodeFileView` automatically starts the shared worker pool on first use. The
adapter supplies Bun and browser worker factories, with a 15-second
initialization deadline (`CODE_VIEW_POOL_DEADLINE_MS`). Highlighting falls back
to the main thread only when workers are unavailable or the pool fails,
including startup errors or a missed initialization deadline.

For embedded page teardown, call `disposeCodeViewPool` from
`@smthrs/ui/adapters/code-view` after unmounting its code views, while its DOM
still exists. This releases the shared pool so the next page can start a fresh
one.

## Attach a terminal

`Terminal` owns the emulator, the fit addon, theming, and resize. The data
source is entirely on props, so the component knows nothing about your
transport. Three seams cover a live session:

```tsx
import { Terminal } from "@smthrs/ui/adapters/terminal"

interface TerminalSession {
  readonly input: (data: string) => void
  readonly resize: (cols: number, rows: number) => void
  readonly attach: (sink: { readonly onOutput: (bytes: string) => void }) => () => void
}

export function SessionTerminal({ session }: { readonly session: TerminalSession }) {
  return (
    <Terminal
      onData={(data) => session.input(data)}
      onResize={({ cols, rows }) => session.resize(cols, rows)}
      stream={(write) => session.attach({ onOutput: write })}
    />
  )
}
```

`stream` is called once, right after the emulator opens, with a `write` function
that pushes bytes in. Return a teardown from it to unsubscribe on unmount.
`lines` writes a snapshot instead, for a recorded session with no live source.
`onReady` hands back the raw xterm.js instance when you need to load an addon or
read the buffer.

The xterm base stylesheet is vendored as a string and injected through the same
style seam the rest of the library uses. Never add
`import "@xterm/xterm/css/xterm.css"` yourself: a bundler configured to drop CSS
artifacts discards it silently.

## Draw a chart

`ChartContainer` is the shadcn chart contract over Recharts. Series colors come
from a fixed, contrast-validated palette in slot order:

```tsx
import { CHART_SERIES, chartConfig, chartSeriesColor } from "@smthrs/ui/adapters/chart"

const config = chartConfig([{ key: "passed", label: "Passed" }, { key: "failed", label: "Failed" }])
const firstSeriesLight: string = chartSeriesColor(0, "light")
const slots: number = CHART_SERIES.length // 8
```

Never reorder, cycle, or generate hues past the eight slots. An index past the
palette clamps to the last slot rather than wrapping, which is deliberate: fold
the tail into an "Other" series or facet the chart instead.

## Edit markdown

`MarkdownEditor` is the Milkdown Crepe WYSIWYG surface behind an injectable
`loadEditor` seam. `value` is the initial document, not a controlled value:
re-seeding on every keystroke would move the caret. Live edits arrive through
`onChange`.

Render `MarkdownEditorStyles` once to ship the Crepe theme:

```tsx
import { MarkdownEditor, MarkdownEditorStyles } from "@smthrs/ui/adapters/markdown-editor"

export function NoteEditor({ initial, onChange }: {
  readonly initial: string
  readonly onChange: (markdown: string) => void
}) {
  return (
    <>
      <MarkdownEditorStyles />
      <MarkdownEditor
        onChange={onChange}
        onError={(error) => console.warn(error.code, error.cause)}
        value={initial}
      />
    </>
  )
}
```

The component decides between the rich editor and a controlled textarea with a
layout probe, exported as `supportsRichTextEditing()` for a host that wants to
branch on the same answer. Pass `fallback` to force one path. The rendered
`data-mode` attribute reports which path is live: `"wysiwyg"`, `"fallback"`, or
`"failed"`.

A failed load is not a lost document. The component reports `editor-load-failed`
or `editor-create-failed` through `onError` and renders a seeded textarea with
`data-mode="failed"`, so editing continues in plain text. See
[Failure codes and limits](../reference/contracts.md) for both codes.

## Draw a vault graph

`KnowledgeGraph` renders over a `d3-force` simulation. The graph math is not
behind the subpath: `computeGraphModel`, `nodeRadius`, `folderTint`, and
`neighbourSet` are on the base barrel, so a host can compute and inspect a graph
without loading the renderer.

```tsx
import { computeGraphModel } from "@smthrs/ui"
import { KnowledgeGraph } from "@smthrs/ui/adapters/knowledge-graph"

const model = computeGraphModel(notes, links)
const nodeCount: number = model.nodes.length
```

## Confirm what landed in your bundle

An adapter belongs to whichever chunk imports it, so the check is your bundler's
production output rather than anything in this package. Build for production and
find the chunk that holds the adapter's dependency. It should be a lazily loaded
chunk. If it is the entry chunk, a module on your initial route imports the
adapter eagerly: follow the import back and move it behind the lazy boundary.

Importing `@smthrs/ui` itself never pulls a heavy dependency in, which
[The adapters boundary](../concepts/adapters.md) explains and the package's test
suite enforces.

## Related

- [The adapters boundary](../concepts/adapters.md): why the boundary exists and
  what each subpath costs.
- [API reference](../api.md): every export of every adapter.
