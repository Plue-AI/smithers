---
title: "Installation"
description: "What @smthrs/create-app needs, how to scaffold an installable RC app, and the import forms each subpath serves."
sidebar:
  order: 1
---

## Requirements

- Node.js 26.4.0 or later.
- pnpm, for the scaffold command and for the app's own scripts.

Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

## Scaffold an app

`create-app` is a verb of `smithers-build`, the executable of
[`@smthrs/build-cli`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/build-cli). The templates ship inside this package,
and the CLI resolves them through Node rather than by path:

```bash
pnpm exec smithers-build create-app ledger
```

The directory name becomes the app name, so it must match
`^[a-z0-9][a-z0-9._-]*$`. The target directory must be absent or empty. Two
options change what you get:

| Option                    | Default   | What it does            |
| ------------------------- | --------- | ----------------------- |
| `--template <name>`, `-t` | `default` | Which template to copy. |

[Templates](./reference/templates.md) describes the public scaffold, and the
command's full argument list is in the [command reference](./reference/cli.md).

## What the scaffold rewrites

Copying is the whole scaffold, plus one substitution.

Every `.css`, `.html`, `.json`, `.jsonc`, `.md`, `.mjs`, `.ts`, and `.tsx` file
has `__APP_NAME__` replaced by the directory's name. Every other file is copied
byte for byte.

The template manifest already pins every `@smthrs/*` dependency to the same RC
release line:

```json
{
  "dependencies": {
    "@smthrs/core": "1.0.0-rc.1",
    "@smthrs/create-app": "1.0.0-rc.1"
  }
}
```

There is no generated override, local path, or vendored package tree. A fresh
app resolves through the registry exactly as an end user install does.

## Install the app

```bash
cd ledger
pnpm install
```

The install brings the app's own stack with it: React 19, Vite 8, Vitest 5.0.0,
wrangler, and the Cloudflare Vite plugin. It also installs this package's
executable, `smithers-routes`, which the app's `pnpm routes` script runs.

The generated `flows/chat/flow.e2e.ts` uses the optional testing adapter.
The template already declares its `@smthrs/testing`,
`@effect/platform-node`, and `@effect/platform-node-shared` prerequisites and
the compatible Vitest 4 runner.

For npm consumers of `@smthrs/create-app/testing`, use npm 11.16.0 or newer.
The release smoke certifies npm 11.16.0 on Node 26.4.0. npm 10.9.3 crashes in
Arborist while resolving this valid optional-peer graph; the same manifest
installs and runs with npm 11.16.0.
This is an installer requirement, separate from the supported Node runtime.

## Import forms

An app imports the subpath whose runtime class matches the file doing the
importing. There is no barrel that serves all of them:

```ts
// PACKAGE.ts, in Node.
import { CreateApp } from "@smthrs/create-app"

// AGENT.ts, SANDBOX.ts, TOOLS.ts, and flow files: browser, workerd, or Node.
import { defineAgent, defineSandbox, defineTools } from "@smthrs/create-app/app"

// app/panes/<name>.tsx, in the browser.
import { definePane } from "@smthrs/create-app/ui"

// A host that runs a routed flow.
import { layerFor, materializeFlow } from "@smthrs/create-app/runtime"

// vite.config.ts.
import { createApp } from "@smthrs/create-app/vite"

// A flow's test file.
import { cachedModelTest } from "@smthrs/create-app/testing"
```

`./app`, `./ui`, and `./runtime` reach no `node:` builtin, which is what lets a
Worker bundle and a browser bundle load them. `sideEffects: []` lets a bundler
drop the Node half when only those three are imported.

Two subpath forms are refused by the export map: `@smthrs/create-app/internal/*`
and `@smthrs/create-app/*/index`. `@smthrs/create-app/package.json` is
exported.

## Optional peer dependencies

Each peer is needed only by the subpath that uses it, so an app that skips a
subpath skips its peer:

| Peer                           | Range          | Needed by                                                |
| ------------------------------ | -------------- | -------------------------------------------------------- |
| `@effect/platform-node`        | `4.0.0-rc.115` | `./testing`                                              |
| `@effect/platform-node-shared` | `4.0.0-rc.115` | `./testing`                                              |
| `@smthrs/testing`              | `1.0.0-rc.1`   | `./testing`                                              |
| `react`                        | `^19.2.8`      | `./ui`, and any page or layout                           |
| `vite`                         | `^8.2.2`       | `./vite`                                                 |
| `vitest`                       | `^5.0.0`       | `./testing`                                              |
| `tsx`                          | `^4.23.13`     | `loadManifest` in `./vite`, which evaluates `PACKAGE.ts` |

The default library install has no test runner or testing facade. To use
`@smthrs/create-app/testing`, install its prerequisites explicitly: `@smthrs/testing`,
`@effect/platform-node`, `@effect/platform-node-shared`, and `vitest@5.0.0`. Not on npm yet; see
[Installation](/docs/installation/#use-the-libraries).

`@effect/platform-node-shared` is the implementation `@effect/platform-node`
loads. The Node adapter depends on it through a caret, so an install that names
only the adapter is free to resolve a later shared release candidate whose own
`effect` peer this release does not satisfy. Naming both at the same version
keeps one Effect runtime in the tree.

`@smthrs/testing` supplies its grading facade through `@smthrs/scorers`.
Only its separate `Vitest` adapter also needs `@effect/vitest`.

An app that passes its own manifest to the Vite plugin never needs `tsx`. See
[Brand an app](./guides/brand-an-app.md).

## Next step

Scaffold, route, and test an app end to end in the
[Quickstart](./quickstart.md).
