---
title: "Wire protocol"
description: "The normative message shapes of the sync read path: scopes, cursors, read requests and responses, subscription frames, and the limits every side enforces."
---

## Scopes and cursors

A client reads either one run or every run in a workspace:

```ts
import { SyncProtocol } from "@smthrs/sync"
import { Schema } from "effect"

const scope = Schema.decodeUnknownSync(SyncProtocol.RunScope)({
  _tag: "Run",
  runId: "build-42"
})
const cursor = Schema.decodeUnknownSync(SyncProtocol.RunCursor)({
  runId: "build-42",
  afterSeq: 17
})
```

A run cursor stores the last sequence the client was delivered. A workspace
cursor is an array of per-run cursors with at most one entry per run: a request
that names one run twice is refused with `invalid_request`, because the read
position and the echoed response state would otherwise disagree. Journal
sequences may have holes, so a cursor means "read entries after this number",
not "expect the next number to be exactly one greater".

A read and a subscribe request carry the same envelope, `SyncProtocol.RequestEnvelope`:
one scope and one cursor set. Server read, server subscribe and client
subscribe admit a caller-built request against that single schema.

`generation` is asymmetric on purpose. A request may omit it, which is how a
cursor persisted before rewind support still decodes; a response may not. The
server-side shapes state that requirement in the type system:
`SyncProtocol.ServerCursor`, `ServerReadResponse`, `ServerEntriesFrame` and
`ServerFrame` all require `generation`, and `SyncServer.Service` answers with
them, so a server that omits one does not compile. The wire schemas stay
lenient so a non-conforming server is refused with `protocol_violation` naming
the missing generation rather than a bare decode failure.

## Protocol version

`SyncProtocol.protocolVersion` is the one accepted wire revision, and the only
place the number is written. Read, subscribe and snapshot requests all decode a
version this revision does not speak, so the refusal is a typed
`protocol_violation` with cause `protocol_version_mismatch` on every path,
in process and over the wire, request and response alike. There is no second
code for a version mismatch.

## Read

`Sync.Read` accepts `protocolVersion: 1`, a scope, a cursor set, and a limit, and returns journal
entries plus the cursor set the page served through. `RunCatalog` supplies the
run list for workspace reads; `SyncServer.layer` combines it with `Journal`.

`limit` is bounded at `SyncProtocol.maxReadLimit`. A page is also bounded by
the encoded-entry ceiling, `maxFrameBytes`, which defaults to 2 MiB. The
ceiling is a budget on the page, not a verdict on the read: the server serves
entries until the next one would cross it, then returns `done: false` so the
client asks for the rest. Only a single entry whose own encoded size exceeds
the ceiling fails, with `frame_too_large`, because no page can carry it.

Persist the returned cursors only after applying the returned batch.

There is no application acknowledgement RPC. Response cursors are delivery
bookmarks. `SyncClient.progress` reports `Progress`, two cursor sets:
`delivered` holds delivery bookmarks and `applied` holds application
positions. Only successful `apply` and snapshot-restore callbacks advance the
applied set. An applying subscription never inherits delivery-only progress.

Both server and client validate complete admitted batches before serving or
applying them. A malformed envelope or non-JSON payload fails `decode_failed`;
foreign runs, foreign branch identities, and non-monotonic sequences fail
`protocol_violation`. Causes retain a bounded classification without publishing
private record contents. Unknown event namespaces remain open JSON values.
Known branch commands must decode; existing defaults for absent `args` and
`target` remain unchanged. No stored row is rewritten or silently skipped.

## Subscribe

`Sync.Subscribe` requires the same `protocolVersion: 1` and streams `Entries` frames, each carrying one run's entries and
the interval the server covered (`runId`, `fromSeq`, `toSeq`), and a terminal
`Closed` frame when the server ends the subscription. `fromSeq` and `toSeq`
describe the covered interval, not the sequences actually carried: dropped
admissions leave legitimate holes. No frame carries a cursor; a client tracks
its own, which is what `SyncClient` does.

The `Heartbeat` variant is RESERVED. No server emits one at 1.0.0-rc.0, so a
client must not wait for one; it stays in the union so adding it later is not a
wire break. Keepalive is a transport concern, because a heartbeat here would
spend the subscription's credit.

The request includes a credit count between 1 and
`SyncProtocol.maxSubscribeCredit`. Credit is a hard limit on frames emitted by
that subscription, not a sliding acknowledgement window, and there is no Ack
RPC. A client that needs more resubscribes from its current cursor positions,
which is what `SyncClient` does once per window. These are applied positions
when an `apply` callback is supplied and delivery bookmarks otherwise.

A subscription also ends when the credential that opened it expires, with
`SyncError` code `unauthorized`. Authorization happens once, at open, so
without that deadline a signed expiry could not revoke a stream that simply
stayed connected.

`SyncClient.subscribe` wraps the RPC stream. It detects invalid cursor movement
as `SyncGapError`, refuses a frame or a catch-up page that contradicts itself
as a `protocol_violation`, reconnects transport failures under exponential
backoff capped at five seconds, and resumes from the subscription's matching
progress map. Authentication is `SyncAuth`, and both are part of the package
rather than left to the application.

## Compacted runs

A cursor below a run's compaction floor names entries the journal has deleted.
The read or the subscription fails with `SyncError` code `compacted`, and the
error carries a `Resync` of `{ runId, checkpointSeq, generation }`: the floor to
resume from and the run history it belongs to. `SyncClient.subscribe` fails
closed unless `onResync` restores the missing prefix and returns
`{ runId, afterSeq }`. The cursor advances to that actual restored sequence, not
necessarily the older reported floor, before replaying the suffix. A receipt
without a generation takes the refusal's, so a fresh follower of a rewound run
resumes the right history. Foreign-run and behind-floor receipts are refused.

:::warning
The resync moves a cursor, not state. The entries below `checkpointSeq` are
never delivered. Fetch an explicitly public projection with `Sync.Snapshot`
or use an authorized local source. `SubscribeOptions.onResync` runs before the cursor moves and must
succeed with a valid restored cursor, so a consumer that cannot restore the prefix fails instead of silently
skipping it. A Node follower reads that prefix out of band with
`journal.latestCheckpoint(runId)`, applies `checkpoint.state`, and continues
from the sync stream. See [Checkpoints and compaction](/pkg/journal/concepts/compaction).
:::

## Public snapshots

`Sync.Snapshot` accepts `SnapshotRequest`: `protocolVersion: 1`, `runId`,
`lineageId`, `projection`, `projectionVersion`, `atLeastSeq`, and an optional
branch `capability`. The response repeats that identity with `seq` and JSON
`state`, representing the complete public projection through `seq` inclusive.
Lineage IDs are nonempty and at most 512 characters; projection names are
nonempty and at most 128. Projection versions are positive safe integers.

Run/branch read authorization is the same as for history. An explicit host
`SyncServer.SnapshotSource` must select a public projection safe for every reader
of that run; raw journal checkpoints are never served automatically. Missing
providers or unavailable projections fail closed. Credential expiry is checked
before and after provider work, and provider failures do not expose private text.

Both ends enforce the requested identity, its protocol version, and the
minimum sequence; each mismatch is a `protocol_violation`. Both also bound
the entire encoded UTF-8 snapshot response by `maxFrameBytes` (default 2 MiB,
excluding the outer RPC envelope), and reject non-JSON provider state. The
response is detached from mutable provider objects.

`SyncClient.snapshot` fetches only: it does not apply state or move cursors.
After transactional application, `onResync` returns the actual restored cursor.
If compaction advances before the next suffix read, recovery runs again at the
newer floor. Snapshot bytes are inline, so no temporary download reference can
expire during application. Providers must retain a usable latest snapshot
covering every compacted prefix and version they continue to serve.

## Directionality

`SyncRpcs` is read only: `Sync.Read`, `Sync.Subscribe`, and `Sync.Snapshot`. Client-to-server
submission is not planned work, it is `BranchRpcs`: `Branch.Submit` admits one
command onto a branch's journal run under a client-minted idempotency key, and
`Branch.Announce`, `Branch.Leave`, `Branch.Roster`, and `Branch.WatchRoster`
carry ephemeral presence. `BranchRpcs` has no production mount at
1.0.0-rc.0; the gateway serves `SyncRpcs` alone.

Bidirectional reconciliation of the read path, acknowledgement windows, and
resumable transport sessions remain unplanned.

Command admission separately permits up to 1 MiB of UTF-8 JSON submission
bytes. Before writing, it also checks the complete journal envelope against
`BranchCommands.Options.maxFrameBytes` (2 MiB by default), reserving the largest
generated sequence/timestamp representation. Custom admission, server, and
client budgets must agree. `maxFrameBytes` sums encoded entries; an RPC transport
must additionally allow its frame/envelope overhead. Neither journal cursors nor
entries change when admission refuses a command.
