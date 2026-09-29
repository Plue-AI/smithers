---
title: "The Host surface on Bun"
description: "The five service slots a Smithers program reaches the world through, what fills each one on Bun, why the bundle adds no shell and no HTTP wrapper, and how to take one service without the other four."
sidebar:
  order: 1
---

Smithers programs do not call `node:fs`, `Bun.spawn`, or a global `fetch`.
Everything that touches the outside world enters through a closed list of five
Effect service tags, and a host bundle is the thing that fills them:

| Slot            | Tag                                           |
| --------------- | --------------------------------------------- |
| Filesystem      | `effect/FileSystem`                           |
| Path            | `effect/Path`                                 |
| Child processes | `effect/unstable/process/ChildProcessSpawner` |
| Version control | `Jj`, from [`@smthrs/jj`](/api/jj)            |
| Network         | `effect/unstable/http/HttpClient`             |

The list is closed for one reason, owned by
[`@smthrs/kernel`](/api/kernel): a service that is not on it cannot be
attenuated, denied, or audited, so it must not exist.

Closing the list does not make the platform implementations part of a step's
identity. [`@smthrs/plan`](/api/plan)'s step key digests only the `layers` its
caller passes it, so "which platform implementations were in scope" is an
explicit input a caller supplies, not something this bundle contributes. The
identity table below is data to pass; nothing reads it for you.

`BunHost.layer` provides all five, and `BunHost` is the type union of them:

```ts
export type BunHost = FileSystem | Path.Path | ChildProcessSpawner | Jj | HttpClient
```

## What fills each slot, and whose code it is

`BunHost.implementationIds` is this mapping as data, so a swapped
implementation is a visible change to a public value rather than a comment
that drifted:

```ts
import { BunHost } from "@smthrs/platform-bun"

BunHost.implementationIds
// {
//   "effect/FileSystem": "@smthrs/platform-node/AtomicFileSystem",
//   "effect/Path": "@effect/platform-bun/BunPath",
//   "effect/process/ChildProcessSpawner": "@effect/platform-bun/BunChildProcessSpawner",
//   "@smthrs/jj/Jj": "@smthrs/jj/bun/BunJj",
//   "effect/HttpClient": "@smthrs/platform-node/EgressHttpClient"
// }
```

Each value names the module actually behind the slot, not the specifier you
import it through. The filesystem entry says
`@smthrs/platform-node/AtomicFileSystem` because that is the implementation,
even though a Bun program reaches it through this package. Each key is the
slot's stable identity in the closed list, which is likewise not always the
specifier the tag comes from: the spawner key is
`effect/process/ChildProcessSpawner` while its tag is imported from
`effect/unstable/process/ChildProcessSpawner`.

Nothing digests these values today. [`@smthrs/plan`](/api/plan)'s step key
carries a `layers` component they are meant to feed, but no planner derives it
from a host bundle yet, so changing one invalidates no cached step.

## Three slots the bundle does not implement

**Path** is runtime independent. `effect/Path`'s own layer goes in the slot
unchanged, and the kernel keeps `Path` on the closed list as an explicit
pass-through decision rather than dropping it.

**Child processes** are Effect's. `@effect/platform-bun`'s
`BunChildProcessSpawner` is `@effect/platform-node-shared`'s spawner
re-exported, which means Bun and Node run literally the same module. There is
no Bun shell wrapper here and no runtime detection, because there is nothing
to choose between. See
[Runtime parity with Node](./runtime-parity.md) for what that means for your
program, and where the parity stops.

**The network** is Effect's `HttpClient`. There is no Smithers transport port
beneath it, because a raw port would be a second way to reach the network
whose contract never mentions permission. The bundle provides
`@smthrs/platform-node`'s egress client, with hostname-based proxy routing
and connection pinning for web tools.

## Redirects and connection pinning

```ts
const layerHttpClient: Layer.Layer<HttpClient> = EgressHttpClient.layer(process.env)
```

A `302` therefore comes back to the caller as a `302`, with its `location`
header intact and the second origin never contacted. That is deliberate: a
client that follows a redirect on its own reaches a host the capability kernel
never authorized. Following a redirect is the kernel's guarded
`HttpClient.layer`, which rechecks the capability on every hop.

## Two slots the bundle composes from Smithers packages

**Version control** is `Jj`, the service whose methods make a step reversible:
snapshot, restore, diff, workspace lanes. It runs the `jj` command from
[Jujutsu](https://jj-vcs.github.io), a version-control system that works on a
Git repository, so the slot needs that binary on the host. Bun's adapter is
`@smthrs/jj/bun/BunJj`, which is the Node adapter under another name because
Bun implements the child-process API it uses. The adapter is imported from
[`@smthrs/jj`](/api/jj) and deliberately not re-exported here: it belongs to
that package.

**The filesystem** is `@smthrs/platform-node`'s `AtomicFileSystem`, byte for
byte the layer [`@smthrs/platform-node`](/api/platform-node) puts in its own
filesystem slot. It carries the kernel's atomic host extension, which is what
lets the kernel's guarded `FileSystem.layer` perform a guarded path operation
descriptor-relative and no-follow instead of failing closed. With the
extension, the operation runs against file descriptors, so a symlink swapped in
after authorization cannot redirect it somewhere else. Without a working one,
every guarded path operation is refused with a typed `PermissionDenied` rather
than falling back to a path-based call, because the fallback is the race the
extension exists to prevent.

That extension executes its syscalls in a `smithers-jj-export` subprocess
rather than in-process, which is why the host needs that helper. See
[Configure the filesystem helper](../guides/configure-the-filesystem-helper.md).

## Taking one service without the other four

`BunHost` re-exports the single-slot modules, so a program that should
reach only part of the host has one import to take it from:

```ts
import { BunHost } from "@smthrs/platform-bun"

BunHost.AtomicFileSystem // the filesystem implementation, with its options
BunHost.BunFileSystem // the filesystem slot as this package spells it
BunHost.BunChildProcessSpawner
BunHost.layerHttpClient // the network slot, redirects stopped
```

`@effect/platform-bun/BunHttpClient` is not re-exported: its `layer` follows
redirects, which is the escape the section above closes.

`AtomicFileSystem` is in that set for a specific reason: it owns the only
configuration escape hatch the filesystem slot has, and a Bun program whose
helper is elsewhere must be able to reach
`AtomicFileSystem.layerWith` without adding
[`@smthrs/platform-node`](/api/platform-node) as a second dependency.

Composing individual slots yourself means you own the closure. `BunHost.layer`
is the only thing that guarantees all five are present and consistent; a
hand-composed subset is a surface the kernel can still guard, but not one this
package pins.
