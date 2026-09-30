---
title: "API reference"
description: "Every public export of @smthrs/gateway: the assembled server and its Node host, the served read path, the wire schemas and folds, the RPC group, the diagnosis renderer, and the failure vocabulary."
---

The gateway declares `effect`, `@effect/platform-node`,
`@effect/platform-node-shared`, and `@effect/platform-bun` as exact
`4.0.0-rc.115` peers; `@effect/platform-node` is optional for
`node/NodeGateway`, `@effect/platform-bun` is optional for `bun/BunGateway`, and
`@effect/platform-node-shared` is optional beside them, since it is the sibling
both of those adapters pull in. Use the same Effect version in the host.

The root entry point exports one namespace per module, and every local module is
also importable from `@smthrs/gateway/<Module>`.

A UI depends on this package and on [`@smthrs/control`](/api/control). It never
depends on [`@smthrs/engine-store`](/api/engine-store), and it never reads a
store table: a projection is the contract, and a store row is an implementation
detail. [`smthrs serve`](/cli/serve) composes the assembly with
`@smthrs/control` and [`@smthrs/sync`](/api/smithers-sync) to host it.

The model behind these signatures is in [Projections](./concepts/projections.md),
[Subscriptions and cursors](./concepts/subscriptions.md), and
[The trust boundary](./concepts/trust-boundary.md).

## Example

```ts
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
import * as Projections from "@smthrs/gateway/Projections"
import { Layer } from "effect"

const health = { workspaceHash: "8f4b2c1d", gatewayId: "host-1", protocolVersion: "1", version: "1.0.0-rc.0" }
const gateway = NodeGateway.layer(health, NodeGateway.defaultServerOptions).pipe(Layer.provide(Projections.layer))
```

## `GatewayServer`

The whole HTTP surface as one application layer a host serves.

### Mounts

`GatewayServer.layer` mounts seven base routes, and `NodeGateway.layer` binds
them to a socket. A host that supplies `runtimeBridge` adds two authenticated
JSON routes.

| Path                       | Protocol           | Serves                                               |
| -------------------------- | ------------------ | ---------------------------------------------------- |
| `POST /rpc`                | RPC over HTTP      | `@smthrs/control` `ControlRpcs`                      |
| `/rpc/ws`                  | RPC over WebSocket | `ControlRpcs`, including a kept-alive `Watch`        |
| `POST /projections`        | RPC over HTTP      | `GatewayRpcs`                                        |
| `/projections/ws`          | RPC over WebSocket | `GatewayRpcs`, including `Projection.Subscribe`      |
| `POST /sync`               | RPC over HTTP      | `@smthrs/sync` `SyncRpcs`                            |
| `/sync/ws`                 | RPC over WebSocket | `SyncRpcs`                                           |
| `GET /health`              | JSON               | `GatewayServer.Health`                               |
| `POST /runtime/v1/command` | JSON               | Versioned launch and Control mutations (optional)    |
| `POST /runtime/v1/observe` | JSON               | Bounded journal replay and run projection (optional) |

### Scoped tokens

A credentialed gateway also accepts a token minted under its credential with
`@smthrs/control` `ScopedToken` (`smthrs token mint`). The edge admits it on
its signature and expiry alone, and only toward `NodeGateway.scopedTokenPaths`
(`/rpc`, `/projections`, their sockets, and `/auth/ticket`); every RPC frame is
then judged in band against the procedures, run, or flow it names, and it
stamps `NodeGateway.scopedPrincipal` (`gateway/scoped`), which no delegation to
`gateway/bearer` covers. Journal sync and the runtime bridge accept the bearer
alone, and a ticket issued against a scoped token opens only what the token
could open.

### Runtime observation cursors

`POST /runtime/v1/observe` returns `nextCursor`; pass it back unchanged as
`afterCursor` with the same `runId`. An empty cursor consumes no events. A
decimal cursor, such as `"42"`, consumes the whole journal entry. A versioned
cursor, such as `"v1:42:0"`, consumes only members through that zero-based
expansion offset. Both numeric components are canonical nonnegative integers
below `Number.MAX_SAFE_INTEGER`. Existing decimal cursors remain accepted.

`hasMore` indicates another event page; `terminal` independently reports the
run's current lifecycle. Backend failures retain their stable Control code and
retryability without exposing backend message text.

### Types and constants

| Export                       | Signature                                                                                                                         | Meaning                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Health`                     | `Schema.Struct` and its type                                                                                                      | What `GET /health` answers: gateway identity, package version, and optional non-secret runtime bridge identity. |
| `LayerOptions`               | `{ heartbeatMillis?; ingress?; runtimeBridge? }`                                                                                  | How an assembled gateway is configured. `runtimeBridge` opts into the versioned Go adapter.                     |
| `IngressOptions`             | `{ maxRequestBodyBytes?: number; loopbackOnly?: boolean; authorize?: (headers, path) => Effect<boolean>; ticketMillis?: number }` | The ingress policy the RPC mounts run behind.                                                                   |
| `Ticket`                     | `Schema.Struct` and its type                                                                                                      | What `POST /auth/ticket` answers: `{ ticket, expiresInMs }`, a single-use key that opens one protected socket.  |
| `ticketPath`                 | `"/auth/ticket"`                                                                                                                  | Exchanges an accepted bearer for a `Ticket`. Served only when `authorize` is set.                               |
| `ticketPaths`                | `ReadonlyArray<string>`                                                                                                           | `["/rpc/ws", "/projections/ws", "/sync/ws"]`: the sockets a ticket opens as `<mount>?ticket=<ticket>`.          |
| `defaultTicketMillis`        | `number`                                                                                                                          | 30,000. How long an unredeemed ticket stays valid.                                                              |
| `rpcPaths`                   | `ReadonlyArray<string>`                                                                                                           | `["/rpc", "/projections", "/sync"]`: the `POST` mounts that carry RPC request messages.                         |
| `boundedPostPaths`           | `ReadonlyArray<string>`                                                                                                           | RPC mounts plus both runtime bridge routes; every body is bounded before a handler reads it.                    |
| `protectedPaths`             | `ReadonlyArray<string>`                                                                                                           | Projection, sync, WebSocket, and runtime bridge paths that pass edge authentication.                            |
| `defaultMaxRequestBodyBytes` | `number`                                                                                                                          | 1,048,576. The default maximum request body accepted by an RPC mount.                                           |
| `loopbackHostNames`          | `ReadonlyArray<string>`                                                                                                           | `["127.0.0.1", "localhost", "::1"]`: the names that mean this machine only, as a bind address is spelled.       |
| `loopbackHostHeaderNames`    | `ReadonlyArray<string>`                                                                                                           | `["127.0.0.1", "localhost", "[::1]"]`: the same names as a Host header spells them; the default `allowedHosts`. |
| `watchHeartbeatKind`         | `"control.gateway.heartbeat"`                                                                                                     | The `ControlEvent` kind a `Watch` keepalive carries.                                                            |

`POST /rpc` is deliberately not in `protectedPaths`, and `GET /health` is
deliberately unauthenticated. Both decisions, and the alias handling behind
`routedPath`, are explained in
[the trust boundary](./concepts/trust-boundary.md).

### Layers

| Export                      | Signature                                                                   | Provides                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `layer`                     | `(health: Health, options?: LayerOptions) => Layer<..., GatewayError, ...>` | The whole surface. Fails with `bind_failed` for a non-positive cadence or body limit.                    |
| `layerHealth`               | `(health: Health) => Layer<never, never, HttpRouter>`                       | The unauthenticated `GET /health` probe.                                                                 |
| `layerHandlers`             | `Layer<Handler<...>, never, Control \| Projections>`                        | The gateway's own RPC handlers over the read path and the approval mutation.                             |
| `layerControlHttp`          | `(millis?: number) => Layer<RpcServer.Protocol, never, ...>`                | `/rpc` and `/rpc/ws`, with the keepalive merged into `watch`.                                            |
| `layerProjectionsHttp`      | `Layer<RpcServer.Protocol, never, ...>`                                     | `/projections` and `/projections/ws`. Both protocols mount together so they cannot disagree.             |
| `layerSyncHttp`             | `Layer<RpcServer.Protocol, never, ...>`                                     | `/sync` and `/sync/ws`.                                                                                  |
| `layerIngress`              | `(options?: IngressOptions) => Layer<...>`                                  | The global middleware: local Host/Origin policy, edge authentication, body limit, and RPC-message check. |
| `layerKeepAlive`            | `(millis?: number) => Layer<Control, never, Control>`                       | Wraps the ambient `Control` so `watch` emits a keepalive when idle.                                      |
| `layerProjectionsKeepAlive` | `(millis: number) => Layer<Projections, never, Projections>`                | Wraps the ambient `Projections` so a followed subscription beats at the bind's cadence.                  |

`layerKeepAlive` wraps the service rather than re-declaring handlers, which
keeps `@smthrs/control` `ControlServer` the single definition of what every
procedure does, including the principal it stamps on mutations.

### Functions

| Export              | Signature                                                                                     | Answers                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `routedPath`        | `(url: string) => string`                                                                     | The mount a request target reaches, spelled the way `rpcPaths` and `protectedPaths` spell it.          |
| `exceededBodyLimit` | `(error: unknown) => boolean`                                                                 | Whether a failed body read hit the configured size limit rather than failing for another reason.       |
| `bodyRefusal`       | `(path: string, maxBytes: number, error: unknown) => { error: GatewayError; status: number }` | 413 `request_too_large` for an overflow, 400 `malformed_request` for every other read failure.         |
| `carriesRpcRequest` | `(serialization: RpcSerialization["Service"], body: string) => boolean`                       | Whether a body carries at least one RPC message the server can act on. A binary framing is always yes. |

## `node/NodeGateway`

The Node host: bind policy, credential policy, and the socket.

| Export                 | Signature                                                                                                                                             | Meaning                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ServerOptions`        | `ListenOptions & { allowedHosts?: readonly string[]; listen?: boolean; credential?: string; heartbeatMillis?: number; maxRequestBodyBytes?: number }` | Bind address, explicitly admitted Host names, authentication, and request limits.                                         |
| `defaultServerOptions` | `ServerOptions`                                                                                                                                       | `{ host: "127.0.0.1", port: 7331 }`: loopback, no credential.                                                             |
| `isLoopbackHost`       | `(host: string) => boolean`                                                                                                                           | True for `127.0.0.1`, `::1`, and `localhost`, and nothing else.                                                           |
| `bindRefusal`          | `(options: ServerOptions) => GatewayError \| undefined`                                                                                               | The typed `bind_failed` refusal a requested bind earns, or `undefined` when it is allowed.                                |
| `listenOptions`        | `(options: ServerOptions) => Effect<ListenOptions, GatewayError>`                                                                                     | The admitted `node:net` options, with this module's own fields removed, or that refusal in the error channel.             |
| `ingressOptions`       | `(options: ServerOptions) => GatewayServer.IngressOptions`                                                                                            | The Host policy for a bind: the loopback names, `allowedHosts`, and the concrete bind host; a wildcard bind adds nothing. |
| `layerAuth`            | `(options: ServerOptions) => Layer<ControlRpcs.ControlAuth>`                                                                                          | The bearer or a scoped token minted under it when a credential is configured; the loopback-only local operator otherwise. |
| `bearerPrincipal`      | `Readonly<{ id: string; kind: string }>`                                                                                                              | The frozen `{ id: "gateway", kind: "bearer" }` identity stamped by shared-bearer authentication.                          |
| `scopedPrincipal`      | `Readonly<{ id: string; kind: string }>`                                                                                                              | The frozen `{ id: "gateway", kind: "scoped" }` identity a verified scoped token stamps.                                   |
| `scopedTokenPaths`     | `ReadonlyArray<string>`                                                                                                                               | The protected mounts a scoped token may reach at the edge: `/rpc`, `/projections`, their sockets, and `/auth/ticket`.     |
| `layer`                | `(health: GatewayServer.Health, options?: ServerOptions) => Layer<..., GatewayError, Control \| SyncAuth \| SyncServer \| Projections>`               | The assembled gateway on a Node HTTP server.                                                                              |

`layer` supplies the bind policy, the shared-credential authentication both RPC
mounts run under, and newline-delimited JSON as the wire serialization. The
caller supplies `Control`, `Projections`, `SyncServer`, and `SyncAuth`. The
returned layer retains the concrete `HttpServer` service, so a caller that
bound port 0 can read the ephemeral address it got. Policy refusals and
operating-system listen failures both fail the layer as sanitized `bind_failed`
values.

### Bind and credential policy

Two rules decide whether a bind is allowed, and both fail closed.

1. A non-loopback host requires an explicit `listen` opt-in.
2. A non-loopback bind requires a bearer credential.

A loopback bind with no credential is allowed and is the local default. One
shared bearer authenticates every mount as `bearerPrincipal`. This does not
grant approval authority. The owning Control runtime must explicitly delegate
the allowed approval target kinds and scopes through `ApprovalAuthority`;
without that delegation, bearer approve and deny requests are unauthorized.
Every holder of the shared credential has the same delegated authority. See
[Serve beyond loopback](./guides/serve-beyond-loopback.md).

Without that bearer, `NodeGateway.layer` enables `loopbackOnly`: every request
must carry a loopback `Host`. With or without a bearer, a supplied browser
`Origin` must be a canonical HTTP(S) origin whose host and port equal the
request's `Host`; serve a browser client from the gateway's origin or through a
same-origin proxy. An Origin-less CLI request remains accepted. The same guard runs on HTTP and WebSocket
upgrades before any mount handles them.

## `Projections`

The read path, served as bounded snapshots and followed deltas.

| Export                    | Signature                                                                                                      | Meaning                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Projections`             | `Context.Service` tagged `@smthrs/gateway/Projections`                                                         | The service tag the mounts read through.                                                                           |
| `Service`                 | `{ snapshot; subscribe }`                                                                                      | Read-path operations served by the gateway.                                                                        |
| `Service.snapshot`        | `<S extends ProjectionSelector>(selector: S, after?: ProjectionCursor) => Effect<SnapshotOf<S>, GatewayError>` | Current rows, or the run-events suffix after `after`, with the current cursor.                                     |
| `Service.subscribe`       | `<S extends ProjectionSelector>(selector: S, after?: ProjectionCursor) => Stream<FrameOf<S>, GatewayError>`    | A snapshot followed by deltas and keepalives, or, with `after`, the deltas after that cursor alone.                |
| `make`                    | `(control: ControlService, options?: { heartbeatMillis?: number }) => Effect<Service, GatewayError>`           | Builds the read path over a control plane. Invalid settings are `bind_failed` failures; construction never throws. |
| `layer`                   | `Layer<Projections, GatewayError, Control>`                                                                    | The read path over the ambient control plane, at the default cadence.                                              |
| `layerWith`               | `(options: { heartbeatMillis?: number }) => Layer<Projections, GatewayError, Control>`                         | The same under an explicit keepalive cadence.                                                                      |
| `heartbeatIntervalMillis` | `30_000`                                                                                                       | How often an idle subscription emits a keepalive frame.                                                            |
| `maxWorkspaceRuns`        | `500`                                                                                                          | The most runs one workspace projection folds, newest first. Equals `ControlSchema.maxPageSize`.                    |
| `maxEventsPerRun`         | `10_000`                                                                                                       | The most journal events retained per run; older events enter the carried digest.                                   |
| `maxEventsPerPage`        | `1_000`                                                                                                        | The most events one `run-events` page returns.                                                                     |
| `maxEventBytes`           | `16 * 1024`                                                                                                    | Retained event size before clipping. Native engine events on `run-events` pages are exempt.                        |
| `maxProjectionBytes`      | `4 * 1024 * 1024`                                                                                              | The encoded byte budget for retained events plus digest identity state, an event page, or a projected row set.     |

`ControlService` is `@smthrs/control` `Control`'s service interface, the shape
the tag carries.

`run-events` pages return complete `control.engine.event` payloads so clients
can decode native result contracts. Other oversized events are clipped. A
single encoded event plus its array brackets exceeding `maxProjectionBytes`
fails with `GatewayError` code `resource_limit`; a full page ends at its cursor.

## `GatewaySchema`

The wire schemas the read path and its subscriptions speak. Every entry is an
`effect` `Schema` with a same-named type. Every schema here is served: the
gateway mints, reads, or answers with each one.

### Identity

| Export          | Fields                                          |
| --------------- | ----------------------------------------------- |
| `GatewayHealth` | `workspaceHash`, `gatewayId`, `protocolVersion` |

### Selectors

| Export                  | Shape                                    |
| ----------------------- | ---------------------------------------- |
| `ProjectionName`        | the eight served projection names        |
| `WorkspaceRunsSelector` | `{ _tag: "workspace-runs" }`             |
| `RunSummarySelector`    | `{ _tag: "run-summary", runId }`         |
| `RunEventsSelector`     | `{ _tag: "run-events", runId }`          |
| `TranscriptSelector`    | `{ _tag: "transcript", runId }`          |
| `RunTreeSelector`       | `{ _tag: "run-tree", runId }`            |
| `ApprovalsSelector`     | `{ _tag: "approvals", runId? }`          |
| `NodeOutputSelector`    | `{ _tag: "node-output", runId, nodeId }` |
| `FlowDurationsSelector` | `{ _tag: "flow-durations", flowId }`     |
| `ProjectionSelector`    | the union of the eight                   |

`ApprovalsSelector` without `runId` lists the workspace's pending gates, which
is the approvals inbox. With one it lists that run's gates including the decided
ones, which is what a run card renders.

`FlowDurationsSelector` is the one selector scoped to a flow rather than to a
run. It ranks the durations the flow's newest finished runs measured, so a
client reads it once when it opens a card and again when a run finishes, never
inside a poll loop.

`rowSchemaFor<S extends ProjectionSelector>(selector: S)` answers the schema of
the rows that selector projects, so a client decodes a snapshot instead of
casting it. A literal selector keeps its own row: `rowSchemaFor({ _tag:
"approvals" })` is `ApprovalRow`, not the union of every row. `RowOf<S>` is that
row's type.

### Cursors, snapshots, and frames

`Projection.Snapshot` accepts optional `after: ProjectionCursor` for
`run-events` only. It returns rows strictly after that sequence and offset,
with the cursor the read reached. An unchanged journal returns no rows, and so
does a cursor at or past the journal's head. The cursor must belong to the same
selector and run; other selectors with `after` return `malformed_request`.
Omit `after` for the first page: the empty cursor `0:0` also names the first
sequence-zero event.

A `run-events` snapshot is a PAGE, not the whole journal. It carries at most
`maxEventsPerPage` events and `maxProjectionBytes`, whichever binds first, and
the cursor it answers with names the last event it carried. A reader pages by
passing that cursor back until a page comes back empty. Every other selector
answers rows whose size the selector bounds, so it reads the reconciled source
and needs no paging.

| Export               | Shape                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| `ProjectionCursor`   | `{ selector, projection, runId: string \| null, value: int, offset: int }` |
| `ProjectionSnapshot` | `{ selector, cursor, rows }`, correlated on the selector                   |
| `SnapshotStartFrame` | `{ _tag: "snapshot-start", selector, cursor }`                             |
| `RowFrame`           | `{ _tag: "row", selector, cursor, row }`                                   |
| `SnapshotEndFrame`   | `{ _tag: "snapshot-end", selector, cursor }`                               |
| `DeltaFrame`         | `{ _tag: "delta", selector, cursor, delta }`                               |
| `HeartbeatFrame`     | `{ _tag: "heartbeat", atMs }`                                              |
| `GatewayFrame`       | the union of all five frame kinds                                          |

`ProjectionSnapshot`, `RowFrame`, and `DeltaFrame` are unions correlated on the
selector, so a payload whose rows do not belong to its selector does not decode.
One table in `GatewaySchema` pairs each selector with its row, and those three
unions, `ProjectionName`, and `rowSchemaFor` all derive from it.
`runId` is `null` for a workspace cursor, whose `value` is always 0, because
control journal sequences belong to per-run partitions and no workspace-wide
sequence exists.

`SnapshotOf<S>` is the snapshot one selector answers with and `FrameOf<S>` the
frames its subscription emits, so a literal selector keeps its own rows. A
selector chosen at runtime maps to the full `ProjectionSnapshot` and
`GatewayFrame` unions, which is what it can be answered with.

## `GatewayProjection`

The stable wire rows and the pure folds that compute them. Nothing here exposes
a store row, a database column, or an engine type.

### Rows

| Export          | Carries                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunSummaryRow` | `runId`, `flowId`, `status`, `statusRollup` (the `@smthrs/control` `Health.StatusRollup` a status surface renders; optional on the wire, folded on every row the gateway serves), `createdAt`, `updatedAt`, the optional plan, lineage, waiting, steering, cancellation, and seat fields, the activity and token counters, `verdict`, `diagnosis`, and `finalOutput`. |
| `RunTreeRow`    | `runId`, `nodeId`, `label`, `status` (`running`, `completed`, `failed`), `seat?`, `startedAt`, `endedAt?`, `parentRunId?`.                                                                                                                                                                                                                                            |
| `ApprovalRow`   | `runId`, `requestId`, `title`, `request`, `payload` (the `ControlSchema.ApprovalPayload` a client submits back), `requestedAt`, `status`.                                                                                                                                                                                                                             |
| `NodeOutputRow` | `runId`, `nodeId`, `outcome` (`success` or `failure`), `output`, `settledAt`.                                                                                                                                                                                                                                                                                         |
| `TranscriptRow` | `runId`, `sequence`, `turn`, `at`, `kind`, `text`. Each `text` is one display line.                                                                                                                                                                                                                                                                                   |

### Folds

| Export         | Signature                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runSummary`   | `(run: ControlSchema.RunSummary, events, now?) => RunSummaryRow`       | Status comes from the run row, everything else from the events. `now` expires the health reading; it defaults to the later of the row's `updatedAt` and the last event.                                                                                                                                                                                                                                         |
| `statusRollup` | `(run: ControlSchema.RunSummary, events, now) => Health.StatusRollup`  | Lifecycle from the run row; activity and observed health from the current incarnation's highest evidence sequence, with durable sequence breaking ties. Freshness also requires a successful reading whose evidence covers later progress and whose lifetime includes `now`. Stale readings retain provenance but cannot establish activity. A malformed observation or one from a former owner colors nothing. |
| `runTree`      | `(run: ControlSchema.RunSummary, events) => ReadonlyArray<RunTreeRow>` | Keys each call by the ordinal it opened on; pairs a settlement with the oldest open call of that flow name.                                                                                                                                                                                                                                                                                                     |
| `approvals`    | `(events) => ReadonlyArray<ApprovalRow>`                               | A decision closes the gate its `tokenId` names; one naming neither field closes the oldest pending gate.                                                                                                                                                                                                                                                                                                        |
| `nodeOutput`   | `(events) => ReadonlyArray<NodeOutputRow>`                             | Keyed the way `runTree` keys its rows, so both agree on a node id.                                                                                                                                                                                                                                                                                                                                              |
| `transcript`   | `(events) => ReadonlyArray<TranscriptRow>`                             | One row per `control.run.*`, `control.agent.*`, and approval-request event, numbered by turn.                                                                                                                                                                                                                                                                                                                   |

`statusRollup` is an additive optional wire field. Existing Effect decoders
strip unknown properties by default, and current clients still decode older
rows without it. The app validates the subject and lifecycle, expires stale
activity, and falls back to the existing status when the field is absent.
Clients configured to reject unknown properties must admit this field before
reading the newer wire shape.

Every fold takes `ReadonlyArray<ControlSchema.ControlEvent>` in run order and is
total: an unknown kind contributes nothing.

## `GatewayRpcs`

The gateway's own remote procedures. Control mutations are not re-declared here:
`@smthrs/control` `ControlRpcs` is the mutation contract, and the gateway mounts
it unchanged on `/rpc`. The group shares `ControlRpcs.ControlAuth`, so one
bearer credential authenticates both mounts.

| Procedure              | Payload                           | Success                   | Error                                                                                                                                                                           |
| ---------------------- | --------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Projection.Snapshot`  | `{ selector }`                    | `ProjectionSnapshot`      | `GatewayError`                                                                                                                                                                  |
| `Projection.Subscribe` | `{ selector, after? }`, streaming | `GatewayFrame`            | `GatewayError`                                                                                                                                                                  |
| `Approval.Submit`      | `SubmitApprovalInput`             | `SubmitApprovalOutput`    | `PlanDigestMismatch`, `EnvelopeMismatch`, `AlreadyResolved`, `PlanNotFound`, `RunNotFound`, `InvalidInput`, `Unauthorized`, `PersistenceError`, `Unavailable`, `TransportError` |
| `Run.Fork`             | `RunHistory.ForkInput`            | `RunHistory.ForkOutput`   | `HistoryRefused`, `Unauthorized`, `Unavailable`                                                                                                                                 |
| `Run.Verify`           | `RunHistory.VerifyInput`          | `RunHistory.VerifyReport` | `HistoryRefused`, `Unauthorized`, `Unavailable`                                                                                                                                 |

| Export                 | Shape                                                     |
| ---------------------- | --------------------------------------------------------- |
| `Decision`             | `"approve" \| "deny"`                                     |
| `SubmitApprovalInput`  | `ControlSchema.ApprovalPayload` fields plus `decision`    |
| `SubmitApprovalOutput` | `{ decision: ControlSchema.Receipt }`                     |
| `GatewayRpcs`          | the `RpcGroup`, with `ControlRpcs.ControlAuth` middleware |

`Approval.Submit` is the transport form of Control's single decision command.
Control records the decision and its durable resume delegation as one domain
command; the gateway never composes a second mutation, and its error union is
exactly the one `Control.approve` and `Control.deny` declare. See
[Submit an approval from a client](./guides/submit-an-approval.md).

`Run.Fork` and `Run.Verify` are served by the host that owns the project's
stores, through `RunHistory`; see below.

## `RunHistory`

A run's recorded history as the gateway serves it. `Run.Fork` branches a run at
the exact journal sequence `at` into a parked child, optionally with one step's
recorded result replaced; `Run.Verify` reports what resuming a run under the
current flow code would replay and what it would execute again. They answer
exactly what `smthrs runs fork` and `smthrs runs verify` print, because
`smthrs serve` implements the service over the same history library. A gateway
composed without the service answers both `Unavailable`. Both procedures are
in the `write:runs` token scope, and an anonymous loopback caller is
`Unauthorized`: a fork writes a durable run and a verification drives the
project's flow code.

| Export           | Shape                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Step`           | `{ stepKeyDigest, action?, node? }`                                                                                      |
| `VerifyInput`    | `{ runId }`                                                                                                              |
| `VerifyReport`   | `{ runId, verdict: "consistent" \| "divergent", replayed, resumes?, executes?, notReplayed }`                            |
| `StepEdit`       | `{ stepKeyDigest, result }`                                                                                              |
| `ForkInput`      | `{ runId, at, lineage?, step?: StepEdit }`                                                                               |
| `ForkOutput`     | `{ runId, parentRunId, status: "parked" }`                                                                               |
| `HistoryRefused` | the host's refusal: the CLI's stable `code` and sentence (`history_missing`, `history_frame_missing`, `run_active`, ...) |
| `Service`        | `{ fork(input), verify(input) }`                                                                                         |
| `RunHistory`     | the service tag a host provides                                                                                          |

A divergent report is an answer, not a failure: the CLI exits 1 with
`run_divergent` for it, while `Run.Verify` returns the report so a client can
show which recorded steps would not replay.

## `Diagnosis`

What happened to a run, computed from that run's own control events. This is
the one fold both surfaces read: `@smthrs/cli` `Forensics` calls `digest` and
adds what a terminal card needs on top of it, so the served row and
[`smthrs runs show`](/cli/runs) cannot disagree about a run's counts, refusals,
or clipping.

| Export           | Signature                                                                           | Answers                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Digest`         | interface                                                                           | Status, cause, seat, turn and call counts, edits, refusals, tokens, final output, pending question, and the span the events cover.                                |
| `Refusal`        | `{ message: string; count: number }`                                                | One refused flow call, aggregated by its message.                                                                                                                 |
| `Subject`        | `{ runId: string; flowId?: string }`                                                | The identity a diagnosis is rendered for.                                                                                                                         |
| `RunStatus`      | `ControlSchema.RunStatus`                                                           | The run statuses a digest may report.                                                                                                                             |
| `digest`         | `(events, runId?) => Digest`                                                        | The facts. Total: an unknown kind contributes nothing, including its timestamp. With `runId`, a `control.run.*` verdict stamped with another run's id is skipped. |
| `resolvedOutput` | `(value: Pick<Digest, "finalOutput" \| "nativeResolution">) => string \| undefined` | Assistant output first, otherwise a committed native result matching the host's root binding.                                                                     |
| `verdict`        | `(value: Digest) => string`                                                         | One line: the status plus the reason that most explains it.                                                                                                       |
| `duration`       | `(span: Pick<Digest, "startedAt" \| "endedAt">) => string`                          | The wall-clock span the handled events cover, as `12s` or `3m 04s`.                                                                                               |
| `usd`            | `(value: number) => string`                                                         | A USD amount: `$12.34` from one dollar, `$0.0042` below it.                                                                                                       |
| `render`         | `(subject: Subject, value: Digest) => string`                                       | The whole card: verdict, activity evidence, tokens, cost, refusals, cause, and output.                                                                            |
| `asRecord`       | `(value: unknown) => Record<string, unknown>`                                       | A wire payload as a record, or an empty record when it is not one.                                                                                                |
| `asString`       | `(value: unknown) => string \| undefined`                                           | A payload field as a string, or nothing.                                                                                                                          |
| `asNumber`       | `(value: unknown) => number \| undefined`                                           | A payload field as a number, or nothing.                                                                                                                          |
| `timeOf`         | `(event) => number`                                                                 | When an event occurred: its payload's own stamp, else journal admission time.                                                                                     |
| `firstLine`      | `(text: string) => string`                                                          | The first line, whichever line ending produced it, so a CRLF cause loses its carriage return.                                                                     |
| `clip`           | `(text: string, width: number) => string`                                           | Truncation on code points, never on UTF-16 code units, marking the cut with an ellipsis.                                                                          |

`RunSummaryRow.verdict` and `RunSummaryRow.diagnosis` are `verdict` and `render`
already applied, so a client rendering a run card calls neither. See
[Diagnose what happened to a run](./guides/diagnose-a-run.md).

`emptyDigest()` is the identity for `combine(earlier, later)`. Digests retain
private in-memory scalar identity contributions so adjacent ranges deduplicate
replayed calls and checkpoints and prefer native facts over telemetry. Keep the
returned digest objects when combining ranges; serialized or spread copies
retain only aggregate facts, not this reconciliation state. Gateway projection
retention charges this state to the existing byte budget and returns
`resource_limit` if exact state cannot fit.

`Digest.nativeResolution` optionally retains `binding: { runId, executionId }`,
`result: { runId, executionId, text }`, and `conflict: true` across bounded
journal windows. `combine` preserves this evidence. `resolvedOutput` accepts
only an unambiguous committed success for the bound `agent/run` root, ignoring
child results and telemetry. String results remain strings; other JSON values
are serialized. `RunSummaryRow.finalOutput`, `verdict`, and `diagnosis` use
this resolved output.

## `GatewayError`

| Export             | Signature                                                                 | Meaning                                                                                     |
| ------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GatewayErrorCode` | nine literals                                                             | The whole failure vocabulary.                                                               |
| `GatewayError`     | `Schema.TaggedError` tagged `@smthrs/gateway/GatewayError`                | `{ code, message, cause? }`, where `cause` is a `{ _tag, code? }` summary and nothing more. |
| `settingRefusal`   | `(name: string, value: number \| undefined) => GatewayError \| undefined` | The refusal a numeric setting earns when it is not a positive safe integer.                 |

Every code is constructed by a real path, and the declared vocabulary is exactly
the set those paths produce.

| Code                | Status | Produced by                                                                                                                                              |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bind_failed`       | none   | `NodeGateway.bindRefusal`, `NodeGateway.listenOptions`, `GatewayServer.layer`, `GatewayServer.layerIngress`, and `Projections.make`, at composition time |
| `invalid_host`      | 421    | the ingress guard, when `Host` is not in `allowedHosts`, or under `loopbackOnly` does not name `localhost`, `127.0.0.1`, or `[::1]`                      |
| `invalid_origin`    | 403    | the ingress guard, when a supplied browser `Origin` is not a canonical HTTP(S) origin whose host and port equal the request's `Host`                     |
| `unauthorized`      | 401    | the ingress guard, on any protected path without the configured credential                                                                               |
| `malformed_request` | 400    | the ingress guard, for a `POST` body carrying no RPC request message or a body it could not read, and the read path, for an invalid resume cursor        |
| `request_too_large` | 413    | the ingress guard, for a body over the configured limit                                                                                                  |
| `resource_limit`    | none   | the read path, when one run or projected row set exceeds its event or encoded-byte allowance                                                             |
| `run_unavailable`   | none   | the read path, when listing runs, reading a run's events, or following a run or the workspace failed                                                     |
| `run_not_found`     | none   | the read path, for a run the control plane does not have, identically for every run-scoped selector                                                      |

`GatewayError.cause` carries only a redacted summary of an internal failure: its
tag and its stable code. Projection warnings log an allowlisted operation
identifier and known control error tag/code pairs. Backend messages, nested
causes, SQL, and file paths are omitted from projection logs.

## `Sync`

The root entry re-exports [`@smthrs/sync`](/api/smithers-sync) whole, so a gateway host
gets the read-only journal replication protocol from the same import:
`SyncClient`, `SyncServer`, `SyncProtocol`, `SyncRpcs`, `SyncError`,
`RunCatalog`, and the rest of that package's namespaces.

Sync is read-only in both senses: a follower cannot mutate a run, and it cannot
resume one. See [Sync and read-only followers](/docs/concepts/sync/).

## `RunTrace`

The pure journal projection shared by the app and terminal monitors. Import
`@smthrs/gateway/RunTrace`; it requires no server or filesystem. Records without
evidence do not acquire invented phases, successful checks, or file changes.

- `traceFromJournal(run, records, options?)` builds a `TraceModel`: nested
  spans, frame summaries, phase bands, milestone pins, and discipline notes.
- `traceFold(run, records?)` holds the same fold open. `traceFoldStep(fold,
  record)` adds one record at the cost of that record; `traceFoldSync(fold, run,
  records)` steps only what a grown journal appended; `traceFoldModel(fold,
  status)` returns the model `traceFromJournal` would build for the same records.
  A record out of sequence order, or a native fact that supersedes earlier
  telemetry, refolds the journal. `TraceFold` types the handle.
- `runMemoryOf(records)` folds the `relevance-settled` rows into the memory a
  run was brought and the memory Jev withheld, by id and relevance, most
  relevant first; undefined when Jev never read. `RunMemory` and `MemoryItem`
  type it. `smthrs status` prints the same fold.
- `turnNarratives(model)` derives concise recorded turn text. `spanPath(model,
  id)` finds recorded ancestry. `durationWords(ms)` formats elapsed time.
- `waterfallGeometry`, `phaseExtent`, and `phaseBandGeometry` calculate layout
  from recorded time. Historical inspection folds a journal prefix while the
  full trace supplies stable geometry.
- `callSubject` and `callSemantics` interpret captured flow descriptors, with
  compatibility for older records. `CallMetadata` names their descriptor fields.
- `spanMatches`, `traceFiltersFor`, `isTraceFilter`, and `TRACE_FILTER_IDS` own
  the shared filter vocabulary. `TraceFilter` and `TraceView` type that state.
- `JournalRecord`, `TraceRun`, `TraceOptions`, `TraceSpan`, `SpanKind`,
  `SpanStatus`, `SpanDetail`, `TraceExtent`, `PhaseId`, `PhaseBand`, `Milestone`,
  `TraceOwner`, `FrameLine`, `TraceNote`, and `TurnNarrative` describe the
  projection. `TraceBuilder` is the mutable draft used while folding, never a
  persisted graph or a second execution model.

## `RunDevTools`

`@smthrs/gateway/RunDevTools` is the DevTools projection: a run inspected
like a component tree, as a view over the `RunTrace` model the run card, the
terminal and `smthrs runs devtools` already fold. `devTools(model)` is the tree
(`DevToolsModel`: one `DevToolsNode` per span with its measured timing, the
run's counts and wall time); `inspect(model, id?, options?)` is one node's
`DevToolsInspection` (recorded input, output, script, printed text, failure,
seat, tokens, child run, opening event, remaining fields, and the newest
`DevToolsFrame` records written while it was open, bounded by
`DevToolsOptions.frames`, `defaultFrameLimit` by default); `framesOf(model,
span)` is that frame rule alone; `lines(model, selected?, options?)` renders
the tree and the inspection as text for a terminal. Pure: no server, no
filesystem, no clock.

## `EngineTrace`

`@smthrs/gateway/EngineTrace` decodes native journal envelopes through the
contracts that wrote them. `engineTraceFromJournal(records)` produces spans;
`engineExecutionEvidence(records)` returns typed `EngineExecutionEvidence` for
result projections. `engineRunEvidence(records, rootId, cursorSeq?)` limits
facts to recorded ancestry and the inspection cursor. `engineProjectionPending`
reports unfinished observation independently of the run's terminal verdict.
