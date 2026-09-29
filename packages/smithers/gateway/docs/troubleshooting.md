---
title: "Troubleshooting"
description: "The refusals a gateway answers with, grouped by where they come from: the bind, the ingress guard, the read path, a subscription, and the data a projection can and cannot see."
---

Every refusal this package produces is a `GatewayError` carrying one of nine
stable codes. Find the symptom, then the code, then the change.

## The gateway will not bind

### Refusing non-loopback gateway bind

**Symptom**

```text
Refusing non-loopback gateway bind 0.0.0.0 without an explicit --listen opt-in
Refusing non-loopback gateway bind 0.0.0.0 without a bearer credential
```

**Cause** The bind policy, which fails closed. A host other than `127.0.0.1`,
`::1`, or `localhost` needs both an explicit `listen` opt-in and a bearer
credential.

**Fix** Supply both, or bind loopback. See
[Serve beyond loopback](./guides/serve-beyond-loopback.md).

### A setting must be a positive safe integer

**Symptom**

```text
The gateway keepalive cadence must be a positive safe integer, not 0
The gateway request body limit must be a positive safe integer, not -1
```

**Cause** `heartbeatMillis` or `maxRequestBodyBytes` is zero, negative,
fractional, or outside the safe-integer range. A cadence of zero turns the
keepalive into a tight loop and a body limit of zero refuses every request, so
the composition is refused before it binds rather than after it is serving.

**Fix** Pass a positive integer, or omit the field and take the default: 30,000
milliseconds and 1,048,576 bytes.

### The gateway socket could not be bound

**Symptom** A `bind_failed` `GatewayError` whose message is
`The gateway socket could not be bound`.

**Cause** The operating system refused the listen: the port is already in use,
the address is not local, or the port is privileged.

**Fix** Read the server log. The Node host writes one error-level line before
it sanitizes the failure: `The gateway socket could not be bound`, with the
requested `host` and `port` and the `ServeError` whose `cause` is the
operating-system error (`EADDRINUSE`, `EACCES`, `EADDRNOTAVAIL`). The wire error
deliberately omits all of that, because it reaches every bearer holder. Then
check what already holds the port. A gateway already serving this workspace
answers `GET /health` with the workspace hash, which is how a supervisor decides
whether to keep it.

## The gateway is up but a request is refused

### 421 invalid_host or 403 invalid_origin on a local gateway

**Symptom** A credential-less loopback gateway answers with `invalid_host`, or
a browser request or WebSocket upgrade answers with `invalid_origin`.

**Cause** Local mode accepts `Host` values naming only `localhost`,
`127.0.0.1`, or `[::1]`, with an optional port. If an `Origin` header is
present, it must be a canonical `http` or `https` origin whose host and port
equal the request's `Host`, in every mode. An app on `http://localhost:5173`
calling a gateway on `localhost:3000` is refused. This prevents a web page or
DNS-rebound hostname from acting as the local operator.

**Fix** Connect through the loopback URL the server printed. Serve the browser
client from that same origin, or put it behind a dev-server proxy that
forwards to the gateway so the browser only ever talks to one origin. CLI
clients should omit `Origin`, as usual; an Origin-less request is accepted.

### 401 on /projections or /sync, but /rpc answers something else

**Symptom** `POST /projections`, or any protected socket upgrade, answers HTTP
401 with this body, while `POST /rpc` with the same missing credential answers
HTTP 200 carrying a `/control/Unauthorized` in the RPC frame.

```json
{
  "_tag": "@smthrs/gateway/GatewayError",
  "code": "unauthorized",
  "message": "A valid bearer credential is required"
}
```

**Cause** Not a bug. `/rpc` authenticates in band so that a caller sees the
control plane's own typed refusal, exactly as it would against a control server
hosting the same procedures. Every other RPC path is checked at the edge,
because a socket cannot be refused after it is open.

**Fix** Send `Authorization: Bearer <token>` on both. Handle the two shapes:
`@smthrs/control` `ControlError.Unauthorized` from `/rpc`, and a `GatewayError`
body under a 401 from the rest. The reasoning is in
[the trust boundary](./concepts/trust-boundary.md#edge-authentication-and-where-it-deliberately-stops).

### 400 malformed_request: carries no RPC request message

**Symptom**

```json
{
  "_tag": "@smthrs/gateway/GatewayError",
  "code": "malformed_request",
  "message": "POST /projections carries no RPC request message"
}
```

**Cause** The body decoded to something that is not a tagged RPC message:
`{}`, `[]`, prose, or nothing at all.

**Fix** Send the framed envelope, one JSON object per line:

```text
{"_tag":"Request","id":1,"tag":"Projection.Snapshot","payload":{"selector":{"_tag":"workspace-runs"}},"headers":[]}
```

A body naming a procedure that does not exist is _not_ this error. It reaches
the mount and the RPC protocol reports the defect itself.

### 413 request_too_large

**Symptom** `POST /rpc exceeds the 1048576-byte request limit`.

**Cause** The body is over `maxRequestBodyBytes`, or its declared
`content-length` is.

**Fix** Send less, or raise the limit at the bind. A declared length over the
limit is refused without reading the body, so a client that lies low in
`content-length` is still measured as the body is read. A streaming body has no
declared size; when it crosses the limit, the Node host destroys the source
rather than draining attacker-controlled bytes, so the client may observe a
connection reset instead of the 413 response.

### 400 malformed_request: a body the server could not read

**Symptom** `POST /rpc carries a body the server could not read`.

**Cause** The read failed for a reason that is not size: a truncated body, a
reset transport. This is deliberately not 413, because the request cannot be
retried smaller.

**Fix** Retry the request. If it repeats, look at the client's framing and at
whatever sits between it and the gateway.

### 404 on a path that looks like a mount

**Symptom** `/rpc%2f`, `/%2frpc`, `/rpc%3Bp`, and `/rpc%20` answer 404.

**Cause** A reserved character left percent-encoded is not a separator, to the
router or to the ingress guard. Those spellings name no mount, exactly as they
name none to `HttpRouter`.

**Fix** Post to `/rpc`. Aliases the router does resolve, including `/rpc/`,
`//rpc`, `/RPC`, and `/rpc;p`, are recognized by the guard too, so they are
authenticated and size-limited rather than slipping past.

## A read is refused

### run_not_found for a run you can see

**Symptom** Every run-scoped selector answers
`{ "code": "run_not_found", "message": "No run <id>" }`.

**Cause** The control plane does not list that run. The gateway never opens the
engine database, so a run that exists only there is invisible here. Event reads
alone cannot distinguish an unknown run from an empty run, so the gateway checks
existence through `Control.list`. An existing run with no events projects successfully.

**Fix** Confirm the run with `Control.list`, or [`smthrs runs list`](/cli/runs). If the
run is in the engine database but not the control plane, the launch never
reached the control plane and the gateway is reporting that correctly.

### resource_limit

**Symptom** A `resource_limit` `GatewayError` on a snapshot or a delta.

**Cause: retained state** A run projection keeps a window of at most 10,000
events and 4 MiB of retained events plus digest identity state. Older events
enter a carried digest. Large retained events are clipped to 16 KiB. The read
fails if the digest's exact identity state cannot fit the 4 MiB budget.

**Cause: oversized graph event** A native `flows.engine.plan-recorded` or
`flows.engine.subgraph-appended` event exceeds 16 KiB. These events are refused
instead of clipped, including on `run-events` pages, so graph topology stays
intact.

**Fix** Inspect raw history through `run-events` snapshots. Each page returns
at most 1,000 events and 4 MiB, plus a cursor; pass that cursor as `after` until
a page is empty. Other large events are clipped, while admitted native
`control.engine.event` payloads remain complete. One event too large for a
4 MiB page fails with `resource_limit`. Inspect an oversized graph event with
a bounded `Control.watch` read and keep future graph events within 16 KiB.

**Cause: projected rows** The encoded projected row set exceeds 4 MiB.

**Fix** Narrow the selector to reduce the projected row set, for example
`node-output` for one node or `run-summary`. This only helps if the selected
rows fit within the row budget.

A `resource_limit` refusal returns no rows. A successful `run-events` page is a
bounded part of the history; use its cursor to continue.

### run_unavailable with a cause that says almost nothing

**Symptom**

```json
{
  "code": "run_unavailable",
  "message": "Listing runs failed",
  "cause": { "_tag": "/control/Unavailable", "code": "unavailable" }
}
```

**Cause** A control-plane read failed. The cause carries only the failure's tag
and stable code.

**Fix** Use the projection log operation identifier and known control error
tag/code to locate the failing backend operation. Projection logs omit backend
messages and nested causes, including SQL, credentials, and file paths.

## A subscription misbehaves

### malformed_request when resuming from a cursor

**Symptom** One of:

```text
A cursor for the run-tree projection cannot resume a run-summary subscription
A cursor can resume only the exact selector that issued it
A cursor for run run-2 cannot resume a subscription to run run-1
A workspace-runs subscription has no resumable cursor, because control journal sequences belong to per-run partitions
Cursor 12:0 was not issued by run run-1
Cursor 99:0 cannot resume run run-1 past its last position 12:0
```

**Cause** The cursor does not belong to this subscription, or names a position
this run never reached.

**Fix** Send back the cursor exactly as it arrived, from the same selector.
For a workspace projection there is no resume at all: re-subscribe without
`after` and take the snapshot again.

### The connection drops after a few minutes of quiet

**Symptom** A follower on a quiet run disconnects and reconnects on a cycle,
with no error from the gateway.

**Cause** Something between the client and the gateway cuts idle connections
sooner than the keepalive cadence. The default is one frame every 30 seconds,
sized for a relay that cuts at 600 seconds.

**Fix** Shorten the cadence at the bind with `heartbeatMillis`, which re-times
both the `/projections/ws` heartbeat and the `/rpc/ws` `Watch` keepalive, or
build the read path with `Projections.layerWith({ heartbeatMillis })` to
shorten the projection heartbeat alone.

### A followed Watch delivers events nothing emitted

**Symptom** `/rpc/ws` `Watch` frames arrive with kind
`control.gateway.heartbeat` and a `null` payload, repeating the last sequence.

**Cause** That is the gateway's keepalive. `ControlRpcs.Watch` answers
`ControlEvent` and has no frame of its own for one, so the keepalive is
published as an event whose kind no emitter uses.

**Fix** Ignore the kind, as every fold in this package does with an unknown
kind. It repeats the last delivered sequence on purpose, so resuming from the
last sequence you saw does not rewind.

## A projection is missing something you expected

### The run tree has no nodes, though the run did work

**Cause** `run-tree` folds agent cell calls, from
`control.agent.cell-call-started` and `control.agent.cell-call-settled`. The
durable engine's own `flows.engine.*` records live in a different database with
a different journal, and `Control.watch` reads one run's partition of the
control journal alone.

**Fix** Nothing to change here. What an engine step did reaches a client as the
agent call that made it. A run driven by an executor that journals no agent
events has no tree, correctly.

### The approvals inbox is empty though a run is waiting

**Cause** The unscoped `approvals` selector asks the control plane for runs
whose status is `waiting-approval` and then keeps only those with a pending
gate. A run parked for another reason, or one whose gate was already decided,
is not in the inbox.

**Fix** Use the run-scoped form, `{ _tag: "approvals", runId }`, which lists
that run's gates including the decided ones. That is what a run card renders.

A human wait held by a NESTED execution is no longer one of these cases. A
flow that calls another flow parks the child, so a `HumanTask` several
`.child()` boundaries down used to leave the run an operator opened reading
`waiting · event` with an empty inbox, the shape run-3 of `coding/request`
parked in, on a gate named `coding-clarification`. The control plane now rolls
a run tree's open human waits onto the root as
`ControlSchema.RunSummary.pendingWaits` and rolls its status up with them, and
the projection turns each into a pending row of that root. A run still showing
an empty inbox is waiting on a timer, an event, or a quota, and its
`waitingReason` says which.

### A question in the inbox cannot be answered

**Cause** A `HumanTask` gate asks for a value, and `decision: "approve"` alone
carries none. The run stays parked on the wait it opened.

**Fix** Submit the value in `Approval.Submit`'s `answer`, shaped for the
`kind` the row's `request` declares. The mount routes it to `Control.signal`
addressed to the row's `runId` and naming its `requestId`, and the control
plane resolves the wait wherever in the tree it is held. `smthrs runs signal <root
run> '{"name":"<the question>","payload":…}'` is the same act from a terminal.

### The workspace listing stops at 500 runs

**Cause** `Projections.maxWorkspaceRuns` is 500, matching
`ControlSchema.maxPageSize` so the control plane can answer the whole allowance
in one page.

**Fix** Read the runs you care about individually with `run-summary`. There is
no paging on the workspace projection: a workspace with more runs is answered
with its newest 500, and a newly created run displaces the oldest one.

## Recovery

### An abandoned run is never resumed

**Cause** The gateway does not supervise runs, so nothing it serves discovers
or resumes a run whose owner died.

**Fix** Recovery is a reclaim rather than a supervisor. A run becomes
reclaimable once the heartbeat its owner stopped renewing is older than 30
seconds, and any running process with the flow registered takes it over. Bring
up a host composition running the durable engine driver with the relevant flows
registered, or recover the run explicitly.

### /health answers but every projection fails

**Cause** Startup is deliberately not blocked by a subsystem that failed to
recover. A gateway whose read path cannot read still comes up, because a
supervisor still has to be able to ask which workspace this process is.

**Fix** Read the server log for the read path's own failure. The identity
answer is correct and is not evidence that the rest is healthy.
