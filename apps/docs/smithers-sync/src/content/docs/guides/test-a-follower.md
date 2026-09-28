---
title: "Test a follower"
description: "Bind a real sync server to a real sync client over an in-memory socket, then drop, stall, and disconnect frames to prove your follower survives a faulty transport."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sync/docs/guides/test-a-follower.md"
---

This guide tests the code you wrote against
[Follow a run](/guides/follow-a-run/), using the production server and the
production client. Only the transport is a double: an in-memory socket pair
stands in for a WebSocket, and it can drop, stall, and break frames on demand.

Two subpaths ship for this:

| Import                         | What it gives you                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `@smthrs/sync/test/TestSocket` | `makePair`, the `Pair` it returns, its `TestFaults` controls, and the `FrameFilter` type. Runs anywhere.                 |
| `@smthrs/sync/test/TestSync`   | `layerTest`, `layerTrustAllAsOwner`, `layerNoop`, and `connect`. Binds the Node SQLite test journal, so it is Node only. |

## Bind a server to a client

`TestSync.layerTest` provides the in-memory SQLite journal, an empty mutable
run catalog, a middleware that trusts the connection as the workspace owner,
and the production `SyncServer`. `TestSocket.makePair` allocates the socket,
and `TestSync.connect` starts an RPC server over its server end and returns a
`SyncClient.Service` over its client end:

```ts
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestSocket from "@smthrs/sync/test/TestSocket"
import * as TestSync from "@smthrs/sync/test/TestSync"
import { Effect, Fiber, Stream } from "effect"

const runId = "build-42" as JournalEvent.RunId
const sourceId = "test" as JournalEvent.SourceId

const collectTwo = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const pair = yield* TestSocket.makePair()
  const client = yield* TestSync.connect(pair)

  yield* journal.emitDurableUnfenced({ runId, sourceId, eventType: "first", payload: { value: 0 } })
  yield* journal.flush

  return yield* Stream.runCollect(
    client.subscribe({ scope: { _tag: "Run", runId }, cursors: [] }).pipe(Stream.take(1))
  )
}).pipe(Effect.provide(TestSync.layerTest), Effect.scoped)
```

Both `makePair` and `connect` are scoped, so `Effect.scoped` closes the socket
and the RPC server together. Everything below builds on this shape.

## Use real elapsed time

Run these cases with `it.live`, not `it.effect`. A follower's reconnect
backoff, the server's tail interval, and the socket's own delivery loop all
advance on the wall clock, and `it.effect` freezes the `TestClock` so a live
follow never wakes:

```ts
import { describe, expect, it } from "@effect/vitest"

describe("my follower", () => {
  it.live("receives the durable history", () =>
    Effect.gen(function*() {
      const entries = yield* collectTwo
      expect(Array.from(entries).map((entry) => entry.eventType)).toEqual(["first"])
    }))
})
```

Fork a subscription with `Effect.forkChild({ startImmediately: true })` when
the test commits an entry after subscribing. Without it the entry can land
before the stream attaches, and the follower reads it out of the durable
history instead of following it, which proves less than the test intends.

## Drop the frames that carry one range

`faults.dropRange(runId, from, to)` drops every `Entries` frame whose covered
interval intersects `from..to`. Install it before you connect, then assert
that the follower never delivers entries past the hole:

```ts
const withHole = Effect.gen(function*() {
  const pair = yield* TestSocket.makePair()
  pair.faults.dropRange(runId, 1, 1)
  return yield* TestSync.connect(pair)
})
```

The follower stalls at sequence 0 forever. That is the correct outcome:
sequence 1 is not a legitimate journal hole, it is a frame the transport ate,
and skipping it would lose an entry. The package's own transport-fault suite
asserts exactly this, by requiring the subscription to time out rather than
complete.

`dropRange` recognizes the JSON form of an `Entries` frame without importing
the protocol, so it works only when the connection uses JSON serialization,
which `TestSync.connect` does.

## Stall and resume delivery

`faults.stall()` holds every frame in the socket, and `faults.resume()`
releases them. Nothing is lost, so this reproduces a slow link rather than a
broken one:

```ts
const stallThenResume = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const pair = yield* TestSocket.makePair()
  const client = yield* TestSync.connect(pair)

  yield* journal.emitDurableUnfenced({ runId, sourceId, eventType: "before-stall", payload: { value: 0 } })
  yield* journal.flush
  pair.faults.stall()

  const fiber = yield* Stream.runCollect(
    client.subscribe({ scope: { _tag: "Run", runId }, cursors: [] }).pipe(Stream.take(1))
  ).pipe(Effect.forkChild({ startImmediately: true }))

  const stalled = yield* Fiber.join(fiber).pipe(Effect.timeoutOption("200 millis"))
  pair.faults.resume()
  return { stalled, entries: yield* Fiber.join(fiber) }
})
```

`stalled` is `None`, and `entries` carries the frame the stall held. Assert
both: the first proves the stall took effect, and the second proves the resume
delivered rather than dropped.

## Break the connection

`faults.disconnect()` fails both queues with a socket error, which is what a
dropped WebSocket looks like to the client. The subscription does not fail:
`SyncClient` classifies the failure as `transport_failed` and retries under
exponential backoff capped at five seconds, resuming from the subscription's
progress. Assert that the stream stays open, not that it errors:

```ts
const survivesDisconnect = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const pair = yield* TestSocket.makePair()
  const client = yield* TestSync.connect(pair)

  yield* journal.emitDurableUnfenced({ runId, sourceId, eventType: "first", payload: { value: 0 } })
  yield* journal.flush

  const fiber = yield* Stream.runCollect(
    client.subscribe({ scope: { _tag: "Run", runId }, cursors: [] }).pipe(Stream.take(2))
  ).pipe(Effect.forkChild({ startImmediately: true }))

  yield* pair.faults.disconnect()
  const settled = yield* Fiber.await(fiber).pipe(Effect.timeoutOption("500 millis"))
  yield* Fiber.interrupt(fiber)
  return settled._tag
})
```

`survivesDisconnect` returns `"None"`: the fiber was still running when the
timeout elapsed. A test that expects a failure here is asserting the opposite
of the contract.

## Corrupt a frame

`faults.installFilter` takes a `FrameFilter`, which is called with each frame's
bytes. Return `false` to drop the frame, or return replacement bytes to rewrite
it. Use it to feed your follower a frame the server would never send, and prove
the client refuses it:

```ts
import type * as TestSocket from "@smthrs/sync/test/TestSocket"

const misattribute: TestSocket.FrameFilter = (bytes) => {
  const text = new TextDecoder().decode(bytes)
  if (!text.includes("\"Entries\"")) return true
  return new TextEncoder().encode(text.replace("\"runId\":\"build-42\"", "\"runId\":\"other-run\""))
}

pair.faults.installFilter(misattribute)
```

The rewrite changes exactly one of the two run ids an `Entries` frame carries,
its own or its first entry's, so the frame ends up claiming one run and
carrying another. The subscription fails with `protocol_violation` before any
cursor moves. The client admits server frames rather than trusting them, and
this is how you prove your own error handling sees that.

Filters run in installation order on every frame in both directions. A filter
that returns bytes hands them to the next filter.

## Choose the authorization the test needs

`layerTest` uses `TestSync.layerTrustAllAsOwner`, which trusts every connection
as the workspace owner. That is what a replication-mechanics test wants: it
exercises paging and streaming without provisioning capabilities.

To test authorization itself, compose the production middleware instead.
`SyncAuth.layer` verifies a `WorkspaceShare` capability from the
`flows-sync-workspace` header, so the test provides a real keyring and mints a
real capability:

```ts
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as RunCatalog from "@smthrs/sync/RunCatalog"
import * as SyncAuth from "@smthrs/sync/SyncAuth"
import * as SyncServer from "@smthrs/sync/SyncServer"
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"
import { Layer, Redacted } from "effect"

const keyring: WorkspaceShare.Keyring = {
  activeKid: "k1",
  keys: [{ kid: "k1", secret: Redacted.make("test-secret-fixture-only-not-for-prod") }]
}

const servingStack = Layer.mergeAll(SyncServer.layerHandlers, SyncAuth.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(SyncServer.layer, WorkspaceShare.layerHmac(keyring))),
  Layer.provideMerge(Layer.mergeAll(TestJournal.layer(), RunCatalog.layerStatic([runId])))
)
```

A connection that presents no header reads no non-branch run, so the
unauthenticated case is the one to assert first. See
[Authorize a connection](/guides/authorize-a-connection/) for minting and
presenting the capability.

For an in-process caller with no wire at all, provide the principal directly
with `SyncPrincipal.layerWorkspace("my-suite")`. That path presents no
credential and therefore has no expiry.

## Register runs a workspace subscription can see

`layerTest`'s run catalog starts empty, and a workspace subscription covers
only what the catalog lists. Build your own catalog when the test needs runs in
it. `RunCatalog.makeMemory` returns both the service and a `register` function:

```ts
const catalog = Effect.gen(function*() {
  const memory = yield* RunCatalog.makeMemory()
  yield* memory.register(runId)
  return memory.catalog
})
```

Provide that catalog as `RunCatalog.RunCatalog` in place of the one `layerTest`
supplies. See
[List a workspace's runs](/guides/list-workspace-runs/) for the production forms.

## Stub the ports entirely

A consumer that only needs the sync services to exist, and never exercises
them, takes `TestSync.layerNoop`. It provides a closed client, a closed server,
an empty catalog, and a pass-through middleware. Every subscription it hands
out fails with `closed`, so it is a compile-time convenience and not a fixture
to assert against.

## What these fixtures do not cover

`TestSync` binds the read path only. It mounts `SyncRpcs`, never `BranchRpcs`,
so a branch test drives `BranchServer` and the branch services directly. See
[Branch collaboration](/concepts/branches/) for why the branch surface
ships unserved.

The socket pair's queues hold 16 frames each. A test that writes more than
that without a reader blocks, which is a bounded transport behaving correctly
rather than a fixture defect.

## Next steps

- [Troubleshooting](/troubleshooting/): every failure code these faults
  produce, and what each one means.
- [Replay then follow](/concepts/replay-then-follow/): why the client
  retries a transport failure and propagates everything else.
