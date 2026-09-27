---
title: "Troubleshooting"
description: "The failures @smthrs/platform-bun produces: a missing required peer, a refused repository root, a filesystem guard that fails closed, an unfollowed redirect, a missing process ledger, and a browser bundle that will not resolve."
---

Find the symptom, read the cause, apply the fix. Every failure here is one this
package or its slots actually produce; the signatures behind them are on the
[API reference](./api.md).

## ERR_MODULE_NOT_FOUND for @effect/platform-bun/BunChildProcessSpawner

**Symptom.** The first `import { BunHost } from "@smthrs/platform-bun"`, or
`import * as BunHost from "@smthrs/platform-bun/BunHost"`, throws
`ERR_MODULE_NOT_FOUND` before any of your code runs.

**Cause.** The install is missing the required `@effect/platform-bun` peer,
which both the root entry point and `BunHost` import at module load. This can
happen with an older package version that marked it optional, or when peer
installation was disabled.

**Fix.** Install it yourself, at the version your composition's `effect` is
built against:

```bash
pnpm add @effect/platform-bun@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115
```

`@smthrs/platform-bun/BunFileSystem` is the one entry point that resolves
without it, because it imports nothing from `@effect/platform-bun`.

## BunHostError: requires an absolute repository root

**Symptom.** `BunHost.layerAt` or `BunHost.layerContainedAt` throws while your
program is still composing its layers:

```text
BunHostError: BunHost.layerAt requires an absolute repository root, got "repositories/app"
```

**Cause.** The root is not absolute. The empty string counts, and so does a
path that looks absolute only after the process working directory is applied.

**Fix.** Resolve the root before you hand it over, and branch on
`error.code === "invalid_repository_root"` rather than on the message text. The
message names the Bun factory that refused and repeats at most 64 code points
of the root, so a root taken from input cannot flood a log line. See
[Bind the host to a repository root](./guides/bind-a-repository-root.md).

## PermissionDenied: descriptor-relative filesystem isolation failed closed

**Symptom.** A guarded filesystem operation fails, naming the helper it
could not find:

```text
PlatformError: PermissionDenied: AtomicFileSystem.writeFileString (/tmp/work/x.txt):
descriptor-relative filesystem isolation failed closed:
Error: smithers-jj-export is missing; install @smthrs/platform-node with its native helper, ...
```

**Cause.** The filesystem slot's no-follow extension executes its syscalls
through the `smithers-jj-export` helper, and no usable helper was found, or
the one it was told to spawn is missing or not executable. The guard fails closed rather than falling back to a path-based
operation, because a path-based fallback is exactly the symlink race the
extension exists to prevent.

**Fix.** Run `cargo +1.98.0 build --locked --release -p smithers-ffi --bin smithers-jj-export`
in a source checkout, or set `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` to an
absolute helper path. See
[Configure the filesystem helper](./guides/configure-the-filesystem-helper.md).

This failure is unguarded-path-safe: it appears only under
[`@smthrs/kernel`](/api/kernel)'s `FileSystem.layer`. A program that uses
`BunFileSystem.layer` without the kernel's guard never starts the helper, so a
missing helper goes unnoticed until the guard is composed.

## BadResource: Not a directory, on a path that exists

**Symptom.** Reading a file through a directory symlink fails with a
`BadResource` reason, and the same path opens fine from a shell:

```text
{ "_tag": "BadResource", "syscall": "open", "description": "[Errno 20] Not a directory: 'escape'" }
```

**Cause.** This is the guard working. The component named a symlink pointing
outside the workspace boundary, and the descriptor-relative helper refuses to
traverse it rather than following it. A path-based filesystem would have
followed the link and returned the bytes.

**Fix.** Nothing, if the boundary is the one you meant. If the target is
legitimately part of the workspace, move it inside the boundary root rather
than reaching it through a link.

## A 302 comes back instead of the redirected response

**Symptom.** `HttpClient.execute` returns status `302` with a `location`
header, and the destination never receives a request.

**Cause.** The bundle configures Effect's fetch-backed client with
`RequestInit { redirect: "manual" }`, deliberately. A client that follows a
redirect on its own reaches a second origin the capability kernel never
authorized.

**Fix.** Compose [`@smthrs/kernel`](/api/kernel)'s guarded `HttpClient.layer`,
which follows redirects and rechecks the capability on every hop. Handling the
`302` yourself is the other option, and it puts the authorization decision in
your code.

## layerContained will not compose without a ProcessLedger

**Symptom.** `BunHost.layerContained(...)` does not satisfy a
`Layer.Layer<BunHost>`, and the type error names
`@smthrs/kernel/ProcessLedger`.

**Cause.** Both contained factories return
`Layer.Layer<BunHost | Crypto.Crypto, JjError, ProcessLedger.ProcessLedger>`.
The ledger is a
requirement rather than a built-in default, because the durable half is only as
good as the journal underneath it, and only your program knows whether it has
one.

**Fix.** Provide a ledger. `ProcessLedger.layerMemory({ hostId, ownerPid })`
contains this incarnation's children and inherits nothing;
`ProcessLedger.layer` writes through a [`@smthrs/journal`](/api/journal)
`Journal` and is what makes the cross-incarnation sweep real. See
[Contain and reap child processes](./guides/contain-child-processes.md).

## A contained child outlives the host

**Symptom.** After a crash, a `sleep`, a `jj`, or a build tool the host started
is still running, and the next incarnation does not kill it.

**Cause, and what to check in order.**

1. **The ledger was in-memory.** `ProcessLedger.layerMemory` records nothing
   durably, so the next incarnation inherits an empty orphan set. Use
   `ProcessLedger.layer`.
2. **The `hostId` changed.** Inheritance is keyed on it. Two incarnations of
   the same host must pass the same string.
3. **The reaper declined.** `ProcessReaper.reap` refuses to signal a record
   whose numbers do not clearly name an abandoned process: the owning
   incarnation is alive, the pid is gone, the pid exists but did not start when
   the record says it did, the record predates the machine's boot, or the
   record names this host's own group. Three of those refusals leave the record
   inherited so a later incarnation can try again.
4. **The child was started around the host.** A process spawned with
   `node:child_process` directly, rather than through the host's
   `ChildProcessSpawner`, is in no ledger and no reaper can find it. Under
   `BunHost.layer` that includes `jj`, which is why the contained factories
   build `Jj` over the contained spawner.

## A bundler cannot resolve node:fs

**Symptom.** Bundling for a browser fails on `node:fs`, `node:path`, or
`node:child_process` reached from `@smthrs/platform-bun`.

**Cause.** The bundle falls back to the `@effect/platform-node` adapters off
Bun, so it resolves `node:` built-ins by design. That is what makes one bundle
run on both runtimes, and it is exactly what a browser bundler cannot resolve.

**Fix.** Compose [`@smthrs/platform-browser`](/api/platform-browser) in the
page. It fills the same five slots from browser primitives, so the program
between them does not change. See
[Runtime parity with Node](./concepts/runtime-parity.md).

## Jj fails with not_installed

**Symptom.** Building any complete bundle fails with a `JjError` whose code
is `not_installed` or `unsupported_version` before the program body runs,
even when the program never asks for `Jj`.

**Cause.** No usable `jj` executable, or one older than 0.39.0. Every
`BunHost` factory builds its `Jj` layer eagerly, and that layer probes
`jj --version` at construction. This package vendors no binaries and installs
nothing on your behalf.

**Fix.** Install [Jujutsu](https://jj-vcs.github.io), which provides the `jj`
command, or set `SMITHERS_JJ_PATH` to the executable you want spawned.
[`@smthrs/jj`](/api/jj) documents the resolution order and the failure codes.
