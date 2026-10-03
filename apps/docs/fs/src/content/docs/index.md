---
title: "@smthrs/fs"
description: "Turn a directory of Smithers flows into named, schema-checked commands for agents, shells, HTTP clients, and MCP tools."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/fs/docs/README.md"
---

A flow is one unit of Smithers work: an input schema, an output schema, and a
body, declared with tagged `Flow.make` from [@smthrs/flow](https://flow.smithers.sh/). `@smthrs/fs`
turns a directory of those flows into a set of named commands.

It reads the tree without importing a single flow module, records what it finds
as immutable routes named after their directory paths, and projects the runnable
ones onto four surfaces: a command surface an agent drives, a CLI, HTTP, and
MCP. Each flow's own Effect schema decodes every input and encodes every output.

## What it solves

Offering a directory of flows to a model, a shell, or an HTTP client usually
forces a bad trade. Import every flow to learn its name and its schema, and
listing the commands runs arbitrary user code and pays for every dependency in
the tree. Skip the import, and you advertise hand-written descriptions that
drift away from what each flow actually accepts.

This package refuses the trade. The scan and the agent's list operation read
metadata only, so a flow whose module throws at import time still appears in
the listing. Dispatch imports one module, the one being called, and decodes the
arguments through that flow's real Effect schema. `--help`, `--schema`, the
OpenAPI document, and the MCP tool list publish that same schema, so the
advertised input is the accepted input; the first such discovery imports every
visible module once and caches the projection.

Two halves share one immutable route model:

- **Metadata routing.** `FileRouter.scan` reads [registry](https://registry.smithers.sh/reference/api/)
  metadata and returns module, Markdown, and skill routes for inspection.
  `Route` validates and freezes that metadata, `CommandTree` indexes routes for
  lookup, and `Directive` compiles placement literals into [core](https://core.smithers.sh/reference/api/)
  placement values.
- **Command projections.** `Command.make` exposes the model-invocable module
  routes to an agent as list, parse, execute, and typed call operations.
  `Incur.createCli` serves the same routes as a CLI and as HTTP, OpenAPI, and
  MCP surfaces, built on the [`incur`](https://github.com/wevm/incur) CLI
  library. Neither projection runs a flow: both dispatch through the
  injected `FlowInvoker` seam, and every failure arrives as a sanitized
  `FsError`.

## How it relates to @smthrs/agent

`@smthrs/fs` is one package in the Smithers agent group, next to
[@smthrs/agent](https://agent.smithers.sh/reference/api/), and the two own opposite ends of the same
contract. The agent owns the loop: it runs the model's program in a sandbox
whose only authority is calling a flow by name. This package owns the other end
of that name, answering which flows exist on disk, what each one accepts, and
how a command string becomes one schema-checked invocation. Neither package
executes a flow itself. Execution lands behind the `FlowInvoker` seam, which a
harness fills.

Both packages sit under the `smthrs` command line, the program most people
actually run. To plan, approve, run, and inspect flows from a shell, start at
[@smthrs/cli](https://cli.smithers.sh/reference/api/).

## Availability

`@smthrs/fs` is not published to npm. You install it from a checkout of the
[Smithers repository](https://github.com/smithersai/smithers), and it carries no
support promise while the registry and the command surfaces settle. See
[Quickstart](/quickstart/) for the checkout steps. Read these pages for the
routing contract and the schema behavior; to run flows from a shell today, use
[@smthrs/cli](https://cli.smithers.sh/reference/api/).

## The smallest working example

Start with one flow at `flows/review/flow.ts`, whose directory path gives the
command its name:

```ts
import { Schema } from "effect"

export default ({
  description: "Review a pull request.",
  input: Schema.Struct({ number: Schema.Number }),
  output: Schema.Struct({ accepted: Schema.Boolean, number: Schema.Number })
})
```

Then scan that directory, build the agent command surface, and execute one
command through a stub invoker:

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Command, FileRouter, FlowInvoker } from "@smthrs/fs"
import { Effect, Layer } from "effect"
import { resolve } from "node:path"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const invoker = FlowInvoker.make({
  invoke: ({ input }) => Effect.succeed({ accepted: true, number: (input as { readonly number: number }).number })
})

const program = Effect.gen(function*() {
  const { routes } = yield* FileRouter.scan({ root: resolve("flows") })
  const commands = yield* Command.make(routes)
  return yield* commands.execute("review --number 42")
}).pipe(
  Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker)),
  Effect.provide(platform)
)

Effect.runPromise(program).then(console.log)
```

`FileRouter.scan` requires the platform `FileSystem` and `Path` services, and
`execute` requires a `FlowInvoker`. For the guided version of this program, see
[Quickstart](/quickstart/).

## Where to go next

- [Quickstart](/quickstart/): scan a flows tree and run one command end to end.
- [Expose flows to an agent](/guides/expose-flows-to-an-agent/): list, parse, execute, and call routes programmatically.
- [Serve flows over CLI, HTTP, and MCP](/guides/serve-over-cli-http-and-mcp/): project routes onto an Incur CLI.
- [Test flow invocation](/guides/test-flow-invocation/): stub the invocation boundary.
- [Metadata routing](/concepts/metadata-routing/): how filesystem paths become routes.
- [Command projections](/concepts/command-projections/): how routes become schema-checked surfaces.
- [Filesystem routing contract](/contract/): the normative visibility, schema, path, snapshot, resource, and error behavior.
- [API reference](/reference/api/): every export, with signatures, requirements, and errors.
- [Exported members](/exports/): the public surface as one index.
- [Troubleshooting](/troubleshooting/): the `FsError` codes, their causes, and their fixes.
