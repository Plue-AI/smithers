---
title: "Installation"
description: "Install @smthrs/flow, its runtime requirements and pinned effect version, its import forms, and the packages a runnable composition adds."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

`effect` is a runtime dependency of this package and installs with it. Add it to
your own dependencies at the same version anyway: your declarations import
`effect/Schema` and your implementations import `effect/Effect` directly, and two
copies of `effect` in one program are two sets of service tags.

The package requires Node.js 26.4.0 or later. It ships as both ESM and
CommonJS with TypeScript declarations, and it pulls in
[`@smthrs/plan`](/api/plan), [`@smthrs/crypto`](/api/crypto),
[`@smthrs/keys`](/api/keys), and [`@smthrs/canonical`](/api/canonical), which
supply the node vocabulary a body is written in, the digests identity is built
from, and the canonical JSON checks applied to values.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Action, DurableDeferred, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
```

Several modules are also importable from their own subpath, which is the form the
reference uses:

```ts
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import * as Flow from "@smthrs/flow/Flow"
```

The `exports` map publishes `@smthrs/flow/Action`, `/CacheEnvironment`,
`/FileBoundary`, `/FileInput`, `/Flow`, `/FlowRuntime`, `/StepIdentity`, and one
subpath per top-level module (`DurableClock`, `DurableDeferred`, `DurableQueue`,
`Graph`, `HumanTask`, `Interpreter`, `Poll`, `RetryPolicy`, `Sleep`, `WaitFor`).
Four subpath shapes resolve to nothing on purpose: `@smthrs/flow/internal/*`,
`@smthrs/flow/*/index`, and the per-file paths under `Action/`, `Flow/`, and
`FlowRuntime/`. Reach those namespaces through their directory subpath instead.
`@smthrs/flow/package.json` is exported.

## What a runnable composition adds

This package declares the `FlowRuntime` port and implements none of it, so a
composition that runs a flow adds an engine and a platform crypto service.

- [`@smthrs/engine`](/api/engine) implements `FlowRuntime`. Its
  `FlowEngine.layerMemory` keeps every recorded step in the process, which is
  what the [Quickstart](./quickstart.md) and most tests use.
- `@effect/platform-node` supplies `NodeCrypto.layer`. An action dispatch is
  recorded under a derived step identity, so the engine needs a `Crypto` service
  even in memory. A browser host supplies its own, such as `BrowserCrypto` from
  `@effect/platform-browser`; nothing in this package imports a Node built-in.

Add [`@smthrs/engine-store`](/api/engine-store) when the recorded steps have to
outlive the process. It backs the same port with SQLite, which is what turns a
suspended run into one a later process resumes.

## Next step

Run a flow end to end in the [Quickstart](./quickstart.md).
