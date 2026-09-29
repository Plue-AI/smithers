---
title: "Host the gateway in your own process"
description: "Compose NodeGateway.layer with the four services the mounts read through, launch it, and read back the port it bound."
sidebar:
  order: 1
---

`NodeGateway.layer` is the whole gateway on a Node HTTP server. It supplies the
bind policy, the shared-credential authentication both RPC groups run under,
and newline-delimited JSON as the wire serialization. Four services stay yours,
because only a project on disk can provide them.

Reach for this when [`smthrs serve`](/cli/serve) is not the host you want: an
embedded gateway inside a larger process, a test harness, or a deployment that
already owns its own storage layer.

## Supply the four services

```ts
import type * as GatewayServer from "@smthrs/gateway/GatewayServer"
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
import * as GatewayProjections from "@smthrs/gateway/Projections"
import type * as Journal from "@smthrs/journal/Journal"
import * as RunCatalog from "@smthrs/sync/RunCatalog"
import * as SyncAuth from "@smthrs/sync/SyncAuth"
import * as SyncServer from "@smthrs/sync/SyncServer"
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"
import { Layer } from "effect"

export const gateway = (
  health: GatewayServer.Health,
  options: NodeGateway.ServerOptions,
  journal: Layer.Layer<Journal.Journal>
) =>
  NodeGateway.layer(health, options).pipe(
    Layer.provide([
      // The read path, over whatever Control the caller provides.
      GatewayProjections.layer,
      // The journal read path. A local gateway publishes no catalog and
      // shares nothing, so both sync ports are the no-op implementations.
      SyncServer.layer.pipe(Layer.provide([journal, RunCatalog.layerNoop])),
      SyncAuth.layer.pipe(Layer.provide(WorkspaceShare.layerNoop))
    ])
  )
```

The journal is the host's own, so [`@smthrs/journal`](/api/journal) is a
dependency you add rather than one this package installs for you.

Those three provisions discharge every gateway input except `Control`, which
stays a requirement on purpose: a host should serve the same control plane its
own code talks to rather than opening a second one over the same database.
Provide it last, from `ControlLive.layer` over your control runtime. See
[Serve the control plane over RPC](/pkg/control/guides/serve-over-rpc).

`GatewayProjections.layer` reads through the ambient `Control`, so it inherits
whatever you provide. When a relay in front of you cuts idle connections sooner
than 600 seconds, set `heartbeatMillis` at the bind, which re-times both the
projection heartbeat and the `Watch` keepalive, or use
`GatewayProjections.layerWith({ heartbeatMillis })` to shorten the projection
heartbeat alone.

## The health identity

`NodeGateway.layer` takes the identity `GET /health` will answer with. It is
`GatewaySchema.GatewayHealth` plus the version of the package serving it:

```ts
import type * as GatewayServer from "@smthrs/gateway/GatewayServer"
import { createHash } from "node:crypto"
import { resolve } from "node:path"

/** A stable short hash of the project root, so the path is never published. */
const workspaceHash = (root: string): string => createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16)

export const health = (root: string, version: string): GatewayServer.Health => ({
  workspaceHash: workspaceHash(root),
  gatewayId: `host-${process.pid}`,
  protocolVersion: "1",
  version
})
```

Derive `workspaceHash` from the workspace and from nothing else. A supervisor
that finds a gateway already on a port asks `/health` whether it is this
workspace's before deciding to keep or replace it, and an identity derived from
anything else cannot answer that.

## Launch it

The layer is the server. Launching it serves until the fiber is interrupted:

```ts
import { Effect, Layer } from "effect"

const program = Layer.launch(gateway(health(root, "1.0.0-rc.0"), { host: "127.0.0.1", port: 7331 }, journal))

Effect.runFork(program.pipe(Effect.provide(control)))
```

`NodeGateway.defaultServerOptions` is `{ host: "127.0.0.1", port: 7331 }`. The
CLI binds port 3000 instead; neither is privileged, and the port is yours to
choose.

## Read back the port you got

The returned layer retains the concrete `HttpServer` service, so a caller that
bound port 0 can read the ephemeral address the operating system gave it. This
is what a test harness wants:

```ts
import { Effect } from "effect"
import { HttpServer } from "effect/unstable/http"

const baseUrl = Effect.map(HttpServer.HttpServer, (server) => {
  if (server.address._tag !== "InetAddressV4" && server.address._tag !== "InetAddressV6") {
    throw new Error("expected a TCP gateway")
  }
  return `http://127.0.0.1:${server.address.port}`
})
```

## Refuse a bad bind before you compose

Policy refusals and operating system listen failures both fail the layer as
sanitized `bind_failed` `GatewayError` values. A host that would rather report
a refusal than fail a layer asks first:

```ts
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"

const refusal = NodeGateway.bindRefusal({ host: "0.0.0.0", port: 7331 })
// GatewayError {
//   code: "bind_failed",
//   message: "Refusing non-loopback gateway bind 0.0.0.0 without an explicit --listen opt-in"
// }
```

`bindRefusal` answers the same value `listenOptions` fails with and `layer`
fails through, so there is one rule and one message, not a copy per call site.
The rules themselves are in [Serve beyond loopback](./serve-beyond-loopback.md).

## Mount only part of the surface

`GatewayServer` exposes each mount as its own layer for a host that assembles
its own router: `layerControlHttp`, `layerProjectionsHttp`, `layerSyncHttp`,
`layerHealth`, and `layerIngress`. `GatewayServer.layer` is those five merged,
and `NodeGateway.layer` is that plus a socket, a serialization, and an
authentication layer.

Splitting them is for hosts with an existing router, not for dropping a mount:
the ingress guard reads `rpcPaths` and `protectedPaths`, which name all three
RPC mounts, and a surface that serves fewer of them still pays the same guard.
