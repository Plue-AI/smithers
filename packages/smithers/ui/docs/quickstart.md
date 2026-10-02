---
title: "Quickstart"
description: "Build a run panel end to end: mount the stylesheet, render a card with a status pill and a live timestamp, and drive the tone from the shared status vocabulary."
sidebar:
  order: 2
---

This quickstart builds one small surface: a panel of workflow runs, each with a
status pill, a relative timestamp, and a retry affordance that appears only on a
finished run. It uses nothing but the root barrel, so it adds no dependency to
your bundle beyond the base library.

By the end you have a component whose colors are correct in light and dark with
no dark-mode code of your own, and whose status tone comes from the vocabulary
every Smithers UI shares.

## Prerequisites

- A React 19 application that resolves `@smthrs/ui`, `react`, and `react-dom`.
  See [Installation](./installation.md).
- A bundler that compiles TSX.

## Model the data

The panel needs a run id, a status string, and a start time. Status is a plain
string, because that is what a control plane reports:

```tsx
type Run = {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly startedAt: number
}

const runs: readonly Run[] = [
  { id: "r-1", name: "fix-login-redirect", status: "running", startedAt: Date.now() - 42_000 },
  { id: "r-2", name: "upgrade-deps", status: "failed", startedAt: Date.now() - 900_000 },
  { id: "r-3", name: "release-notes", status: "completed", startedAt: Date.now() - 3_600_000 }
]
```

## Render one run

`StatusPill` takes the raw status string and derives its own label and tint.
`RelativeTime` renders a live timestamp that re-renders off one shared interval,
however many of them are mounted. `isTerminalRunStatus` answers whether a run
has stopped moving, which is what decides whether the retry button appears:

```tsx
import { Button, Card, CardContent, CardHeader, CardTitle, isTerminalRunStatus, RelativeTime, StatusPill } from "@smthrs/ui"

function RunCard({ run, onRetry }: { readonly run: Run; readonly onRetry: (id: string) => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{run.name}</CardTitle>
        <StatusPill status={run.status} />
      </CardHeader>
      <CardContent>
        <p>
          Started <RelativeTime ts={run.startedAt} />
        </p>
        {isTerminalRunStatus(run.status)
          ? <Button onClick={() => onRetry(run.id)}>Retry</Button>
          : null}
      </CardContent>
    </Card>
  )
}
```

You wrote no color. `StatusPill` resolved `running` to the brand tone,
`failed` to the danger tone, and `completed` to the success tone through the
shared vocabulary, and each tone is a theme token rather than a hex value.

## Render the panel

`SectionHeader` gives the panel a titled frame, and `EmptyState` covers the case
with no runs, so the surface never renders a bare heading over nothing:

```tsx
import { Button, EmptyState, KpiStat, SectionHeader } from "@smthrs/ui"

function RunPanel({ runs, onRetry }: { readonly runs: readonly Run[]; readonly onRetry: (id: string) => void }) {
  const finished = runs.filter((run) => isTerminalRunStatus(run.status)).length
  return (
    <section>
      <SectionHeader
        eyebrow="Workflow"
        title="Recent runs"
        actions={<KpiStat label="Finished" value={`${finished}/${runs.length}`} />}
      />
      {runs.length === 0
        ? <EmptyState title="No runs yet" description="Launch a workflow to see it here." />
        : runs.map((run) => <RunCard key={run.id} onRetry={onRetry} run={run} />)}
    </section>
  )
}
```

## Mount the stylesheet

Nothing above imported a stylesheet, because the styles travel as a JavaScript
string. Render `SmithersUiStyles` once at the root of the document. Pass
`withTheme` when the host page does not already inline the theme tokens, which
is the case for a standalone app:

```tsx
import { createRoot } from "react-dom/client"
import { SmithersUiStyles } from "@smthrs/ui"

function App() {
  return (
    <>
      <SmithersUiStyles withTheme />
      <RunPanel onRetry={(id) => console.log("retry", id)} runs={runs} />
    </>
  )
}

const container = document.getElementById("root")
if (container === null) throw new Error("index.html is missing #root")
createRoot(container).render(<App />)
```

Load the page. The panel renders in the palette and mode the document asks for:
the OS `prefers-color-scheme` preference decides light against dark, and an
explicit `data-theme` attribute on `<html>` overrides it.

## Prove the theme switch

Flip the attribute from the console and watch every color follow, with no
re-render and no state of your own:

```js
document.documentElement.setAttribute("data-theme", "dark")
```

Every color in the panel resolves through a `var(--token, lightFallback)`
expression, so changing the attribute changes what those custom properties
resolve to and the browser repaints. That is the whole dark-mode mechanism. See
[Theme tokens](./concepts/theming.md) for the token bridge and Paper light/dark.

## What you built

- One `SmithersUiStyles` element carrying the entire component stylesheet.
- Three components whose tone came from a status string rather than from a
  color you chose.
- A surface that is correct in both modes because it names tokens, not colors.

## Next steps

- [Style a host application](./guides/style-a-host-application.md): the
  `withTheme` and `extra` seams, and the once-per-document rule.
- [Render a run status](./guides/render-run-status.md): the vocabulary behind
  `StatusPill`, and when to call `statusClass` yourself.
- [The adapters boundary](./concepts/adapters.md): read this before you import
  a chart, a terminal, or a diff view.
