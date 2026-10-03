---
title: "Quickstart"
description: "Derive a key for a unit of work, use it as a cache key, persist it, and validate it when you read it back."
sidebar:
  order: 2
---

This quickstart builds the smallest thing keys are for: a cache that recognizes
work it has already done. By the end you will have derived a key from
structured input, hit the cache with a differently spelled but equivalent
input, persisted the key, and validated it on the way back in.

## Prerequisites

- Node.js 26.4.0 or later.
- A package with the dependencies installed. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## Derive a key for one unit of work

Create `quickstart.ts`. The input is a plain structured value. Name the
protocol and its material version in it, so a key from this cache can never
collide with a key some other part of your system derives:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { deriveKey } from "@smthrs/keys"
import * as Effect from "effect/Effect"

interface CompileRequest {
  readonly target: string
  readonly flags: ReadonlyArray<string>
}

/** The key of one compile, under this cache's own namespace. */
const compileKey = (request: CompileRequest) =>
  deriveKey({
    domain: "quickstart/compile",
    version: 1,
    target: request.target,
    flags: request.flags
  })
```

`compileKey` returns an `Effect<KeyV1, KeyDerivationError, Crypto.Crypto>`. The
`Crypto` requirement is the hashing host: nothing is computed until you provide
one.

## Use the key as a cache key

A `Map` stands in for a real store. The point is what happens on the second
call:

```ts
const cache = new Map<string, string>()

const compile = Effect.fn("compile")(function*(request: CompileRequest) {
  const key = yield* compileKey(request)
  const cached = cache.get(key)
  if (cached !== undefined) return { key, output: cached, hit: true }

  const output = `built ${request.target} with ${request.flags.join(" ")}`
  cache.set(key, output)
  return { key, output, hit: false }
})
```

## Run it

```ts
const main = Effect.gen(function*() {
  const first = yield* compile({ target: "web", flags: ["--minify", "--sourcemap"] })
  const second = yield* compile({ target: "web", flags: ["--minify", "--sourcemap"] })

  console.log(first.key)
  console.log(first.hit, second.hit)
}).pipe(Effect.provide(NodeCrypto.layer), Effect.orDie)

await Effect.runPromise(main)
```

Run the file with your TypeScript runner:

```text
key1_331f037bd10c4bc742f2d8b50028af9424ecde88572180536a0a17c12868cbb0
false true
```

The second call is a hit because the same structured input derives the same
key. Change one flag and it misses.

## Watch a canonically equal input hit

Key derivation runs on the canonical form of your input, not its spelling. Two
objects that differ only in property order are the same document, so they are
the same key:

```ts
const equivalent = Effect.gen(function*() {
  const a = yield* deriveKey({ domain: "quickstart/compile", version: 1, target: "web" })
  const b = yield* deriveKey({ target: "web", version: 1, domain: "quickstart/compile" })
  console.log(a === b) // true
}).pipe(Effect.provide(NodeCrypto.layer))
```

This is the guarantee the whole package exists to make, and it has edges worth
knowing before you feed it real data. See
[Key material](./concepts/key-material.md).

## Validate the key on the way back in

Persist the key as text. When it comes back from a database, an RPC, or a file,
decode it through `StoredKey` before you trust it. Validation returns the same
text and needs no `Crypto` service:

```ts
import { digest, StoredKey } from "@smthrs/keys"
import * as Schema from "effect/Schema"

const fromStorage = (text: unknown) => {
  const key = Schema.decodeUnknownSync(StoredKey)(text)
  return { key, payload: digest(key) }
}
```

Do not decode a stored key through `deriveKey` or `DerivedKey`. Those hash
whatever you hand them, so a key passed in comes back as a different key, and
the mistake is silent. That is why the two operations are separate exports.

## What just happened

You derived an identity from meaning rather than from spelling, and you
validated one without recomputing it. The three steps of the derivation are
fixed and frozen for this format version, so the key printed above is the same
on any host and in any release that still writes `key1_`. Read
[Key derivation](./concepts/key-derivation.md) for what those steps are and
what the resulting identity does and does not promise.

## Next steps

- [Validate a stored key](./guides/validate-a-stored-key.md): the trust
  boundary in more detail.
- [Separate identity namespaces](./guides/separate-identity-namespaces.md): why
  the `domain` and `version` fields are there.
- [Handle a derivation failure](./guides/handle-a-derivation-failure.md): the
  two failure codes and what to do about each.
