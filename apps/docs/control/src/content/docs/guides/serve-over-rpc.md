---
title: "Serve the control plane over RPC"
description: "Mount the same Control service as HTTP and WebSocket RPC, project it back into the Control interface on a client, authenticate with a bearer token, and read the transport failures a client can retry."
sidebar:
  order: 9
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/guides/serve-over-rpc.md"
---

`ControlServer.layerHttp` mounts the `Control` service as RPC;
`ControlClient.layer` projects the RPC client back into the same interface.
Remote operations also require transport configuration and authentication.

## Mount the server

```ts
import { NodeHttpServer } from "@effect/platform-node"
import * as ControlRpcs from "@smthrs/control/ControlRpcs"
import * as ControlServer from "@smthrs/control/ControlServer"
import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { createServer } from "node:http"

const served = HttpRouter.serve(
  ControlServer.layerHttp.pipe(
    Layer.provide(ControlRpcs.layerBearerAuth({
      token: process.env["SMITHERS_CONTROL_TOKEN"] ?? "",
      principal: { id: "operator", kind: "bearer" }
    })),
    Layer.provide(RpcSerialization.layerNdjson)
  )
).pipe(
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
)
```

`layerHttp` mounts both protocols together: unary procedures over
`POST /rpc`, and the `watch` stream over `WebSocket /rpc/ws`. The operations
divide cleanly. Plan, approve, run, and list are requests with answers; `watch`
is a projection that keeps arriving, so it rides a socket.

`ControlServer.layer` is the handler layer alone, for a host that mounts its
own protocols.

## Connect a client

`credential` authenticates HTTP requests only. Authenticated `watch` also
requires an `Authorization` header on the WebSocket upgrade. An ordinary
`NodeSocket.layerWebSocket` does not send it and watch fails with
`Unauthorized`. This Node composition uses the `ws` constructor exported by
`NodeSocket` to supply the upgrade header:

```ts
import { NodeHttpClient, NodeSocket } from "@effect/platform-node"
import * as ControlClient from "@smthrs/control/ControlClient"
import * as Layer from "effect/Layer"
import { RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"

const credential = process.env["SMITHERS_CONTROL_TOKEN"] ?? ""
const authenticatedSocket = Socket.layerWebSocket("ws://127.0.0.1:4000/rpc/ws").pipe(
  Layer.provide(
    Layer.succeed(Socket.WebSocketConstructor)((url, options) => {
      const configured = options !== undefined && typeof options !== "string" && !Array.isArray(options)
        ? options
        : undefined
      const protocols = configured === undefined ? options as string | Array<string> | undefined : undefined
      const socket = new NodeSocket.NodeWS.WebSocket(url, protocols, {
        ...configured,
        headers: { ...configured?.headers, Authorization: `Bearer ${credential}` }
      })
      // Effect removes reader listeners before closing. `ws` can report a
      // late handshake error during that close; keep Node from treating it as
      // an unhandled event. Active Effect listeners still receive all errors.
      socket.on("error", () => {})
      return socket
    })
  )
)

const client = ControlClient.layer({
  url: "http://127.0.0.1:4000/rpc",
  credential
}).pipe(
  Layer.provide([
    NodeHttpClient.layerUndici,
    authenticatedSocket,
    RpcSerialization.layerNdjson
  ])
)
```

With both HTTP and the socket upgrade authenticated, programs written against
`Control` can use this client layer. Handle `TransportError` and `Unauthorized`
in addition to each operation's domain failures; both are declared on every
`Control.Service` method.

Browser WebSockets cannot set upgrade headers. Browser deployments need a
trusted proxy that authenticates the caller and supplies the header. Tokens
in URL query strings are not supported.

`layerHttp` refuses, with 403 and before authentication, any request whose
`Origin` header does not match its `Host` header, on POST `/rpc` and on the
`/rpc/ws` upgrade. A browser always sends `Origin`, so a page on another site
cannot use a credential the proxy attaches for its victim. Non-browser
clients send no `Origin` and are unaffected. Serve the browser app from the
same origin as the control mount, and keep the proxy's `Host` header intact.

## Authenticate

`ControlRpcs.ControlAuth` is the middleware boundary, and it provides
`ControlPrincipal` to every handler.

| Layer                                   | Use                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `layerBearerAuth({ token, principal })` | One shared token. Every request carrying it receives the same principal. |
| `layerAuth(authenticator)`              | Your own header authenticator, returning a principal or `Unauthorized`.  |
| `layerNoopAuth(principal?)`             | Trusted in-process use and tests. Authenticates nothing.                 |

The bearer comparison is constant time, and a missing, malformed, empty, or
incorrect credential all fail closed with the same `Unauthorized` response.

## Who reads which runs

Every run the control plane launches records the principal that launched it as
`RunSummary.launchedBy`. `List` and `Watch` answer an operator with every run
and every other principal with only the runs it launched: its own run
summaries, the fires that started them, and their events. Triggers, a plan's
events and a run the engine created (a child, a fork, a later round) reach
operators only.
Another principal's run answers `RunNotFound`, exactly as a missing one does.

The authentication layer names the operators, because it knows which
identities it stamps. `layerBearerAuth` and `layerNoopAuth` stamp one principal
and make it the operator. `layerAuth` takes the rule as `seesAllRuns`, and
without it no principal is an operator:

```ts
const auth = ControlRpcs.layerAuth(authenticator, {
  seesAllRuns: (principal) => principal.kind === "operator"
})
```

Mutations are not yet confined the same way: a principal that learns another
principal's run id can still steer, signal, cancel, or resume it.

An authenticator also receives the call it is guarding, `{ rpc, payload }`,
on every in-band frame and nothing at a transport edge; `anyAuthenticator`
asks several in turn. `ScopedToken.authenticator` uses the call to confine a
minted token to the procedures, run, or flow it names, and composes with the
bearer:

```ts
import * as ControlRpcs from "@smthrs/control/ControlRpcs"
import * as ScopedToken from "@smthrs/control/ScopedToken"

const auth = ControlRpcs.layerAuth(ControlRpcs.anyAuthenticator([
  ControlRpcs.bearerAuthenticator({ token, principal: { id: "gateway", kind: "bearer" } }),
  ScopedToken.authenticator({ key: token, principal: { id: "gateway", kind: "scoped" } })
]))
```

A custom authenticator is an object with one method:

```ts
import { Unauthorized } from "@smthrs/control/ControlError"
import type * as ControlRpcs from "@smthrs/control/ControlRpcs"
import * as Effect from "effect/Effect"

const authenticator: ControlRpcs.Authenticator = {
  authenticate: (headers) =>
    lookupSession(headers["x-session"]).pipe(
      Effect.map((session) => ({ id: session.userId, kind: "user", stampedAt: Date.now() })),
      Effect.mapError(() => new Unauthorized({ message: "A valid session is required" }))
    )
}
```

## The server stamps identity, always

Every mutation that records who asked reads `ControlPrincipal` and stamps it,
rather than forwarding whatever the client sent. The identity the middleware
authenticated is the only one the server can stand behind, and it is what
reaches the journal, `RunSummary.cancellation`, and a steer's notification
provenance.

`Steer` is the one payload that carries a principal on the wire, because an
in-process caller names one that is not an operator. Over RPC the
authenticated identity replaces whatever arrived. See
[attribution over a wire](/guides/steer-a-run/).

## Failures a client sees

`ControlClient` normalizes everything into `ControlError`. A declared control
failure crosses the wire as itself; anything else becomes `TransportError`,
whose `retryable` flag classifies only the transport phase:

| Cause                                                  | `retryable` |
| ------------------------------------------------------ | ----------- |
| Connection, socket open, read, write, or close failure | `true`      |
| HTTP 5xx                                               | `true`      |
| HTTP 4xx                                               | `false`     |
| Request encode failure                                 | `false`     |
| Response decode failure                                | `false`     |
| Invalid client URL                                     | `false`     |

Resend a retryable mutation only when its idempotency key makes replay safe. A
keyless request can have reached the server even when its response was lost.

`ControlClient.isControlError` is `Schema.is` of the same union the errors are
declared in, so an error class added to the package reaches the refinement
without anyone updating a second list.

An operator's own interruption is re-raised exactly as it arrived rather than
described as a transport failure. Cancelling a request is not the server
failing.

## Where to go next

- [The complete loopback example](https://github.com/smithersai/smithers/blob/main/examples/src/24-control-plane-and-gateway.ts):
  a discovered flow planned, approved, launched, and watched over the wire.
- [Watch a run's events](/guides/watch-a-run/): the operation the WebSocket exists
  for.
- [`smthrs serve`](https://smithers.sh/docs/reference/cli/serve/): the shipped server over this layer.
