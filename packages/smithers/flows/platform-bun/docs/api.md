---
title: "API reference"
description: "Every export of @smthrs/platform-bun: the BunHost layers and their refusal, the containment options, the implementation identities, and the BunFileSystem escape hatch."
---

```ts
import { BunHost } from "@smthrs/platform-bun"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("printf", ["hello"]))
}).pipe(Effect.provide(BunHost.layer))
```

`@effect/platform-bun` is a required peer at exactly `4.0.0-rc.115` because
this barrel and `BunHost` import it at module load. It is installed alongside
the package by package managers that resolve required peers. The Effect Node
platform packages and `effect` are also exact peers at `4.0.0-rc.115`.

:::warning
This entry point is Node-only in the browser-bundle sense: it falls back to the
`@effect/platform-node` adapters off Bun, so it resolves `node:fs` and the other
`node:` built-ins. It runs on Bun and on Node. What it does not do is bundle for
a browser; a page composes
[`@smthrs/platform-browser`](/api/platform-browser) instead.
:::

The complete host bundles require jj 0.39.0 or newer. Each bundle checks its jj
executable before exposing repository operations. Construction can fail with
`JjError`, including `not_installed` or `unsupported_version`. The contained
bundles route that probe
through their process spawner and retire its ledger entry when it exits. Probe
results are cached per resolved absolute executable path and runner; contained
spawners share a result only within the same spawner instance.

## Entry points

| Import                               | Source                                                                                                                             | Platform  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `@smthrs/platform-bun`               | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-bun/src/index.ts)                 | Bun, Node |
| `@smthrs/platform-bun/BunHost`       | [src/BunHost.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-bun/src/BunHost.ts)             | Bun, Node |
| `@smthrs/platform-bun/BunFileSystem` | [src/BunFileSystem.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-bun/src/BunFileSystem.ts) | Bun, Node |

The root entry point exports exactly two names, `BunHost` and `BunFileSystem`,
each the namespace of the module above. `@smthrs/platform-bun/internal/*` and
`@smthrs/platform-bun/*/index` are blocked in the export map;
`@smthrs/platform-bun/package.json` is exported.

Supported runtimes are Bun >=1.4.0 and Node.js >=26.4.0.

## BunHost

The complete closed Host bundle: layers, construction errors, models,
implementation identities, and platform module re-exports.

### Layers

| Export             | Signature                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `layer`            | `Layer.Layer<BunHost \| Crypto.Crypto, JjError>`                                                              |
| `layerAt`          | `(root: string) => Layer.Layer<BunHost \| Crypto.Crypto, JjError>`                                            |
| `layerContained`   | `(options?: ContainedOptions) => Layer.Layer<BunHost \| Crypto.Crypto, JjError, ProcessLedger>`               |
| `layerContainedAt` | `(root: string, options?: ContainedOptions) => Layer.Layer<BunHost \| Crypto.Crypto, JjError, ProcessLedger>` |
| `layerHttpClient`  | `Layer.Layer<HttpClient>`                                                                                     |

`layer` provides all five Host services, including the runtime-independent
`Path`. `Jj` is bound to the process working directory.

`layerAt` is `layer` with `Jj` bound to `root` instead. `root` must be an
absolute path; see [BunHostError](#bunhosterror).

`layerContained` is `layer` with process containment turned on: every child is
spawned through `@smthrs/kernel`'s `ContainedSpawner` with
`ProcessReaper.layerSpawner`, including its native adapter and
`ProcessReaper.processLifecycle`. Each pipeline leg prepares a supervisor,
records its identity, and then activates the target with a
`SIGTERM`-then-`SIGKILL` deadline. The ledger retires a record only after
verified cleanup, and `@smthrs/platform-node`'s `ProcessReaper` sweeps the records a
crashed incarnation left behind while the layer is built. `Jj` is built over
that same spawner (`BunJj.layerSpawner`), so a `jj` a dead host left running is
a ledger record like any other. The `ProcessLedger` requirement is deliberate:
only the program knows whether it has a durable one.

On POSIX, `handle.pid` names the supervisor; `exitCode` and `isRunning`
describe the target. Natural target exit still cleans up children in its owned
group, including children holding output open. `detached: false` retains the
supervisor but opts out of group cleanup, signalling only the target. Use the
handle's `kill` rather than signalling its numeric pid yourself. Explicit
stopping while a grouped target is alive attempts a best-effort ancestry sweep
for escaped descendants; natural exit does not reclaim deliberately escaped
sessions. Failed cleanup fails scope close and retains its record. Ordinary
Bun runtimes are supported; compiled Bun applications are refused before
activation because they cannot launch the runtime supervisor.

`layerContainedAt` is `layerContained` with `Jj` bound to `root`
(`BunJj.layerSpawnerAt`). It refuses a root exactly as `layerAt` does.

`layerHttpClient` is the network slot every factory above installs, on its
own: `EgressHttpClient.layer(process.env)` from `@smthrs/platform-node`. A `3xx`
comes back with its `location` header intact and the second origin is never
contacted. Following a redirect is `@smthrs/kernel`'s guarded
`HttpClient.layer`, which rechecks the capability on every hop.

### BunHostError

```ts
class BunHostError extends Schema.TaggedError<BunHostError>()("@smthrs/platform-bun/BunHostError", {
  code: Schema.Literal("invalid_repository_root"),
  message: Schema.String
}) {
  readonly name: "BunHostError"
}

type BunHostErrorCode = "invalid_repository_root"
```

The refusal `layerAt` and `layerContainedAt` throw when `root` is not absolute,
the empty string included. It is thrown rather than failed because a factory
runs while a program composes its layers, where there is no fiber to fail into
and a wrong root is a composition mistake, not a runtime outcome. The check
runs when the factory is called, before any layer exists.

It is this package's class rather than the `Jj` adapter's: a Bun caller
composed `BunHost` and should learn nothing about the adapter behind the `Jj`
slot from an error message. The message names the Bun factory that refused,
never `NodeJj`, and repeats at most 64 code points of the root before reporting
its true length, so a root taken from input cannot flood a log line. Branch on
`code`; the message is for a person.

### Models

| Export              | Type                                                            | Meaning                                             |
| ------------------- | --------------------------------------------------------------- | --------------------------------------------------- |
| `BunHost`           | `FileSystem \| Path \| ChildProcessSpawner \| Jj \| HttpClient` | The closed Host service union this bundle provides. |
| `BunHostErrorCode`  | `"invalid_repository_root"`                                     | The stable codes a factory refuses with.            |
| `ContainedOptions`  | `ProcessReaper.SpawnerOptions & ProcessReaper.Options`          | What a caller may configure about containment.      |
| `implementationIds` | `Readonly<Record<HostServiceIds[number], string>>`              | The module behind each raw bundle Host slot.        |

`ContainedOptions` carries three fields:

| Field      | Meaning                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `graceMs`  | Milliseconds between the `SIGTERM` that asks a child to stop and the `SIGKILL` that makes it. Default 2000.           |
| `ownerPid` | The pid the reaper must never signal a group for. Default `process.pid`.                                              |
| `system`   | The operating-system seam the reaper reads liveness and start times through. Default: chosen from `process.platform`. |

`platform` is deliberately not part of it. The factory uses the real
`process.platform`, so the native process-group behavior and recorded identity
agree. A caller cannot describe a Windows record for an owner that actually
leads a POSIX group. For a smaller Bun composition, use
`ProcessReaper.layerSpawner` with a ledger and an underlying runtime spawner.

Each factory reads its options when it is called and splits them into the
spawner half and the reaper half, so a field meant for one can never be read by
the other and mutating the object afterwards changes neither layer.

`implementationIds` names the raw bundle implementation behind each slot rather than the
specifier you import it through, which is why the filesystem entry is
`@smthrs/platform-node/AtomicFileSystem`. Contained factories replace the
process runner with `ProcessReaper.layerSpawner`; this static table does not
describe that substitution:

```ts
{
  "effect/FileSystem": "@smthrs/platform-node/AtomicFileSystem",
  "effect/Path": "@effect/platform-bun/BunPath",
  "effect/process/ChildProcessSpawner": "@effect/platform-bun/BunChildProcessSpawner",
  "@smthrs/jj/Jj": "@smthrs/jj/bun/BunJj",
  "effect/HttpClient": "@smthrs/platform-node/EgressHttpClient"
}
```

A key is the slot's stable identity in [`@smthrs/kernel`](/api/kernel)'s closed
list, which is not always the specifier the tag is imported from: the spawner
slot is `effect/process/ChildProcessSpawner` while its tag comes from
`effect/unstable/process/ChildProcessSpawner`. The keys are written as literals
rather than positions in that list, so reordering it cannot silently pair a slot
with another slot's implementation. Nothing digests the record yet:
[`@smthrs/plan`](/api/plan)'s step key carries a `layers` component these values
are meant to feed, but no planner derives it from a host bundle today, so
changing one invalidates no cached step.

### Re-exports

`BunHost` re-exports these modules so a program that should reach only part of
the host has one place to take it from:

| Export                   | What it is                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AtomicFileSystem`       | `@smthrs/platform-node/AtomicFileSystem`, the filesystem implementation itself.                                                                                           |
| `BunChildProcessSpawner` | `@effect/platform-bun/BunChildProcessSpawner`.                                                                                                                            |
| `BunCrypto`              | `@effect/platform-bun/BunCrypto`, the [Effect Crypto service](https://github.com/Effect-TS/effect/blob/main/packages/platform/bun/src/BunCrypto.ts) layer.                |
| `BunFileSystem`          | This package's `BunFileSystem` module.                                                                                                                                    |
| `HostLiveness`           | `@smthrs/platform-node/HostLiveness`, the [host liveness probe](/api/platform-node#liveness-and-reaping).                                                                 |
| `ProcessReaper`          | `@smthrs/platform-node/ProcessReaper`, the [contained spawner](/api/platform-node#processreaperlayerspawner) and [orphan sweep](/api/platform-node#liveness-and-reaping). |

`AtomicFileSystem` is in the set for the same reason `NodeHost` re-exports it:
it owns the only configuration escape hatch the filesystem slot has, and a Bun
program whose helper is elsewhere must reach
`AtomicFileSystem.layerWith` without adding
[`@smthrs/platform-node`](/api/platform-node) as a second dependency.

`BunJj` is deliberately absent. It belongs to [`@smthrs/jj`](/api/jj) and is
imported from there, never re-exported here.

`@effect/platform-bun/BunHttpClient` is deliberately absent too: its `layer`
follows redirects to origins the capability kernel never authorized. Take the
network slot on its own from `layerHttpClient`.

## BunFileSystem

The filesystem slot on its own.

| Export      | Signature                                 | Meaning                                                                                        |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `layer`     | `Layer<FileSystem>`                       | The filesystem slot, carrying the kernel's atomic host extension. Is `AtomicFileSystem.layer`. |
| `layerWith` | `(options: Options) => Layer<FileSystem>` | The same filesystem against an explicitly configured helper and byte limits.                   |
| `Options`   | `AtomicFileSystem.Options`                | The helper, concurrency ceiling, timeout, and byte limits `layerWith` accepts.                 |

`layer` is `@smthrs/platform-node`'s `AtomicFileSystem.layer`, the same value
behind `NodeHost`'s filesystem slot, by identity and not by resemblance. It
carries the kernel's atomic host extension, so under
[@smthrs/kernel](/api/kernel)'s `FileSystem.layer` a guarded path operation runs
descriptor-relative and no-follow instead of failing closed, and a symlink
swapped in after authorization cannot redirect it.

That extension executes its syscalls through the `smithers-jj-export` helper,
a host prerequisite. Windows is unsupported.

`layerWith` is the escape hatch for a host whose helper is outside the default
search; `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` does the same without code. `BunHost` re-exports the
same escape hatch as `AtomicFileSystem`, for parity with `NodeHost`.
`executable` is re-validated per request, because the file it names can be
replaced while the host runs; everything else is snapshotted when the layer is
built.

## Two services the bundle does not wrap

There is no shell service, and no runtime detection either, because Bun's
spawner _is_ the Node one. Running a command is Effect's `ChildProcess` and
`ChildProcessSpawner`, and there is nothing for a detection branch to choose
between.

There is no HTTP service either. `BunHost` provides the shared `EgressHttpClient.layer(process.env)`, so the
runtime never walks to a second origin behind the capability kernel's back.
Following a redirect is [@smthrs/kernel](/api/kernel)'s guarded
`HttpClient.layer`, which rechecks the capability on every hop.

## Reading next

[@smthrs/kernel](/api/kernel) owns the closed list and decorates these same tags
with capability checks. [@smthrs/platform-node](/api/platform-node) and
[@smthrs/platform-browser](/api/platform-browser) are the sibling bundles.
[The Host surface on Bun](./concepts/host-surface.md) explains what each slot
buys, [Runtime parity with Node](./concepts/runtime-parity.md) explains how far
the two runtimes are interchangeable, and
[Troubleshooting](./troubleshooting.md) lists the failures these exports
produce.
