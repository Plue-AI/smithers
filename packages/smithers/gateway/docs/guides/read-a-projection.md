---
title: "Read a projection over HTTP"
description: "Call Projection.Snapshot for each of the eight selectors, decode the rows with the schema the selector names, and keep the cursor the snapshot answers with."
sidebar:
  order: 2
---

`Projection.Snapshot` answers every row a selector currently projects, plus the
cursor they were read at. It is the request/response half of the read path, and
it is what a relay in front of a gateway uses, because a stream belongs on a
socket rather than in a buffered response.

## Pick a selector

Each selector is a tagged struct. Build one as a value, never as a string:

```ts
import * as GatewaySchema from "@smthrs/gateway/GatewaySchema"

const everyRun: GatewaySchema.ProjectionSelector = { _tag: "workspace-runs" }
const oneRun: GatewaySchema.ProjectionSelector = { _tag: "run-summary", runId }
const itsEvents: GatewaySchema.ProjectionSelector = { _tag: "run-events", runId }
const itsTranscript: GatewaySchema.ProjectionSelector = { _tag: "transcript", runId }
const itsCalls: GatewaySchema.ProjectionSelector = { _tag: "run-tree", runId }
const itsGates: GatewaySchema.ProjectionSelector = { _tag: "approvals", runId }
const theInbox: GatewaySchema.ProjectionSelector = { _tag: "approvals" }
const oneOutput: GatewaySchema.ProjectionSelector = { _tag: "node-output", runId, nodeId: "call-1" }
const itsDurations: GatewaySchema.ProjectionSelector = { _tag: "flow-durations", flowId }
```

`approvals` is the one selector whose `runId` is optional, and the two forms
answer different questions. With a run it lists that run's gates including the
decided ones, which is what a run card renders: a gate a human already answered
still belongs on the card that asked. Without one it lists the workspace's
pending gates, which is the approvals inbox.

## Read it in process

```ts
import { Projections } from "@smthrs/gateway/Projections"
import { Effect } from "effect"

const rows = Effect.gen(function*() {
  const projections = yield* Projections
  const snapshot = yield* projections.snapshot({ _tag: "run-tree", runId })
  return snapshot.rows
})
```

The effect fails with a `GatewayError`. `run_not_found` means the control plane
does not have that run, and it is answered identically for every run-scoped
selector: reading a run's events alone cannot tell an unknown run from a run
with no events.

## Read it over the wire

The mount speaks RPC over newline-delimited JSON. One request is one line:

```bash
curl -s http://127.0.0.1:3000/projections \
  -H 'content-type: application/json' \
  --data-binary '{"_tag":"Request","id":1,"tag":"Projection.Snapshot","payload":{"selector":{"_tag":"run-tree","runId":"run-1"}},"headers":[]}
'
```

```text
{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":{"selector":{"_tag":"run-tree","runId":"run-1"},"cursor":{...},"rows":[...]}}}
```

A failure arrives as the same envelope with a `Failure` exit carrying the typed
`GatewayError`. A refusal answered by the ingress guard instead, before the
mount saw the request, is a plain JSON body under an HTTP status: see
[the trust boundary](../concepts/trust-boundary.md#ingress-runs-before-the-transport-parses-anything).

If the gateway was bound with a credential, send it:

```bash
curl -s http://127.0.0.1:3000/projections \
  -H "authorization: Bearer $SMITHERS_TOKEN" \
  -H 'content-type: application/json' \
  --data-binary '{"_tag":"Request","id":1,"tag":"Projection.Snapshot","payload":{"selector":{"_tag":"workspace-runs"}},"headers":[]}
'
```

## Decode the rows, do not cast them

`GatewaySchema.rowSchemaFor` maps a selector to the schema its rows decode
under, so a client that already has the selector does not need a switch of its
own:

```ts
import * as GatewaySchema from "@smthrs/gateway/GatewaySchema"
import { Schema } from "effect"

const decodeRows = (selector: GatewaySchema.ProjectionSelector, rows: unknown) =>
  Schema.decodeUnknownSync(Schema.Array(GatewaySchema.rowSchemaFor(selector)))(rows)
```

| Selector                        | Row schema                          |
| ------------------------------- | ----------------------------------- |
| `workspace-runs`, `run-summary` | `GatewayProjection.RunSummaryRow`   |
| `run-events`                    | `ControlSchema.ControlEvent`        |
| `transcript`                    | `GatewayProjection.TranscriptRow`   |
| `run-tree`                      | `GatewayProjection.RunTreeRow`      |
| `approvals`                     | `GatewayProjection.ApprovalRow`     |
| `node-output`                   | `GatewayProjection.NodeOutputRow`   |
| `flow-durations`                | `GatewayProjection.FlowDurationRow` |

`GatewaySchema.ProjectionSnapshot` decodes the whole answer, selector and
cursor included, and it is a union correlated on the selector: a snapshot whose
rows do not belong to its selector does not decode at all.

## Keep the cursor

Every snapshot carries the cursor its rows were read at. It is not decoration:
it is the position a subscription resumes from without a second snapshot, and
the read that produced the rows produced it, so the two cannot disagree. See
[Follow a run over a WebSocket](./follow-a-run.md).

A workspace cursor is always `value` 0 with a `null` run, and cannot resume
anything. That is a fact about control journal partitioning, not a gap: see
[Subscriptions and cursors](../concepts/subscriptions.md#workspace-subscriptions-do-not-resume).

## Fold rows yourself

The folds are exported, so a client that already holds a run summary and its
events can compute the same rows without a gateway at all:

```ts
import * as GatewayProjection from "@smthrs/gateway/GatewayProjection"

const tree = GatewayProjection.runTree(run, events)
const gates = GatewayProjection.approvals(events)
const lines = GatewayProjection.transcript(events)
```

This is the same code path the served projection uses, which is what makes an
offline reader and a served reader agree.
