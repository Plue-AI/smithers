---
title: "Installation"
description: "Install @smthrs/capability, its runtime requirement, its import forms, and the enforcement it deliberately leaves to @smthrs/kernel."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. It has one runtime dependency,
[`@smthrs/canonical`](/api/canonical), which supplies the record guard
`Permission.isPermissionError` validates payloads with.

[`effect`](https://effect.website) is a peer dependency pinned at
`effect@4.0.0-rc.115`. It supplies the `Schema`, `Option`, and `PlatformError`
types on the exported surface. Install exactly that version: two copies of
`effect` in one program are two sets of service tags.

## Import forms

The root entry point re-exports both modules as namespaces:

```ts
import { Capability, Permission } from "@smthrs/capability"
```

Each module is also importable from its own subpath, which keeps the import
narrow when you need only one of them:

```ts
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
```

Two subpath forms are not public: `@smthrs/capability/internal/*` and
`@smthrs/capability/*/index`. Both are blocked in the package's export map.
`@smthrs/capability/package.json` is exported.

## Test a value with the refinement, not `instanceof`

Because the package ships dual CommonJS and ESM, a consumer can load two copies
of it, and class identity is not stable across them. Use
`Permission.isPermissionError` to recognize a permission failure at a boundary.
It validates the whole enumerable shape rather than the `_tag` alone, so it
accepts a structurally valid failure from another copy of the package and
rejects a forgery that carries an extra field.

## What this package does not ship

There is no grant store, no decorated `FileSystem`, no journal, and no policy
loader here. This package answers "what was asked for, does a rule cover it,
and what does retrying it cost". Acting on the answer belongs to the packages
that hold state:

- [`@smthrs/kernel`](/api/kernel) owns the `GrantStore`, the layers that
  decorate host services, and the grant journal.
- [`@smthrs/agent`](/api/agent) declares a run's capability envelope and gates
  each call before its durable boundary opens.
- [`@smthrs/jj`](/api/jj) is one protected service that names
  `Permission.PermissionError` in its own error channel.

## Next step

Decide one request against a policy in the [Quickstart](./quickstart.md).
