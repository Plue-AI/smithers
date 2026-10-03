---
title: "Installation"
description: "Install @smthrs/artifacts, the runtime it requires, the Effect services each tier needs in scope, and the public import forms."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. It has exactly two runtime dependencies,
[`effect`](https://effect.website) and [`@smthrs/crypto`](/api/crypto), and both
install with it.

## What each tier needs in scope

Nothing in this package opens a file or a socket by itself. Every host effect
goes through an Effect service, which is what lets the same code run in Node,
in Bun, in a browser tab, and inside a sandbox:

| Service                                                        | Needed by                                         | Node layer              |
| -------------------------------------------------------------- | ------------------------------------------------- | ----------------------- |
| `Crypto.Crypto` from `effect/Crypto`                           | `put` and `get` on every store                    | `NodeCrypto.layer`      |
| `FileSystem.FileSystem` from `effect/FileSystem`               | the filesystem store, the sweep, the backup lease | `NodeFileSystem.layer`  |
| `Path.Path` from `effect/Path`                                 | the filesystem store                              | `NodePath.layer`        |
| `HttpClient.HttpClient` from `effect/unstable/http/HttpClient` | `RemoteArtifacts`                                 | `FetchHttpClient.layer` |

`has` and `findMissing` never hash anything, so they do not require `Crypto`.
The memory and no-op stores require no `FileSystem` or `Path` at all, which is what makes
them usable in a browser and in a test with no temporary directory.

The Node implementations live in `@effect/platform-node`:

```bash
pnpm add @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115
```

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

/** Everything every tier in this package can ask for. */
export const host = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer, FetchHttpClient.layer)
```

`FetchHttpClient` ships inside `effect`, so the shared tier adds no dependency
of its own.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import {
  ArtifactBackupLease,
  ArtifactStore,
  ArtifactStoreMetrics,
  ArtifactSweep,
  CombinedArtifacts,
  RemoteArtifacts
} from "@smthrs/artifacts"
```

Each module is also importable from its own subpath, which is the form the
guides and the [API reference](./api.md) use:

```ts
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as ArtifactSweep from "@smthrs/artifacts/ArtifactSweep"
```

Two subpath forms are blocked in the export map and are not public API:
`@smthrs/artifacts/internal/*` and `@smthrs/artifacts/*/index`.
`@smthrs/artifacts/package.json` is exported.

## What a full composition adds

A host that spills step outputs into this store composes it with the engine
packages.

- [`@smthrs/engine-store`](/api/engine-store) owns `StepBoundary`, which decides
  when a step output is inline and when it is spilled here by digest. It also
  owns `ArtifactGc`, the mark half of collection that drives `ArtifactSweep`,
  and `ArtifactSync`, which honors the download policy on replay.
- [`@smthrs/step-cache`](/api/step-cache) maps a step key to the recorded result
  that references those digests.

The end-to-end composition, from a flow to a shared cache, is on smithers.sh in
[Share results with artifacts and the step cache](/docs/guides/artifacts-cache/).

## Next step

Publish and read your first artifact in the [Quickstart](./quickstart.md).
