---
title: "Quickstart"
description: "Derive a content key from a value: canonicalize it, hash it, prove the key does not depend on member order, and handle a value that has no canonical form."
sidebar:
  order: 2
---

This quickstart builds a content key: a hash that names a value rather than the
object that carried it. By the end you will have a function that returns the
same key for two objects a `===` comparison would call different, and that
fails loudly on a value with no canonical form.

## Prerequisites

- Node.js 26.4.0 or later.
- The package and its `effect` peer dependency. Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

## Canonicalize a value

Create `quickstart.ts`:

```ts
import { canonicalize } from "@smthrs/canonical"

const work = { flowId: "build", input: { target: "web-app", clean: false } }

console.log(canonicalize(work))
```

Run it with your TypeScript runner:

```text
{"flowId":"build","input":{"clean":false,"target":"web-app"}}
```

Two things already happened. The members came out sorted by UTF-16 code unit,
at every level, so `clean` precedes `target` inside the nested object. And
nothing else moved: array order, number formatting, and string escaping are
fixed by [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html), so this
string is the only canonical form this value has.

## Hash it into a key

Canonical bytes are what makes the hash stable. Add the digest:

```ts
import { canonicalize } from "@smthrs/canonical"
import { createHash } from "node:crypto"

const contentKey = (value: unknown): string => createHash("sha256").update(canonicalize(value), "utf8").digest("hex")

const built = { flowId: "build", input: { target: "web-app", clean: false } }
const submitted = { input: { clean: false, target: "web-app" }, flowId: "build" }

console.log(contentKey(built))
console.log(contentKey(submitted) === contentKey(built))
```

```text
1a5d898ee183f17cd1f3c89eacf8c9dc036bc5614e76264456316d1831415ec4
true
```

`built` and `submitted` are different objects with different insertion orders.
They name the same work, so they get the same key. That is the property a step
cache, an idempotency key, and a plan digest all depend on.

## Handle a value that has no canonical form

Not every JavaScript value can be a JSON document. Rather than emit a
best-effort string that would hash to something another host disagrees with,
`canonicalize` throws:

```ts
import { CanonicalError, canonicalize } from "@smthrs/canonical"

try {
  contentKey({ flowId: "build", input: { tags: new Set(["release"]) } })
} catch (error) {
  if (error instanceof CanonicalError) {
    console.log(error.code, error.path)
  }
}
```

```text
canonical_unsupported_value $.input.tags
```

The `code` is stable across releases and the `path` names the exact member, so
a caller can report the failure without copying the rejected value into a log.
A `Set` is refused because `JSON.stringify` renders it as `{}`, which would
collide with an empty object and with every other empty collection. Convert it
to JSON data first:

```ts
const key = contentKey({
  flowId: "build",
  input: { tags: [...new Set(["release"])].sort() }
})
```

[Convert a value the serializer refuses](./guides/prepare-a-value.md) covers
the other built-ins the same way.

## Use the schema instead of the function

When the surrounding code is Effect, decode through the `Canonical` schema and
the failure arrives as a `SchemaError` in the error channel rather than a
thrown exception:

```ts
import { Canonical } from "@smthrs/canonical"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const document = Effect.runSync(Schema.decodeUnknownEffect(Canonical)(built))
```

The decoded value is branded, so a function that requires a canonical document
cannot be handed an arbitrary string. See
[Canonicalize inside an Effect pipeline](./guides/use-the-schema.md).

## What just happened

One serialization decided one digest. Change the serialization and every key
derived from it changes with it, which is why every rule that fixes the bytes
is written down in [The serialization contract](./serialization.md).

## Next steps

- [The serialization contract](./serialization.md): sorting, numbers, strings,
  depth, and the two places this serializer deliberately diverges from
  `JSON.stringify`.
- [Why digests need canonical JSON](./concepts/digest-determinism.md): what the
  bytes are load bearing for.
- [`@smthrs/keys`](/api/keys): Smithers' own key derivation, which is this
  quickstart's two steps behind a typed failure.
