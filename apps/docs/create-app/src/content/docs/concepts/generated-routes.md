---
title: "The generated route tables"
description: "routes.gen.ts and routes.ui.gen.ts are the router walk written down: what each file holds, why the two are split, how import bindings are named, and the three ways drift is checked."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/create-app/docs/concepts/generated-routes.md"
---

The router walk produces one value in memory. Two renderers turn it into the
two files an app actually imports, and those files are the only place a route
name appears outside the file that owns it.

`smithers-routes` writes exactly two files at the app root and never anything
else.

## routes.gen.ts

Every flow with its three resolved layers, plus the pane names:

```ts
import * as layer0 from "./AGENT.ts"
import * as flow0 from "./flows/chat/flow.ts"
import * as layer1 from "./SANDBOX.ts"
import * as layer2 from "./TOOLS.ts"

export const paneNames = ["message"] as const

export const flows = [
  {
    id: "chat",
    file: "flows/chat/flow.ts",
    spec: flow0.default,
    agent: layer0.Agent,
    sandbox: layer1.Sandbox,
    tools: layer2.Tools
  }
] as const
```

It imports no React and no virtual module, which is the reason for the split: a
Cloudflare Worker bundle and a plain Vitest run both load this file without
Vite in the loop. `paneNames` is here rather than in the UI table because a
host that offers `ui/pane` to a model has to know which names are registered
without pulling the components into its bundle.

## routes.ui.gen.ts

The shell layout, the pages, the pane components, and the flow summaries:

```ts
import * as layoutModule from "./app/layout.tsx"
import * as page0 from "./app/page.tsx"
import * as pane0 from "./app/panes/message.tsx"
import * as flow0 from "./flows/chat/flow.ts"

export const layout = layoutModule.default

export const pages = [
  { route: "/", file: "app/page.tsx", component: page0.default }
] as const

export const panes = {
  "message": pane0.Pane
} as const

export const flowSummaries = [
  { id: "chat", file: "flows/chat/flow.ts", chat: flow0.default.chat === true }
] as const
```

`layout` is `undefined` when the app has no `app/layout.tsx`, so a shell can
branch on it rather than guess.

`flowSummaries` is what a browser shell needs of a flow: its id, its file, and
whether it is a chat. It reaches only the flow files, which import
`Flow.make` and a schema. The browser never reads `routes.gen.ts` for this:
that table imports every layer file and every tool module, and the aomi
template's chain tools build an EVM client at module scope.

The browser entry point reads this file and never imports a page itself. The
generated module already imports every page, so a page that imported it back
would close an initialization cycle.

## Why the bindings are numbered

Import bindings are named by position (`flow0`, `layer1`, `page2`) and every
specifier is a JSON string literal.

No derivation from a route name is injective. Mapping every non-word character
to `_` gave the flows `a-b` and `a/b` the same binding, and the pages `/a-b`,
`/a/b`, and `/a_b` the same binding too, so the generated module failed to
parse while the generator reported success. Numbering by position cannot
collide.

The JSON string literal is the second half of that: no character in a file path
can close the literal and inject a statement into the generated module.

## Checking for drift

Both generated files are derived data. Edit what they are derived from, then
regenerate. One command checks that you did:

```bash
pnpm routes:check
```

Both templates define that script as `smithers-routes --check`. It writes
nothing, names each stale file, and exits 1:

```text
routes.gen.ts is out of date; run `pnpm routes`
```

Writing and checking are the same function, `writeRoutes`, called with and
without `check`, so the two can never disagree about what the tables should
hold.

## Regeneration in dev

The Vite plugin regenerates both files when the config resolves and whenever a
routed file appears or disappears, so `pnpm dev` never serves a stale table. A
file counts as routed when it is a `page.tsx`, a `layout.tsx`, a file directly
under a `panes/` directory, a `flow.ts`, or one of the three
layer files.

Both tables are replaced together or not at all. The Worker bundle imports one
and Vite the other, so a pair from two different trees is a broken app. Every
table is first written to a neighbouring `.tmp` file; only when both writes
succeed are they renamed into place. A rename that fails after the first table
was replaced restores it, and the staging files are removed.

A tree the router refuses while the server is running is reported on stderr
rather than thrown. The watcher listener runs inside chokidar's emit, where a
throw would take the dev server down instead of raising an overlay, so the
previous tables stay on disk and the message says what to fix. A refusal at
startup is different: Vite awaits `configResolved`, so a refused tree there
fails the startup.

Pass `onRouterError` to the plugin to route those reports somewhere else. See
[Brand an app](/guides/brand-an-app/) for the plugin's options.

A filesystem that refuses the write is treated the same way: `ENOSPC`,
`EACCES`, `EBUSY`, `EROFS` and their kind are reported on stderr and leave the
previous tables in place. They are not routed through `onRouterError`, because
nothing in the tree is wrong. `ENOENT` is not one of them: the app root itself
is gone, so the regeneration throws.
