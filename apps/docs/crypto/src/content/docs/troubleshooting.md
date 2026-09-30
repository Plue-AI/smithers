---
title: "Troubleshooting"
description: "Every failure @smthrs/crypto reports, the symptom you see, what causes it, and what to change."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/crypto/docs/troubleshooting.md"
---

Each entry names the symptom first. `Sha256Error.code` is the stable value to
branch on; messages are prose and may change.

## Service not found: effect/Crypto

**Symptom.** The program dies with `Service not found: effect/Crypto`, or
TypeScript refuses to run an Effect whose requirement channel still holds
`Crypto.Crypto`.

**Cause.** `digest` and the `Sha256` schema require a `Crypto` service, and
the composition provided none. This is a composition defect, not a
`Sha256Error`, which is why it is a defect rather than a typed failure.

**Fix.** Provide a service: `NodeCrypto.layer`, `BunCrypto.layer`,
`BrowserCrypto.layer`, or `syncCrypto` for synchronous code and tests. See
[Installation](/installation/#provide-a-crypto-service). If the call site
cannot suspend at all, use `digestSync`, which requires nothing.

## invalid_text

**Symptom.** `Sha256Error` with
`SHA-256 text input contains an unpaired UTF-16 surrogate`.

**Cause.** The string holds a lone high or low surrogate. `TextEncoder` would
replace it with U+FFFD, so two different malformed strings would hash
identically. The package refuses instead.

**Fix.** Find where the string was split or truncated: slicing a JavaScript
string at an arbitrary index can cut a surrogate pair in half. Slice on code
points, or hash the bytes you already have as a `Uint8Array`.

## invalid_input

**Symptom.** `Sha256Error` with `SHA-256 input must be a string or Uint8Array`,
or `SHA-256 byte input could not be copied`.

**Cause.** The first message means the value was neither a string nor a
`Uint8Array`. `ArrayBuffer`, `DataView`, `Uint16Array`, plain arrays,
iterables, and streams are all rejected rather than coerced. The second means
the value was a `Uint8Array` whose buffer had been detached, usually by a
`structuredClone` transfer or a worker `postMessage`.

**Fix.** Wrap a buffer as `new Uint8Array(buffer)` before hashing, and do not
hash an array whose buffer you transferred. `Buffer` needs no conversion; it
is a `Uint8Array` subclass and is accepted.

## text_encoding_failed

**Symptom.** `Sha256Error` with
`SHA-256 text input could not be encoded as UTF-8`, with the original throw as
`cause`.

**Cause.** The host's `TextEncoder` threw. In practice this means the runtime
does not provide a working `TextEncoder`, or something replaced the global.

**Fix.** Check the runtime against
[the requirements](/installation/#runtime-requirements), and check whether
test code monkey-patched `TextEncoder.prototype.encode` and failed to restore
it.

## digest_failed

**Symptom.** `Sha256Error` with
`The injected Crypto service failed to compute SHA-256`, or
`The injected Crypto service returned a non-Effect SHA-256 operation`.

**Cause.** The first covers a host that failed, threw synchronously, or died:
the original failure is preserved as `cause`. The second means
`crypto.digest(...)` returned something that is not an Effect, which points at
a hand-rolled service that returned bytes directly.

**Fix.** Read `cause` for the host's own error. If you wrote the service,
build it with `Crypto.make({ randomBytes, digest })` so `digest` returns
`Effect<Uint8Array, PlatformError>`.

## invalid_digest

**Symptom.** `Sha256Error` with
`The injected Crypto service returned N SHA-256 bytes; expected 32`,
`returned a non-Uint8Array SHA-256 digest`, or
`returned SHA-256 bytes that could not be copied`.

**Cause.** The host answered with something that is not a 32-byte copyable
array. A different algorithm, a hex string instead of bytes, or a detached
buffer all land here.

**Fix.** Make the service return the raw 32 bytes of SHA-256. The package
never accepts a hexadecimal string from a host; encoding is its job.

## A SchemaError instead of a Sha256Error

**Symptom.** Decoding through `Sha256` fails with a `SchemaError` whose
message reads `[digest_failed] The injected Crypto service failed ...`.

**Cause.** The `Sha256` schema maps operational failures into schema issues so
it composes with other schemas. The typed error is not lost: it is the issue's
`cause` annotation, alongside the stable `code`.

**Fix.** Branch on the annotation's `code`, or call `digest` directly where
you want the typed failure in the error channel.

## The hashed value is missing from the error

**Symptom.** You passed `reportInput: true` and the standalone `Sha256` issue
still has no `input`.

**Cause.** The `Sha256` schema sets `reportInput: false` for its own node,
because hash inputs can be credentials or multi-megabyte buffers. This does
not override an enclosing schema's input reporting.

**Fix.** To suppress input capture throughout a composed schema, pass
`reportInput: false` at the outermost decode. See the
[composition example](/guides/hash-a-structured-value/#compose-the-sha256-schema).
Preserved causes and custom diagnostics still need separate handling before
logging a complete error.

## A digest cannot be converted back into its source bytes

**Symptom.** Encoding a `Sha256` value fails with exactly that message.

**Cause.** `Sha256` is a one-way transformation. There is no inverse to run.

**Fix.** Keep the source bytes yourself if you need them later. A
content-addressed store such as [`@smthrs/artifacts`](https://artifacts.smithers.sh/reference/api/) exists
for exactly that.

## Digest rejected a value that looks like a digest

**Symptom.** `Schema.decodeUnknownSync(Digest)` throws on a 64-character
string.

**Cause.** `Digest` accepts `^[0-9a-f]{64}$` and nothing else. Uppercase
hexadecimal is the common case; a leading or trailing space is the next one.

**Fix.** Lowercase the value at the boundary where it enters your system, and
trim it there too. Do not loosen the pattern: one representation is what makes
digests comparable with `===`.

## syncCrypto refused the operation

**Symptom.** A `BadArgument` reading
`syncCrypto supports only SHA-256, not SHA-384`, or a `BadArgument` defect
from `randomBytes` reading `@smthrs/crypto syncCrypto provides SHA-256 only;
supply a platform Crypto layer for randomness`.

**Cause.** `syncCrypto` is a hashing adapter, not a platform layer. It answers
`SHA-256` only and refuses randomness rather than returning weak bytes, which
also fails every random helper `Crypto.make` derives from `randomBytes`.

**Fix.** Provide a platform `Crypto` layer for anything but SHA-256 hashing.

## digestSync blocks on a large input

**Symptom.** A synchronous call takes noticeably long on a large buffer.

**Cause.** `digestSync` runs the compression function in JavaScript on the
calling thread, and the API is one-shot, so the input and its snapshot are
both in memory.

**Fix.** Use `digest` with a platform host, which hands the work to the host
binding. There is no streaming entry point; if you cannot hold the whole input
in memory, hash it outside this package.
