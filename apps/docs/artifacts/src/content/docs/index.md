---
title: "@smthrs/artifacts"
description: "A content-addressed byte store for Effect: publish bytes, get back their SHA-256 address, and read them back verified from a directory, an in-memory map, an HTTP cache, or a local tier backed by a shared one."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/artifacts/docs/README.md"
---

`@smthrs/artifacts` stores bytes under their own SHA-256 digest. You hand it a
`Uint8Array`, it hands back a 64 character address, and any store holding those
bytes returns them for that address after checking that they still hash to it.

## The problem it solves

A program that caches large outputs (a compiled bundle, a build log, a model
transcript, a tarball) has to answer two awkward questions: what to call each
blob, and whether the blob is still what its name claims. Names collide, drift,
and need a namespace of their own. Nothing about a name proves that the bytes
behind it were not truncated by a crashed writer or replaced by a broken
cache.

Addressing bytes by their digest answers both at once. Two callers that produce
identical bytes produce one address, so no copy is stored twice and the second
write never rewrites the payload. That second write is not free: it hashes its
input, rehashes the stored blob, takes and releases a lock file, freshens the
blob's modification time, and syncs the blob and its directories. An address is
a claim the store can recheck on every read, so a mismatch surfaces as a typed
failure instead of a wrong result flowing into whatever consumes it.

Reach for this package when you cache or ship large byte payloads and you care
that a read either returns the exact bytes that were published or fails. It has
two runtime dependencies, `effect` and [`@smthrs/crypto`](https://crypto.smithers.sh/reference/api/), owns no
database, and opens no file and no socket by itself: the filesystem and the
network arrive as Effect's `FileSystem` and `HttpClient` services, which is what
lets the same store code run in Node.js, in Bun, in a browser tab, and inside a
sandbox.

The two-minute coordination acquisition deadline includes the in-process
semaphore wait and filesystem lock acquisition. It does not time out the
protected operation. Semaphores are scoped by filesystem service, objects
directory, and digest. An interrupted backup acquisition removes the marker
it created, including interruption during marker creation or gate release.
Host completion and release finalizers can extend cancellation latency.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

`@effect/platform-node` supplies the Node.js implementations of the services
the store asks for. A browser or a test host provides different ones.

## Publish bytes and read them back

This publishes a payload into `.flows/objects`, publishes the identical payload
a second time, and reads it back:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const layer = ArtifactStore.layerFileSystem({ directory: ".flows/objects" }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer))
)

const program = Effect.gen(function*() {
  const store = yield* ArtifactStore.ArtifactStore
  const bytes = new TextEncoder().encode("the bytes a build step produced")

  const address = yield* store.put(bytes)
  const again = yield* store.put(bytes)

  console.log(address)
  console.log(again === address)
  console.log(new TextDecoder().decode(yield* store.get(address)))
})

await Effect.runPromise(program.pipe(Effect.provide(layer)))
```

```text
6bb29e0869012afcfc246886c647422236e0b7d3419d3dc4ded8da758a4dfeb3
true
the bytes a build step produced
```

One blob landed on disk, at
`.flows/objects/6b/6bb29e0869012afcfc246886c647422236e0b7d3419d3dc4ded8da758a4dfeb3`.
The second `put` measured the bytes, took the digest's lock, verified the blob
already there, freshened its modification time, and synced it, then returned
the same address without rewriting the payload. The `get` measured what it read
before returning it, so a blob that had been truncated or overwritten would
have failed with `ArtifactCorruption` rather than handing back the wrong
bytes.

## Filesystem security and existing stores

New payloads are created exclusively (`wx`) with mode `0600`. New objects,
fanout, and lock directories use `0700`. The host umask may restrict these
modes further. Set `fileMode` and `directoryMode` explicitly to share payloads
and object directories; lock directories remain private. Creation modes do
not change existing entries or ACLs.

Scratch creation retries collisions with a fresh random token, keeping the
opened handle through writing and syncing. Both durability modes require
exclusive writable handles and symlink inspection. `best-effort` tolerates
sync refusals only. Hosts without those capabilities fail as `unavailable`;
use the memory or remote tier until the host supplies them.

Publication and sweep removal reject detected symlinks at the objects root,
fanout, and blob paths, and recheck directory identities before mutation.
Reads and probes (`get`, `has`, `findMissing`) refuse the same symlinks as
`unavailable` instead of following them, so a planted link is never reported
as a stored blob. The `.locks` directory is refused as a symlink before and
after creation, and its identity is rechecked before every lock, claim, and
tombstone mutation.
Scratch cleanup and inventory inspect one directory level at a time and skip
symlinked entries. The portable Effect filesystem API provides no `lstat`,
no-follow open, or descriptor-relative rename/unlink. Inspection uses
`readLink` plus `stat`; a replacement after the final check can still redirect
a pathname operation. These checks are defense in depth, not containment
against a process able to replace directory entries concurrently. Keep the
store and its ancestors writable only by trusted principals, or supply a
filesystem confined by the host. Closing this race requires a host capability
that enforces containment during each mutation.

Before reusing an existing store, stop writers and sweepers and audit the
objects root, its ancestors, fanouts, blobs, lock entries, ownership, modes,
and ACLs without following symlinks. Remove unexpected links and migrate
verified blobs into a newly created private store, or apply owner-only modes
to verified regular files and directories. Do not run a recursive permission
change across unaudited links. Existing readable blobs remain readable after
an upgrade, including deduplicated blobs.

## The stores you can compose

Every implementation is the same four operations, `put`, `get`, `has`, and
`findMissing`, so a composition swaps one for another without touching a
caller:

| Constructor                    | What backs it                               | Use it for                                 |
| ------------------------------ | ------------------------------------------- | ------------------------------------------ |
| `ArtifactStore.makeFileSystem` | A directory, reached through `FileSystem`   | The durable local tier                     |
| `ArtifactStore.makeMemory`     | A private `Map`                             | Tests, and hosts with no durable disk      |
| `ArtifactStore.makeNoop`       | Nothing, with per-method overrides          | Declaring a tier honestly unavailable      |
| `RemoteArtifacts.make`         | An HTTP cache, reached through `HttpClient` | The tier several machines share            |
| `CombinedArtifacts.make`       | A local store in front of a shared one      | Read local first, fall through, write back |

Two more modules cover the lifecycle of the filesystem tier: `ArtifactSweep`
enumerates an objects directory and deletes one blob behind a modification time
fence, and `ArtifactBackupLease` keeps a sweep from deleting a blob that a
running backup is still copying.

## How this fits with @smthrs/flows

This package is one piece of the Smithers durable flow engine, whose whole
surface is re-exported by [`@smthrs/flows`](https://flows.smithers.sh/reference/api/). Inside that engine the
artifact store is the byte half of the result cache:
[`@smthrs/step-cache`](https://step-cache.smithers.sh/reference/api/) records what a step returned, and any
part of that result too large to sit inline is spilled here and referenced by
digest. If you already depend on `@smthrs/flows`, this store is its
`Artifacts` namespace and there is nothing further to install:

```ts
import { Artifacts } from "@smthrs/flows"

const layer = Artifacts.ArtifactStore.layerFileSystem({ directory: ".flows/objects" })
```

Install `@smthrs/artifacts` on its own when a content-addressed byte store is
all you want. Nothing in it knows what a flow, a step, or a run is.

`@smthrs/flows` is in turn the library behind the `smithers` command line tool,
[`@smthrs/cli`](https://cli.smithers.sh/reference/api/), which runs and inspects durable flows. The artifacts
that tool stores, replays, and garbage collects are the blobs this package
publishes.

## Where to go next

- [Installation](/installation/): the runtime it needs, which Effect service
  each tier requires in scope, and the public import forms.
- [Quickstart](/quickstart/): publish an artifact against a real directory,
  then corrupt a blob on purpose and watch the store refuse it and heal it.
- [Content addressing](/concepts/content-addressing/): why an address is a
  measurement, and the four invariants that keep an address and its bytes from
  disagreeing.
- [The three tiers](/concepts/tiers/): what a combined store does with a
  miss, a refusal, and a corrupt address, and what the download policy changes.
- [Coordination between processes](/concepts/coordination/): the locks,
  heartbeats, and fences that let several processes share one objects
  directory.
- [Share artifacts across machines](/guides/share-artifacts-across-machines/):
  compose a local store behind an HTTP cache.
- [Serve the artifact protocol](/guides/serve-the-artifact-protocol/): the
  four requests a shared tier owes, if you are writing the service.
- [Test against an artifact store](/guides/test-against-an-artifact-store/):
  the memory store, scripted refusals, and a loopback server.
- [API reference](/reference/api/): every export, option, and error code.
- [Troubleshooting](/troubleshooting/): each failure, what caused it, and
  what to change.
