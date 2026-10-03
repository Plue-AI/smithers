---
title: "Quickstart"
description: "Scan a flows tree and run one command end to end with @smthrs/fs."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/fs/docs/quickstart.md"
---

This walkthrough builds the smallest real program: one flow on disk, one
metadata-only scan, one parsed command, and one invocation through a stub
boundary. By the end you have a command surface you can also serve to a
shell or an HTTP client.

## Prerequisites

- Node.js 26.4.0 or later, and pnpm.
- `@smthrs/fs`, `@smthrs/core`, `effect`, and `@effect/platform-node` resolvable
  from your program.

`@smthrs/fs` is not published to npm, so you install it from a checkout:

```bash
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
```

Write this walkthrough's program inside that checkout, in a package that depends
on `@smthrs/fs`, so the imports below resolve.

## Create a flow

A route's name comes from its directory path, not from the flow's `name`
field. Create `flows/review/flow.ts`:

```ts
import { Schema } from "effect"

export default ({
  name: "review",
  description: "Review a pull request.",
  input: Schema.Struct({ number: Schema.Number }),
  output: Schema.Struct({ accepted: Schema.Boolean, number: Schema.Number })
})
```

The default export must satisfy `isFlow` from
[@smthrs/core](https://core.smithers.sh/reference/api/). Anything else fails at dispatch time with
`load_failed`.

## Scan the flows tree

`FileRouter.scan` reads registry metadata without importing `flow.ts`. It
requires the platform `FileSystem` and `Path` services:

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FileRouter } from "@smthrs/fs"
import { Effect, Layer } from "effect"
import { resolve } from "node:path"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const scanned = Effect.gen(function*() {
  const { routes } = yield* FileRouter.scan({ root: resolve("flows") })
  return routes.map((route) => route.name)
}).pipe(Effect.provide(platform))

Effect.runPromise(scanned).then(console.log)
```

```text
[ "review" ]
```

The route carries the discovered description, schema locators, capabilities,
effect declaration, placement, and `modelInvocable` flag, all validated and
frozen. The flow module itself has not been imported.

## Build the command surface and execute one command

`Command.make` filters the scan to executable routes (module kind with
`modelInvocable` set to true) and projects them for an agent. `execute`
parses the command string, loads only the selected module, decodes the input
through the flow's Effect schema, invokes through `FlowInvoker`, and encodes
the output:

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
  console.log(commands.list())
  return yield* commands.execute("review --number 42")
}).pipe(
  Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker)),
  Effect.provide(platform)
)

Effect.runPromise(program).then(console.log)
```

```text
[ { name: "review", description: "Review a pull request." } ]
{ accepted: true, number: 42 }
```

Two defining behaviors happened here: the flow module loaded only when the
command dispatched, and the string `"42"` from the command line decoded to
the number `42` through the flow's own schema before invocation.

## Serve the same routes

To expose the same routes to a shell or an HTTP client, project them with
`Incur.createCli`. The returned CLI responds to `serve` with an argv and to
`fetch` with a `Request`:

```ts
import { Incur } from "@smthrs/fs"

const cli = await Effect.runPromise(
  Effect.gen(function*() {
    const { routes } = yield* FileRouter.scan({ root: resolve("flows") })
    return yield* Incur.createCli("flows", routes)
  }).pipe(
    Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker)),
    Effect.provide(platform)
  )
)

await cli.serve(["review", "--number", "42", "--format", "json"])
const response = await cli.fetch(new Request("http://localhost/review?number=42"))
console.log(await response.json())
```

`cli.fetch` performs no authentication: any client that reaches it can run
every mounted flow. Before you serve it on a socket, follow
[Authenticate before you listen](/guides/serve-over-cli-http-and-mcp/#authenticate-before-you-listen).

The CLI run prints the encoded output as JSON, and the HTTP response body
carries the same encoded output under `data`. Discovery stays metadata-aware:
`--help`, `--llms`, `--schema`, `/openapi.json`, and `/mcp` all describe the
flow's real input schema.

## Next steps

- To drive this surface programmatically, see
  [Expose flows to an agent](/guides/expose-flows-to-an-agent/).
- For the full CLI, HTTP, and MCP behavior, see
  [Serve flows over CLI, HTTP, and MCP](/guides/serve-over-cli-http-and-mcp/).
- To learn why discovery and dispatch work this way, see
  [Metadata routing](/concepts/metadata-routing/) and
  [Command projections](/concepts/command-projections/).
