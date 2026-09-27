---
title: "Installation"
description: "Install @smthrs/canonical, its runtime requirements, its two import forms, and the subpaths the export map blocks."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/canonical/docs/installation.md"
---

## Install the package

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

[`effect`](https://effect.website) is a peer dependency, declared at exactly
`4.0.0-rc.115`. Install it yourself at that version: it supplies the `Schema`
module the `Canonical` codec is built on, the examples in these pages import
`effect/Schema` and `effect/Effect` directly, and two copies of `effect` in one
program are two sets of service tags. Effect 3 does not satisfy that peer
dependency, and the schema APIs these pages use exist only in Effect 4.

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. The serializer has no native bindings,
no platform layer, and no filesystem or network access, so it runs unchanged in
Node.js, in Bun, and in a browser bundle.

## Import forms

The root entry point exports the whole surface:

```ts
import { Canonical, CanonicalError, canonicalize } from "@smthrs/canonical"
import type { CanonicalErrorCode } from "@smthrs/canonical"
```

The schema is also importable from its own subpath:

```ts
import { Canonical } from "@smthrs/canonical/Canonical"
```

`canonicalize` and `CanonicalError` are only available from the root, because
the serializer lives under a private subpath.

## What is not public

Two subpath forms are blocked in the export map:

- `@smthrs/canonical/internal/*`, which holds the serializer.
- `@smthrs/canonical/*/index`.

`@smthrs/canonical/package.json` is exported. `MAX_CANONICAL_DEPTH` lives in
the private module and is not part of the public surface; the bound it names is
documented as 10,000 levels in
[The serialization contract](/serialization/#depth).

## Use it with the rest of Smithers

If you already depend on [`@smthrs/flows`](https://flows.smithers.sh/reference/api/), the barrel for the
whole durable flow engine, this package is its `Canonical` namespace and needs
no separate install:

```ts
import { Canonical } from "@smthrs/flows"

Canonical.canonicalize({ b: 2, a: 1 })
```

Several engine packages also wrap it behind a narrower surface:

- [`@smthrs/keys`](https://keys.smithers.sh/reference/api/) derives a `key1_` flow key by canonicalizing key
  material and hashing it.
- [`@smthrs/core`](https://core.smithers.sh/reference/api/) exposes `Digest.canonical` for synchronous
  fingerprints inside pure constructors.
- [`@smthrs/crypto`](https://crypto.smithers.sh/reference/api/) supplies the SHA-256 service those
  derivations hash with.

Add `@smthrs/canonical` directly when you are computing your own digest and
none of those fits, or when canonical JSON is all you want from Smithers.

## Next step

Derive a content key end to end in the [Quickstart](/quickstart/).
