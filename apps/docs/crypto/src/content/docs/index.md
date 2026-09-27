---
title: "@smthrs/crypto"
description: "Strict SHA-256 for TypeScript: one branded digest representation, an injected Effect Crypto service, and a synchronous entry point that needs no service."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/crypto/docs/README.md"
---

`@smthrs/crypto` computes SHA-256 digests and gives them exactly one
representation: 64 lowercase hexadecimal characters, branded as `Digest`.

Hashing is host access, so the cryptographic operation goes through
[Effect](https://effect.website)'s `Crypto` service: a Node process, a Bun
process, a browser, or a test supplies the implementation, and the code that
hashes does not change. One entry point deliberately does not inject.
`digestSync` uses the package's own FIPS 180-4 implementation, so a pure
synchronous constructor can compute an identity without suspending.

## Why you would reach for it

`node:crypto` already computes SHA-256. Reach for this package when the digest
is part of a contract that two programs, or one program and its future self,
have to agree on.

- **Which bytes did you hash?** `TextEncoder` replaces an unpaired UTF-16
  surrogate with U+FFFD, so two different broken strings hash to the same
  value. This package refuses them with a typed `invalid_text` failure. It
  applies no Unicode normalization, accepts `Uint8Array` and nothing else in
  the byte position rather than coercing an `ArrayBuffer` or a plain array,
  and hashes a subarray's own window.
- **Which form is the digest?** `createHash().digest()` returns a `Buffer`
  unless every call site remembers to ask for `"hex"`, and the casing is then
  up to whoever wrote that line. Here there is one form, and `Digest` is a
  schema that rejects an uppercase, truncated, or whitespace-padded value
  before it reaches your storage layer.
- **Where does the hashing happen?** A Node build, a browser build, and a test
  with a scripted or deliberately broken host all run the same code, because
  the host arrives as a service rather than an import.
- **What about code that cannot suspend?** An identity computed inside a pure
  constructor has no Effect to suspend in. `digestSync` requires no service
  and returns the identical digest.

## What SHA-256 gives you here, and what it does not

SHA-256 is a collision-resistant hash function. It is not a message
authentication code, not a key derivation function, and not a password hash.
This package adds no key, no salt, and no iteration count, so it defends
against nothing that SHA-256 by itself does not.

Read [the contract](/contract/) before you make a digest a security
boundary. It states every guarantee in full and names the attacks this package
does not stop, including length extension, brute-force recovery of a
low-entropy input, and a `Crypto` service that returns bytes of its own
choosing.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

`effect` is the only runtime dependency. `digest` also needs a `Crypto`
service, which `@effect/platform-node`, `@effect/platform-bun`, and
`@effect/platform-browser` each provide as a layer. For the runtime
requirements, the import forms, and the full list of services you can supply,
see [Installation](/installation/).

## The smallest real example

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { digest, digestSync } from "@smthrs/crypto"
import { Effect } from "effect"

const injected = await Effect.runPromise(
  digest("hello").pipe(Effect.provide(NodeCrypto.layer))
)
const synchronous = digestSync("hello")

// Both are:
// 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```

The two entry points agree on every input they both accept: the same bytes,
the same hash, and the same encoding, whether or not a service is involved.

A digest that arrives from a database column, a URL segment, or a request body
is an ordinary untrusted string. `Digest` settles the claim without hashing
anything, so it needs no service:

```ts
import { Digest } from "@smthrs/crypto"
import * as Schema from "effect/Schema"

const address = Schema.decodeUnknownSync(Digest)(untrusted)
// The same string, typed as Digest. Anything that is not 64 lowercase
// hexadecimal characters throws a SchemaError instead.
```

That branded type is the point of the schema: a function declared to take a
`Digest` cannot be called with a `string` nobody checked. The
[Quickstart](/quickstart/) takes one value through hashing, storage, and
validation on the way back.

## The package at a glance

The root entry point exports every name below. Each is also importable from
`@smthrs/crypto/Sha256`.

| Export                           | What it is                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `digest`                         | Hashes text or bytes through the injected `Crypto` service. Fails with `Sha256Error`.                  |
| `digestSync`                     | Hashes text or bytes with the package's own implementation. Throws `Sha256Error`.                      |
| `Digest`                         | The schema and brand for a digest: 64 lowercase hexadecimal characters. It validates and never hashes. |
| `Sha256`                         | The one-way schema transformation from text or bytes to `Digest`.                                      |
| `Sha256Error`, `Sha256ErrorCode` | The typed boundary failure and its five stable codes.                                                  |
| `syncCrypto`                     | A SHA-256-only `Crypto` service backed by the synchronous implementation. It refuses randomness.       |

Every export, with its signature and its failure modes, is on the
[API reference](/reference/api/).

## What the package guarantees

- **One representation.** A digest is 64 lowercase hexadecimal characters or
  it is not a `Digest`. Uppercase, truncated, padded, and non-hexadecimal
  values are rejected by the schema.
- **The host sees a snapshot.** `digest` copies byte input when its Effect
  begins, before the host is called, and `digestSync` copies during the call.
  Mutating your array afterwards cannot change the operation in flight.
- **The result is a copy.** Host output is copied before it is encoded, so a
  host that reuses one output buffer cannot rewrite a digest you already hold.
- **Malformed text is refused, not replaced.** A string containing an unpaired
  UTF-16 surrogate fails with `invalid_text` instead of being encoded as a
  replacement character, so two different broken strings never collide on one
  digest.
- **Messages omit hash input.** Every `Sha256Error` message omits the hashed
  value. The `Sha256` schema disables input reporting for its own node only.
  Composed schemas must pass `reportInput: false` at the outermost decode
  boundary and must not re-enable it on descendant schemas.

[The injected boundary](/concepts/injected-hashing/) and
[what a digest covers](/concepts/what-a-digest-covers/) explain why each of
those holds.

## How this fits with @smthrs/flows

`@smthrs/crypto` is one package of the Smithers durable flow engine, published
on its own so a program that needs SHA-256 does not have to take the engine
with it. [`@smthrs/flows`](https://flows.smithers.sh/reference/api/) is the barrel that re-exports the whole
engine, this package included, so code that already depends on flows reaches
the same module as a namespace with no second dependency:

```ts
import { Crypto } from "@smthrs/flows"

Crypto.digestSync("hello")
```

Inside that engine, digests are how work is identified: a step's cache key, an
artifact's address, a flow's execution id, a plan card's identity. One input
policy and one wire format hold across all of them because they all hash
through this package. The layers above it belong to its neighbours:
[`@smthrs/canonical`](https://canonical.smithers.sh/reference/api/) turns a structured value into stable
bytes, [`@smthrs/keys`](https://keys.smithers.sh/reference/api/) turns bytes plus a domain into a versioned
`key1_` string, and [`@smthrs/artifacts`](https://artifacts.smithers.sh/reference/api/) stores bytes under
their digest and verifies them on the way back out. Reach for those rather
than assembling a format out of `digest` yourself.

The whole engine sits under the [`smithers` CLI](https://cli.smithers.sh/reference/api/), which is how you
run and inspect flows from a terminal.

## Where to go next

- [Installation](/installation/): runtime requirements, import forms, and
  the `Crypto` services you can provide.
- [Quickstart](/quickstart/): hash a value, store the digest, and validate
  it on the way back.
- [The contract](/contract/): the full guarantee list and the attacks this
  package does not defend against.
- Concepts: [the injected hashing boundary](/concepts/injected-hashing/)
  and [what a digest covers](/concepts/what-a-digest-covers/).
- Guides: [hash inside synchronous code](/guides/hash-in-synchronous-code/),
  [validate a digest read from storage](/guides/validate-a-stored-digest/),
  and [hash a structured value](/guides/hash-a-structured-value/).
- [Testing](/testing/): how to test code that hashes, and the evidence
  behind each guarantee.
- [Troubleshooting](/troubleshooting/): every failure this package reports,
  what causes it, and what to change.
