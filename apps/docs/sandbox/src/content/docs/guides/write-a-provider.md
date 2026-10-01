---
title: "Write a provider"
description: "Implement Sandbox.Provider or RemoteChildProcessSpawner.Provider for a new backend: the obligations, the structural SDK slice, native filesystem overrides, and capability declaration."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sandbox/docs/guides/write-a-provider.md"
---

A new backend joins this package by implementing one of the
[two seams](/concepts/seams/). Implement `Sandbox.Provider` when you own
the machine's lifecycle, which is the usual case. Implement
`RemoteChildProcessSpawner.Provider` only when the machine already exists and
your transport can do nothing but run a command line.

## Take the vendor SDK as a structural slice

Declare the shape you use, and let the caller pass the real client. That is
how this package stays free of vendor dependencies and keeps bundling for the
browser, and it is also what lets a test double satisfy the same type:

```ts
interface VendorMachine {
  readonly id: string
  run(line: string, cwd: string): Promise<{ readonly stdout: Uint8Array; readonly code: number }>
  get(path: string): Promise<Uint8Array | null>
  put(path: string, bytes: Uint8Array): Promise<void>
  destroy(): Promise<void>
}

interface VendorSdk {
  create(name: string): Promise<VendorMachine>
}
```

A command-line tool arrives the same way, as an injected
`ChildProcessSpawner` rather than a call to `node:child_process`. No module in
`@smthrs/sandbox` reads a host global, which is what lets the package bundle
for a browser; a provider that follows the same rule keeps that property.

## Implement acquire

`acquire` is scoped. Register teardown with `Effect.acquireRelease` so that
closing the acquiring scope, including an interruption, ends the machine:

```ts
import { ProviderError } from "@smthrs/sandbox/RemoteChildProcessSpawner"
import type { Provider, Session } from "@smthrs/sandbox/Sandbox"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const failed = (code: ProviderError["code"], message: string) => (cause: unknown) =>
  new ProviderError({ code, message, cause })

export const make = (sdk: VendorSdk, workdir: string): Provider => ({
  acquire: (session) =>
    Effect.gen(function*() {
      const machine = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => sdk.create(session),
          catch: failed("unavailable", `the machine for ${session} could not be created`)
        }),
        (held) => Effect.ignore(Effect.promise(() => held.destroy()))
      )
      const held: Session = {
        id: session,
        remoteId: machine.id,
        workdir,
        spawn: (command, options) =>
          Effect.map(
            Effect.tryPromise({
              try: () => machine.run(command, options.cwd ?? workdir),
              catch: failed("spawn_error", `the machine could not run ${command}`)
            }),
            (result) => ({
              stdout: Stream.fromArray([result.stdout]),
              stderr: Stream.empty,
              exitCode: Effect.succeed(result.code)
            })
          ),
        readFile: (path) =>
          Effect.flatMap(
            Effect.tryPromise({
              try: () => machine.get(path),
              catch: failed("unavailable", `the machine could not read ${path}`)
            }),
            (bytes) =>
              bytes === null
                ? Effect.fail(new ProviderError({ code: "not_found", message: `nothing at ${path}` }))
                : Effect.succeed(bytes)
          ),
        writeFile: (path, content) =>
          Effect.tryPromise({
            try: () => machine.put(path, content),
            catch: failed("unavailable", `the machine could not write ${path}`)
          }),
        ping: Effect.asVoid(
          Effect.tryPromise({
            try: () => machine.run("true", workdir),
            catch: failed("unavailable", "the machine did not answer")
          })
        )
      }
      return held
    })
})
```

That sketch omits three obligations a real provider owes. Fill them in before
you run the conformance suite, which will name each one you missed.

## The obligations, and how to satisfy each

**Name the machine from the session key.** A key must land on the same machine
when a crashed run acquires it again. Every bundled provider derives its name
from the key's leading name-safe characters plus a 64-bit digest of the whole
key, and adopts an existing machine of that name rather than failing on the
conflict.

**Run in `workdir` and root a relative `cwd` under it.** `spawn(command, {})`
runs in `Session.workdir`, and a relative `cwd` is taken under `workdir`, never
under whatever directory your transport starts in.

**Deliver `options.stdin`.** This is not optional on a session. If your
transport has an input channel, use it. If it does not, stage the bytes as a
file in the workspace and rewrite the command to read from it, and remove the
file as a finalizer of the spawn's scope so a killed command does not leave the
caller's script or credential blob on the machine.

**Create parent directories in `writeFile`, and report absence as
`not_found`.** A caller has to be able to tell "nothing there" from "session
broken", which is the one place the code set keeps them apart.

**Move file contents as bytes.** An adapter whose SDK speaks text encodes; the
seam does not. Base64 through a shell is a normal way to do this, and the
conformance suite proves it with a 64 KiB payload of every byte value.

**Refuse an environment name a shell would drop.** Names must match
`[A-Za-z_][A-Za-z0-9_]*`. Deliver a caller's environment with `env(1)` in front
of an absolute shell rather than with `export`, which aborts the line on a name
like `a-b`, and delete an `undefined` value with `env -u` rather than omitting
the assignment. Put every `-u` before every assignment, because `env` stops
reading options at its first operand.

**If you declare `kill`, end the work and not just the wrapper.** Signalling
the shell your transport started is not enough when its child survives. The
bundled container providers record each command's guest pid in a
session-private pidfile and signal descendants through `/proc` before the root.

## Serve what you can natively

`Sandbox.fileSystem` derives Effect's `FileSystem` from `readFile`,
`writeFile`, and POSIX `sh` probes. Where your SDK has a real operation, put it
in `Session.files` and it replaces the probe one entry at a time:

```ts
const held: Session = {
  // ...
  files: { exists: machineExists, stat: machineStat, readDirectory: machineList }
}
```

An override is installed through the workdir resolver rather than beside it, so
your operation receives the already rooted path and does not re-implement the
rule.

## Declare capabilities when you project the session

`Sandbox.commandProvider` projects a lifecycle provider down to the narrow
seam, which decides statically whether `kill` and `ping` exist. A lifecycle
provider only learns what its session can do after `acquire`, so you close the
gap by declaring it:

```ts
import { Sandbox } from "@smthrs/sandbox"

const spawnOnly = Sandbox.commandProvider(provider, {
  session: "run:01J...",
  provides: { kill: true, ping: true }
})
```

A declared capability the acquired session turns out to lack fails honestly
with `unavailable` instead of pretending. `stdin` is not among the flags,
because delivering it is an obligation of every session rather than a
capability a session may lack.

## Then prove it

Do not ship on inspection. [Prove a provider](/guides/prove-a-provider/) runs both
contracts as behavior and reports every check that did not hold.
