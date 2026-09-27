---
title: "@smthrs/canonical"
description: "RFC 8785 canonical JSON for TypeScript, as a plain function and as an Effect Schema codec, so one value serializes to one byte sequence and its digest never depends on key order."
---

`@smthrs/canonical` turns a JavaScript value into an
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) canonical JSON
document. One value has exactly one canonical document, so a hash of that
document names the value rather than the object that happened to carry it.

## The problem it solves

`JSON.stringify` emits members in the order the object was built, so the same
data has more than one byte sequence:

```ts
JSON.stringify({ a: 1, b: 2 })
// => '{"a":1,"b":2}'
JSON.stringify({ b: 2, a: 1 })
// => '{"b":2,"a":1}'
```

Hash those and you get two digests for one document. Every identity built on
that hash then breaks quietly: a cache that never hits, an idempotency key that
submits the same work twice, a signature that stops verifying. Number
formatting and string escaping drift the same way across implementations.

RFC 8785 removes the choice. It fixes member order, number form, and string
escaping, so a value has one serialization and therefore one digest. Two hosts
that both implement the standard agree, whether they are a laptop and a CI
runner or a Node.js server and a browser tab.

Reach for this package when you hash, sign, cache, or compare JSON data and the
answer must not depend on how the value was built.

## Install

Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

`effect` is a peer dependency at exactly `4.0.0-rc.115`.
[Installation](./installation.md) covers the rest of the requirements.

## Derive a content key

```ts
import { canonicalize } from "@smthrs/canonical"
import { createHash } from "node:crypto"

const contentKey = (value: unknown): string => createHash("sha256").update(canonicalize(value), "utf8").digest("hex")

contentKey({ flowId: "build", input: { target: "web-app", clean: false } })
  === contentKey({ input: { clean: false, target: "web-app" }, flowId: "build" })
// => true
```

Two objects, different key order, one key. That property is what a step cache,
an idempotency key, and a plan digest all rest on.

A value with no canonical form is refused rather than approximated. A `Set`, a
`bigint`, `NaN`, a cycle, or an unpaired surrogate throws a `CanonicalError`
carrying a stable `code` and the JSON-style path of the offending member:

```ts
canonicalize({ tags: new Set(["release"]) })
// throws CanonicalError: canonical_unsupported_value: Set at $.tags
```

Report only the stable `code` by default. Paths contain caller-supplied member
names, which may be tokens, emails, or other sensitive data. Treat every path
segment, `message`, and `cause` text as untrusted before logging or sending them
over RPC. Schema decoding with `reportInput: false` suppresses Schema input
rendering only; it does not redact these diagnostics. See
[Limit diagnostic disclosure](./guides/use-the-schema.md#limit-diagnostic-disclosure).

## Use it as an Effect schema

The same serialization is also a codec. `Canonical` decodes any value into a
branded canonical document and reports the failure in the error channel instead
of throwing:

```ts
import { Canonical } from "@smthrs/canonical"
import * as Schema from "effect/Schema"

Schema.decodeUnknownSync(Canonical)({ b: 2, a: 1 })
// => '{"a":1,"b":2}'
```

The brand is obtainable only by decoding, so a function that requires a
canonical document cannot be handed a string that merely looks like JSON.

## How this fits with @smthrs/flows

This package is one piece of the Smithers durable flow engine, whose whole
surface is re-exported by [`@smthrs/flows`](/api/flows). If you already depend
on that barrel, this serializer is its `Canonical` namespace and you do not
need to install anything else:

```ts
import { Canonical } from "@smthrs/flows"

Canonical.canonicalize({ b: 2, a: 1 })
// => '{"a":1,"b":2}'
```

Install `@smthrs/canonical` on its own when canonical JSON is all you want. Its
only dependency is `effect`, and it carries no engine, no storage, and no I/O.

`@smthrs/flows` is in turn the library behind the `smithers` command line
tool, [`@smthrs/cli`](/api/cli), which runs and inspects durable flows. Every
content-addressed identity that tool shows you, from flow keys to plan digests,
is a hash of a document this package produced.

## Where to go next

- [Installation](./installation.md): runtime requirements, the two import
  forms, and what the export map keeps private.
- [Quickstart](./quickstart.md): build a content key end to end, including the
  failure path.
- [The serialization contract](./serialization.md): every rule that fixes the
  bytes, and the two places this serializer deliberately diverges from
  `JSON.stringify`.
- [Why digests need canonical JSON](./concepts/digest-determinism.md): what the
  bytes are load bearing for, and why an output change is a digest change.
- [API reference](./api.md): `canonicalize`, the `Canonical` schema,
  `CanonicalError`, and the nine stable failure codes.
- [Troubleshooting](./troubleshooting.md): each failure code with its cause and
  its fix.
