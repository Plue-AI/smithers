---
title: "Run a command in a tab"
description: "Spawn a command through the in-page bash interpreter: working directories, environment, buffered output, cancellation, and the eight things this spawner refuses rather than fakes."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-browser/docs/guides/run-a-command.md"
---

`BrowserChildProcessSpawner` implements Effect's `ChildProcessSpawner` over an
in-page bash interpreter. Commands are written the way they are on a server, and
the divergences are stated rather than hidden.

## Run one command

```ts
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const counted = Effect.flatMap(
  ChildProcessSpawner,
  (spawner) => spawner.string(ChildProcess.make("wc", ["-l", "notes.txt"], { cwd: "/workspace" }))
)
```

The service is built from one `spawn`, so `exitCode`, `string`, `lines`,
`streamString`, and `streamLines` are all derived from it and all inherit the
behaviour below.

The layer requires `FileSystem` and `Path` in context, for the same reason
`NodeChildProcessSpawner` does: `cwd` is validated and resolved before the
command runs. `BrowserServices.layer` and `BrowserHost.layer` provide both.

## Pass an absolute working directory

A tab has no `process.cwd()`, so give `cwd` an absolute path inside the mounted
volume. The adapter stats it before running anything. An absent path propagates
`NotFound` from `FileSystem.stat`; an existing non-directory produces
`BadArgument` from `ChildProcess.spawn`. Neither case calls the interpreter.

## Environment variables replace by default

Effect's `CommandOptions.env` replaces the environment unless `extendEnv: true`
is set. just-bash merges unless it is asked for `replaceEnv`. The adapter
reconciles the two: it asks for replacement whenever `env` is supplied and
`extendEnv` is not `true`, and it drops `undefined` values, which just-bash has
no way to represent.

A command without `env` runs with the interpreter's own environment, the one the
page passed when it constructed just-bash. That environment is ambient to every
command, as `process.env` is on Node, so any command a flow runs can read it.
Never seed credentials into the interpreter's environment; pass a secret in the
`env` of the one command that needs it.

## Output arrives after the command finishes

just-bash is a buffered, run-to-completion API. The handle replays what it
captured:

- `stdout` and `stderr` each emit at most one chunk, after the command settles.
- `all` is `stdout` followed by `stderr`, not a live interleaving, and it
  inherits both stream options.
- `isRunning` is `true` while the run is queued or executing and `false` once it
  settles.

The `stdout` and `stderr` options keep their Node meaning: `"inherit"` and
`"ignore"` yield an empty stream, and a `Sink` is transduced through. They are
applied to captured text rather than to a live readable.

Captured output is not bounded. The adapter holds the complete `stdout` and
`stderr` strings and re-encodes them to bytes, so a command that prints a large
amount of text holds it twice in the tab's single heap. Bound the command.

## One command runs at a time

Runs are serialized behind a permit, so two interpreters never mutate the mount
at once. The permit is held until the interpreter's promise settles, an abort
included, rather than until the calling fiber stops waiting. An interpreter that
ignores its `AbortSignal` and never settles therefore blocks every later run
instead of being abandoned with the mount half written.

## Cancel a run

Scope closure, interruption, a timeout, and `kill` all abort the interpreter
through its `AbortSignal`. Every observable on the handle then reports a
`PlatformError` naming the abort, rather than replaying the interrupt into the
caller's fiber:

```ts
const cancelled = Effect.scoped(
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("slow-thing"))
    yield* handle.kill()
    // Failure carrying the abort PlatformError.
    return yield* Effect.result(handle.exitCode)
  })
)
```

`Effect.result` returns a `Failure` with the `PlatformError` in `failure`, or a
`Success` with the exit code in `success`. The abort is a typed failure; defects
and fiber interruptions are not captured by `Effect.result`.

`killSignal` is accepted and ignored, because there is no process to signal in a
tab. `forceKillAfter` is refused instead of dropped: there is no harder stop
after the abort.

## What the spawner refuses

Each refusal is a typed `PlatformError` raised before anything runs, except the
two marked otherwise:

| Input                              | Why                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A `PipedCommand`                   | There is no process table to pipe between. Write the pipeline as one command line.                             |
| A `Stream` for `stdin`             | The adapter runs the interpreter once with captured output and has nowhere to stream into.                     |
| `additionalFds`                    | just-bash cannot configure extra file descriptors.                                                             |
| `shell: "/bin/zsh"` or any string  | `shell: true` means the in-page interpreter; another shell cannot be selected.                                 |
| `detached: true`                   | Nothing can outlive the tab.                                                                                   |
| `forceKillAfter`                   | Refused on the command and on `kill(options)`, because `CommandOptions` extends `KillOptions`.                 |
| `handle.stdin`                     | A `Sink` that fails, for the same reason a stdin `Stream` is refused at spawn.                                 |
| `handle.getInputFd`, `getOutputFd` | Answer `Sink.drain` and `Stream.empty`, which is what Node answers for a descriptor that was never configured. |

`pid` is a per-layer counter rather than an OS process id, and `unref` is a
no-op: a tab has no parent process reference count.

The error messages, and what to change for each, are in
[Troubleshooting](/troubleshooting/).

## How the command line is built

A `StandardCommand` is rendered to a command line by
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/)'s `CommandLine.render`, which is the same
renderer the kernel grants against. Without `shell`, the command and its
arguments are POSIX single-quoted, so a spawn keeps argv semantics and a hostile
token cannot become syntax. With `shell`, they are joined verbatim, mirroring
how Node hands `sh -c` an unquoted line.
