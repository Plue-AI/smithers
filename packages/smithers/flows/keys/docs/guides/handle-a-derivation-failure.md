---
title: "Handle a derivation failure"
description: "Match on the two KeyDerivationError codes, read the cause without leaking key material into a log, and tell a real failure apart from a missing Crypto service."
sidebar:
  order: 4
---

`deriveKey` fails with a `KeyDerivationError` and nothing else. It carries a
stable `code`, a fixed `message`, and the underlying failure as `cause`.

| Code                      | What happened                                                                  |
| ------------------------- | ------------------------------------------------------------------------------ |
| `canonicalization_failed` | The input has no canonical form.                                               |
| `digest_failed`           | The injected SHA-256 operation failed, or the host returned an invalid digest. |

## Branch on the code

The two codes call for different responses, so match on `code` rather than on
the message:

```ts
import { deriveKey, KeyDerivationError } from "@smthrs/keys"
import * as Effect from "effect/Effect"

const keyOrReport = (material: unknown) =>
  deriveKey(material).pipe(
    Effect.catchTag("@smthrs/keys/KeyDerivationError", (error: KeyDerivationError) =>
      error.code === "canonicalization_failed"
        ? Effect.fail(new Error("key material is not representable; fix the input"))
        : Effect.fail(new Error("the hashing host failed; retry or replace the Crypto layer")))
  )
```

`canonicalization_failed` is a defect in your material and will fail the same
way on every attempt, so do not retry it. Fix what you are hashing:
[Key material](../concepts/key-material.md) lists what has no canonical form.

`digest_failed` is a host failure, so retrying can succeed. Its `cause` is the
`Sha256Error` from [`@smthrs/crypto`](/api/crypto), which preserves the
provider's own error underneath.

## What is safe to log

`message` is one of exactly two fixed sentences and never contains your input:

```text
Key input could not be canonicalized
Canonical key material could not be hashed
```

`cause` is a different matter. For a canonicalization failure it is the
serializer's own error, and that error names the JSON path of the offending
value, which includes object property names. Two of its codes also carry a
value-derived detail: a non-finite number is printed, and a throwing getter or
`toJSON` contributes its own error message.

```text
canonical_bigint: BigInt at $["accountNumber"]
canonical_non_finite: Infinity at $.amount
canonical_getter_threw: password=hunter2 at $.credentials
```

Log `code` and `message` freely. Before you log `cause`, decide whether the
property names and getter messages of that material are safe in your logs. The
values themselves are not retained: no schema issue keeps the rejected input,
because the derivation pins input reporting off.

`cause` never leaves the process through the error's schema. It is a
non-enumerable runtime property rather than a schema field, so encoding a
`KeyDerivationError` for a journal or an API response, or passing it to
`JSON.stringify`, yields only `_tag`, `code`, and `message`.
`Cause.pretty` still renders the in-process `cause` chain, including a
getter's message, so treat its output as in-process diagnostics.

## A missing Crypto service is not this error

If no `Crypto` service is provided, the effect dies rather than failing:

```text
Service not found: effect/Crypto
```

That is an unsatisfied Effect requirement, which makes it a composition defect,
not a runtime failure to handle. `KeyDerivationErrorCode` deliberately has no
member for it. Provide a layer; see [Installation](../installation.md).

## Inside a schema

When you derive through `DerivedKey`, the failure arrives as a `SchemaError`
instead. Its message names the code and the fixed sentence:

```text
[canonicalization_failed] Key input could not be canonicalized
```

The typed `KeyDerivationError` is retained on the failing issue's annotations
as `cause`, alongside the same `code`. Where you want to branch on the code,
call `deriveKey` directly and match as above. See
[Derive a key inside a schema](./derive-a-key-inside-a-schema.md).
