---
title: "Quickstart"
description: "Scaffold a Smithers app, write its route tables, replay its flow test offline, add a pane of your own, and run the dev server."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/create-app/docs/quickstart.md"
---

By the end of this quickstart you will have an app on disk, its two route
tables generated, its flow test passing with no network and no API key, and a
pane of your own rendered from a file you added. It takes about five minutes.

The app is the `default` template: one page, one pane, one flow, one tool, and
a Cloudflare Worker that runs the chat flow at `POST /api/turn`.

## Prerequisites

- Node.js 26.4.0 or later, and pnpm.
- `@smthrs/build-cli` and `@smthrs/targets` in the project from which you run
  the scaffold. Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

## Scaffold the app

```bash
pnpm exec smithers-build create-app ledger
```

The directory name becomes the app name, so `ledger` is substituted everywhere
the template wrote `__APP_NAME__`: the manifest, the Worker name, the brand,
and the agent's teaching. The command reports what it copied:

```text
{
  "directory": "/work/ledger",
  "name": "ledger",
  "template": "default",
  "files": 33
}
```

Then install:

```bash
cd ledger
pnpm install
```

## Read the app in one file

`PACKAGE.ts` is the only file that declares anything about the app as a whole:

```ts
import { CreateApp } from "@smthrs/create-app"
import { Smithers as S } from "@smthrs/targets"

export const App = CreateApp({
  name: "ledger",
  brand: { name: "ledger", theme: "system", tokens: { accent: "#5288c2" } },
  nav: [{ label: "App", items: [{ label: "Chat", href: "/", icon: "message-square" }] }],
  deploy: { cloudflare: { workerName: "ledger", domain: "ledger.example.com" } }
})

export const Package = S.Package({
  targets: { routes: App.routes, dev: App.dev, build: App.build, deploy: App.deploy }
})
```

Nothing else names a route, a pane, or a flow. Four files do that by sitting
where they sit:

| File                    | What it declares                                       |
| ----------------------- | ------------------------------------------------------ |
| `AGENT.ts`              | The seat and teaching every flow below it runs on      |
| `SANDBOX.ts`            | The QuickJS budget every cell runs under               |
| `TOOLS.ts`              | The flow bindings every flow below it may call         |
| `flows/chat/flow.ts`    | The flow `chat`: a payload, an output schema, a prompt |
| `app/page.tsx`          | The page `/`                                           |
| `app/panes/message.tsx` | The pane `message`                                     |

## Generate the route tables

```bash
pnpm routes
```

```text
routes: 1 pages, 1 panes, 1 flows
```

That wrote two files at the app root. `routes.gen.ts` holds every flow with its
three resolved layers, and imports no React, so the Worker and a plain Vitest
run can both load it. `routes.ui.gen.ts` holds the layout, the pages, the pane
components, and the flow summaries for the browser bundle. Both are generated:
edit the files they are derived from, never the tables. To fail instead of writing, ask for a drift
check:

```bash
pnpm routes:check
```

## Run the flow test offline

```bash
pnpm test
```

```text
Test Files  1 passed (1)
     Tests  1 passed (1)
```

`flows/chat/flow.e2e.ts` ran the `chat` flow through the production agent loop
against `flows/chat/fixtures/answer.json`, a recorded model transcript. There
is no network call and no API key in that path, so the same model turn is
graded on every commit. [Test a flow](/guides/test-a-flow/) covers recording
a new fixture.

## Add a pane

A pane is a React component the agent can put on screen by name. Create
`app/panes/balance.tsx`:

```tsx
import { definePane } from "@smthrs/create-app/ui"
import * as Schema from "effect/Schema"

export const Pane = definePane({
  props: Schema.Struct({ address: Schema.String, eth: Schema.String }),
  title: "Balance",
  render: ({ address, eth }) => (
    <dl className="pane">
      <dt>{address}</dt>
      <dd>{eth} ETH</dd>
    </dl>
  )
})
```

The file name is the pane name, so this is `balance`. Regenerate:

```bash
pnpm routes
```

```text
routes: 1 pages, 2 panes, 1 flows
```

`routes.ui.gen.ts` now imports your component, and `routes.gen.ts` lists
`balance` in `paneNames`.

One more step makes it callable. The template's `tools/ui.ts` builds its
binding over a fixed pane list, so add the new name there:

```ts
export const ui: FlowBinding.Source = uiSource(
  Context.add(
    Context.make(CardSink, makeCollecting(collectedCards)),
    PaneNames,
    makePanes([{ name: "balance", fullscreen: false }, { name: "message", fullscreen: false }])
  )
)
```

Without that entry, `ui/pane` refuses the name and tells the model which panes
are registered. [Add a pane](/guides/add-a-pane/) explains why the list is
the host's to build and how to read it from `routes.gen.ts` instead.

## Run the dev server

```bash
pnpm dev
```

Vite serves the browser bundle and runs `worker/index.ts` under workerd in the
same process. Three things are worth trying:

- The page at `/` renders through `app/layout.tsx`, whose sidebar comes from
  the `nav` you declared in `PACKAGE.ts`.
- `GET /api/routes` reports what the router found, which is the cheapest way to
  confirm the app serving is the one you edited.
- Adding or deleting a routed file regenerates both tables while the server
  runs, so the dev server never serves a stale table.

`POST /api/turn` runs the `chat` flow and streams `TurnFrame` NDJSON back to
the page. Enter and Send start one reply at a time; after a reply or error,
you can send again. The Worker answers HTTP 401 until `.dev.vars` sets `APP_API_TOKEN` (open the
page as `/#token=<value>`) or, for local development only, `APP_API_OPEN=1`. It
answers HTTP 503 `host_unconfigured` until `.dev.vars` holds the seat's
provider connection; see the template README.
[Run a routed flow from your own host](/guides/host-a-turn/) explains the
host underneath.

## What just happened

You never registered anything. The router walked the app root once, derived the
page route from `app/page.tsx`, the pane names from `app/panes/*.tsx`, and the
flow id from `flows/chat/`, then resolved each flow's agent, sandbox, and tools
to the nearest ancestor layer file. The generated tables are that walk written
down, which is why they are checked for drift rather than edited.

## Next steps

- [File routing](/concepts/routing/): every rule the walk enforces, and the
  refusals it reports.
- [Layer files](/concepts/layers/): how one `AGENT.ts` moves every flow
  below it to another seat.
- [Add a flow](/guides/add-a-flow/): the second flow, and its test.
- [Deploy to Cloudflare](/guides/deploy-to-cloudflare/): the build and
  deploy targets, and the secrets each one needs.
