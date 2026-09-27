# `@smthrs/artifacts`

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://artifacts.smithers.sh

The content-addressed artifact store: bytes addressed by their own SHA-256
digest. You hand it a `Uint8Array`, it hands back a 64 character address, and
any store holding those bytes returns them for that address after checking that
they still hash to it.

Reach for it when you cache or ship large byte payloads, a compiled bundle, a
build log, a model transcript, a tarball, and you care that a read either
returns the exact bytes that were published or fails. It opens no file and no
socket by itself: the filesystem and the network arrive as Effect's
`FileSystem` and `HttpClient` services, which is what lets the same store code
run in Node.js, in Bun, in a browser tab, and inside a sandbox.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

`@effect/platform-node` supplies the Node.js implementations of the services
the store asks for. The filesystem store needs exclusive writable handles,
symlink inspection, and (by default) file and directory syncing. Compose it
with the trusted host filesystem before applying the capability kernel to
workflow services; `NodeRuntime.layerHost` and `BunRuntime.layerHost` do this.
The guarded native filesystem refuses open handles and cannot back this store,
even with `durability: "best-effort"`. Use `layerMemory` on hosts without those
filesystem capabilities.

## Publish bytes and read them back

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const layer = ArtifactStore.layerFileSystem({ directory: ".flows/objects" }).pipe(
  Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodeCrypto.layer))
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

One blob landed on disk, under the first two characters of its own address. The
second `put` measured the bytes, took the digest's lock, verified the blob
already there, freshened its modification time, and synced it, then returned the
same address without rewriting the payload.

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

`ArtifactSweep` enumerates an objects directory and deletes one blob behind a
modification time fence, and `ArtifactBackupLease` keeps a sweep from deleting
a blob a running backup is still copying.

Every export, option, and error code is in the
[API reference](https://artifacts.smithers.sh/reference/api/).

## What it guarantees

- **Every read is digest verified.** A truncated blob left by a crashing
  writer, a corrupted disk, or a mis-serving shared tier is refused with
  `ArtifactCorruption`, never handed back as the recorded artifact. The memory
  store is the one deliberate exception: its address space is a private `Map`
  keyed by the digest it measured, so the address and the content cannot
  disagree.
- **Publication is atomic.** Bytes land at a temp path in the destination
  directory, are fsynced, and are renamed into place. Temp names fold a random
  per-instance token, so two processes publishing the same digest into one
  workspace never share a scratch path.
- **An existing blob is verified on every `put`.** The objects directory is
  shared, so a remembered proof could outlive the bytes it proved. A mismatch
  or failing read falls through to the atomic rewrite and heals the address.
- **The endpoint and its credentials are a capability, never an input.** They
  arrive as layer construction options, so they are never hashed into a cache
  key and never recorded. `RemoteArtifacts` refuses a non-HTTPS endpoint, and
  any endpoint carrying credentials, a query, or a fragment, at construction.
  The sanitized message names only the violated rule, so the failure text never
  echoes the endpoint.

Every `put` snapshots its bytes when the Effect begins. Stores never retain a
caller-owned buffer, and every successful `get` returns a new byte array.

## Defaults

| Boundary                                  | Default                 | Guarantee                                                                    |
| ----------------------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| Filesystem directory                      | `.flows/objects`        | Two-hex fanout, atomic publication, digest verification, required fsync      |
| Cross-process coordination                | `required`              | Writers and sweepers share per-digest lock files; stale owners are recovered |
| Remote request, upload, download deadline | 60 seconds each         | No remote exchange can wait forever                                          |
| Maximum downloaded blob                   | 256 MiB                 | The body is rejected before or while buffering past the limit                |
| `findMissing` batch and response          | 1,000 digests / 256 KiB | Inputs are validated and deduplicated in first-seen order                    |

`invalid_configuration` and `invalid_digest` are permanent caller failures.
`ArtifactMissing` is an ordinary miss, and `ArtifactCorruption` is an integrity
failure. `digest_failed`, `unavailable`, and `transport_failed` describe host
or transport failures whose retryability depends on the host and operation.
[Troubleshooting](https://artifacts.smithers.sh/troubleshooting/) lists each
one with what to change.

## Prior art

The contract's ergonomics follow Effect's own `KeyValueStore`: one small set of
total operations over one address space, so memory, filesystem, and network
implementations are the same shape. Everything else follows Bazel's
remote-cache classes: `findMissing` is
[`MissingDigestsFinder`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/remote/common/MissingDigestsFinder.java),
one batched probe whose result is a subset of its input; the two-hex fanout and
the fsync before the rename are
[`DiskCacheClient`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/remote/disk/DiskCacheClient.java);
and the wire protocol, CAS blobs under `/cas/base16-key`, is
[`HttpCacheClient`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/remote/http/HttpCacheClient.java).
Where this package deviates, and why, is in
[content addressing](https://artifacts.smithers.sh/concepts/content-addressing/).

## Where it fits

This package is one piece of the Smithers durable flow engine, whose whole
surface is re-exported by [`@smthrs/flows`](https://flows.smithers.sh). Inside
that engine the artifact store is the byte half of the result cache:
[`@smthrs/step-cache`](https://step-cache.smithers.sh) records what a step
returned, and any part of that result too large to sit inline is spilled here
and referenced by digest.

Install `@smthrs/artifacts` on its own when a content-addressed byte store is
all you want. Nothing in it knows what a flow, a step, or a run is.

Reclaiming published artifacts is an explicit operation, never a side effect of
a store call. The `.tmp-*` sweep in `layerFileSystem` reclaims crash orphans
only. `ArtifactSweep` is the deletion surface, and the mark phase that decides
what is live belongs to
[`@smthrs/engine-store`](https://engine-store.smithers.sh).

## License

MIT
