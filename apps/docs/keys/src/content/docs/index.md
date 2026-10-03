---
title: "@smthrs/keys"
description: "Derive a stable content key from structured data with canonical JSON and SHA-256, and validate a key you read back from storage without hashing it a second time."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/keys/docs/README.md"
---

`@smthrs/keys` gives a piece of structured data a name that any process can
compute for itself: a 69-character key such as
`key1_74a286a394e4b0619c05801dd4e7315deeb83b8203cd3c3ee7cd6033ec55c683`. The
same input always derives the same key, on any machine, in any release that
writes this format.

The package does two things and keeps them apart on purpose. `deriveKey` turns
your input into a key. `StoredKey` checks that a value arriving from a
database, an RPC, or a file really is a key, and hands it back unchanged.

## The problem it solves

A cache, an idempotency check, and a durable replay all want the same thing: a
short name for a unit of work that two processes agree on without talking to
each other. Hashing `JSON.stringify(input)` almost gets you there, and then
fails in three ways.

- Member order changes the bytes. `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` are the
  same data and would name two different units of work.
- Some values have no single JSON form. A `bigint` throws, a `Map` silently
  serializes to `{}`, and `NaN` becomes `null`, each at the point where it is
  most expensive to notice.
- Nothing separates one protocol's identities from another's. Two subsystems
  that both hash `{ id: 1 }` collide in a shared store.

This package fixes the first two: it serializes your input to
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) canonical JSON with
[`@smthrs/canonical`](https://canonical.smithers.sh/reference/api/), which fixes member order, number form,
and string escaping, and refuses a value that has no canonical form rather than
approximating one. It then hashes that exact document with SHA-256 through
[`@smthrs/crypto`](https://crypto.smithers.sh/reference/api/). The third is yours, and it costs two fields:
see [Separate identity namespaces](/guides/separate-identity-namespaces/).

There is a fourth failure, and separating derivation from validation is what
prevents it. Hand an existing key to a hash function and you get a different
key back, with nothing thrown and nothing logged. A boundary that "parses"
incoming keys that way rewrites every identity that crosses it, and the damage
surfaces much later as a cache that never hits.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

Node.js 26.4.0 or later. Hashing is host access, so
derivation runs through Effect's `Crypto` service and you choose the
implementation: [Installation](/installation/) covers the layer to provide
on Node.js, on Bun, and in a browser.

## Derive a key

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { deriveKey } from "@smthrs/keys"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const key = yield* deriveKey({ domain: "cache/compile", version: 1, target: "web", flags: ["--minify"] })
  const reordered = yield* deriveKey({ flags: ["--minify"], target: "web", version: 1, domain: "cache/compile" })
  return { key, same: key === reordered }
}).pipe(Effect.provide(NodeCrypto.layer))

console.log(await Effect.runPromise(program))
```

```text
{
  key: 'key1_a8a24926078622a3dc7a19ca9074b44d6ff55f8910ad6a2df9314922ab415a21',
  same: true
}
```

Two objects, written in different member order, produce one key. Store it as
ordinary text and use it as a cache key, a row id, or an idempotency token.
The `domain` and `version` fields are yours: they keep this cache's identities
out of every other namespace in your system.

## Validate a key you read back

When the key comes back to you, decode it. Validation returns the same text,
performs no hashing, and requires no `Crypto` service:

```ts
import { digest, StoredKey } from "@smthrs/keys"
import * as Schema from "effect/Schema"

/** Accept a key that arrived from outside this process. */
const load = (text: unknown) => {
  const key = Schema.decodeUnknownSync(StoredKey)(text)
  return { key, payload: digest(key) } // payload: the 64 hexadecimal characters, without the prefix
}
```

`StoredKey` is branded, so a plain `string` does not type-check where a
validated key is required, and the brand is obtainable only by decoding. Put it
in the schema of the record that carries the key and the record cannot decode
with a key-shaped hole in it: see
[Validate a stored key](/guides/validate-a-stored-key/).

## How this fits with @smthrs/flows

This package is one piece of the Smithers durable flow engine, whose whole
surface is re-exported by [`@smthrs/flows`](https://flows.smithers.sh/reference/api/). If you already depend
on that barrel, these functions are its `Keys` namespace and you install
nothing else:

```ts
import { Keys } from "@smthrs/flows"

/** The same effect as the example above, reached through the barrel. */
const compileKey = Keys.deriveKey({ domain: "cache/compile", version: 1, target: "web" })
```

The engine rests on this operation wherever an identity has to survive a
restart. [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) mints the default execution id of an
invocation from the flow tag and the canonical form of its payload, so
re-driving a crashed program re-attaches to the run it left behind.
[`@smthrs/engine`](https://engine.smithers.sh/reference/api/) derives the key each action dispatch is
recorded under. [`@smthrs/plan`](https://plan.smithers.sh/reference/api/) validates those keys with
`StoredKey` at its store boundary.

Install `@smthrs/keys` on its own when content-addressed identity is all you
want. It has three runtime dependencies, `effect`, `@smthrs/canonical`, and
`@smthrs/crypto`, and brings no engine, no storage, and no I/O.

`@smthrs/flows` is in turn the library behind the `smthrs` command line tool,
[`@smthrs/cli`](https://cli.smithers.sh/reference/api/), which plans, runs, and inspects durable flows. Every
key that tool prints was derived here.

## Where to go next

- [Installation](/installation/): the runtime requirement, the `Crypto`
  layer to provide, and the import forms.
- [Quickstart](/quickstart/): a cache that recognizes work it has already
  done, end to end, including the read-back path.
- [Key derivation](/concepts/key-derivation/): the three fixed steps, what
  the key guarantees, and the four things it deliberately does not.
- [Key material](/concepts/key-material/): what canonicalization erases,
  what it refuses, and why a `Redacted` value must never be key material.
- [The wire format](/concepts/wire-format/): the `key1_` representation, and
  why an unknown version prefix is rejected rather than guessed.
- [Testing](/testing/): the `Crypto` layer to provide in a unit test, and
  how to assert on a key.
- [API reference](/reference/api/): every export, with signatures, requirements, and
  failures.
- [Troubleshooting](/troubleshooting/): each failure, its cause, and its fix.
