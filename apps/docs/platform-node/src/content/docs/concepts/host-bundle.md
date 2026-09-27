---
title: "The host bundle"
description: "Why the Host surface is a closed set of five tags, which of them this package composes and which it implements, and why there is no shell service, no HTTP wrapper, and no Windows support."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-node/docs/concepts/host-bundle.md"
---

A Smithers **host** is the boundary between a durable flow and the machine
underneath it. The surface is closed: five service tags, no more, and
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/) owns the list.

```text
FileSystem  Path  ChildProcessSpawner  Jj  HttpClient
```

Closing the list is what makes the capability check complete. The kernel
decorates each of the five with a permission check, so a program that reaches
the machine has to go through a tag the kernel is watching. A sixth capability
smuggled in beside them would be authority nobody checked.

Three of the five tags are Effect's own, from `effect/FileSystem`,
`effect/Path`, and `effect/unstable/process/ChildProcessSpawner` and
`effect/unstable/http/HttpClient`. Smithers provides implementations of them
rather than wrappers around them, so an ordinary Effect program runs on a
Smithers host unchanged. `Jj` is the one Smithers tag, and it lives in
[`@smthrs/jj`](https://jj.smithers.sh/reference/api/).

## What this package composes

`@effect/platform-node` already ships most of a Node host. `NodeHost.layer` is
mostly assembly:

| Tag                   | Implementation                          |
| --------------------- | --------------------------------------- |
| `Path`                | `NodePath.layer`                        |
| `ChildProcessSpawner` | `NodeChildProcessSpawner.layer`         |
| `HttpClient`          | `EgressHttpClient.layer(process.env)`   |
| `Jj`                  | `@smthrs/jj`'s `NodeJj.layer`           |
| `FileSystem`          | this package's `AtomicFileSystem.layer` |

Only the filesystem slot is this package's own implementation, and
[it exists because Node cannot express what the kernel needs](/concepts/descriptor-relative-filesystem/).

The HTTP slot is Undici either way. `EgressHttpClient.layer` routes it through
the egress proxy `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` name, and is exactly
`NodeHttpClient.layerUndici` when they name none, so an unproxied host is
unchanged. A bundle spans a whole host, and a host may be a sandbox whose only
way out is that proxy; a bare Undici `Agent` reads none of those variables and
dials every origin directly, which such a host drops.

`NodeHost` re-exports the pieces it composes, so a program that wants one slot
rather than the whole bundle needs no second dependency:
`NodeHost.AtomicFileSystem`, `NodeHost.ProcessReaper`, `NodeHost.NodeCrypto`,
`NodeHost.NodeFileSystem`, `NodeHost.NodeChildProcessSpawner`,
`NodeHost.NodeHttpClient`, and `NodeHost.EgressHttpClient`.

`NodeCrypto` is there for a different reason from the rest. `Crypto` is not a
Host service: it carries no host authority the kernel could attenuate, so it is
not in the closed list. Every durable composition needs one anyway, and a
program that already depends on this package for its host should not need a
second dependency for the digest.

## The four layers

The bundle ships four layers, along two independent axes: where `Jj` is rooted,
and whether spawned processes are contained.

| Layer                                       | `Jj` bound to                 | Containment |
| ------------------------------------------- | ----------------------------- | ----------- |
| `NodeHost.layer`                            | the process working directory | no          |
| `NodeHost.layerAt(root)`                    | one absolute repository root  | no          |
| `NodeHost.layerContained(options?)`         | the process working directory | yes         |
| `NodeHost.layerContainedAt(root, options?)` | one absolute repository root  | yes         |

The rooted pair exists because a durable host outlives any one working
directory. `@smthrs/flows`' `NodeRuntime` composes `layerContainedAt`, so both
the repository and the process containment are pinned by the runtime rather
than inherited from whatever shell started it.

The contained pair carries a requirement the plain pair does not: a
`ProcessLedger`. See [Process containment](/concepts/process-containment/) for what
it buys and why the ledger is not defaulted.

## What the bundle does not provide

Each of these is a decision with a consequence, not a gap.

**There is no shell service.** Running a command is Effect's `ChildProcess` and
`ChildProcessSpawner`. That means a wall-clock budget is `Effect.timeout`
around the effect rather than an option on a command record, and cancellation
is fiber interruption rather than an `AbortSignal`. A Smithers shell service
would be a second way to express what Effect already expresses, and the kernel
would then have two spawn paths to check instead of one.

**There is no HTTP service.** An outgoing request is Effect's `HttpClient`, and
`@effect/platform-node` already ships the Undici-backed implementation. Undici
follows no redirect unless a redirect interceptor is installed, and this bundle
installs none, so every hop stays a separate request. That is what lets the
kernel check `net:get` and `net:post` against the host of every URL a request
actually reaches, redirect targets included.

**There is no Windows support.** `AtomicFileSystem` needs `O_NOFOLLOW`,
`O_DIRECTORY`, and `dir_fd`, none of which Windows has, so every filesystem
call fails closed there. `ProcessReaper` still reaches `taskkill /T /F` through
`systemFor("win32")` rather than retiring every record unsignalled, because a
reaper that silently discarded records would be worse than one that says what
it does. Treat it as unsupported best-effort.

**There is no path-based fallback.** A host with no usable `smithers-jj-export` helper fails
every guarded filesystem call with `PermissionDenied`. The adapter never
degrades to a check-then-path operation, because that is exactly the race it
exists to close.

## Conformance

The bundle is not trusted to be correct because it is composed correctly. It
runs the shared host contract from `@smthrs/kernel/test/contract` twice: once
with explicit expectations, and once taking every default the suite offers,
against a loopback HTTP server so the `HttpClient` success path is asserted
rather than only its refusal.

On top of that, the atomic filesystem is compared row by row against
`@effect/platform-node`'s own adapter (open flags, errno classification, `stat`
fields, and the glob grammar), and containment is driven over real detached
process groups.
