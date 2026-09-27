# @smthrs/gateway

This package declares `effect`, `@effect/platform-node`,
`@effect/platform-node-shared`, and `@effect/platform-bun` as exact
`4.0.0-rc.115` peers; `@effect/platform-node` is optional for the Node host,
`@effect/platform-bun` is optional for the Bun host, and
`@effect/platform-node-shared` is optional beside them, since it is the sibling
both of those adapters pull in. Keep the application on that version so all
Smithers packages share one Effect runtime.

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://gateway.smithers.sh

The assembled workspace gateway: one HTTP surface carrying the control plane, the sync read path, the served projections, and a health probe. It also defines the gateway wire schemas and re-exports the durable journal synchronization package gateway hosts use.

The mounts, the bind and credential policy, the projections and their rows, the subscription and cursor semantics, every failure code with the status it answers, and the resource limits are documented once, on [the API page](https://gateway.smithers.sh/reference/api/). This file lists what the package exports and shows how a host composes it.

`smthrs serve`, from [`@smthrs/cli`](https://cli.smithers.sh), is a host over this package: it resolves a project on disk, builds the control plane and the journal over that project's database, and hands the assembly here to bind and serve. Install the CLI when you want a gateway without writing code; install this package when you are writing a client against the wire, or embedding the surface in a process of your own.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

Node 26.4.0 or later is required. `effect@4.0.0-rc.115` is a required peer.
The root and protocol subpaths install no native adapter. The optional peer
`@effect/platform-node@4.0.0-rc.115` is required by `node/NodeGateway`,
including the hosting example below. The Bun host at `bun/BunGateway` instead
requires `@effect/platform-bun@4.0.0-rc.115`:

```sh
pnpm add effect@4.0.0-rc.115 @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115
```

Pin `@effect/platform-node-shared@4.0.0-rc.115` with either adapter: both depend on that shared implementation through a caret, which otherwise resolves to a later release candidate whose own `effect` peer this release does not satisfy.

## Public API

The root entry point exports these namespaces; local modules are also importable from `@smthrs/gateway/<Module>`.

| Module              | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                               | Description                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GatewayError`      | `GatewayErrorCode`, `GatewayError`, `settingRefusal`                                                                                                                                                                                                                                                                                                                                                                                         | Defines the stable failure codes, including local Host/Origin refusals, and the refusal a bad setting earns. |
| `GatewaySchema`     | `GatewayHealth`, `ProjectionName`, `WorkspaceRunsSelector`, `RunSummarySelector`, `RunEventsSelector`, `TranscriptSelector`, `RunTreeSelector`, `ApprovalsSelector`, `NodeOutputSelector`, `FlowDurationsSelector`, `ProjectionSelector`, `rowSchemaFor`, `RowOf`, `ProjectionCursor`, `ProjectionSnapshot`, `SnapshotOf`, `SnapshotStartFrame`, `RowFrame`, `SnapshotEndFrame`, `DeltaFrame`, `HeartbeatFrame`, `GatewayFrame`, `FrameOf`   | Supplies the wire schemas for projections, cursors, snapshots, and frames.                                   |
| `Diagnosis`         | `RunStatus`, `Refusal`, `Digest`, `asRecord`, `asString`, `asNumber`, `timeOf`, `firstLine`, `clip`, `digest`, `emptyDigest`, `handlerReach`, `combine`, `duration`, `resolvedOutput`, `verdict`, `Subject`, `render`, `callEventKey`, `callScope`, `nativeCallEvent`, `nativeStepEvent`, `openCallIndex`, `uniqueCallEvents`                                                                                                                | Computes and renders what happened to a run, from that run's own control events.                             |
| `GatewayProjection` | `RunSummaryRow`, `RunTreeRow`, `ApprovalRow`, `NodeOutputRow`, `FlowDurationRow`, `NodeDuration`, `TranscriptRow`, `runSummary`, `statusRollup`, `runTree`, `approvals`, `nodeOutput`, `nodeDurations`, `flowDurations`, `transcript`                                                                                                                                                                                                        | Defines the served wire rows and the pure folds that compute them.                                           |
| `GatewayRpcs`       | `Decision`, `SubmitApprovalInput`, `SubmitApprovalOutput`, `GatewayRpcs`                                                                                                                                                                                                                                                                                                                                                                     | Declares the served read path and the composite approval mutation.                                           |
| `GatewayServer`     | `Health`, `layerHealth`, `layerHandlers`, `watchHeartbeatKind`, `layerKeepAlive`, `layerProjectionsKeepAlive`, `layerControlHttp`, `layerProjectionsHttp`, `layerSyncHttp`, `rpcPaths`, `boundedPostPaths`, `protectedPaths`, `routedPath`, `defaultMaxRequestBodyBytes`, `loopbackHostNames`, `loopbackHostHeaderNames`, `IngressOptions`, `exceededBodyLimit`, `bodyRefusal`, `carriesRpcRequest`, `layerIngress`, `LayerOptions`, `layer` | Assembles the whole HTTP surface as one application layer a host serves.                                     |
| `Projections`       | `heartbeatIntervalMillis`, `maxWorkspaceRuns`, `maxEventsPerRun`, `maxEventsScanned`, `maxEventsPerPage`, `maxDurationRuns`, `maxProjectionBytes`, `maxEventBytes`, `Service`, `Projections`, `make`, `layer`, `layerWith`                                                                                                                                                                                                                   | Serves the bounded read path as snapshots and followed deltas.                                               |
| `RuntimeBridge`     | `protocol`, `Identity`, `LaunchCommand`, `DecisionCommand`, `SignalCommand`, `SteerCommand`, `LifecycleCommand`, `Command`, `ObserveRequest`, `Config`, `BridgeError`, `execute`, `observe`, `CommandResponse`, `ObserveResponse`, `ErrorResponse`, `layer`                                                                                                                                                                                  | Adapts authenticated versioned JSON commands to the canonical Control service.                               |
| `Sync`              | `RunCatalog`, `SyncClient`, `SyncError`, `SyncProtocol`, `SyncRpcs`, `SyncServer`                                                                                                                                                                                                                                                                                                                                                            | Re-exports `@smthrs/sync`, the read-only journal replication protocol.                                       |
| `node/NodeGateway`  | `ServerOptions`, `defaultServerOptions`, `isLoopbackHost`, `bindRefusal`, `listenOptions`, `ingressOptions`, `layerAuth`, `bearerPrincipal`, `layer`                                                                                                                                                                                                                                                                                         | Binds the assembled gateway to a Node HTTP server under the bind and credential policy.                      |
| `bun/BunGateway`    | `ServerOptions`, `layer`, `bearerPrincipal`                                                                                                                                                                                                                                                                                                                                                                                                  | Bun HTTP/WebSocket adapter using the same bind, bearer, ingress and RPC policies.                            |

## Hosting it

```ts
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"

// The composition `smthrs serve` hosts. The caller supplies
// `Control`, `Projections`, `SyncServer`, and the `SyncAuth` middleware.
const gateway = NodeGateway.layer(
  { workspaceHash: "…", gatewayId: "…", protocolVersion: "1", version: "1.0.0-rc.0" },
  { host: "0.0.0.0", port: 7331, listen: true, credential: process.env.SMITHERS_API_KEY }
)
```

A bind the policy or operating system refuses fails the layer with a sanitized `bind_failed` `GatewayError`. A host can inspect policy before composing the layer:

```ts
const refusal = NodeGateway.bindRefusal({ host: "0.0.0.0", port: 7331 })
// => GatewayError { code: "bind_failed", message: "Refusing non-loopback gateway bind 0.0.0.0 without an explicit --listen opt-in" }
```

A credential-less loopback host also requires a loopback `Host`. On every
host, a supplied browser `Origin` must be a canonical HTTP(S) origin whose host
and port equal the request's `Host`, so a browser client is served from the
gateway's own origin or through a same-origin proxy. Origin-less CLI requests
remain accepted. Refusals
are typed `GatewayError` bodies with stable `invalid_host` or `invalid_origin`
codes, and the same rule runs on HTTP and WebSocket upgrades.

## Recovery at 1.0.0-rc.0

The gateway does not supervise runs. Nothing here watches for a run whose owner died, so a run abandoned through the gateway is not automatically discovered, reclaimed, or resumed.

Recovery is a reclaim rather than a supervisor. A run becomes reclaimable once the heartbeat its owner stopped renewing is older than 30 seconds, and any running `smthrs` process with the flow registered takes it over. Bring up a host composition running the durable engine driver with the relevant flows registered, or recover the run explicitly.

`@smthrs/gateway/package.json` is also exported. `internal/*` and nested `*/index` subpaths are not public.

The concrete Bun adapter serves the same protocol without a Node sidecar:

```ts
import * as BunGateway from "@smthrs/gateway/bun/BunGateway"

const server = BunGateway.layer(health, { host: "127.0.0.1", port: 7331 })
// Supply the same Control, Projections, SyncServer and SyncAuth layers.
```

`bun/BunGateway` supports TCP host/port binds. Platform adapters share one private
policy/router implementation; neither adapter automatically advertises coding
capabilities. Those belong to a configured host after its catalog and workspace
binding have been validated.
