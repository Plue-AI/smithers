---
title: "Installation"
description: "Install @smthrs/gateway, know which Node version it needs, which import forms are public, and which four services a host must supply before the mounts can serve."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/gateway/docs/installation.md"
---

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

## Requirements

- Node.js 26.4.0 or later. The Node host uses `node:http` and
  `@effect/platform-node`, so it does not run in a browser or in a Worker.
- One copy of `effect` in the resolved tree. A second copy makes a `Layer`
  built against one fail to satisfy a requirement declared against the other.

`effect` is a required peer pinned to `4.0.0-rc.115`.
`@effect/platform-node` is an optional peer at the same exact version, needed
by `node/NodeGateway`. The root and protocol subpaths do not install the Node
adapter. A Node gateway host selects it explicitly:

```bash
pnpm add effect@4.0.0-rc.115 @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115
```

For Bun, add the optional `@effect/platform-bun@4.0.0-rc.115` peer and import
`@smthrs/gateway/bun/BunGateway`. Pin
`@effect/platform-node-shared@4.0.0-rc.115` with either adapter: both depend on
that shared implementation through a caret, which otherwise resolves to a later
release candidate whose own `effect` peer this release does not satisfy. The
root and protocol subpaths need neither native adapter.

Two packages install with it as ordinary dependencies:
[`@smthrs/control`](https://control.smithers.sh/reference/api/) and [`@smthrs/sync`](https://smithers-sync.smithers.sh/reference/api/).
You do not name them separately to
compile against this package's API. The guides that compose a full host or a
test stack import more than that, and each says which packages it adds.

## Import forms

The root entry point exports one namespace per module:

```ts
import { Diagnosis, GatewayError, GatewayProjection, GatewaySchema, GatewayServer, Projections } from "@smthrs/gateway"
```

Every local module is also importable on its own path, which is what a host
that only needs one of them should use:

```ts
import * as GatewayServer from "@smthrs/gateway/GatewayServer"
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
```

`@smthrs/gateway/package.json` is exported. `@smthrs/gateway/internal/*` and
nested `@smthrs/gateway/<Module>/index` subpaths are not public and resolve to
nothing.

The root entry also re-exports `@smthrs/sync` whole as `Sync`, so a host that
mounts the journal read path does not add a second import:

```ts
import { Sync } from "@smthrs/gateway"

const server = Sync.SyncServer.layer
```

## What a host supplies

`NodeGateway.layer` builds the socket, the newline-delimited JSON
serialization, and the shared-credential authentication. Four services stay the
caller's, because only a project on disk can provide them:

| Service                       | Comes from                                 | Serves                |
| ----------------------------- | ------------------------------------------ | --------------------- |
| `Control` (`@smthrs/control`) | `ControlLive.layer` over a control runtime | `/rpc`, `/rpc/ws`     |
| `Projections` (this package)  | `Projections.layer`, over that `Control`   | `/projections`        |
| `SyncServer` (`@smthrs/sync`) | `SyncServer.layer` over a journal          | `/sync`               |
| `SyncAuth` (`@smthrs/sync`)   | `SyncAuth.layer`                           | `/sync` authorization |

`Projections.layer` reads through the ambient `Control`, so a host that
composes both gets one control plane rather than two views of one database.
The full composition, with the storage underneath it, is in
[Host the gateway in your own process](/guides/host-the-gateway/).

## Running without composing anything

[`smthrs serve`](https://smithers.sh/docs/reference/cli/serve/) hosts this exact assembly for a project on disk.
If you want a gateway rather than a library, use the CLI instead. Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#install-the-cli).

Then see the [Quickstart](/quickstart/).
