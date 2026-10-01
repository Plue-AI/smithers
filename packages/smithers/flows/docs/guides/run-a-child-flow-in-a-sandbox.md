---
title: "Run a child flow in a sandbox"
description: "Put a child flow's own code on a provisioned machine with SandboxedFlow: write the entry module, call execute directly, or declare the whole execution as one durable action of a parent flow."
sidebar:
  order: 4
---

`@smthrs/flows/SandboxedFlow` runs a child flow's own code inside a machine a
`Sandbox.Provider` provisions. The child's TypeScript never runs in the parent's
process. Read
[the sandboxed runner protocol](../concepts/runner-protocol.md) for what happens
on the wire; this guide is the wiring.

## Write the entry module

The entry is the module that gets bundled. It exports the flow, and, when the
flow's body names actions, a `layer` that implements them. Everything the
implementation touches belongs to the guest: `process.cwd()` is the session
workdir, and files it writes land in the workspace the host can read back.

```ts
// child.ts
import { Action, Flow } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { writeFile } from "node:fs/promises"

export const Greeting = Schema.Struct({ greeting: Schema.String, workdir: Schema.String })

export const ComposeGreeting = Action.make("app/ComposeGreeting", {
  payload: { name: Schema.String },
  success: Greeting
})

export const Greet = Flow.make("app/Greet", {
  payload: { name: Schema.String },
  success: Greeting,
  body: (payload) => ComposeGreeting.call(payload)
})

/** The implementations the guest runner provides beside the interpreter. */
export const layer = ComposeGreeting.toLayer(({ name }) =>
  Effect.promise(async () => {
    const greeting = `hello, ${name}`
    await writeFile("greeting.txt", greeting)
    return { greeting, workdir: process.cwd() }
  })
)
```

The flow may be exported under any name, including as the default export. The
runner finds it by tag.

## Run it directly

`execute` acquires the session, runs the protocol, and releases the session
when it returns. A normal completion tears the machine down.

```ts
import * as SandboxedFlow from "@smthrs/flows/SandboxedFlow"
import * as Effect from "effect/Effect"

const greet = Effect.gen(function*() {
  const result = yield* SandboxedFlow.execute(Greet, { name: "Ada" }, {
    provider,
    session: "greet-1",
    entry: new URL("./child.ts", import.meta.url)
  })
  // result.output is Greet's success value, decoded through Greet's own schema.
  return result.output
})
```

`entry` is a `file:` URL or an absolute path. `provider` is a
`Sandbox.Provider` value that you pass in: there is no string registry, no
lookup by name, and no environment variable default.
[Choose a provider](#choose-a-provider) below builds the local one.

The remaining options are all optional:

| Option        | Default                       | What it does                                                                                                                                                                    |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime`     | `"node"`                      | The guest executable: `"node"`, `"bun"`, or an executable path. Each path is quoted as one shell word. Use a wrapper script for flags.                                          |
| `captureWork` | `false`                       | Capture the workdir's changes as a `Sandbox.Work` git patch. The workdir must be a git repository. See [Capture the work a sandboxed child did](./collect-a-workspace-diff.md). |
| `limits`      | `SandboxedFlow.defaultLimits` | Bounds on the result and the patch.                                                                                                                                             |
| `timeout`     | 10 minutes                    | The wall-clock budget for the whole session, acquisition through result readback. It is measured on the platform timer, so it fires under a frozen test clock too.              |

## Make it one durable action of a parent

This is the usual shape. `action(flow)` declares an ordinary durable action over
the child's payload schema, and `toLayer` implements it with `execute`. The
parent's body calls it like any other action.

```ts
import { Action, Flow, Interpreter } from "@smthrs/flows"
import * as SandboxedFlow from "@smthrs/flows/SandboxedFlow"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Greet, Greeting } from "./child.ts"

const RunGreet = SandboxedFlow.action(Greet)

const SandboxedGreeting = Flow.make("app/SandboxedGreeting", {
  payload: { name: Schema.String },
  success: SandboxedFlow.resultSchema(Greeting),
  error: SandboxedFlow.ExecuteError,
  body: (payload) => RunGreet.call(payload)
})

const stack = Layer.mergeAll(
  SandboxedFlow.toLayer(RunGreet, Greet, ({ executionId, callId }) => ({
    provider,
    session: `greet:${executionId}:${callId}`,
    entry: new URL("./child.ts", import.meta.url)
  })),
  Interpreter.layer(SandboxedGreeting)
).pipe(Layer.provideMerge(Action.layerImplementations))
```

The action's tag is `app/Greet/sandboxed` unless you pass
`{ name: "..." }` as `action`'s second argument. Both forms preserve the literal
name in the type, so each declaration requires its own implementation. Its success schema is
`resultSchema(Greeting)`, which is `{ output, work, capabilityCeiling }`, and
its error schema is `ExecuteError`: `SandboxedFlowError` or the kernel's
`PermissionDenied`.

Compose the returned layer beside `Interpreter.layer(parent)` over one
`Action.layerImplementations`, exactly as you would any other action
implementation.

## Derive the session key from the execution and call

`toLayer`'s third argument is either the placement itself or a function of the
call's context: the decoded payload, the parent's `executionId`, and `callId`.
Derive the session key from both `executionId` and `callId`, as above. The engine
assigns a distinct `callId` to each call, including parallel calls with identical
payloads, and preserves it across retries and resume. A crash that left a machine
behind is reattached by the resumed call with the same key. The parent id or
payload alone cannot distinguish repeated calls.

Because the whole sandboxed execution is one durable action, a second run of the
parent over the same database answers from the journal and never asks the
provider for a machine at all.

## Choose a provider

Providers come from [`@smthrs/sandbox`](/api/sandbox), which the barrel
re-exports as the `Sandbox` namespace. It ships several, and
`DirectorySandbox` is the one to start with: its machines are scratch
directories on this host, so the whole placement path runs with no container
runtime. It takes the filesystem and the spawner as values, which a Node
program reads from a contained host. Provide `NodeHost.layerContained()` with
a `ProcessLedger`; the [sandbox quickstart](https://sandbox.smithers.sh/quickstart/)
shows a complete composition. A raw or deadline-only spawner is refused before
the directory is created:

```ts
import { Sandbox } from "@smthrs/flows"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const makeProvider = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  return Sandbox.DirectorySandbox.make({ fs, spawner, root: "/var/tmp/smithers" })
})
```

A directory is a workspace boundary, not a security boundary: nothing confines
the guest process to it. Swap in `Sandbox.ContainerSandbox` or a vendor
provider where isolation matters.

Any value with an `acquire` method satisfies the provider contract, which
through the barrel is `Sandbox.Sandbox.Provider`: the package's own `Sandbox`
module sits one level below its namespace. Wrapping a provider to count
acquisitions or inject a fault is a few lines:

```ts
import type { Sandbox } from "@smthrs/flows"

let acquisitions = 0
const counted: Sandbox.Sandbox.Provider = {
  acquire: (session) => {
    acquisitions++
    return underlying.acquire(session)
  }
}
```

## Check the guest image

The runtime the bundle is started with has to be on the guest's `PATH`, and
nothing installs it. `node:22-alpine` has `node`; bare `alpine` does not, and a
missing runtime comes back as `guest_failed` naming what it looked for. The full
list of refusals is in [Troubleshooting](../troubleshooting.md).

## Failure diagnostics

`result_unreadable` means a zero-exit guest left no result, wrote malformed
protocol JSON, or returned a result for another attempt. Each execution creates
a fresh `attempt` nonce in `request.json`; the guest echoes it in both success
and failure envelopes. The host accepts only the current nonce and removes any
leftover `result.json` before launch. Reattaching a session preserves workspace
files but cannot reuse a previous attempt's result.

Before writing a failed `result.json`, the guest applies the engine logger's
shared credential key and text rules to error fields, messages, and string
failures. The host applies the same rules to `SandboxedFlowError.message` and
its provider causes, and redacts guest stdout/stderr before taking diagnostic
tails. Sensitive fields such as `password` and nested `Authorization` become
placeholders. Error details that do not match the rules remain available.

These rules are best effort, not a guarantee for arbitrary secret text. They
cover failure diagnostics, not successful output, request payloads, collected
files, or the guest's original output streams. Keep secrets out of those
surfaces or model them with `Schema.Redacted` where supported.
