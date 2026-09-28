---
title: "API reference"
description: "Canonical JSON serialization, schema and errors, bounded JSON admission, and the shared record guard."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/canonical/docs/api.md"
---

The package provides canonical serialization, its schema and errors, bounded JSON admission, and an array-excluding record guard.

```ts
import { Canonical, CanonicalError, canonicalize } from "@smthrs/canonical"
import type { CanonicalErrorCode } from "@smthrs/canonical"
```

The schema is also importable as `@smthrs/canonical/Canonical`. The shape guard is importable as `@smthrs/canonical/Record`. Private paths `@smthrs/canonical/internal/*` and `@smthrs/canonical/*/index` are
blocked in the export map.

`@smthrs/canonical/Serializer` exports the same `canonicalize`, `CanonicalError`,
and `CanonicalErrorCode` without loading Effect. Wire contracts can use that
entry point while retaining identical canonical bytes and error identities.

The behavior every entry below shares is on
[The serialization contract](/serialization/).
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) is the normative format
specification.

## canonicalize

```ts
const canonicalize: (input: unknown) => string
```

Serializes a value into an RFC 8785 canonical JSON document.

| Parameter | Type      | Meaning                                                                                       |
| --------- | --------- | --------------------------------------------------------------------------------------------- |
| `input`   | `unknown` | Any JavaScript value. `JSON.stringify` semantics reduce it to JSON data before serialization. |

**Returns** the canonical document as a plain `string`. It is always valid JSON
text, and canonicalizing its parse returns the same string.

**Throws** a [`CanonicalError`](#canonicalerror) when the value has no
canonical form. The error names the failure with a stable
[code](#canonicalerrorcode) and the JSON-style path of the offending value.

```ts
canonicalize({ flowId: "build", input: { target: "web-app", clean: false } })
// => '{"flowId":"build","input":{"clean":false,"target":"web-app"}}'
```

## Canonical

```ts
const Canonical: Schema.decodeTo<
  Schema.brand<Schema.String, "@smthrs/canonical/Canonical">,
  Schema.Unknown,
  never,
  never
>
```

The same serialization as an [`effect/Schema`](https://effect.website) codec,
built against Effect 4: the package declares `effect@4.0.0-rc.115` as a peer
dependency.

**Decoding** takes any value, canonicalizes it, and returns the document
branded. The serializer guarantees valid JSON, so decoding does not parse its
output again. A value with no canonical form fails with a `Schema.SchemaError`
whose message carries the same `code: detail at path` text `canonicalize`
would have thrown.

**Encoding** takes a canonical document and parses it back into a plain JSON
value. The round trip is lossy exactly where JSON is lossy: a `Date` comes back
as a string, and a member dropped for being `undefined` does not return. The
brand guarantees canonical form on the typed path. An unknown-string encode
(`Schema.encodeUnknownSync` or `Schema.encodeUnknownEffect`) validates the
text: a string that does not parse fails with a `Schema.SchemaError` whose
message starts with `canonical_malformed:`, never a raw `SyntaxError`.

```ts
import * as Schema from "effect/Schema"

const document = Schema.decodeUnknownSync(Canonical)({ b: 2, a: 1 })
// => '{"a":1,"b":2}'

Schema.encodeUnknownSync(Canonical)(document)
// => { a: 1, b: 2 }
```

Pass `{ reportInput: false }` to suppress Schema input rendering only. It does
not redact the custom issue message, which includes the path and any original
getter or `toJSON` exception text. See
[Canonicalize inside an Effect pipeline](/guides/use-the-schema/).

## Canonical (type)

```ts
type Canonical = typeof Canonical.Type
// string & Brand<"@smthrs/canonical/Canonical">
```

A canonical JSON document. The brand is obtainable only by decoding through the
`Canonical` schema, so a string that merely looks like JSON cannot be passed
where a canonical document is required.

## CanonicalError

```ts
class CanonicalError extends TypeError {
  readonly code: CanonicalErrorCode
  readonly path: string
  constructor(code: CanonicalErrorCode, detail: string, path: string, options?: ErrorOptions)
}
```

A stable, located canonicalization failure, thrown by `canonicalize`.

| Member    | Type                 | Meaning                                                                                            |
| --------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `name`    | `string`             | Always `"CanonicalError"`.                                                                         |
| `code`    | `CanonicalErrorCode` | The stable failure identifier. Safe to branch on and to log.                                       |
| `path`    | `string`             | The JSON-style path of the offending value. Member names are caller-supplied and may be sensitive. |
| `message` | `string`             | `` `${code}: ${detail} at ${path}` ``.                                                             |
| `cause`   | `unknown`            | The original error, for `canonical_tojson_threw` and `canonical_getter_threw`. Absent otherwise.   |

Report only the stable `code` by default. Treat every path segment, `message`,
and `cause` text as caller-controlled and potentially sensitive. Member names
can contain tokens or emails, and callback exception text is copied into
`message`. `reportInput: false` affects Schema input rendering only; it does
not sanitize a `CanonicalError`. Allowlist or redact diagnostics before they
cross a log or RPC boundary. See
[Limit diagnostic disclosure](/guides/use-the-schema/#limit-diagnostic-disclosure).

Path grammar:

| Segment     | Meaning                                                     |
| ----------- | ----------------------------------------------------------- |
| `$`         | The root value.                                             |
| `.name`     | A member whose name matches `/^[A-Za-z_$][A-Za-z0-9_$]*$/`. |
| `["name"]`  | Any other member, with the name JSON-quoted.                |
| `[0]`       | An array index.                                             |
| `.toJSON()` | A step into the result of a `toJSON` method.                |

```ts
try {
  canonicalize({ input: { tags: new Set(["release"]) } })
} catch (error) {
  if (error instanceof CanonicalError) {
    error.code // "canonical_unsupported_value"
    error.path // "$.input.tags"
  }
}
```

## CanonicalErrorCode

```ts
type CanonicalErrorCode =
  | "canonical_bigint"
  | "canonical_circular"
  | "canonical_depth_exceeded"
  | "canonical_getter_threw"
  | "canonical_lone_surrogate"
  | "canonical_nan"
  | "canonical_non_finite"
  | "canonical_tojson_threw"
  | "canonical_unsupported_value"
```

The nine stable failure identifiers. They are part of the package's public
contract: a consumer may branch on them, and they do not change with a value's
shape or a host's runtime.

| Code                          | Raised when                                                                                                                                                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canonical_bigint`            | A `bigint`, boxed or not, reaches the serializer.                                                                                                                                                                                                                       |
| `canonical_circular`          | A value is an ancestor of itself. Sharing without a cycle is allowed.                                                                                                                                                                                                   |
| `canonical_depth_exceeded`    | Nesting passes 10,000 levels below the root. The detail names both numbers.                                                                                                                                                                                             |
| `canonical_getter_threw`      | Reading a property threw: an accessor, a proxy `get`, `ownKeys`, or `getPrototypeOf` trap, or a proxied array's `length`. The original error is `cause`.                                                                                                                |
| `canonical_lone_surrogate`    | A member name or a string value carries an unpaired surrogate. The detail says `key` or `value`.                                                                                                                                                                        |
| `canonical_nan`               | A number is `NaN`.                                                                                                                                                                                                                                                      |
| `canonical_non_finite`        | A number is `Infinity` or `-Infinity`. The detail names which.                                                                                                                                                                                                          |
| `canonical_tojson_threw`      | A `toJSON` method threw. The original error is `cause`.                                                                                                                                                                                                                 |
| `canonical_unsupported_value` | A lossy built-in or class instance (`Map`, `Set`, `WeakMap`, `WeakSet`, `ArrayBuffer`, a typed array, `RegExp`, an `Error` subclass, any non-plain object), or a root value that is `undefined`, a function, or a symbol. The detail names the constructor or the type. |

Each code, with its cause and its fix, is in
[Troubleshooting](/troubleshooting/).

## isRecord

`isRecord(value)` accepts non-null objects and excludes arrays. It preserves member types for typed JSON-like values. It does not read properties or validate their contents, and accepts class instances; use `canonicalize` or a schema when validating serialization. Import it from the package root or `@smthrs/canonical/Record`.

## BoundedJson

`BoundedJson.admit(input, limits)` copies inert JSON without calling getters or
`toJSON`. A Proxy's `ownKeys`, `getOwnPropertyDescriptor`, and
`getPrototypeOf` traps still run, so admission bounds parsed or otherwise inert
data, not a live Proxy from untrusted code. A success carries `{ ok: true, value, bytes }`; a refusal carries
`{ ok: false, code, complaint, path }`. `path` contains property names and array
indices, so callers should allowlist or redact sensitive segments before
reporting it, then bound its length. A length cap does not remove secrets.

The required limits are `maxDepth`, `maxNodes`, and `maxMembers` (per array or
object). Optional `maxTotalMembers` bounds members across the whole tree.
`maxBytes`, `maxStringBytes`, and `maxKeyBytes` bound the encoded JSON bytes,
including quotes and escapes. The snapshot is deeply frozen; objects have null
prototypes. Sparse arrays, accessors, enumerable symbols, non-plain objects,
cycles, non-JSON values, and malformed Unicode are refused.

Object descriptor collection checks member limits before buffering each
additional enumerable property. It also refuses when the minimum node or encoded
byte cost of the members seen exceeds the remaining budget. `Reflect.ownKeys`
still enumerates and materializes all own keys before these checks; skipped
non-enumerable properties still require descriptor inspection. Bound raw input
size outside admission to constrain that work.

`BoundedJson.encodedStringBytes(value, maximum?)` counts a JSON string's UTF-8
bytes without allocating its encoded copy, or returns `undefined` for malformed
or oversized text. It counts the short control escapes exactly.

Import the namespace from the package root or `@smthrs/canonical/BoundedJson`.
Admission is a separate boundary from canonical serialization and does not alter
`canonicalize`'s handling of values or its output bytes.
