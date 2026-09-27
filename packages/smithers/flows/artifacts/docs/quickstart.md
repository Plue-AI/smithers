---
title: "Quickstart"
description: "Publish bytes to a real objects directory, read them back, watch the address deduplicate a second put, and watch a corrupted blob get refused and then healed."
sidebar:
  order: 2
---

This quickstart runs the filesystem store against a real directory. By the end
you will have published an artifact, read it back, seen the address absorb a
second identical put, and seen the store refuse and then repair a blob you
corrupted on purpose.

## Prerequisites

- Node.js 26.4.0 or later.
- An empty directory to work in. The store writes under `.flows/objects`
  relative to the process working directory.
- The package and the Node host layers. Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

## Compose the store

Create `quickstart.ts`. The filesystem store needs Effect's `FileSystem` to
reach the disk and `Crypto` to measure bytes, so the composition provides both
and keeps them visible for the rest of the walkthrough:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"

const directory = ".flows/objects"
const payload = new TextEncoder().encode("the bytes a step produced")

const host = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)
const layer = ArtifactStore.layerFileSystem({ directory }).pipe(Layer.provideMerge(host))
```

`Layer.provideMerge` feeds the host services into the store and keeps them in
the resulting layer, so the snippets below can use `FileSystem` directly to
tamper with a blob.

## Publish an artifact and read it back

`put` measures the bytes, publishes them, and returns their address. `get`
verifies that the stored bytes still hash to the address before returning
them:

```ts
const digest = await Effect.runPromise(
  Effect.gen(function*() {
    const store = yield* ArtifactStore.ArtifactStore
    const address = yield* store.put(payload)

    console.log("address:", address)
    console.log("read back:", new TextDecoder().decode(yield* store.get(address)))
    return address
  }).pipe(Effect.provide(layer))
)
```

Each snippet below is another statement in the same file. They all provide the
same `layer`, so they all reach the same directory.

## Put the same bytes twice

There is no second copy and no second address. The store verifies the blob
already at the address, freshens its modification time so a retention sweep
reads it as recently referenced, and returns the same digest:

```ts
const again = await Effect.runPromise(
  Effect.gen(function*() {
    const store = yield* ArtifactStore.ArtifactStore
    return yield* store.put(payload)
  }).pipe(Effect.provide(layer))
)

console.log("same address:", again === digest)
```

## Read an address nothing was published under

A well-formed address with no bytes behind it is `ArtifactMissing`, a distinct
tag rather than a generic failure, because a composition with a second tier
acts on it:

```ts
const miss = await Effect.runPromise(
  Effect.gen(function*() {
    const store = yield* ArtifactStore.ArtifactStore
    return yield* store.get("0".repeat(64))
  }).pipe(
    Effect.catchTag("@smthrs/artifacts/ArtifactMissing", (failure) => Effect.succeed(failure.code)),
    Effect.provide(layer)
  )
)

console.log("absent address:", miss)
```

An address that is not 64 lowercase hexadecimal characters never reaches the
disk at all: it fails with an `ArtifactStoreError` whose code is
`invalid_digest`.

## Corrupt a blob, then heal it

Overwrite the published blob with different bytes. The next read measures what
it found, sees that it no longer matches the address, and refuses. The repair
is an ordinary put: because the store verifies the blob already at an address
rather than trusting that the path exists, the mismatch falls through to the
atomic rewrite:

```ts
await Effect.runPromise(
  Effect.gen(function*() {
    const store = yield* ArtifactStore.ArtifactStore
    const fs = yield* FileSystem.FileSystem
    const blob = `${directory}/${digest.slice(0, 2)}/${digest}`

    yield* fs.writeFile(blob, new TextEncoder().encode("tampered"))

    const refusal = yield* store.get(digest).pipe(
      Effect.catchTag("@smthrs/artifacts/ArtifactCorruption", (failure) => Effect.succeed(failure.measuredDigest))
    )
    console.log("measured instead:", refusal)

    yield* store.put(payload)
    console.log("healed:", new TextDecoder().decode(yield* store.get(digest)))
  }).pipe(Effect.provide(layer))
)
```

## Run it

Run the file with your TypeScript runner. The output is:

```text
address: 077303668cf56af8d162bb5ccccd7127f2e8baff448bf5b649530a98e9c943da
read back: the bytes a step produced
same address: true
absent address: artifact_missing
measured instead: d121be3103007b41edf96f8262925f8c7d61894afe9a041843b631f69445bc57
healed: the bytes a step produced
```

Look at what landed on disk:

```bash
find .flows/objects -type f
```

```text
.flows/objects/07/077303668cf56af8d162bb5ccccd7127f2e8baff448bf5b649530a98e9c943da
```

The two-hex directory is the digest's own prefix. It exists so a workspace that
publishes hundreds of thousands of artifacts never puts them all in one
directory.

## What just happened

Every operation was addressed by content, so nothing above needed a file name,
a bucket, or an identifier of its own. The second put stored no second copy
because the address already existed and verified, but it was not free: it
hashed its input, rehashed the stored blob, took the digest's lock, freshened
the blob, and synced it. The corrupted read failed loudly instead of returning
bytes that were not the recorded artifact, and the repair was the same call
that published it the first time.

## Next steps

- [Content addressing](./concepts/content-addressing.md): why each of those
  outcomes is the only one the store can give.
- [Share artifacts across machines](./guides/share-artifacts-across-machines.md):
  put the same store behind an HTTP cache so a second machine reads what this
  one produced.
- [Test against an artifact store](./guides/test-against-an-artifact-store.md):
  the in-memory store, which needs no directory and no temporary files.
