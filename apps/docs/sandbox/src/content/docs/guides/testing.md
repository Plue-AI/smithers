---
title: "Test against a scripted machine"
description: "Use Sandbox.TestSession and RemoteChildProcessSpawner.TestRemote to run a body against a deterministic in-memory machine, and know what a scripted double cannot prove."
sidebar:
  order: 8
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sandbox/docs/guides/testing.md"
---

Two doubles ship with the package, one per seam. Both are deterministic, hold
no host resource, and expose the state a test asserts against.

## Script a machine with TestSession

`Sandbox.TestSession.make` builds a `Sandbox.Provider` whose sessions have an
in-memory guest tree and answer command lines from a script table:

```ts
import { Sandbox } from "@smthrs/sandbox"

const provider = Sandbox.TestSession.make({
  workdir: "/sandbox",
  files: { "/sandbox/input.txt": "seed\n" },
  scripts: { "wc -c /sandbox/input.txt": { stdout: "5\n" } }
})
```

It composes exactly where a real provider does, so the body under test never
knows the difference:

```ts
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  yield* fs.writeFileString("report.txt", "written\n")
  return yield* spawner.string(ChildProcess.make("wc", ["-c", "/sandbox/input.txt"]))
}).pipe(
  Effect.provide(Sandbox.layerHost(provider, { session: "test" })),
  Effect.scoped
)
```

After the effect runs, `provider.state` holds what happened. `files` is the
guest tree itself, keyed by the exact absolute path, so the relative
`report.txt` above is found at `/sandbox/report.txt`:

| Field      | Holds                                                       |
| ---------- | ----------------------------------------------------------- |
| `acquired` | every session key `acquire` was called with, in order       |
| `commands` | every command line, in spawn order                          |
| `inputs`   | the standard input each command received, in the same order |
| `files`    | the guest tree, as a `Map<string, Uint8Array>`              |
| `released` | how many sessions have been released                        |

Options cover the cases a test needs: `scripts` for exact command lines,
`script` as a resolver for anything the record does not name, `files` for the
initial tree, `ping` to give sessions a liveness answer, and `acquireFailure`
to make acquisition fail. An unscripted command answers the way a shell reports
a missing binary: exit 127 with `command not found` on stderr.

## Script a transport with TestRemote

`RemoteChildProcessSpawner.TestRemote.make` is the same idea for the narrow
seam:

```ts
import { RemoteChildProcessSpawner } from "@smthrs/sandbox"

const remote = RemoteChildProcessSpawner.TestRemote.make({
  scripts: { "sleep 60": { pending: true } },
  kill: true,
  stdin: true
})
```

A `TestScript` carries `stdout`, `stderr`, `exitCode`, a `failure` to fail the
spawn itself, or `pending: true` for a command that runs until something stops
it. `pending` is modelled as a deferred exit rather than `Effect.never` on
purpose, so a `kill` that works actually settles the command; use
`killIsNoop: true` when you want to model a provider whose signal goes nowhere,
and `killFailure` when you want the signal to fail.

`remote.state` records `openedSessions`, `commands`, `inputs`, `kills` (each
with the command and the signal), and a `cancellations` count that increments
when the provider's release finalizer runs. That count is how you assert
interruption really tore the session down.

Declare capabilities to test the paths they open: `kill: true` gives the
provider a `kill`, `ping` gives it a liveness effect, and `stdin: true` makes
it accept input-fed commands instead of having the adapter refuse them.

## What a scripted double cannot prove

A double answers command lines; it does not run a shell. It cannot tell you
whether your environment delivery survives dash, whether your `kill` reaches a
descendant process, or whether your file transfer stays byte exact across a
text boundary. Those are properties of a real backend.

Use the doubles for adapter logic, cancellation, and composition. Prove backend
behavior with [the conformance suites](/guides/prove-a-provider/) against something
real. The package's own suite runs them against host directories and processes,
Docker, OrbStack Kubernetes, and a Microsandbox microVM, skipping each when the
backend is not present, and yours can do the same.

## Read next

- [Prove a provider](/guides/prove-a-provider/).
- [Troubleshooting](/troubleshooting/).
