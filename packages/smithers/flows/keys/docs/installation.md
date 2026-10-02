---
title: "Installation"
description: "Install @smthrs/keys, provide the Effect Crypto service that derivation requires, and pick an import form."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

`@effect/platform-node` provides `NodeCrypto` for the example below and is
optional if you supply your own `Crypto` implementation.

[`effect`](https://effect.website) is a peer dependency at exactly `4.0.0-rc.115`,
because the schemas this package exports have to be the ones your own code
composes with. Two more dependencies install with the package and are the only
ones: [`@smthrs/canonical`](/api/canonical) for the serialization and
[`@smthrs/crypto`](/api/crypto) for the digest.

The package requires Node.js 26.4.0 or later and ships as ESM and CommonJS
with TypeScript declarations.

## Provide a Crypto service

`deriveKey` and `DerivedKey` return an Effect that requires
`Crypto.Crypto` from `effect/Crypto`. The package imports no `node:` builtin
and ships no implementation of its own, which is what lets the same source
bundle for a browser. You choose where the hashing happens.

On Node.js or Bun, use the platform layer:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { deriveKey } from "@smthrs/keys"
import * as Effect from "effect/Effect"

const program = deriveKey({ domain: "docs/install", version: 1 }).pipe(
  Effect.provide(NodeCrypto.layer)
)
```

Where you want no platform dependency at all, `@smthrs/crypto` ships a
synchronous SHA-256-only service. It refuses randomness and every other digest
algorithm, so use it for identity construction and supply a real platform layer
for anything else:

```ts
import { syncCrypto } from "@smthrs/crypto"
import { deriveKey } from "@smthrs/keys"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const key = Effect.runSync(
  deriveKey({ domain: "docs/install", version: 1 }).pipe(
    Effect.provide(Layer.succeed(Crypto.Crypto)(syncCrypto))
  )
)
```

In a browser, compose `BrowserCrypto` from `@effect/platform-browser`, or the
synchronous service above. [`@smthrs/platform-browser`](/api/platform-browser)
deliberately omits `Crypto`, so it does not pick for you.

`StoredKey`, `KeyV1`, and `digest` require no `Crypto` service. A boundary that
only validates keys installs nothing.

## Import forms

The root entry point re-exports every module:

```ts
import { DerivedKey, deriveKey, digest, KeyDerivationError, KeyV1, StoredKey } from "@smthrs/keys"
```

Every name is also importable from the `Key` subpath:

```ts
import * as Key from "@smthrs/keys/Key"
```

Two subpath forms are blocked in the export map and are not public:
`@smthrs/keys/internal/*` and `@smthrs/keys/*/index`.
`@smthrs/keys/package.json` is exported.

## Next step

Derive a key, store it, and read it back in the [Quickstart](./quickstart.md).
