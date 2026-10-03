---
title: "Installation"
description: "Install @smthrs/control, its runtime requirements, its import forms, and the collaborator packages an in-memory, durable, or remote composition adds."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. Its runtime dependencies install with
it: [`effect`](https://effect.website) and the `@smthrs/*` packages the plane
composes.

The package imports no `node:*` module. Identity comes from
`globalThis.crypto`, encryption comes from Web Crypto, and persistence speaks
the driver-neutral SQL contract, so the same modules run in Node.js and in a
browser that supplies a SQL driver. That is a statement about the imports, not
a tested guarantee: nothing here is exercised in a browser, so verify your own
bundle before you depend on it.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Control, ControlLive, Monitor, SqlControlRuntime } from "@smthrs/control"
```

Each module is also importable from its own subpath, which is the form the
[API reference](./api.md) uses:

```ts
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlSchema from "@smthrs/control/ControlSchema"
```

The deterministic test stack has its own subpath:

```ts
import * as TestControl from "@smthrs/control/test/TestControl"
```

Two subpath families are not public and are blocked in the export map:
`@smthrs/control/internal/*` and `@smthrs/control/migrations/*`, along with
every nested `*/index`. `@smthrs/control/package.json` is exported.

## What a composition adds

`ControlLive.layer` requires four collaborators, and a host provides all four:

| Requirement         | Package                                       | What it does here                                                                  |
| ------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ControlRuntime`    | this package                                  | Stores plans, tokens, grants, idempotency records, and run rows.                   |
| `Journal`           | [`@smthrs/journal`](/api/journal)             | Records every decision beside the state change it caused, and backs `watch`.       |
| `NotificationQueue` | [`@smthrs/notifications`](/api/notifications) | Carries a steer to the turn boundary that delivers it, and counts what is pending. |
| `Registry`          | [`@smthrs/registry`](/api/registry)           | Answers `list({ _tag: "flows" })` with the flows this host discovered.             |

`ControlExecutor` is optional. A composition that provides none observes and
records but starts nothing, which is the correct shape for a monitor or a
read-only dashboard.

### An in-memory composition

`TestControl.layer` bundles all four collaborators with the deterministic
runtime. Its journal uses a real in-memory SQLite database, so the
[Quickstart](./quickstart.md) adds the optional Node driver:

```bash
pnpm add effect@4.0.0-rc.115 @effect/sql-sqlite-node@4.0.0-rc.115
```

### A durable composition

- [`@smthrs/database`](/api/database) supplies the SQL client and the
  `DurableWriter` every control write serializes through.
- [`@smthrs/run-store`](/api/run-store) supplies the fenced run store
  `SqlControlRuntime` maps the control lifecycle onto.

See [Store control state in a database](./guides/durable-storage.md) for the
layer stack and the migration order.

### A remote composition

The RPC boundary uses Effect's own HTTP, WebSocket, and RPC modules, which ship
inside `effect`. A Node host adds the platform bindings and a serialization
format:

```bash
pnpm add @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115
```

See [Serve the control plane over RPC](./guides/serve-over-rpc.md).

### Credential storage

The credential boundary needs a store and a cipher. `CredentialStore.layerMemory`
and `WebCryptoCipher.layer` need nothing beyond this package;
`SqlCredentialStore.layer` needs the same database packages a durable
composition adds. See [Store and resolve a credential](./guides/store-credentials.md).

## Next step

Run one plan through approval and launch in the [Quickstart](./quickstart.md).
