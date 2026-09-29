---
title: "Installation"
description: "Install @smthrs/sandbox, its runtime requirements and import forms, and the vendor SDK or host tool each bundled provider expects you to supply."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

The package requires Node.js 26.4.0 or later and ships as ESM and CommonJS
with TypeScript declarations. It has two runtime dependencies,
[`effect`](https://effect.website) and
[`@smthrs/kernel`](/api/kernel), and the second is used only for command line
rendering and POSIX quoting. Nothing else is required: a sandbox is one way to
satisfy Effect's `ChildProcessSpawner` rather than a new host interface you
have to adopt.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Sandbox, SandboxHealth, SandboxSupervision } from "@smthrs/sandbox"
```

Each namespace is also its own subpath, which is the form the API reference
uses:

```ts
import * as ContainerSandbox from "@smthrs/sandbox/ContainerSandbox"
import * as Sandbox from "@smthrs/sandbox/Sandbox"
```

Two subpath forms are blocked in the export map:
`@smthrs/sandbox/internal/*` and `@smthrs/sandbox/<Namespace>/index`.
`@smthrs/sandbox/package.json` is exported.

## What a runnable composition adds

Four of the bundled providers are built from Effect's own host services,
which a platform package supplies.

`NodeHost.layerContained()` provides the filesystem, path, and lifecycle-backed
spawner `DirectorySandbox` requires. Provide a `ProcessLedger` underneath it,
as the [quickstart](./quickstart.md) does. A raw `NodeServices.layer` spawner or
a wrapper with only a kill deadline is refused before a workspace is created.

`ContainerSandbox`, `KubernetesSandbox`, and `AwsSandbox` accept host services
for their local transports; their machines and guest cleanup are managed by
the respective providers. `JustBashSandbox` takes a `FileSystem` mounted over
its interpreter's tree. The remaining prerequisites are listed per provider.

## What each provider expects

This package owns no vendor dependency. A vendor SDK arrives as an injected
structural slice and a command-line tool arrives as an injected spawner, so
adding a backend costs this package no dependency and costs you only what that
backend needs.

| Provider              | You supply                                                                                                                    | Installed where                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `DirectorySandbox`    | An Effect `FileSystem` and a lifecycle-backed `ChildProcessSpawner`.                                                          | The host process.                                                                   |
| `JustBashSandbox`     | A [`just-bash`](https://www.npmjs.com/package/just-bash) `Bash` instance and a `FileSystem` mounted over the same tree.       | The host process, or the browser page.                                              |
| `CommandSandbox`      | A `ChildProcessSpawner` and an argv prefix that reaches the machine, such as `ssh`. The guest needs `sh`, `env`, `base64`.    | The machine running the provider.                                                   |
| `ContainerSandbox`    | A `ChildProcessSpawner`, a Docker-compatible CLI, host `/dev/stdin` for creation env, and guest `sh`, `env`, `base64`.        | The machine running the provider.                                                   |
| `KubernetesSandbox`   | A `ChildProcessSpawner`, `kubectl` on `PATH`, and a cluster context. The guest image must carry `sh`, `env`, and `base64`.    | The machine running the provider, plus the cluster.                                 |
| `MicrosandboxSandbox` | The [`microsandbox`](https://www.npmjs.com/package/microsandbox) SDK module, and a Microsandbox host that can boot a microVM. | Both.                                                                               |
| `VercelSandbox`       | The `@vercel/sandbox` SDK module, and either an OIDC token or a token, team id, and project id.                               | The host process.                                                                   |
| `DaytonaSandbox`      | A configured Daytona client from the vendor SDK.                                                                              | The host process.                                                                   |
| `AwsSandbox`          | An ECS client and CLI spawner; `exec.streamingSpawner` is required for file writes, stdin, and spawn env.                     | The machine running the provider, plus an ECS cluster with execute-command enabled. |
| `CloudflareSandbox`   | The `@cloudflare/sandbox` `getSandbox` function and a Worker binding to a deployed Durable Object namespace.                  | The Worker.                                                                         |

Because the SDK slices are structural, you can satisfy them with a test double
instead of the vendor package, which is how the package's own suite proves
seven of the ten providers. See
[Test against a scripted machine](./guides/testing.md).

## Browser bundles

The package bundles for the browser. No module reads a host global: the conformance fixture's per-process
uniqueness comes from Web Crypto rather than a process id, because a bundler
cannot catch a free `process` identifier that survives into the bundle and
throws in a browser.

`JustBashSandbox` is the provider a browser page can actually run, over a
just-bash interpreter and a filesystem mounted on the same tree. The other
providers bundle, but their transports need a host.

## Next step

Place a flow body on a real machine and read its result in the
[Quickstart](./quickstart.md).
