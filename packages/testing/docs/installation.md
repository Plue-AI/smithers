---
title: "Installation"
description: "Install @smthrs/testing, its optional vitest peers, its import forms, and the subpaths that are deliberately not on the root barrel."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

[`effect`](https://effect.website) is a required peer dependency at exactly
`4.0.0-rc.115`. Two copies of `effect` in one program are two sets of service
tags, so the version is pinned rather than ranged.

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. The `@smthrs/*` packages the assertions
read install with it: [`@smthrs/core`](/api/core),
[`@smthrs/engine`](/api/engine), [`@smthrs/flow`](/api/flow),
[`@smthrs/jj`](/api/jj), [`@smthrs/journal`](/api/journal),
[`@smthrs/kernel`](/api/kernel), [`@smthrs/model`](/api/model), and
[`@smthrs/plan`](/api/plan). The grading facade also installs
[`@smthrs/scorers`](/api/scorers), which owns the runner-neutral `ScoreGate`
implementation. Evals consumes scorers directly and needs no testing facade
in production.

## Install the vitest peers only if you use the adapter

`vitest` and `@effect/vitest` are optional peer dependencies. Only the
`Vitest` module imports them, and `@effect/vitest` is pinned the same way
`effect` is:

```bash
pnpm add -D vitest@5.0.0 @effect/vitest@4.0.0-rc.115
```

Every other module works under any runner, because an assertion is an ordinary
`Effect` and a conformance case is a plain value.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Conformance, EngineSubject, JournalAssertions, TestLayers } from "@smthrs/testing"
```

Each module is also importable from its own subpath, which is the form the
[API reference](./api.md) uses:

```ts
import * as JournalAssertions from "@smthrs/testing/JournalAssertions"
import * as TestLayers from "@smthrs/testing/TestLayers"
```

## Four modules stay off the root barrel

`TestHost` is the deterministic host bundle: an in-memory filesystem, scripted
interpreter, `TestClock`, and seeded PRNG. Each layer build starts with a fresh
filesystem and restarts the PRNG from its seed, even when tests reuse the
exported `TestHost.TestHost` layer. Import it explicitly:

```ts
import * as TestHost from "@smthrs/testing/TestHost"
```

The scripted interpreter only runs commands declared as own properties of the
command table. An unlisted command returns exit code `127` and
`command not found: <command>\n` on stderr, including names such as `constructor`
and `__proto__`.

The memory filesystem rejects non-recursive `mkdir` with `ENOENT` when the
parent is missing. Non-recursive `rm` rejects a non-empty directory with
`ENOTEMPTY`, including when `force` is set, and preserves its entries. Use
`recursive: true` to create missing parents or remove a directory tree.

`Vitest` is ESM only and absent from the barrel on purpose. `vitest` refuses to
load through `require()`, so a barrel that re-exported it would break
`require("@smthrs/testing")` for every CommonJS consumer of the assertion
helpers:

```ts
import * as Vitest from "@smthrs/testing/Vitest"
```

`Faults` is absent for a different reason: it is not a double. It sends real
signals to real pids and moves the wall clock this process reads. Importing it
by subpath keeps that decision visible at the import site:

```ts
import { killProcess, waitForReparent } from "@smthrs/testing/Faults"
```

`ProcessTable` is absent because it spawns `ps` through `node:child_process`,
which browser test hosts cannot load:

```ts
import * as ProcessTable from "@smthrs/testing/ProcessTable"
```

## What is not public

`@smthrs/testing/internal/*` and `@smthrs/testing/*/index` are blocked in the
package's export map. `@smthrs/testing/package.json` is exported.

## Next step

Certify an engine against the mandatory conformance suite in the
[Quickstart](./quickstart.md).
