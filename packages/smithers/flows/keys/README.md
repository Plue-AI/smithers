# `@smthrs/keys`

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://keys.smithers.sh

Give a piece of structured data a name that any process can compute for itself:
a 69-character key such as `key1_74a286a3...ec55c683`. The same input always
derives the same key, on any machine, in any release that writes this format.
Use it as a cache key, a row id, or an idempotency token.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

`@effect/platform-node` provides `NodeCrypto` for the example below and is
optional if you supply your own `Crypto` implementation.

`effect` is a peer dependency at exactly `4.0.0-rc.115`; [`@smthrs/canonical`](https://canonical.smithers.sh) and
[`@smthrs/crypto`](https://crypto.smithers.sh) install with the package and are
the only other runtime dependencies. Node.js 26.4.0 or later; the package
imports no `node:` built-in, so the same code runs under Bun and in a browser.

## Example

```typescript
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { deriveKey, StoredKey } from "@smthrs/keys"
import { Effect, Schema } from "effect"

const derived = await Effect.runPromise(
  deriveKey({ domain: "example/compile", version: 1, source: "main.ts" }).pipe(
    Effect.provide(NodeCrypto.layer)
  )
)

const parsed = Schema.decodeUnknownSync(StoredKey)(derived)
// parsed === derived
```

`deriveKey` serializes input to RFC 8785 canonical JSON through
`@smthrs/canonical`, so member order cannot change the result, then hashes that
exact document with SHA-256 through `@smthrs/crypto` and returns
`key1_<64 lowercase hex>`. Hashing is host access, so derivation returns an
Effect that requires `Crypto.Crypto`; you provide the layer.

`StoredKey` validates a key arriving from a database, an RPC, or a file and
hands it back unchanged, with no hashing and no `Crypto` service. Keep the two
apart: hand an existing key to a hash function and you get a different key
back, silently, and every identity that crosses that boundary is rewritten.
`DerivedKey` is the derivation as a schema transformation, for the places that
need a codec; prefer `deriveKey` for typed `KeyDerivationError` failures.

`KeyV1` validates today's representation. `StoredKey` validates every format
the release you installed understands, currently only `KeyV1`, so decode with
`StoredKey` at a boundary and it widens with the release instead of with your
code. An unknown prefix such as `key2_` is rejected rather than guessed.

Treat keys as opaque. Include a stable domain and a material-schema version in
each protocol's input so two subsystems cannot collide in a shared store.
Derivation inherits `Canonical` semantics, is one-shot, and imposes no size or
depth limit of its own, so bound untrusted input before canonicalizing it.

Full documentation, including the `Crypto` layer to provide on Node.js, on Bun,
and in a browser, is at https://keys.smithers.sh.
