---
title: "Installation"
description: "Install @smthrs/plan and satisfy its peer requirements."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan/docs/installation.md"
---

## Requirements

- Node.js 26.4.0 or later.
- `effect` 4.0.0-rc.115. The package's schemas, layers, and error classes are
  Effect values, so the version has to match the one your application uses.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

That is enough to build node graphs, compile plans, and diff them. Compiling
asks for Effect's `Crypto` service, which a platform package supplies:

```bash
pnpm add @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115
```

`@smthrs/crypto`, `@smthrs/canonical` and [`@smthrs/keys`](https://keys.smithers.sh/reference/api/) arrive as
dependencies of this package; you do not install them yourself unless you use
them directly.

## What persistence adds

This package performs no I/O. Recording a compiled plan is
[`@smthrs/plan-store`](https://plan-store.smithers.sh/reference/api/), which owns the SQL and brings
[`@smthrs/database`](https://database.smithers.sh/reference/api/) with it.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { FileSet, Node, Plan, PlanDiff } from "@smthrs/plan"
```

Each module is also its own entry point. Prefer this form: it keeps a bundle to
the modules you actually reach for.

```ts
import * as Node from "@smthrs/plan/Node"
import * as Plan from "@smthrs/plan/Plan"
```

Both forms resolve to the same values.

## What you cannot import

`@smthrs/plan/internal/*` is blocked by the export map, and so is
`@smthrs/plan/<Module>/index`. Node reports `ERR_PACKAGE_PATH_NOT_EXPORTED` for
either.

`@smthrs/plan/test/PlanFixtures` is the exception that is meant for test code:
it builds drafts and compiles them, and
[`@smthrs/plan-store`](https://plan-store.smithers.sh/reference/api/) drives the same fixtures against the
persisted form.

## Browser support

The package is browser-safe: it resolves no `node:` built-in and binds no
database. Compiling, diffing, and building node graphs all work in a browser.

## Next

[Quickstart](/quickstart/) compiles a plan, appends to it, and diffs it.
