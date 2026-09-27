---
title: "@smthrs/create-app"
description: "Build a web app around Smithers flows: one PACKAGE.ts declaration, file-routed flows and pages, panes the model renders by name, offline flow tests, and Cloudflare deploy targets."
---

`@smthrs/create-app` turns a set of [Smithers flows](/api/flow) into a
deployable web app. You declare the app once, in a `PACKAGE.ts` at the app
root, and every other name comes from where a file sits: a page, a pane the
model can put on screen, a flow, and the three layer files that give a flow its
model, its compute budget, and its tools.

## The problem it removes

An agent app usually keeps a registry beside each of those: a route table, a
pane registry, a tool list, and a map from flow id to model. Every registry is
a second place a name has to be spelled, and each one goes stale on its own
schedule.

This package has no registries. One walk of the app root derives every page
route, pane name, and flow id from the filesystem, then writes two generated
tables that the dev server, the Cloudflare Worker bundle, and the test suite
all import. You never edit those tables. You regenerate them, and
`smithers-routes --check` fails when they drift.

Three more things fall out of the same declaration:

- A flow never names a model. Its seat comes from the nearest ancestor
  `AGENT.ts`, so moving one directory's flows onto a stronger model is a
  one-file change.
- A flow's test replays a recorded model transcript through the production
  agent loop, so the suite runs with no network call and no API key.
- `CreateApp` returns dev, build, and deploy targets, so shipping the app to a
  Cloudflare Worker is already wired.

## The shortest real example

Scaffold an app and run its flow test:

```bash
pnpm exec smithers-build create-app ledger
cd ledger
pnpm install
pnpm test
```

```text
Test Files  1 passed (1)
     Tests  1 passed (1)
```

That test ran the template's `chat` flow through the production agent loop
against a committed transcript, offline.

A second flow is a directory and a file. Nothing registers it:

```ts
// flows/summarize/flow.ts
import { defineFlow } from "@smthrs/create-app/app"
import * as Schema from "effect/Schema"

export const Flow = defineFlow({
  description: "Summarize a ledger entry for an operator.",
  payload: { entryId: Schema.String },
  output: Schema.Struct({
    summary: Schema.String,
    risk: Schema.Literals(["none", "review", "block"])
  }),
  prompt: ({ entryId }) => `Summarize entry ${entryId}.`
})
```

Run `pnpm routes`, and `summarize` is in the table on the seat its nearest
`AGENT.ts` declares.

## How this relates to the smithers CLI

[`@smthrs/cli`](/api/cli) ships `smithers`, the top-level command the rest of
Smithers sits under. It plans, approves, runs, and inspects durable flows from
a shell. `@smthrs/create-app` is the second surface for the same flows: a
routed flow is an ordinary [`@smthrs/flow`](/api/flow) flow, and instead of a
terminal it gets a browser page, panes the model renders by name, and a Worker
that answers a turn.

Use the CLI when a person or a CI job drives the run. Use this package when the
flow needs a product around it.

The scaffold command belongs to neither executable. `create-app` is a verb of
`smithers-build`, the build CLI in [`@smthrs/build-cli`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/build-cli); the
templates ship inside this package, and that CLI resolves them through Node.

## Install

Not on npm yet; see [Installation](/docs/installation/#use-the-libraries). Then run
`pnpm exec smithers-build create-app my-app`.
[Installation](./installation.md) covers the requirements and import forms.

## Where to go next

Two pages get an app running:

- [Installation](./installation.md): requirements, the scaffold command, and
  what it rewrites.
- [Quickstart](./quickstart.md): scaffold, route, test, and serve an app in
  about five minutes.

Three pages explain how an app is named and generated:

- [File routing](./concepts/routing.md): what each file location means, the
  name grammar, and the three ways the walk refuses a tree.
- [Layer files](./concepts/layers.md): how `AGENT.ts`, `SANDBOX.ts`, and
  `TOOLS.ts` resolve, and what each one declares.
- [The generated route tables](./concepts/generated-routes.md): what
  `routes.gen.ts` and `routes.ui.gen.ts` hold, and how drift is checked.

Seven guides cover the work of building one:

- [Add a flow](./guides/add-a-flow.md)
- [Add a pane](./guides/add-a-pane.md)
- [Add a page](./guides/add-a-page.md)
- [Brand an app](./guides/brand-an-app.md)
- [Test a flow](./guides/test-a-flow.md)
- [Run a routed flow from your own host](./guides/host-a-turn.md)
- [Deploy to Cloudflare](./guides/deploy-to-cloudflare.md)

Four reference pages describe the surface:

- [API reference](./api.md): every public export, subpath by subpath.
- [Command reference](./reference/cli.md): the flags and exit codes of
  `smithers-build create-app` and `smithers-routes`.
- [Templates](./reference/templates.md): the public `default` scaffold and the
  repository's UI-only reference app.
- [Troubleshooting](./troubleshooting.md): every refusal this package reports,
  grouped by the component that raises it.
