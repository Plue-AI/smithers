---
title: "API reference"
description: "Every public export of @smthrs/crypto: digest, digestSync, Digest, Sha256, Sha256Error, Sha256ErrorCode, syncCrypto, and the Identity module for function identity, with signatures, failures, and the input policy they share."
---

Every hashing, schema, error, and service name below is exported from the root
entry point and from `@smthrs/crypto/Sha256`. Function identity is the one
other public module: it is exported as the `Identity` namespace from the root
and from `@smthrs/crypto/Identity`.

```ts
import { Digest, digest, digestSync, Identity, Sha256, Sha256Error, Sha256ErrorCode, syncCrypto } from "@smthrs/crypto"
```

## Example

```ts
import { digest, digestSync } from "@smthrs/crypto"

const address = await Effect.runPromise(
  digest("hello").pipe(Effect.provide(NodeCrypto.layer))
)
const sameAddress = digestSync("hello")
```

## Hashing

### digest

```ts
const digest: (input: string | Uint8Array) => Effect.Effect<Digest, Sha256Error, Crypto.Crypto>
```

Hashes text or bytes through the injected Effect `Crypto` service. This is the
normal operational API.

- `input`: a well-formed JavaScript string, or a `Uint8Array`. The string is
  encoded as UTF-8; the array is copied and hashed exactly as viewed.
- Returns the digest as 64 lowercase hexadecimal characters, branded as `Digest`.
- Requires `Crypto.Crypto`. A missing service stays an unsatisfied Effect
  requirement and surfaces as `Service not found: effect/Crypto`, which is a
  composition defect rather than a `Sha256Error`.
- Fails with [`Sha256Error`](#sha256error) under any of the five codes.

The input snapshot is taken when the Effect **begins**, not when it is
constructed, and before the host is called. Host output is copied and must be
exactly 32 bytes.

### digestSync

```ts
const digestSync: (input: string | Uint8Array) => Digest
```

Hashes text or bytes with the package-owned FIPS 180-4 implementation. This is
the explicit synchronous entry point, for pure plan and identity construction.

- Same input policy and same output representation as [`digest`](#digest).
- Requires no service.
- **Throws** [`Sha256Error`](#sha256error), and only under `invalid_input`,
  `invalid_text`, or `text_encoding_failed`. It never raises `digest_failed`
  or `invalid_digest`, because it consults no host.
- Runs on the calling thread. See
  [when not to use the synchronous path](./guides/hash-in-synchronous-code.md#know-when-not-to-use-the-synchronous-path).

## Schemas

### Digest

```ts
const Digest: Schema.Codec<Digest, string>
type Digest = typeof Digest.Type
```

Validates an existing digest. It matches `^[0-9a-f]{64}$` and is branded
`"@smthrs/crypto/Sha256/Digest"`, so a plain `string` does not satisfy a
`Digest` parameter.

Decoding validates and returns the input unchanged. It hashes nothing and
requires no `Crypto` service, so `Schema.decodeUnknownSync(Digest)` is
available. Rejected values include uppercase hexadecimal, 63 or 65 characters,
non-hexadecimal characters, leading or trailing whitespace, and any non-string.

The expected-value message is
`a 64-character lowercase hexadecimal SHA-256 digest`.

### Sha256

```ts
const Sha256: Schema.Codec<Digest, string | Uint8Array, Crypto.Crypto> & {
  readonly Digest: typeof Digest
  readonly digest: typeof digest
  readonly digestSync: typeof digestSync
}
```

The one-way schema transformation from text or bytes to a `Digest`: the
schema-composition face of [`digest`](#digest).

- Decoding runs `digest`, so `Crypto.Crypto` is the codec's decoding
  requirement, the third type argument above. Decode with
  `Schema.decodeUnknownEffect` and provide the service. There is no
  synchronous decode.
- Encoding always fails with
  `A digest cannot be converted back into its source bytes`.
- Operational failures become `SchemaError` issues whose message is
  `[code] message` and whose annotations carry the stable `code` and the typed
  `Sha256Error` as `cause`.
- The schema annotates `parseOptions: { reportInput: false }`, overriding
  input reporting for its own node only. Enclosing Struct, Array, and Union
  issues use their own options and can retain the original input, including
  when a sibling field fails. Pass `reportInput: false` at the outermost
  decode boundary and do not re-enable it on descendant schemas.
- Identifier: `@smthrs/crypto/Sha256`.

For composed schemas, disable input reporting on the complete decode:

```ts
import { Sha256 } from "@smthrs/crypto"
import * as Schema from "effect/Schema"

const Manifest = Schema.Struct({ name: Schema.String, contents: Sha256 })
const decodeManifest = (input: unknown) => Schema.decodeUnknownEffect(Manifest)(input, { reportInput: false })
// Provide a Crypto service when running the returned Effect.
```

This suppresses parser input capture throughout this schema. It does not
sanitize preserved host or encoder causes, schema paths, custom messages, or
annotations. Keep those free of secrets or sanitize them before serializing
or inspecting a complete error.

`Sha256.Digest`, `Sha256.digest`, and `Sha256.digestSync` are the same values
as the named exports, attached for consumers that reached them through the
namespace.

## Errors

### Sha256Error

```ts
class Sha256Error extends Schema.TaggedError<Sha256Error>()("@smthrs/crypto/Sha256Error", {
  code: Sha256ErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}
```

The typed SHA-256 boundary failure.

- `_tag`: `"@smthrs/crypto/Sha256Error"`.
- `code`: stable, and the value to branch on. See
  [`Sha256ErrorCode`](#sha256errorcode).
- `message`: prose, safe to report, and never contains the hashed input.
- `cause`: present when there was an original failure to preserve, such as a
  `TextEncoder` throw or the injected host's own error.

`digest` returns it in the Effect error channel; `digestSync` throws it; the
`Sha256` schema carries it as an issue annotation.

### Sha256ErrorCode

```ts
const Sha256ErrorCode: Schema.Literals<
  ["invalid_input", "invalid_text", "text_encoding_failed", "digest_failed", "invalid_digest"]
>
type Sha256ErrorCode = typeof Sha256ErrorCode.Type
```

| Code                   | Raised by              | Meaning                                                                    |
| ---------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `invalid_input`        | `digest`, `digestSync` | The input is neither a string nor a copyable `Uint8Array`.                 |
| `invalid_text`         | `digest`, `digestSync` | The string contains an unpaired UTF-16 surrogate.                          |
| `text_encoding_failed` | `digest`, `digestSync` | The host `TextEncoder` threw.                                              |
| `digest_failed`        | `digest`               | The injected host failed, threw, died, or returned a non-Effect operation. |
| `invalid_digest`       | `digest`               | The host result is not a copyable 32-byte array.                           |

A missing `Crypto` service is deliberately not a member. It remains an
unsatisfied Effect context requirement, and therefore a configuration defect,
distinct from a provided host failing an operation.

Values rejected by `Digest`, and values the `Sha256` input schema does not
accept, are ordinary `SchemaError` validation failures rather than
`Sha256Error`.

## Services

### syncCrypto

```ts
const syncCrypto: Crypto.Crypto
```

A synchronous, SHA-256-only Effect `Crypto` service backed by the same
package-owned implementation as `digestSync`. It exists for synchronous code
that already consumes a `Crypto` service, and for tests that want real hashing
with no platform layer.

- `digest("SHA-256", input)` snapshots the input and returns the 32 raw bytes.
- Every other algorithm fails with a `PlatformError.badArgument` whose
  description is `syncCrypto supports only SHA-256, not <algorithm>`, with
  `module: "@smthrs/crypto"` and `method: "digest"`.
- An input whose buffer cannot be copied fails with a `badArgument` described
  as `syncCrypto could not snapshot SHA-256 input`, with the original
  `TypeError` as `cause`.
- `randomBytes` throws
  `@smthrs/crypto syncCrypto provides SHA-256 only; supply a platform Crypto layer for randomness`.
  Because `Crypto.make` derives random numbers, UUIDs, and shuffling from
  `randomBytes`, every random operation fails the same way.

Normal application code should provide its platform `Crypto` layer instead.

## Input and memory policy

Text must be well-formed UTF-16. Unpaired surrogates are rejected before the
standard `TextEncoder` converts text to UTF-8, which is what stops two
different malformed strings from colliding on the digest of a replacement
character. `TextEncoder` is a host prerequisite rather than an injected
service: Node, Bun, and modern browser targets provide it as a global.

No Unicode normalization is performed, so NFC and NFD text remain distinct
inputs. Normalize before calling if your protocol needs canonically equivalent
text to share a digest.

`digest` copies byte input when its Effect begins and before the host is
called; `digestSync` copies during the call. Host output is copied and must
contain exactly 32 bytes. `Buffer` is a `Uint8Array` and is accepted; other
buffer and view types are not. The API is one-shot and requires the complete
input plus its snapshot in memory. There is no incremental or streaming entry
point, and nothing is zeroed after use.

Full detail is in [what a digest covers](./concepts/what-a-digest-covers.md),
and the guarantees these rules add up to, along with what they do not cover,
are in [the contract](./contract.md).

## Function identity

A digest of bytes identifies data. `Identity` digests a _function_: the plan-time
mapper, continuation, or predicate a node AST embeds but cannot serialize. It is
a separate module because its admission rules are about JavaScript values, not
about hashing, and because every node model in Smithers has to embed the same
one.

```ts
import { Identity } from "@smthrs/crypto"
// or
import * as Identity from "@smthrs/crypto/Identity"
```

### Identity.functionIdentity

```ts
const functionIdentity: (operation: unknown) => Identity.FunctionIdentity
```

Digests a function's exact source as UTF-8 with SHA-256. Exact source matters:
whitespace inside a string literal is behavior, so normalizing before hashing
could make two different functions share an identity.

- Returns `{ _tag: "FunctionIdentity", algorithm, digest }`, where `digest` is
  64 lowercase hexadecimal characters.
- `algorithm` is `sha256-source-captures/v5` when the operation was declared
  with [`Identity.capture`](#identitycapture), and `sha256-source-ephemeral/v4`
  otherwise. An undeclared closure folds in process-local, per-function
  entropy, because JavaScript cannot inspect what a closure captured and
  source-only identity would permit an incorrect cache hit.
- **Throws** `TypeError("function identity requires a function")` for anything
  that is not a function.

### Identity.capture

```ts
const capture: <C extends Readonly<Record<string, unknown>>, Args extends ReadonlyArray<unknown>, A>(
  captures: C,
  operation: (this: Readonly<C>, ...args: Args) => A
) => (...args: Args) => A
```

Declares the inert values a function closes over, which is what earns it a
deterministic identity. A deeply frozen plain copy of `captures` is
canonicalized into the identity and bound as the callback's `this` receiver, so
use a function expression to read it; ordinary arguments keep their positions.

- Caller objects are left unchanged, and a mutable lexical alias must not
  supply semantic state: only the owned frozen copy enters identity.
- Sealed, non-extensible, frozen, and Immer-style ordinary data are all
  supported, and shared references stay shared in the copy. The identity
  records this sharing: equal separate objects differ from shared references.
- Admission walks original descriptors once and never evaluates a getter.
  Built-in brands, non-plain prototypes, accessors, non-enumerable members,
  symbol keys, cycles, non-finite numbers, and nesting beyond 256 levels are
  refused with a `TypeError` naming the path.
- Object capture requires `structuredClone`, which is how a Proxy is refused.
  A host without it refuses every object capture.
- Capturing an already-captured function keeps the inner source and folds both
  capture sets into one identity.

### Identity.processNonce

```ts
const processNonce: () => string
```

The process-local nonce every ephemeral identity folds in, as 32 lowercase
hexadecimal characters. It exists so a second ephemeral encoding, such as the
projection of an unregistered symbol, shares this process's value instead of
minting a second one. It is seeded lazily on first use: reading entropy while
the module evaluates is rejected by Cloudflare Workers with upload error 10021.

### Identity.FunctionIdentity

```ts
interface FunctionIdentity {
  readonly _tag: "FunctionIdentity"
  readonly algorithm: Identity.Algorithm
  readonly digest: string
}
type Algorithm = "sha256-source-ephemeral/v4" | "sha256-source-captures/v5"
```

The serializable stand-in a node AST stores in place of the function itself. The
algorithm tag is versioned, so a change to identity semantics re-keys what is
derived from one rather than colliding with it.

## Requirements and platform

- Node.js 26.4.0 or later. The package also runs under Bun and in a browser:
  it imports no `node:` built-in.
- One runtime dependency, `effect`.
- `@smthrs/crypto/internal/*` and `@smthrs/crypto/*/index` are blocked in the
  export map. The handwritten implementation is reachable only through
  `digestSync` and `syncCrypto`.
- `Identity.capture` uses `structuredClone`, a global on Node.js 26, Bun, and
  modern browsers, and `Identity.processNonce` uses `crypto.getRandomValues`.
  Neither is read while the module evaluates.

## Neighbouring packages

Canonical value serialization belongs to
[`@smthrs/canonical`](/api/canonical). Domain-specific key formats belong to
[`@smthrs/keys`](/api/keys). Content addressing over a digest belongs to
[`@smthrs/artifacts`](/api/artifacts).
