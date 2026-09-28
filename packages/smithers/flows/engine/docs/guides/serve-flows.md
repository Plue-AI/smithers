---
title: "Serve flows over RPC or HTTP"
description: "Derive Effect RPC definitions or HTTP endpoints from a list of flows with FlowProxy, bind them to a running engine with FlowProxyServer, and understand what the server side requires that the client side does not."
---

One process declares a flow; another runs it. `FlowProxy` derives the wire
definitions from the flow declarations themselves, and `FlowProxyServer` binds
those definitions to a running engine.

Every flow gets three operations, and their names are derived from the flow tag
in one place, `FlowProxy.operationAddresses`:

| Operation | Name           | Request                                          |
| --------- | -------------- | ------------------------------------------------ |
| Execute   | `<tag>`        | The flow payload, plus a required `executionId`. |
| Discard   | `<tag>Discard` | The same, run without waiting for a result.      |
| Resume    | `<tag>Resume`  | An `executionId` alone.                          |

## Start from a flow

Nothing about the flow changes to make it servable:

```ts
import { Action, Flow } from "@smthrs/flow"
import * as Schema from "effect/Schema"

const ReviewStep = Action.make("docs/ReviewStep", {
  payload: { id: Schema.String },
  success: Schema.String
})

const Review = Flow.make("docs/Review", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
  body: (payload) => ReviewStep.call(payload)
})

const flows = [Review] as const
```

## Serve over RPC

Derive the group from the flows, then provide the handler layer under an RPC
server:

```ts
import { FlowProxy, FlowProxyServer } from "@smthrs/engine"
import * as Layer from "effect/Layer"
import { RpcServer } from "effect/unstable/rpc"

class ReviewRpcs extends FlowProxy.toRpcGroup(flows, { prefix: "flows_" }) {}

const RpcLayer = RpcServer.layer(ReviewRpcs, { disableFatalDefects: true }).pipe(
  Layer.provide(FlowProxyServer.layerRpcHandlers(flows, { prefix: "flows_" }))
)
```

Pass the same `prefix` to both calls. The prefix is part of the derived
operation name, so a group built with one prefix and handlers built with
another produce a server with no matching handlers.

Set `disableFatalDefects: true` to keep a handler defect scoped to its request
on a shared RPC connection. See [Troubleshooting](../troubleshooting.md#one-rpc-request-fails-other-pending-requests).

Execute, discard, and resume payloads require an `executionId` with 1 to 4,096
UTF-16 code units and no unpaired surrogates. RPC and HTTP schemas reject
invalid ids before invoking the engine.

Direct library calls to `Flow.execute` may omit the id. A declared
`idempotencyKey` then selects it; otherwise the default source mints a fresh
UUID for each invocation. Proxy clients must supply an id and retain it to
retry or resume the same execution.

## Serve over HTTP

The HTTP form adds a group to an `HttpApi` and binds it the same way:

```ts
import { HttpApi } from "effect/unstable/httpapi"

class ProxyApi extends HttpApi.make("proxy").add(
  FlowProxy.toHttpApiGroup("flows", flows)
) {}

const HttpLayer = FlowProxyServer.layerHttpApi(ProxyApi, "flows", flows)
```

Each flow gets three POST routes: one at its path, one at `<path>/discard`, and
one at `<path>/resume`.

The path is not the flow tag. Routers disagree about whether a percent-encoded
slash is decoded before matching, so a tag is lowered to one opaque URL-safe
segment: `flow-` followed by the tag's UTF-16 code units in hex. The encoding
is injective and stays one segment in every adapter, which preserves case,
reserved characters, and Unicode normalization distinctions that would
otherwise collapse two different flows onto one route.

A tag that is not well-formed UTF-16 has no route encoding, and
`toHttpApiGroup` throws `InvalidFlowTag`. This includes a trailing unpaired
high surrogate.

## Collisions are refused before construction

Operation names are derived by suffixing, so a flow set containing both `Foo`
and `FooDiscard` would generate the same wire name twice.
`FlowProxy.assertNoCollisions` runs first in every group builder and every
server layer, and throws `FlowProxyCollision` naming the ambiguous operation.
The failure happens while you are wiring the server, not while it is serving.

Call it yourself when you assemble a flow list dynamically:

```ts
FlowProxy.assertNoCollisions(flows, "flows_")
```

## Serving a flow is executing it

Both server layers drive the served bodies, so both require what those bodies
require: `Flow.Requirements` of every flow, on top of the schema services
`Flow.RequirementsHandler` names. A forgotten `Action.toLayer` is a compile
error on this side of the boundary, exactly as it is when you execute the flow
directly.

The client side is unaffected. It encodes a payload and decodes a result, and
requires no implementation at all, which is the whole point of putting the
engine behind a wire.

Both layers log a defect raised by a served body through `Effect.logError`,
annotated with the module and the wire operation name, so a serving failure is
attributable without reading the client's error.

## What these modules are not

`FlowProxy` and `FlowProxyServer` expose flow transport and nothing else. They
do not ship a server, a router, an authentication policy, or a durable engine.
Mount the derived definitions in your own application, and provide the engine
underneath.

Authenticate every request before it reaches these handlers. Without an
`executionId` scope, the server passes the client's id through unchanged, so
any caller that knows or guesses an id can resume that execution, or repeat
its execute request and receive its stored result. A server that accepts more
than one principal must bind each id to the caller with an
[`executionId` scope](./namespace-execution-ids.md).

## Related

- [Namespace execution ids per tenant](./namespace-execution-ids.md): the
  `executionId` option both server layers accept.
- [Execution identity](../concepts/execution-identity.md): why a repeated
  request with one id is safe.
