---
title: "@smthrs/ui"
description: "React components for coding-agent interfaces: run cards, status pills, streamed agent output, diffs, and prompt composers, styled through theme tokens with no stylesheet to configure."
---

`@smthrs/ui` is a React component library for interfaces that watch and steer
coding agents. It covers the surfaces such a product keeps needing: run cards
and status pills, streamed agent output with its tool calls and reasoning
summary, diffs and syntax-highlighted code, prompt composers with attachments,
approval and checkpoint cards, and the theme tokens that hold them together.

Build those surfaces yourself and you decide, over and over, what color a
`failed` run is, how a half-streamed tool call reads, how a dropped file that is
too large gets refused, and how all of it behaves in dark mode. This package
makes those decisions once. You pass a status string and get a correctly tinted
pill; you pass a provider payload and get a rendered response; you set
`data-theme` on `<html>` and the whole tree recolors with no code of your own.

The components follow shadcn/ui anatomy on Radix behavior. If you have used
shadcn, the shapes are the ones you already know: compound parts, `data-slot`
attributes, CVA variant recipes, and `asChild`.

## Availability

`@smthrs/ui` is not published to a registry. Its source lives in the
[smithersai/smithers](https://github.com/smithersai/smithers) repository under
`packages/smithers/ui`, and the applications there consume it through the pnpm
workspace.
Every page on this site describes that source, so the component contracts, the
failure codes, and the styling model are readable whether or not you can install
the package. [Installation](./installation.md) covers what a consumer needs and
what each entry point exports.

## Two decisions shape everything else

**Styles ship as TypeScript, not as a CSS file.** There is no stylesheet to
import and no build step to configure. Render one element and the whole library
is styled, in whichever mode the document asks for. See
[how styling ships](./concepts/styling.md).

**Heavy renderers live behind subpaths.** Importing `@smthrs/ui` gets you the
component library, about 500 KB bundled. Shiki, recharts, xterm.js, and Milkdown
are reachable only through `@smthrs/ui/adapters/*`, so you pay for one after you
ask for it. See [the adapters boundary](./concepts/adapters.md) for the measured
costs.

## The shortest real example

A list of workflow runs, each with a status pill and a live timestamp:

```tsx
import { Card, CardContent, CardHeader, CardTitle, RelativeTime, SmithersUiStyles, StatusPill } from "@smthrs/ui"

type Run = {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly startedAt: number
}

export function RunList({ runs }: { readonly runs: readonly Run[] }) {
  return (
    <>
      <SmithersUiStyles withTheme />
      {runs.map((run) => (
        <Card key={run.id}>
          <CardHeader>
            <CardTitle>{run.name}</CardTitle>
            <StatusPill status={run.status} />
          </CardHeader>
          <CardContent>
            Started <RelativeTime ts={run.startedAt} />
          </CardContent>
        </Card>
      ))}
    </>
  )
}
```

You wrote no color and imported no stylesheet. `StatusPill` derived its label
and its tint from the status string through the shared status vocabulary, so
`failed` looks the same here as it does on every other Smithers surface, and
`SmithersUiStyles` carried the sheet and the theme tokens into the document.

## Where this package sits

Smithers is a control plane for long-running coding agents, and its entry point
is the `smthrs` command line in [`@smthrs/cli`](/api/cli). That package plans,
approves, runs, and inspects flows, and it is where the vocabulary this library
renders comes from: a run, its status, an approval waiting on a person. Read
[`@smthrs/cli`](/api/cli) to learn what those things are, then come back here
for the components that put them on a screen.

`@smthrs/ui` sits one level below the CLI, alongside the other pieces the
Smithers applications are assembled from. It consumes
[`@smthrs/ui-styleguide`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui/ui-styleguide), which owns the theme token block
and Paper light/dark, rather than restating them.

## Where to go next

- [Installation](./installation.md): what a consumer needs, the entry-point
  table, and the one style element every host renders.
- [Quickstart](./quickstart.md): build a run panel end to end, then prove the
  theme switch with one attribute change.
- Concepts: [how styling ships](./concepts/styling.md),
  [theme tokens](./concepts/theming.md),
  [component anatomy](./concepts/component-anatomy.md), and
  [the adapters boundary](./concepts/adapters.md).
- Guides: [style a host application](./guides/style-a-host-application.md),
  [render a run status](./guides/render-run-status.md),
  [render agent output](./guides/render-agent-output.md),
  [collect a prompt](./guides/collect-a-prompt.md),
  [use a heavy renderer](./guides/use-a-heavy-renderer.md), and
  [test a component](./guides/test-a-component.md).
- [API reference](./api.md): every export of the base barrel and the ten
  subpaths, with signatures.
- [Failure codes and limits](./reference/contracts.md) and
  [troubleshooting](./troubleshooting.md).
