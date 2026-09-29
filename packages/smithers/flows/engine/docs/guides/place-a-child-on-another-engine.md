---
title: "Place a child flow on another engine"
description: "Annotate a flow with Flow.Placement, bind the placement's target to another engine's served FlowProxy group with Hosts.layer, and run it as a .child() under the id the parent derives."
---

A flow says where it wants to run without naming a machine. The host that
composes the engine says which machine that is.

## Declare the placement

```ts
import { Flow } from "@smthrs/flow"
import * as Placement from "@smthrs/plan/Placement"

const Release = Flow.make("deploy/release", {
  payload: { version: Schema.String },
  success: Schema.String,
  body: (payload) => PushRelease.call(payload)
}).annotate(Flow.Placement, Placement.remote({ target: "deploy" }))

const Ship = Flow.make("deploy/ship", {
  payload: { version: Schema.String },
  success: Schema.String,
  body: (payload) => Release.child(payload)
})
```

A placement that differs from the caller's must be a `.child()`: an inline
`.call()` is refused at build with `placement_requires_boundary`.

## Serve the flow where it runs

The engine that holds the secret or the machine serves the flow:

```ts
const served = RpcServer.layerHttp({ group: FlowProxy.toRpcGroup([Release]), path: "/rpc", protocol: "http" }).pipe(
  Layer.provide(FlowProxyServer.layerRpcHandlers([Release])),
  Layer.provide(RpcSerialization.layerJson)
)
```

## Bind the target where it is called

```ts
import { Hosts } from "@smthrs/engine"

const table = Hosts.layer({
  deploy: {
    _tag: "Proxy",
    connect: (group) =>
      RpcClient.make(group).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({ url: "https://deploy.internal/rpc" }).pipe(
            Layer.provide(RpcSerialization.layerJson),
            Layer.provide(FetchHttpClient.layer)
          )
        )
      )
  }
})
```

Provide `table` to the calling engine's layer, beside its `Interpreter.layer`
registrations, never at an `execute` call site: a body reads the table its
registration was built with, and a run reclaimed after a restart has no call
site. With no table every placement runs here, so the same flow file runs
unchanged on a host that is the deploy machine.

## What the two engines hold

- The caller's plan holds one leaf for the child, under the id
  `Interpreter.childExecutionId` derives from the parent, the node, the callee,
  and the payload.
- The remote engine holds the child's plan, attempts, and result under that id.
  A re-driven parent derives the same id, and the remote engine joins the run it
  already has. Another payload under the same id is refused.
- A parent interrupted while the child runs sends `interrupt` to the remote
  engine, because the remote run has no lineage edge to the parent. The forward
  is best effort: a cancel the remote engine never received is logged, and the
  remote run goes on.
- A connection that fails or resets before an answer arrives is asked again
  under the same id for about six minutes; the remote engine joins the run it
  has or answers the result it recorded. After that it is a defect of the
  parent. An answer the client cannot read, such as a proxy's error page or a
  refused bearer, is not asked again and is a defect at once.
- The remote engine reads its own `Hosts` table, never the caller's. That table
  must run the flows it serves here: one that sends them back out loops.
- Two callers that use the same execution id and payload share one remote run.
  A holder serving several callers scopes their ids with `FlowProxyServer`'s
  `executionId` option.

`agent/spawn` of a `Proxy` flow is not supported: the spawner confirms the child
by reading its run row on this engine, and a remote child has none.
