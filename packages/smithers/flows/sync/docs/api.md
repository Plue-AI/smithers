---
title: "API reference"
description: "Every public export of @smthrs/sync: the wire protocol, the read-path RPC group, the fail-closed server, the replay-then-follow client, the run catalog, the two capability authorities, and the branch collaboration modules."
---

```ts
import { JournalEvent } from "@smthrs/journal"
import { RunCatalog, SyncClient, SyncServer } from "@smthrs/sync"
import { Effect, Layer } from "effect"

const serverLayer = SyncServer.layer.pipe(Layer.provide(RunCatalog.layerStatic([])))

const follow = Effect.gen(function*() {
  const sync = yield* SyncClient.SyncClient
  return sync.subscribe({ scope: { _tag: "Run", runId: "build-42" as JournalEvent.RunId }, cursors: [] })
})
```

## Entry points

| Import                         | Source                                                                                                                         | Platform |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `@smthrs/sync`                 | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/src/index.ts)                     | any      |
| `@smthrs/sync/test/TestSync`   | [src/test/TestSync.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/src/test/TestSync.ts)     | Node     |
| `@smthrs/sync/test/TestSocket` | [src/test/TestSocket.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/src/test/TestSocket.ts) | any      |

The root is browser safe, and the package's own bundle check holds it that
way. The signing paths call Web Crypto directly for that reason, so one module
serves Node and the browser. `TestSync.layerTest` binds the Node SQLite test
journal, which is why it is a separate subpath.

## Authorization

Fail closed along two boundaries, both consulted per request:

- **Branch runs.** A run whose id maps to a shared branch is visible only when
  the request's share capability verifies for that branch. An explicitly scoped
  branch read without one fails; a workspace listing excludes the branch runs
  the caller's capability does not cover. Without a `BranchShare` in scope
  every branch run is closed.
- **Non-branch runs and workspace listings.** Visible only to the workspace
  principal (`SyncPrincipal`), whose default is anonymous. Over RPC,
  `SyncAuth.layer` establishes that principal by verifying the
  `WorkspaceShare` capability presented in the `flows-sync-workspace` header.
  A header that is present but malformed, forged, expired, or signed by an
  unknown key is refused outright rather than downgraded to anonymity.

A SUBSCRIPTION is additionally bounded in time. It is authorized once, when it
opens, so the signed expiry travels with the identity (`SyncPrincipal.Workspace.expiresAtMs`,
or the branch capability's own `expiresAtMs`) and the stream ends with
`unauthorized` when that moment arrives. An in-process owner that provides
`SyncPrincipal` itself presented no credential and has no deadline.

Both authorities sign a length-prefixed encoding of their claims under
HMAC-SHA-256, led by a scheme label, so neither's signature can be replayed as
the other's under a shared secret. Length prefixes count UTF-8 bytes, and a
claim set that does not survive UTF-8 (an unpaired surrogate) is refused with
`invalid_request` rather than signed. Secrets are `Redacted` on both sides and
must be at least 32 bytes of UTF-8, or the keyring is refused with
`invalid_request`. Both carry a `kid` inside the signed claims, so keys rotate without
invalidating capabilities minted under a retired one. Each authority takes its
own keyring: `BranchShare.layerConfig` reads `SMITHERS_SYNC_BRANCH_SECRET` and
`SMITHERS_SYNC_BRANCH_KEY_ID`, `WorkspaceShare.layerConfig` reads
`SMITHERS_SYNC_SECRET` and `SMITHERS_SYNC_KEY_ID`.

Both authorities decode their mint request before signing it, so an empty id
or a non-positive `ttlMs` from an in-process caller is refused with
`invalid_request` rather than crashing the operation. `BranchCommands.submission`
returns an `Effect` for the same reason: a command name the schema forbids is a
refusal, not a throw.

## Bounds

The bounds cap what is in flight at once: entries per page, frames per
subscription, journal reads open per workspace subscription, bytes per frame.
What one follower holds open is therefore a function of the configured bound,
not of how far behind it has fallen. Two things still scale with the workspace.
A workspace subscription keeps a served position for every run it has ever
covered, including a run the catalog later drops, so its bookkeeping is O(runs
covered). A catalog-wide round, which runs at open, on an announcement, and
once per `tailIntervalMs`, reads one page and two generations per covered run,
so its work is O(runs listed) with `concurrency` reads open at a time. A wake
for an entry committed in this process reads only the runs it named. Size
`concurrency` and `tailIntervalMs` for the catalog, not only for the follower.

| Bound                                            | Default                                         | What it caps                                                                                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SyncProtocol.maxReadLimit`                      | 1024                                            | Entries one `Sync.Read` may ask for. Over the limit is refused at the wire; an in-process caller is clamped.                                                                   |
| `SyncProtocol.maxSubscribeCredit`                | 4096                                            | Frames one `Sync.Subscribe` may hold open. Zero is refused rather than served as an empty stream.                                                                              |
| `SyncServer.Options.concurrency`                 | `SyncServer.defaultConcurrency` (64)            | Journal reads one workspace subscription holds open at once. A round reads one bounded page per run it visits, so a busy run wakes the next round instead of holding its slot. |
| `SyncServer.Options.tailIntervalMs`              | `SyncServer.defaultTailIntervalMs` (1000)       | Milliseconds a workspace subscription waits before revisiting every covered run when nothing wakes it, and the longest that local wakes may defer that catalog-wide round.     |
| `SyncServer.Options.maxFrameBytes`               | `SyncProtocol.defaultMaxFrameBytes` (2 MiB)     | Summed encoded entries of one read page or subscription frame.                                                                                                                 |
| `SyncClient.SubscribeOptions.credit`             | `SyncClient.defaultCredit` (256)                | Frames one subscription round carries before the follow replenishes the window by resubscribing from its acknowledged cursors.                                                 |
| `SyncClient.Options.bootstrapLimit`              | `SyncClient.defaultBootstrapLimit` (256)        | Entries one catch-up page asks for.                                                                                                                                            |
| `BranchCommands.Options.maxCommandBytes`         | `BranchCommands.defaultMaxCommandBytes` (1 MiB) | Encoded size of one command submission, refused before anything is appended.                                                                                                   |
| `BranchCommands.Options.ledgerCapacity`          | `BranchCommands.defaultLedgerCapacity` (4096)   | Receipts one branch keeps in memory. The journal's producer identity is the durable dedupe, so an evicted receipt costs a round trip and never correctness.                    |
| `BranchCommands.Options.hydrationLimit`          | `BranchCommands.defaultHydrationLimit` (4096)   | Entries one branch's first-touch hydration reads before it stops, so a long history is not charged to the next writer's latency. What the walk misses, the journal answers.    |
| `BranchCommands.Options.branchIdleMs`            | `BranchCommands.defaultBranchIdleMs` (24 h)     | Untouched time before a branch's in-memory state is dropped. The next submission re-hydrates it from the journal, as after a restart.                                          |
| `BranchPresence.PresenceOptions.maxParticipants` | `BranchPresence.defaultMaxParticipants` (256)   | Participants one branch may hold at once; a further announce is refused with `backpressure`.                                                                                   |
| `RunCatalog.MemoryOptions.changesCapacity`       | `RunCatalog.defaultChangesCapacity` (1024)      | Announcements a stalled `changes` subscriber may fall behind by; the oldest slide out.                                                                                         |
| `RunCatalog.PollingOptions.intervalMs`           | `RunCatalog.defaultPollIntervalMs` (1000)       | Milliseconds between reads of the durable run set: one bounded query per interval per composition, not per subscriber.                                                         |
| `BranchPresence.PresenceOptions.changesCapacity` | `BranchPresence.defaultChangesCapacity` (256)   | Roster notifications a stalled `changes` subscriber may fall behind by; the oldest slide out.                                                                                  |

Every numeric option is validated where it enters. A policy belongs to the
constructor that takes it: `SyncServer.makeLiveWith`, `BranchCommands.makeLiveWith`,
`SyncClient.makeWith`, `BranchPresence.makeMemory`, `RunCatalog.makeMemory` and
`RunCatalog.makePolling`, plus the `layerWith`, `layerMemory` and `layerPolling`
layers over them, fail with `invalid_request` when a value is not a positive
safe integer, so a bad policy fails the composition instead of quietly
disabling the comparison it configures. The plain `make`, `makeLive` and
`layer` forms carry the defaults, which are valid by construction, and cannot
fail on a policy. A count a REQUEST carries rather than a policy, meaning
`Sync.Read`'s `limit` and `SyncClient.SubscribeOptions.credit`, is checked
where the request is built.

Both change feeds slide rather than block: a publisher never waits on a stalled
subscriber and never grows the process on its behalf. Neither feed is a source
of truth. `RunCatalog.list` and `BranchPresence.list` are the authoritative
state, and every reader re-lists on a cadence of its own: a workspace
subscription reconciles its covered run set against `RunCatalog.list` on every
round, and a roster watch re-lists once per `BranchPresence` lease, capped at one second. A dropped
notification therefore costs latency and never state.

## Read path

`SyncServer.Service` has `read(request)`, `subscribe(request)`, and `snapshot(request)`.
`makeLiveWith(options)` and `layerWith(options)` take the `Options` policy
above; `makeLive` and `layer` use the defaults. The live layer requires
`Journal` and `RunCatalog`.

`SyncServer.SnapshotSource` is an optional host service with
`read(SnapshotRequest): Effect<Snapshot, SyncError>`. It provides only public
projections, never raw unredacted execution checkpoints. The server authorizes
the run/branch before invoking it, checks expiry before returning data, and
refuses missing providers. Providers must select the exact requested lineage,
projection and version and retain state covering the requested sequence.

`SyncClient.Service.snapshot(request)` fetches that projection through
`Sync.Snapshot` without applying state or advancing cursors. `SnapshotRequest`
and `Snapshot` in `SyncProtocol` carry protocol version 1, run/lineage identity,
projection name/version, minimum or actual sequence, and response JSON state.
Both ends validate identities and the full response's encoded UTF-8 byte limit
using `maxFrameBytes`. Invalid or stale state is refused, not coerced or skipped.

`SyncClient.Service.progress` returns `SyncProtocol.Progress`: two cursor sets,
`delivered` and `applied`. `delivered` is a delivery bookmark only. `applied`
advances only after successful application or restoration; an applying subscription
uses the shared applied map when choosing its start position. Use one client
per projection and persist projection state and its cursor in one transaction.

A read shares its page across the runs it covers and stops at the first of three
bounds: the request's `limit`, the frame ceiling, or the durable tail of every
covered run, which is the only case that reports `done: true`. Every covered run
takes a share of the budget before any run takes a second helping, and the
budget the shares leave unspent is offered back in run order, so a run with a
backlog takes the larger part of a page but never all of it. Filling in run
order instead let a producer that stayed one page ahead take every slot of every
page, so `done` never became true and a bootstrapping follower never reached the
runs behind it. The frame ceiling is a page budget rather than a verdict on the
read, so a page whose entries sum past it reports `done: false`; only a SINGLE
entry whose own encoded size exceeds the ceiling is refused with
`frame_too_large`, because no page can ever carry it.

Cursors are unique per run. A request that names one run twice is refused with
`invalid_request` on both `read` and `subscribe`, because the read position and
the echoed response state would otherwise disagree about where the page began.

## Follow path

`SyncClient.SyncClient` is the browser-safe service tag; `SyncClient.Sync` is
its deprecated former name. `make({ client })` adapts an Effect RPC client and
`layer` derives that client from `RpcClient.Protocol`.
A subscription replays through `Sync.Read` until the server reports `done`,
then follows through `Sync.Subscribe` in credit windows, replenishing each
window by resubscribing from its matching delivered or applied progress.

A frame or page whose encoded entries exceed `maxFrameBytes` is refused with
`frame_too_large`. Out-of-scope entries, repeated or reordered sequences, and
missing response generations fail with `protocol_violation` before delivery.
Each run represented in a `Sync.Read` page's entries must have exactly one
cursor with an explicit generation matching the request, and every entry must
be above the requested cursor. Live frames instead drop already-covered
entries and deliver only the suffix above the cursor. An incomplete bootstrap
page with no entries or a completed subscription window with no frames fails
with `protocol_violation` instead of reopening immediately.

Transport, authentication, and reconnect are handled here rather than left to
the application. A live follow that loses its transport reconnects under
exponential backoff capped at five seconds, resuming from the subscription's
progress; gaps, authorization refusals, and server closes propagate to the
consumer instead of retrying.

A delivery bookmark names what was delivered. `SubscribeOptions.apply`
additionally records `progress.applied`: the callback runs to success before
that cursor moves, so a failed application is retried by the next applying
subscription. A delivery-only subscription cannot acknowledge application.

`apply` and `onResync` fail with the consumer's own error types, and
`subscribe` returns `Stream<Entry, SyncError | SyncGapError | EApply | EResync>`.
A consumer failure keeps its own type, so it never borrows a wire code and
never passes `SyncError.is`.

## Compaction and resync

Compaction deletes a run's entries below a checkpoint, so a cursor under that
floor names history that no longer exists. The server maps the journal's
`compacted` failure onto its own code with the run id the read was issued for,
and `SyncError.resync` carries `{ runId, checkpointSeq, generation }`. The client
fails closed unless `onResync` restores a snapshot and returns its
`{ runId, afterSeq }`. It validates that receipt before advancing to the actual
restored sequence, in the refusal's generation unless the receipt names its own. A
checkpoint at or below what the subscription already covers cannot move the
cursor forward, so it stays a failure rather than a retry of the same refusal.

:::warning
The resync moves a cursor, not state. The entries below `checkpointSeq` are
gone from the journal. `SyncClient.snapshot` can fetch a configured public
projection, but does not apply it. `SubscribeOptions.onResync` is the seam a consumer fills that hole
through: it runs BEFORE the cursor moves and must return a valid restored cursor, so a failure leaves
the cursor where it was and nothing is skipped silently. A Node follower reads
the prefix from `Journal.latestCheckpoint(runId)` and applies it. With no handler,
the original refusal is preserved. A consumer that cannot restore the prefix
must not return an applied receipt for it. Durable consumers must commit snapshot state and
their durable cursor in their own transaction; the client cursor is in memory.
:::

## Errors

`ErrorCode` includes `unsupported` (since 1.0.0) for unavailable host
operations or presence transport; it does not mean an empty roster.

`SyncError` carries a stable `code` from `ErrorCode`, a `message`, an optional
bounded `cause` string, and a `resync` that is set only on `compacted`.
`SyncGapError` reports a server interval that starts beyond the client's
covered cursor.

`cause` is a STRING and never the host object that failed. `SyncError` is the
declared error schema of every RPC in both groups, so what it carries reaches a
remote follower that may hold nothing but a branch share link: a journal
failure crosses as its stable journal code, never as the driver's own sentence,
and the public message names the run rather than the storage fault.

`SyncError.is` is a structural check: the tag, a declared `code`, a string
`message`, and a `resync` only alongside `compacted`. It deliberately does not
require the prototype, because every value that reaches it has crossed a
boundary that rebuilds it.

## Branch collaboration

`BranchPresence.Service.presenceOn(request)` (since 1.0.0) returns
`"unknown" | "present" | "empty"`, authorizing read access first. It stays
`unknown` for one configured `leaseMs` after startup so live participants can
re-announce, and while any required heartbeat source is unavailable. Treat
`unknown` as present for safe-idle decisions.

`PresenceOptions.sourcesReady(branchId)` (since 1.0.0) supplies an
`Effect<boolean>` readiness check for authorization, revocation, bridge and
session sources. It defaults to unavailable.

`BranchPresence.makeNoop()` and `layerNoop` fail announce, leave and list with
`unsupported`; `presenceOn` returns `unknown`. Consequently
`BranchServer` roster reads and watches also fail with `unsupported` under
`layerNoop`, rather than reporting an empty roster.

A branch is one shared live document whose durable state is exactly one journal
run (`BranchProtocol.branchRunId`), so multiplayer reuses the canonical `seq`,
cursors, gap detection, and resumable follow rather than introducing a second
source of truth. Presence is a lease and is never journalled. Commands are
admitted through a client-minted idempotency key whose exactly-once constraint
is the journal's own producer identity, so two servers racing one command
collide durably inside the write transaction.

`BranchRpcs` is the wire group and `BranchServer.layerHandlers` projects the
branch services onto it. The payload schemas ARE the service schemas, so the
wire and the services cannot drift about what a legal message is.

:::warning
Branch collaboration ships unserved at 1.0.0-rc.0.
[`@smthrs/gateway`](/api/gateway) mounts `SyncRpcs` on `POST /sync` and
`/sync/ws`; nothing outside this package's own tests mounts `BranchRpcs`, so
the seven branch procedures have no integration against a real gateway yet.
Treat the branch modules as a library surface pending a host, not as a served
endpoint.
:::

## Test helpers

| Export                                                               | Source                                                                                                                         | Notes                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `TestSync.layerTest`, `layerTrustAllAsOwner`, `layerNoop`, `connect` | [src/test/TestSync.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/src/test/TestSync.ts)     | a real server and client over an in-memory socket pair |
| `TestSocket.makePair`, `Pair`, `TestFaults`, `FrameFilter`           | [src/test/TestSocket.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/src/test/TestSocket.ts) | fault-injecting socket pair                            |

Subscription fan-out is held to budgets, not only to frame assertions. The
package's soak suite runs five concurrent workspace subscribers and requires an
identical frame set from each, drains 200 subscribe and complete cycles and
requires every per-run journal stream to be released afterwards, and soaks 200
five-subscriber rounds under a retained-heap budget. A regression that retains
per-subscriber state satisfies every frame assertion elsewhere, so those are
the checks that catch it.

The optional [long soak tier](./guides/run-a-long-soak.md) adds repeated
post-warmup resource samples, growth slopes, real TCP reconnects, on-disk
compaction and checkpoint retention, and a stalled subscriber. It writes a
machine-verifiable JSON artifact; ordinary PR gates do not start a timed run.

### Rewind generations

`ReadRequest` and `SubscribeRequest` carry `protocolVersion: 1`. The server
refuses a missing or different version with typed `protocol_violation`.
Server cursors and entry frames always carry a nonnegative `generation`,
including zero; a client refuses missing response generations with the same
error before delivery. Persisted request cursors may omit generation for zero.
Persist the returned
generation alongside `afterSeq`. A mismatch raises `lineage_changed` before
sequence deduplication. Server errors carry
`rewind: { runId, generation, afterSeq }`, where `afterSeq` is the archive
boundary (`-1` for a full reset). Rebuild the projection from the current
retained history through that boundary, create a fresh client, and resume from
that position. Idle subscriptions check generations at
`tailIntervalMs`, as well as around journal reads.
