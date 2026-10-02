# `@smthrs/crypto`

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://crypto.smithers.sh

Strict SHA-256 hashing for TypeScript. The package accepts well-formed
JavaScript text or a `Uint8Array`, hashes a byte snapshot, and returns one
branded wire form: 64 lowercase hexadecimal characters.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/).

`effect` is the only runtime dependency.
`digest` additionally needs an Effect `Crypto` service, which
`@effect/platform-node`, `@effect/platform-bun`, and `@effect/platform-browser`
each provide as a layer. The package requires Node.js 26.4.0 or later, and it
imports no `node:` built-in, so it also runs under Bun and in a browser.

## Example

```typescript
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

## Public API

- `digest(input)` is the normal operational API. It requires an Effect
  `Crypto.Crypto` service and fails with `Sha256Error`.
- `digestSync(input)` is the explicit synchronous API for pure plan and
  identity construction. It uses the package-owned FIPS 180-4 implementation.
- `Digest` validates an existing digest without hashing it.
- `Sha256` is the one-way schema adapter. `Sha256.Digest`, `Sha256.digest`, and
  `Sha256.digestSync` remain attached for compatibility.
- `syncCrypto` adapts the synchronous implementation to Effect `Crypto`. It
  accepts only `SHA-256` and deliberately refuses randomness.

## What SHA-256 gives you here, and what it does not

SHA-256 is a collision-resistant hash function. It is not a message
authentication code, not a key derivation function, and not a password hash.
This package adds no key, no salt, and no iteration count, so it defends
against nothing that SHA-256 alone does not: not length extension, not
brute-force recovery of a low-entropy input, and not a `Crypto` service that
returns bytes of its own choosing. The full statement, with the guarantees the
package does make, is at https://crypto.smithers.sh/contract/.

## Input contract

Strings are rejected if they contain an unpaired UTF-16 surrogate, then encoded
as UTF-8 with the host's standard `TextEncoder`. Supported Node, Bun, and modern
browser targets provide that global; compatible worker and edge runtimes
generally do too. It remains an explicit runtime prerequisite rather than an
injected service.

No Unicode normalization is performed. Canonically equivalent NFC and NFD text
can therefore have different digests. Normalize before calling this package if
your protocol requires normalization.

`digest` copies a `Uint8Array` when its Effect begins, before the injected host
is called; `digestSync` copies during the call. Mutating the caller's array
during asynchronous hashing cannot change that operation. Host output is also
copied and must contain exactly 32 bytes. `Buffer` works because it is a
`Uint8Array`; `ArrayBuffer`, `DataView`, other typed arrays, iterables, and
streams are rejected.

This is intentionally a one-shot, whole-buffer API. It does not provide
incremental or streaming hashing, so callers must hold the complete input and
the snapshot in memory.

## Failure contract

`Sha256Error.code` is stable:

| Code                   | Meaning                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `invalid_input`        | The direct API received an unsupported or uncopyable input. |
| `invalid_text`         | Text contains an unpaired surrogate.                        |
| `text_encoding_failed` | `TextEncoder` threw.                                        |
| `digest_failed`        | The provided host failed or threw.                          |
| `invalid_digest`       | The host result is not a copyable 32-byte array.            |

`digest` fails in the Effect error channel; `digestSync` throws the same typed
error, and only the first three codes, because it consults no host. Invalid
values passed to `Digest` and unsupported values passed through the `Sha256`
input schema are ordinary `SchemaError` validation failures. Operational
failures preserve their original `cause`, use input-safe messages, and do not
attach the value being hashed to schema diagnostics. A missing `Crypto` service
is an unsatisfied Effect requirement and therefore a configuration defect, not a
`Sha256Error`. Encoding `Sha256` in reverse fails with
`A digest cannot be converted back into its source bytes`.

Canonical value serialization belongs to
[`@smthrs/canonical`](https://canonical.smithers.sh). Domain-specific key
formats belong to [`@smthrs/keys`](https://keys.smithers.sh). All three are
part of the Smithers durable flow engine, which
[`@smthrs/flows`](https://flows.smithers.sh) re-exports as one dependency, so
a program that already depends on flows reaches this module as
`Crypto.digestSync` with nothing further to install. Full API documentation is
at https://crypto.smithers.sh/reference/api/.
