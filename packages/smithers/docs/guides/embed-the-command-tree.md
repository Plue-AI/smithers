---
title: "Embed the command tree"
description: "Run the smthrs commands from inside your own Node program: build the config, provide the Node layer, and swap the registry, engine, or output service."
---

`@smthrs/cli` is a library as well as an executable. A host that wants the
Smithers commands inside its own program imports the command tree and the layer
that satisfies it, rather than shelling out.

## The whole executable in nine lines

```ts
import { Command, NodeControl, Version } from "@smthrs/cli"
import { Effect } from "effect"
import { Command as Cli } from "effect/unstable/cli"

const config = NodeControl.makeConfig(
  ["--remote", "http://127.0.0.1:3000"],
  process.env,
  process.cwd()
)

const main = Cli.run(Command.cli, { version: Version.packageVersion }).pipe(
  Effect.provide(NodeControl.layer(config))
)
```

`Command.cli` is the command tree: every shipped verb with a handler, every
removed one with a hidden refusal. `NodeControl.layer(config)` is the complete
Node environment those handlers require.

## Build the configuration first

`NodeControl.makeConfig(args, environment, cwd)` is the pure configuration
boundary. It reads `--remote`, `--mcp-config`, and `--root`
straight off the argument vector, falls back to `SMITHERS_REMOTE`,
`SMITHERS_TOKEN`, and `SMITHERS_MCP_CONFIG`, resolves the project root and
the 0.x migration root, and throws a `CliError.UsageError` naming the offending
flag for a bad URL or an unreadable MCP file. It starts no process. Without
`SMITHERS_TOKEN`, a remote's stored `smithers auth login` credential, which may
live in the system keyring, is read once when `NodeControl.layer(config)` is built.

Those four values cannot be handler-level flags: the durable layers are built
from them, and they are built before the parser reads a token.

`NodeControl.config` is the same call applied to the ambient process, with the
throw converted into a typed failure:

```ts
import * as NodeControl from "@smthrs/cli/NodeControl"
import { Effect } from "effect"

const configured = NodeControl.config.pipe(
  Effect.map((config) => NodeControl.layer(config))
)
```

## What the layer contains

`NodeControl.layer(config)` merges, for a local configuration:

- `Control`, over one durable engine whose SQLite connection is shared by the
  control runtime, the journal, the run store, and the memory store.
- The run executor, with the kernel-guarded filesystem and shell, durable
  memory, and the MCP servers `--mcp-config` named.
- The flow registry discovered from `<root>/flows`.
- `Output`, the deterministic renderer, wired to publish its status as
  `process.exitCode`.
- `Project.ProjectRoot`, `Project.MigrationRoot`, and `Project.LegacyState`.
- The gateway host `smthrs serve` launches.
- Node's own platform services.

For a remote configuration it builds the RPC client, its HTTP and WebSocket
transports, and the memory store that refuses, and opens no local database at
all.

The engine is materialized once, before its consumers are assembled, so a local
composition never opens two writers on one file. Database open and migration
failures terminate startup rather than becoming typed errors, because no local
command can proceed honestly without the store.

## Swapping a piece

Three functions take the pieces as parameters, so a host can supply its own:

```ts
import * as Application from "@smthrs/cli/Application"
import * as NodeControl from "@smthrs/cli/NodeControl"

const root = process.cwd()
const registry = NodeControl.layerRegistry(root)
const engine = NodeControl.engineDurable(root, registry)

const control = NodeControl.layerControl({ root }, registry, engine)
```

- `NodeControl.layerControl(config, registry?, engine?)` builds `Control` alone,
  with the registry and engine you pass.
- `NodeControl.layerExecutor(registry, engine, root, options)` builds the run
  executor. `options.environment` is required; `mcpServers`, `grants`,
  `requestExecutor`, `quotaPolicy`, `executionRoot`, and `modules` are
  optional. Pass a stricter `GrantStore` to confine what a run may touch, and
  pass the same one the filesystem gets: a filesystem pinned to the allow-all
  store beside a shell pinned to a real one is a fail-open the types would not
  catch.
- `Application.layer(config, registry?, engine?, executor?)` is the
  transport-neutral composition underneath. It picks local or RPC from the same
  `Config` and leaves `HttpClient`, `RpcSerialization`, and `Socket` for a
  platform module to provide. `Application.engineMemory` is its in-memory
  default, which records nothing that survives the process.

Omitting the executor leaves every run `pending`, which is correct only for a
composition that observes runs without executing them. It must be passed to
`Application.layer` rather than provided from outside, because `ControlLive`
resolves it with `Effect.serviceOption` while its own layer is built.

## Owning the exit status

`Output.layer` renders and returns; `NodeControl.layerOutput` renders and also
transfers the status to `process.exitCode`. Use the second only at a real
process boundary. `Output.make()` builds the service directly for a focused
test.

```ts
import * as Output from "@smthrs/cli/Output"
import { Effect } from "effect"

const rendered = Effect.gen(function*() {
  const output = yield* Output.Output
  return yield* output.render({ runId: "run-1" }, "json")
})
```

`Output.renderValue(value)` marks caller-controlled data as output rather than
as a control receipt, so a stored value with a receipt-shaped `_tag` cannot
change the status. See
[Output and exit codes](../concepts/output-and-exit-codes.md).

## Owning the terminal

`Ui.layer(process.env)` builds the interactive renderer on the process streams.
`Ui.make({ output, input, interactive })` builds one on streams you supply,
which is how a test drives a fake terminal. `Ui.current` reads the provided
service or falls back to the process streams, so a handler needs no layer
plumbing:

```ts
import * as Ui from "@smthrs/cli/Ui"
import { Effect } from "effect"

const greet = Effect.gen(function*() {
  const ui = yield* Ui.current
  yield* ui.intro()
  yield* ui.success("ready")
  yield* ui.outro("done")
})
```

Every method has a plain-line rendering for a non-interactive session, and
`Ui.isInteractive(stdout, stdin, environment)` is the decision.

## Reading the surface as data

The catalogs are plain values, so a host can render its own help, validate its
own configuration, or check a script against the release:

```ts
import * as Unsupported from "@smthrs/cli/Unsupported"
import * as Verb from "@smthrs/cli/Verb"

const shipped = Verb.names
const removed = Unsupported.removedVerbs.map((verb) => verb.name)
const reserved = Unsupported.isReservedFlow("system/plan")
```

`Serve.mounts` is the route list the gateway banner is rendered from,
`Environment.names` is every variable the CLI reads, and `Doctor.inspect` runs
the readiness checks against host facts you pass rather than against ambient
state.

## See also

- [The API reference](../api.md): every export of every module.
- [Local and remote control planes](../concepts/local-and-remote.md): what
  `Config.remote` changes about the composition.
- [`@smthrs/control`](/api/control): the service every handler talks to.
