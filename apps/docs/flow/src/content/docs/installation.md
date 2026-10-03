---
title: "Installation"
description: "Install @smthrs/flow, its runtime requirements and pinned effect version, its import forms, and the packages a runnable composition adds."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/installation.md"
---

## Install the package

link the source packages using [Use the libraries](#use-the-libraries).

`effect` is a runtime dependency of this package and installs with it. Add it to
your own dependencies at the same version anyway: your declarations import
`effect/Schema` and your implementations import `effect/Effect` directly, and two
copies of `effect` in one program are two sets of service tags.

The package requires Node.js 26.4.0 or later. It ships as both ESM and
CommonJS with TypeScript declarations, and it pulls in
[`@smthrs/plan`](https://plan.smithers.sh/reference/api/), [`@smthrs/crypto`](https://crypto.smithers.sh/reference/api/),
[`@smthrs/keys`](https://keys.smithers.sh/reference/api/), and [`@smthrs/canonical`](https://canonical.smithers.sh/reference/api/), which
supply the node vocabulary a body is written in, the digests identity is built
from, and the canonical JSON checks applied to values.

## Use the libraries

First [install the source checkout](https://github.com/smithersai/smithers/blob/main/packages/smithers/docs/installation.md#install-the-cli). The checkout's `examples` workspace carries the packages used by the flow tutorials and their pinned `effect@4.0.0-rc.115`.

Create a project beside the checkout:

```bash
mkdir my-flows && cd my-flows
echo '{ "type": "module" }' > package.json
ln -s /path/to/smithers/examples/node_modules node_modules
```

Replace `/path/to/smithers` with the absolute path to your installed checkout. Run programs with `node <file>.ts`. Packages absent from the examples workspace, such as `@smthrs/artifacts`, resolve only inside the checkout; use the owning package's workspace for those examples. This linking recipe uses source exports and requires no package build.

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

- [`@smthrs/engine`](https://engine.smithers.sh/reference/api/) implements `FlowRuntime`. Its
  `FlowEngine.layerMemory` keeps every recorded step in the process, which is
  what the [Quickstart](/quickstart/) and most tests use.
- `@effect/platform-node` supplies `NodeCrypto.layer`. An action dispatch is
  recorded under a derived step identity, so the engine needs a `Crypto` service
  even in memory. A browser host supplies its own, such as `BrowserCrypto` from
  `@effect/platform-browser`; nothing in this package imports a Node built-in.

Add [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) when the recorded steps have to
outlive the process. It backs the same port with SQLite, which is what turns a
suspended run into one a later process resumes.

## Next step

Run a flow end to end in the [Quickstart](/quickstart/).
