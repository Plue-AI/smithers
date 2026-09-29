---
title: "Run the agent as a control-plane run"
description: "Compose AgentSession, the production ControlExecutor: what a launch does, the approval gate, steering, the journal trail, and cross-process resume."
sidebar:
  order: 4
---

`AgentSession.layer(options)` is the production `ControlExecutor` for
[`@smthrs/control`](/api/control). When the control plane accepts a launch, the
session looks the flow up in the registry, loads its markdown prompt body,
resolves its declared seat through `SeatResolver`, and runs `Agent` as the body
of one durable flow execution whose id is the control run id.

The session is the adapter, not the agent. Everything about how a frame is
built, sealed, and replayed belongs to `Agent`; what belongs here is the
control-plane half: status fencing, the resume bridge, the approval gate, and
the journal trail. The CLI wiring, `NodeControl.layerExecutor` in
[`@smthrs/cli`](/api/cli), composes this layer with a `SeatResolver` over real
provider routes and the permission-guarded host layers from
[`@smthrs/kernel`](/api/kernel).

## Declare the composition

```ts
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"

const executor = AgentSession.layer({
  // Explicit, never unlimited. These are illustrative values; size them for
  // the cells you expect.
  limits: { calls: 64, memoryBytes: 268_435_456, steps: 100_000, timeMs: 60_000, totalMs: 3_600_000 },
  quotaPolicy: QuotaPolicy.layerDefault(),
  budget: (envelope) => Budget.layerFromEnvelope(envelope),
  flows: [/* the host's executable catalog: filesystem, shell, memory */],
  approvalChannel: true
})
```

Two options are required, and the session supplies no default for either:

- `limits` is the explicit sandbox budget every cell runs under. There is no
  default-unlimited path, because an unlimited QuickJS cell can hang the frame.
- `quotaPolicy` and `budget` are the two policies every model call in the run
  is decided under. `budget` is a function from the approved `Envelope` to a
  `Budget` layer, so the ceiling a run is held to is derived from the plan that
  was admitted rather than from anything the host held. A host that means to
  enforce nothing says so with `QuotaPolicy.layerUnclassified()` and
  `Budget.layerUnbounded()`.

The remaining options shape the loop's discipline: `system`, `maxFrames`,
`readOnlyCap`, `modelCallMs`, `repeatCap`, `narrowingCap`, `unmovedCap`,
`unresolvedCap`, `approvalChannel`, and `reasoningEffort`. The field table is
in the [API reference](../api.md#agentsessionoptions). Two deserve a note:

- `approvalChannel` defaults to false. The executor wires an approval gate on
  every run, but a gate is not an answerer: a benchmark, a cron, and a CI lane
  all register approvals that nobody will ever decide. A run that claims false
  has its `park` transitions refused and answered in-frame.
- `reasoningEffort` is the host's default beneath the flow's own `effort:`
  frontmatter, which wins. The built-in default is `high`: an unset effort is
  not neutral, it is near-zero thinking.

## What a launch does

1. The executor looks the planned flow up in the registry. A flow this
   composition does not know stays `pending`, because another host may run it.
   A flow with a module body also stays `pending`: only prompt flows run on the
   agent.
2. A declared `model:` is resolved at launch, so a missing key refuses the
   launch as a typed failure instead of failing the run after it was accepted.
   A flow with no `model:`, or `model: auto`, is routed instead (below).
3. The driver waits for the control plane's own `running` transition, then
   starts the engine on the one durable flow every agent run executes,
   `agent/run`, with the execution id equal to the control run id.
4. Status writes stay fenced: `waiting-approval` when the execution parks, and
   the terminal status when it settles, with a terminal `failed` carrying the
   rendered cause into the journal.

## Seat routing

A declared `model:` is a person's choice and always wins. A prompt flow with no
`model:`, or with `model: auto`, is routed by the routing graph over the seats
the host's `SeatRouter.Catalog` offers:

- The launch never asks Jev. It only checks that the host binds a catalog with
  at least one seat, and refuses with `LaunchFailed` whose cause is
  `{ seat: "auto", reason: "unconfigured" }` or `reason: "no_candidates"`. A
  host with no catalog refuses a flow with no `model:` as before.
- The run asks once, at its start. Jev answers the graph's questions (phase,
  size, clarity, binary success) and picks the system variant in one reading.
  The run starts on the routed seat, with the seat's available backups as its
  fallbacks. The decision is a sealed step keyed by the run, so a resumed run
  keeps its route and asks nothing.
- An interactive run does not fan out: it routes with `panel: false`, so a
  panel pick starts on the merger with the merger's backups, and no panel is
  recorded.
- The variant's system text follows the host's own `system`.
- The trail opens with `control.agent.seat-routed`, which carries the route's
  `backups`, and the `control.agent.decision-settled` row of the
  `seat/route` reading. A declared seat adds neither.
- A judge that cannot answer, or a pick with no seat available here, fails the
  run as `SeatUnrouted`. No default seat is ever picked.

Approving such a flow approves the seats the graph picks from this host's
catalog; the `seat-routed` row journals the seats that were available.

## The approval gate

A cell asks a person through the `ask` flow. The session gates it in the
`authorize` hook, before the durable boundary opens: it registers an in-run
approval token with the control plane, journals the exact
`control.approval.requested` payload an operator replays through
`smthrs approvals approve`, and fails the call with an encoded
`Permission.PermissionRequired`, which the controller turns into a real durable
park annotated `reason: "approval"`. `Control.approve` records `Approved` and
installs the grant; `Control.deny` records `Denied`. The resumed ask reads that
durable decision and returns `{ answer: "approved", approved: true }` or
`{ answer: "denied", approved: false }`. It never infers a decision by scanning
grants. A missing/pending or unreadable decision is a typed failure, not an
invented answer. Unlike an execution clearance gate, `ask` reports the denial
to its caller; callers must honor `approved: false` before doing gated work.

The park is decided outside the activity on purpose: an activity's outcome is
journaled, so a permission requirement raised from inside one would replay
forever and no later grant could unblock it. The ask's identity is derived from
the run id and the whole input, so a grant for a byte-identical question in one
run never answers it in another, while remaining stable across this run's park
and resumed attempt.

## Steering

The run's `Steering.Source` is `@smthrs/harness`'s `Notifications` over the same
journal-backed notification queue `Control.steer` admits into, so an operator's
message reaches the loop at the next frame boundary. The drain itself is
journaled through the engine port's `record`, so a resumed run replays the
recorded drain instead of reading an already-drained queue.

## The journal trail

The executor consumes the agent's event stream itself and projects it onto the
journal's lossy channel through [`trace`](../api.md#agentsessiontrace): model
settlements with usage and per-call latency, produced cells, call starts and
settlements, transitions, mutation observations, discipline demands, and the
run's terminal resolution. `model-delta` is the one omission, because deltas
are the token-by-token prefix of `model-settled`.

Completion claim readings preserve `demanded` and `refused` separately. A
refused claim remains visible in the run trace after its demand limit is spent.

Two properties keep the trail trustworthy:

- **Identity.** A resumed attempt republishes its whole prefix, so each event
  is journaled under a derived identity, [`traceIdentity`](../api.md#agentsessiontraceidentity),
  that the journal's unique index deduplicates. An event produced after a
  divergence derives a different identity and is admitted normally.
- **No stall.** The trail is buffered in memory and written by a fiber of its
  own, never by the stream's consumer: the consumer runs inside the frame that
  produced the event, and a journal write there deadlocks against the engine
  transaction the frame is holding.

Fields larger than `maxTracedBytes` (65,536) are replaced with a truncation
marker carrying the byte count and digest. Completion outputs are bounded in
both the cell settlement and the applied transition.

### Durable call correlation

The harness creates a `Cell.CallIdentity` before dispatch and carries it in
both `CellCallStarted.call.identity` and `CellCallSettled.identity`. The
control journal preserves it as an additive `callId` on
`control.agent.cell-call-started` and `control.agent.cell-call-settled`.
`AgentSession.callId` hashes canonical JSON containing `session`, `frame`,
`cell`, `ordinal`, `declaration`, and `layers`, and prefixes the SHA-256 digest
with `cell-call-v1:`. Layers are already sorted and unique at the producer.
The ID describes the dispatch, so concurrent calls of the same flow remain
distinct even when their settlements arrive in reverse order.

This is a compatible enrichment of the existing control event payloads; it
does not rename their event kinds, change the journal version, or alter the
engine's activity keys. `traceIdentity` excludes the new `callId` field only
for these two lifecycle kinds so a resumed run still deduplicates a prefix
written by the older producer. Existing journal rows are never rewritten.

Readers join identified calls by ID and keep the first observation of each
start or settlement. Legacy records without IDs retain their name-based FIFO
fallback, restricted to unidentified starts. A new settlement can close an
old unidentified start after an upgrade, but it cannot steal another
identified call. Exact correlation for overlapping legacy calls remains
unrecoverable; see [Gateway projections](/pkg/gateway/concepts/projections).

The ID fixes correlation once an event is journaled. The trail still uses
the buffered lossy channel described above; it does not by itself guarantee
that every observed event survives a process crash or a failed journal write.

## Resume across processes

Resumption is event-driven and durable at once. The executor follows the
journal for the control plane's resume events and re-drives the parked engine
execution, and a once-per-second follower drains the control database's pending
resume delegations, because a decision taken in another process reaches this
executor through nothing else. A parked run has no owner, so the follower takes
up a delegation only when this composition is the run's host: the fence the
park was written under, which only the parking incarnation holds. A delegation
left standing for `abandonedParkAfter` may be adopted by another host. The
default is `Ownership.heartbeatStaleAfter` (30 seconds). The cutoff is inclusive
and applies to the delegation's age, not the age of the parked run.

Corrupt evidence on a succeeded action parks both the engine execution and its
control record. A saved clock, deferred, parent, or approval wake cannot clear
that quarantine, even if it was recorded before the corruption was detected.
Use an explicit run resume to accept the saved outcome. The action is not run
again, and the parked run can still be cancelled.

The module exports the pieces this half is built from
(`waitForRunning`, `waitForParked`, `preserveDriverInterrupt`,
`registerDriver`, `settleDriverFailure`, `requestCancel`, `deliverSignal`,
`drainRecordedSignals`), because a host that runs the agent its own way needs
the same ones. Their signatures are in the
[API reference](../api.md#wait-and-driver-helpers).

## Frame exhaustion

A successful stream exit alone does not complete a session. The final frame
must apply a `complete` transition. A bounded run ending with `continue` is
persisted as `failed` with `HarnessError { code: "model_failed" }` and a
`FramesExhausted` cause carrying the number of frames. `AgentAction` uses the
same terminal outcome check before decoding its answer. An exhausted run is
terminal; approval suspension still parks the run for resume.
