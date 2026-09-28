---
title: "Serve flows over CLI, HTTP, and MCP"
description: "Project routes onto an Incur CLI with Incur.createCli and serve them to shells, HTTP clients, and MCP tools."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/fs/docs/guides/serve-over-cli-http-and-mcp.md"
---

`Incur.createCli` projects the executable routes onto an
[`incur`](https://github.com/wevm/incur) CLI: the same routes get a shell
surface through `serve`, an HTTP surface through `fetch`, and discovery
surfaces (`--help`, `--llms`, `--schema`, OpenAPI, and MCP) that publish each
flow's real input schema. This guide assumes you have scanned routes; for
that step, see [Quickstart](/quickstart/).

## Create the CLI

`createCli` takes the CLI name and the scanned routes, and it captures the
installed `FlowInvoker`, so provide the invoker when you run the effect:

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FileRouter, FlowInvoker, Incur } from "@smthrs/fs"
import { Effect, Layer } from "effect"
import { resolve } from "node:path"

const cli = await Effect.runPromise(
  Effect.gen(function*() {
    const { routes } = yield* FileRouter.scan({ root: resolve("flows") })
    return yield* Incur.createCli("flows", routes)
  }).pipe(
    Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker)),
    Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
  )
)
```

Validation matches `Command.make`: malformed routes fail, hidden and
non-module routes never mount, and a child route literally named `self` under
a route that also has children fails with `duplicate_route`.

## Serve a shell command

`serve` takes an argv, defaulting to `process.argv.slice(2)`. The command
name resolves from the tokens ahead of the first flag, with a slash-joined or
spaced first token:

```ts
await cli.serve(["review", "--number", "42", "--format", "json"])
await cli.serve(["nested/visible", "--number", "7", "--format", "json"])
```

Dispatching one command loads only that command's module. Flags decode
through the flow's advertised schema; a value that contradicts it is refused
before the flow runs, with a field-level error naming the failing path and no
copy of the offending value.

For tests, capture output and exit codes with the `stdout` and `exit`
options:

```ts
const writes: Array<string> = []
await cli.serve(["review", "--number", "42", "--format", "json"], {
  stdout: (value) => writes.push(value),
  exit: () => undefined
})
```

## Answer HTTP requests

`fetch` takes a `Request` and returns a `Response`, resolving the
percent-decoded path the same way the CLI resolves argv and honoring
`request.signal` during dispatch:

```ts
const get = await cli.fetch(new Request("http://localhost/review?number=42&enabled=true"))
const post = await cli.fetch(
  new Request("http://localhost/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ number: 43, tags: ["a", "b"] })
  })
)
```

Both carry typed input to the same decoder; the response body carries the
encoded output under `data`. Request path segments are split before they are
percent-decoded, so an encoded slash (`%2F`) decodes inside one segment and
can never invent a path boundary. A malformed percent escape returns status
400 with the `parse_failed` envelope.

## Authenticate before you listen

`fetch` and the `/mcp` surface perform no authentication and no origin
check. Any client that reaches them can invoke every mounted route with that
flow's capabilities, against your repository and credentials. Before you wire
`cli.fetch` into a listening server, bind it to `127.0.0.1` or put an
authenticating layer in front that rejects a request before it reaches
`cli.fetch`:

```ts
import { createHash, timingSafeEqual } from "node:crypto"

const token = process.env.FLOWS_TOKEN
if (token === undefined || token.length === 0) {
  throw new Error("FLOWS_TOKEN must be set before serving flows")
}
const digest = (value: string) => createHash("sha256").update(value).digest()
const expected = digest(`Bearer ${token}`)

Bun.serve({
  hostname: "127.0.0.1",
  fetch: (request) =>
    timingSafeEqual(digest(request.headers.get("authorization") ?? ""), expected)
      ? cli.fetch(request)
      : new Response("Unauthorized", { status: 401 })
})
```

The server refuses to start without a token, so a missing variable never
turns into a guessable `Bearer undefined` credential. Hashing both sides
gives `timingSafeEqual` equal-length buffers.

## Publish the discovery surfaces

Discovery requests get a metadata surface that projects every command once
and caches the result:

- CLI: any argv containing `--help`, `-h`, `--llms`, `--llms-full`,
  `--schema`, `--version`, or `--mcp`, or a truthy `COMPLETE` environment
  variable (an empty value is ignored).
- HTTP: `/mcp`, `/openapi.json`, `/openapi.yml`, `/openapi.yaml`, and
  everything under `/.well-known/`.

```ts
await cli.serve(["--llms"])
const spec = await cli.fetch(new Request("http://localhost/openapi.json"))
```

Every advertised command publishes the JSON Schema of its flow's Effect
input schema, so the tool list and the OpenAPI document describe the input
the flow actually accepts. A route whose input cannot be projected stays
advertised; calling it reports the `FsError` that stopped the projection.

## Reach a route that also has children

Incur cannot represent a node that is both runnable and a command group, so a
route with children is advertised and dispatched under the reserved `self`
segment, while the bare name keeps dispatching to it directly:

```ts
// Routes: domains, domains/list
await cli.serve(["domains", "self", "--number", "5", "--format", "json"])
const self = await cli.fetch(new Request("http://localhost/domains/self?number=5"))
const bare = await cli.fetch(new Request("http://localhost/domains?number=1"))
const nested = await cli.fetch(new Request("http://localhost/domains/list?number=2"))
```

The OpenAPI document lists `/domains/self` beside `/domains/list`, and
`--llms` shows `domains self`, so nothing executable is left undiscoverable.

## Read the error envelopes

Only an unmatched name falls back to help output. Every pre-dispatch typed
failure reports its own code: on the CLI a JSON envelope goes to `stdout`
followed by exit code 1, and over HTTP the same envelope returns with status
400:

```json
{
  "ok": false,
  "error": { "code": "resource_limit", "message": "The command name exceeds its resource bounds" }
}
```

Failures raised while decoding, invoking, or encoding a dispatched command
report through Incur with the `FsError` code. For the full taxonomy and its
remedies, see [Troubleshooting](/troubleshooting/).
