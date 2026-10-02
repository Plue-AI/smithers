---
title: "Installation"
description: "Install @smthrs/plan-store, satisfy its peer requirements, and add the driver packages a persisting composition needs."
sidebar:
  order: 1
---

## Requirements

- Node.js 26.4.0 or later.
- `effect` 4.0.0-rc.115. The package's schemas, layers, and error classes are
  Effect values, so the version has to match the one your application uses.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

The store writes to SQL, so a composition also needs the SQLite client, the
durable writer, and Effect's `Crypto` service:

```bash
pnpm add @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115 effect@4.0.0-rc.115 @effect/sql-sqlite-node@4.0.0-rc.115
```

[`@smthrs/plan`](/api/plan), [`@smthrs/database`](/api/database) and
[`@smthrs/keys`](/api/keys) arrive as dependencies of this package; you do not
install them yourself unless you use them directly. Compiling the plans you
record is `@smthrs/plan`, which performs no I/O at all.

## Import forms

The root entry point re-exports both modules as namespaces:

```ts
import { Migrations, PlanStore } from "@smthrs/plan-store"
```

Each module is also its own entry point. Prefer this form: it keeps a bundle to
the modules you actually reach for.

```ts
import * as Migrations from "@smthrs/plan-store/Migrations"
import * as PlanStore from "@smthrs/plan-store/PlanStore"
```

Both forms resolve to the same values.

## What you cannot import

The ordered migration steps live under `src/internal/migrations`, and the
export map blocks that prefix. `@smthrs/plan-store/Migrations` is the only way
to reach them.

```ts
import * as Migrations from "@smthrs/plan-store/Migrations"
// Migrations.set is the namespaced set; the steps inside it are not addressable.
```

A step imported on its own would run outside the namespaced ordering that
[`@smthrs/database`](/api/database)'s migrator relies on to decide what has
already been applied. Node reports `ERR_PACKAGE_PATH_NOT_EXPORTED` for the
internal path, and `ERR_MODULE_NOT_FOUND` for the path the steps shipped from
before 1.0.

## Browser support

The package is browser-safe: it resolves no `node:` built-in and names no
database driver, exactly as [`@smthrs/database`](/api/database) does. Choosing
a driver, such as `@smthrs/database/node/NodeDatabase`, is where a platform
choice enters.

## Next

[Quickstart](./quickstart.md) records a plan, appends a generation, and reads
the whole graph back.
