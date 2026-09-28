# @smthrs/gateway

## [Unreleased]

### Added

- `Diagnosis.digest` takes an optional `runId`. A `control.run.*` verdict
  stamped with another run's id, such as a child's, no longer sets the digested
  run's status or failure cause, so a run summary no longer reports a child's
  failure as the parent's.

- Approval RPC failures include `CodeDrift`; gateway envelopes and projections
  carry the optional budget `onExceeded` policy. Clients with exhaustive error
  handling must handle the new refusal (#1807, #1843).

- Added `GatewaySchema.SnapshotOf`, `FrameOf`, and `RowOf`, and made
  `Projections.Service.snapshot`, `subscribe`, and `GatewaySchema.rowSchemaFor`
  generic in their selector, so a literal selector keeps its own row type and a
  caller reads `requestId` or `nodeId` without an assertion. A selector chosen
  at runtime still maps to the `ProjectionSnapshot` and `GatewayFrame` unions.

### Changed

- The `workspace-runs` and `approvals` projections fold the newest 500 runs
  instead of the oldest 500, and a followed workspace admits a run created
  after its oldest followed run by displacing that run. Before, a workspace
  past 500 runs never showed a newly launched run.
- The runtime bridge logs the full cause of every failure the caller did not
  cause, and runs each handler in a `runtime-bridge.command` or
  `runtime-bridge.observe` span. The wire response is unchanged.
- A gateway that enables the runtime bridge without a bearer credential now
  refuses to bind with `bind_failed`, including on loopback. It used to start
  and answer 401 to every bridge request.
- The Bun host keeps the operating-system errno on its bind refusal, so the
  operator log names `EADDRINUSE`, `EACCES`, or `EADDRNOTAVAIL` as the Node
  host's does. The wire refusal still omits it.
- `GatewaySchema` derives `ProjectionSelector`, `ProjectionName`,
  `rowSchemaFor`, `ProjectionSnapshot`, `RowFrame`, and `DeltaFrame` from one
  selector-to-row table instead of five hand-kept lists. The wire format is
  unchanged.
- Renamed the `GatewayError`, `ResumeError`, and `SuperviseRuntime` tags from
  the retired `flows/gateway/` namespace to `@smthrs/gateway/`, the namespace
  `Projections` already used. A refusal body now carries
  `"_tag": "@smthrs/gateway/GatewayError"`.
- `@smthrs/run-store` is no longer a runtime dependency. `SuperviseRuntime`
  spells its two ownership shapes structurally.

### Removed

- Removed `SuperviseRuntime` and `test/TestSuperviseRuntime`. No host
  implemented the port, so it shipped as a stub that scanned nothing and
  resumed nothing. Recovery remains the heartbeat reclaim.
- Removed `GatewaySchema.Workspace`, `GatewayConfig`, `GatewayStatus`,
  `SingletonRecord`, `TokenScope`, and `TokenRecord`, and the API and
  trust-boundary passages that had to disclaim them: nothing minted, read,
  persisted, or served one, and a first release has nothing to be compatible
  with. A singleton handshake lands with its route and its tests.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added the assembled workspace gateway: `POST /rpc`, `/rpc/ws`,
  `POST /projections`, `/projections/ws`, `POST /sync`, `/sync/ws`, and an
  unauthenticated `GET /health`, as one application layer with
  `node/NodeGateway` as its Node host.
- Added the served read path: `workspace-runs`, `run-summary`, `run-events`,
  `transcript`, `run-tree`, `approvals`, and `node-output`, folded from the
  control events `Control.watch` publishes and served as snapshots, replacement
  deltas, and keepalive frames.
- Added `Approval.Submit`, the one composite mutation a product client cannot
  assemble safely on its own, journaled under the operator the shared bearer
  middleware authenticated rather than the composition's default.
- Added keepalives on `/rpc/ws` and `/projections/ws` at a cadence well inside
  the 600-second idle cut a relay applies, and an ingress guard that answers
  401, 400, and 413 with a typed body instead of an empty 500.
- Added `Diagnosis`, which computes what happened to a run from that run's own
  events and renders it as the `run-summary` row's verdict and diagnosis card.
- Added `NodeGateway.bindRefusal`, `GatewayError.settingRefusal`, and
  `GatewayServer.exceededBodyLimit`, so a start-time refusal is a typed
  `bind_failed` value and a body-read failure is told apart from a body that
  was too big.
- Added `GatewaySchema.rowSchemaFor`, a resume cursor on
  `Projection.Subscribe`, and same-named type aliases for every public selector
  and frame schema, so a client decodes rows and resumes a subscription instead
  of casting and re-reading.
- Added package-owned documentation under `docs/`, built and drift-checked by
  the `PACKAGE.ts` `docs` and `docsFiles` targets.

### Changed

- A workspace subscription now reports new runs, status changes, and new gates
  instead of emitting a snapshot and then keepalives forever.
- A subscription now reads the control plane exactly once. The rows, the cursor
  the snapshot advertises, and the sequence its deltas start after all come
  from that read, so an event landing mid-read is no longer delivered as both a
  row and a delta.
- A delta now folds the events accumulated on the stream instead of re-reading
  the whole journal per event, so following a run costs one read whatever its
  length.
- `GatewayError.cause` now carries a redacted `{_tag, code}` summary rather than
  the whole internal `ControlError`, and the full cause is logged server-side.
- Projection histories and encoded row sets are bounded. A limit breach now
  fails as `resource_limit` rather than retaining an unbounded journal or wire
  payload.
- Projection cursors now bind the full selector and a sequence-local offset,
  preserving every derived event when several share one journal sequence.
- Startup policy and operating-system bind failures now travel through typed
  effect and layer channels as sanitized `bind_failed` values; constructors no
  longer throw synchronously.
- The workspace approvals follower counts only runs with pending gates toward
  its run ceiling, so irrelevant completed histories cannot starve a later
  request.
- An unknown run now fails `run_not_found` identically for every run-scoped
  selector, rather than failing for two of them and answering an empty snapshot
  for the other four.
- `Diagnosis.clip` now cuts on code points, never emitting a lone surrogate,
  and honours widths of 0 and 1; `firstLine` no longer leaves a carriage return
  on a CRLF cause.
- `Diagnosis.digest` now measures a run's span from the kinds it handles, so
  the keepalive merged into a followed `Watch` no longer reports a run as
  having lasted as long as it was watched.
- `nodeOutput` now keys its rows exactly as `runTree` does, even when an event
  names no run, so the two folds cannot disagree about which node produced
  which output.
- `GatewayServer.layer` now takes an options object rather than two positional
  optionals.
- `Approval.Submit` now declares exactly the failures `Control.approve` and
  `Control.deny` raise. It gained `PlanNotFound`, which a decision naming a plan
  the control plane does not have answers with, and lost `ClaimLost`, which
  neither command raises: a declared tag no command produces is a recovery
  branch no client's code can reach.
- The ingress guard now classifies a request target the way the router resolves
  it rather than by its literal spelling. `HttpRouter` reaches `/rpc` from
  `/%72pc`, `/rpc;transport-parameter`, `/rpc/`, `//rpc`, `/rpc//`, `/RPC`, and
  `/foo/../rpc`, and the guard recognised none of them, so on a credentialed
  bind those spellings reached the mount with neither the bearer check nor the
  body limit applied. `ControlClient`'s HTTP protocol posts every call to
  `/rpc/`, so this was the ordinary client path and not only a crafted alias.
  An uncredentialed call is now refused 401 at the edge before its body is
  read, which an Effect RPC client reports as a transport failure rather than
  as the mount's own `Unauthorized`.
- A transcript row now carries one display line per event: a seat, flow name,
  failure message, resolved output, or approval question containing a newline
  no longer splits one row into several.
- The published runtime dependency set no longer includes
  `@effect/platform-node-shared`, `@smthrs/journal`, or
  `@smthrs/notifications`. Journal and notifications remain development-only
  fixtures for the real SQLite gateway tests.

### Removed

- Removed `plan-cards` from `ProjectionName`, `PlanCardsSelector`, and the read
  path: the declared projection set equals the served set (release requirements), and
  a plan card is what `Control.plan` returns rather than something projected.
- Removed the never-produced `GatewayErrorCode` members `already_running`,
  `not_running`, `token_expired`, `unsupported_projection`,
  `subscription_expired`, `overflow`, and `sweep_failed`.
- Removed the never-emitted `OverflowFrame`, `ExpiredFrame`, `TerminalFrame`,
  and `UnauthorizedFrame`, and the unreferenced `SubscriptionTick` and
  `SubscriptionWatch` schemas.
- Removed `SubmitApprovalOutput.resume` and the `layerRefuseMalformedRpc`
  alias: a first release has nothing to be compatible with.
- The 0.x gateway protocol is replaced rather than adapted. No 0.x method name
  or path is served and there is no compatibility projection.
