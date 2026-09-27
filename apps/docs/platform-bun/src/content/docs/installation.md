---
title: "Installation"
description: "Install @smthrs/platform-bun, its required peers, the smithers-jj-export helper the filesystem slot needs, the jj executable every complete bundle probes at startup, and the import forms for each entry point."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-bun/docs/installation.md"
---

## Install the package and its peers

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

Version 1.0.0-rc.0 is not on npm yet. Until it is published, take the package
from [the repository](https://github.com/smithersai/smithers); the rest of this
page applies either way.

The manifest declares five required peers, none optional:

| Peer                           | Version        | Why                                                        |
| ------------------------------ | -------------- | ---------------------------------------------------------- |
| `effect`                       | `4.0.0-rc.115` | The runtime every service tag belongs to.                  |
| `@effect/platform-bun`         | `4.0.0-rc.115` | Imported at module load by the root entry and `BunHost`.   |
| `@effect/platform-node`        | `4.0.0-rc.115` | The Node adapters the bundle falls back to off Bun.        |
| `@effect/platform-node-shared` | `4.0.0-rc.115` | The shared adapter implementation both Effect bundles use. |
| `@smthrs/platform-node`        | `1.0.0-rc.0`   | The atomic filesystem slot and the containment machinery.  |

Package managers that resolve required peers install all five automatically;
the command above pins them so a lockfile records the versions. All Effect
versions are exact so the host shares one compatible Effect runtime.

## Supported runtimes

Bun 1.4.0 or later, and Node.js 26.4.0 or later. Both are declared in
`engines`, and both are real: the bundle falls back to the
`@effect/platform-node` adapters off Bun, so it runs unchanged under Node. See
[Runtime parity with Node](/concepts/runtime-parity/) for what that does and
does not buy you.

## Install the filesystem helper

The filesystem slot is `@smthrs/platform-node`'s `AtomicFileSystem`, which
carries the kernel's atomic host extension. That extension does not run
in-process: it executes each guarded path operation through the
`smithers-jj-export` helper so the operation is descriptor-relative and
no-follow. From a source checkout, build it with:

```bash
cargo build --locked --release -p smithers-ffi --bin smithers-jj-export
```

Elsewhere, set `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` to its absolute path; see
[Configure the filesystem helper](/guides/configure-the-filesystem-helper/).

Windows is unsupported for this slot.

## Install Jujutsu for the complete bundles

Every complete bundle, `BunHost.layer`, `layerAt`, `layerContained`, and
`layerContainedAt`, requires jj 0.39.0 or later on the host, whether or not
the program uses the `Jj` slot. Each factory merges its `Jj` layer with the
other four, and that layer runs one `jj --version` probe while the layer is
built. On a host without the executable, or with an older one, construction
fails with `JjError` carrying `not_installed` or `unsupported_version` before
the program body runs, even for a program that asked for only `FileSystem`.

Install [Jujutsu](https://jj-vcs.github.io), a version-control system that
works on a Git repository, and confirm the version:

```bash
jj --version
```

This package vendors no binaries. [`@smthrs/jj`](https://jj.smithers.sh/reference/api/) documents the
resolution order and the `SMITHERS_JJ_PATH` override for an executable that is
not on `PATH`.

A program that must run without jj composes the individual service layers
instead of a complete bundle: `BunFileSystem.layer`, `Path.layer`, and the
spawner and HTTP client layers each build without a probe. See
[The Host surface on Bun](/concepts/host-surface/) for taking one service
without the other four.

## Import forms

The root entry point re-exports both modules as namespaces:

```ts
import { BunFileSystem, BunHost } from "@smthrs/platform-bun"
```

Each module is also importable from its own subpath, which is the form the
[API reference](/reference/api/) uses:

```ts
import * as BunFileSystem from "@smthrs/platform-bun/BunFileSystem"
import * as BunHost from "@smthrs/platform-bun/BunHost"
```

Two subpath forms are blocked in the export map and are not public:
`@smthrs/platform-bun/internal/*` and `@smthrs/platform-bun/*/index`.
`@smthrs/platform-bun/package.json` is exported.

The bundle resolves `node:` built-ins, so it does not bundle for a browser. A
page composes [`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/) instead.

## What a real composition adds

`BunHost.layer` provides the raw host. Two additions are common:

- [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/) guards it. Its `FileSystem.layer`,
  `ChildProcessSpawner.layer`, `HttpClient.layer`, `Jj.layer`, and `Path.layer`
  decorate the very tags this bundle provides, in place, so a capability check
  runs before every host call. The guarded filesystem is also where the atomic
  extension earns its keep, and it needs a `Workspace` root and a `GrantStore`.
- A `ProcessLedger`, from `@smthrs/kernel/ProcessLedger`, is required by
  `BunHost.layerContained` and `BunHost.layerContainedAt`. It is a requirement
  rather than a default because only your program knows whether it has a
  durable journal to write to. See
  [Contain and reap child processes](/guides/contain-child-processes/).

The `Jj` slot spawns the `jj` command that
[Install Jujutsu for the complete bundles](#install-jujutsu-for-the-complete-bundles)
covers. A bundle probes it at construction, so the executable is a startup
requirement rather than a slot the program opts into.

## Next step

Run a command and a file operation through the host in the
[Quickstart](/quickstart/).
