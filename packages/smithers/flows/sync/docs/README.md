---
title: "@smthrs/sync"
description: "Read-only replication of a Smithers journal: a wire protocol, a server that pages and streams entries, and a browser-safe client that replays a run's history and then follows it live."
---

`@smthrs/sync` copies the history of a run to readers that do not own it. It
carries three things: a wire protocol, a server that serves that protocol over
[Effect](https://effect.website) RPC, and a browser-safe client that replays a
run's durable history and then follows it live through one stream.

The history it replicates is a [`@smthrs/journal`](/api/journal) run. The read
path, `SyncRpcs` served by `SyncServer` and followed by `SyncClient`, never
writes to a journal, so a follower cannot corrupt what it reads.
`BranchCommands` is the separate write surface: it appends admitted branch
commands to a branch's journal run after verifying a write-scoped
`BranchShare` capability.

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## What it solves

A long-running job records what it did in a journal, on the machine that ran
it. Everyone else who cares about that job is somewhere else: a dashboard in a
browser, a terminal tailing a build another process started, a second engine
reconciling its own view. Each of them needs the same entries, in the same
order, without reaching into the writer's database.

Writing that by hand means solving the same problems every time, and getting
any one of them wrong loses history quietly. This package solves them once:

- **Catch up and then follow, through one call.** `subscribe` pages durable
  history until the server reports it reached the tail, then switches to live
  frames. The consumer sees one stream and never sees the switch.
- **Resume where you stopped.** A cursor is per run and exclusive, so a
  follower that persists its cursors hands them back after a restart and reads
  forward from there.
- **Acknowledge what you applied, not what you received.** By default a cursor
  names what was delivered. Supply `apply` and the cursor advances only after
  your own write succeeds, so a consumer that fails halfway re-receives the
  entry instead of skipping it.
- **Hold open a bound, not a workspace.** Every in-flight surface has a
  configured ceiling: page size, frame bytes, subscription credit, concurrent
  journal reads. What one follower holds open is a function of those numbers
  rather than of how far behind it has fallen. Its per-run positions and its
  periodic catalog-wide round still scale with the runs it covers; a local
  append wakes a read of that run alone.
- **Read nothing until you are authorized.** The default principal is
  anonymous and reads nothing. A connection becomes a reader by presenting a
  signed, expiring capability, and an open subscription ends when that
  capability expires.
- **Distrust the server.** The client refuses a page or frame that carries
  another run's entry, repeats or reorders a sequence, or serves an entry at or
  below the cursor it asked from. It refuses before any cursor moves, so a
  faulty server or a rewriting proxy costs an error rather than a hole.

## Follow a run

A follower composes the client over a transport and subscribes. This program
prints every entry of one run, starting with the history that already exists:

```ts
import type { JournalEvent } from "@smthrs/journal"
import * as SyncClient from "@smthrs/sync/SyncClient"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"

const runId = "build-42" as JournalEvent.RunId

export const follow = Effect.gen(function*() {
  const sync = yield* SyncClient.SyncClient
  yield* sync.subscribe({ scope: { _tag: "Run", runId }, cursors: [] }).pipe(
    Stream.runForEach((entry) => Effect.logInfo(`${entry.seq} ${entry.eventType}`))
  )
})

export const clientLayer = SyncClient.layer.pipe(
  Layer.provide(RpcClient.layerProtocolSocket()),
  Layer.provide(RpcSerialization.layerJson)
)
```

The socket that protocol runs over comes from your platform: a WebSocket in a
browser, `@effect/platform-node`'s socket layer in Node. Pass
`{ _tag: "Workspace" }` instead of a run scope to follow every run the server
lists and your credential covers.

The serving side is `SyncServer` over a journal and a run catalog.
[`@smthrs/gateway`](/api/gateway) already mounts it on `POST /sync` and
`/sync/ws`, so a follower against a Smithers gateway writes only the code
above. [Serve the read path](./guides/serve-the-read-path.md) builds it into a
host of your own.

To watch both halves work with no network and no database, run the
[quickstart](./quickstart.md): it stands the real server and the real client up
over an in-memory socket pair and follows an entry that commits while you are
watching.

## Branch collaboration

The package also carries a branch surface: several people editing one shared
live document, whose entire durable state is one journal run. Reusing a run
means multiplayer inherits the canonical sequence, the cursors, the gap
detection, and the resumable follow rather than introducing a second source of
truth.

Branch collaboration ships unserved at 1.0.0-rc.0. The gateway mounts the read
path and nothing mounts the branch procedures, so treat those modules as a
library surface waiting for a host. [Branch collaboration](./concepts/branches.md)
describes what they guarantee.

## Where this sits

`@smthrs/sync` is one package of the Smithers durable flow engine, and it owns
exactly the read path out of that engine. [`@smthrs/flows`](/api/flows) is the
engine's barrel: it re-exports this package as a namespace next to the journal,
the stores, and the Node runtime that wires them over one SQLite file, so
`import { Sync } from "@smthrs/flows"` reaches the same code as
`import * as Sync from "@smthrs/sync"`. Depend on the barrel when you want a
working engine in one dependency. Depend on this package when replication is
the part you need, which is what a browser wants: the root here is browser
safe, and the barrel's Node runtime has no place in a bundle.

The two packages either side of it are worth knowing.
[`@smthrs/journal`](/api/journal) writes the entries this one replicates and
owns compaction, which is the one refusal a follower has to recover from.
[`@smthrs/gateway`](/api/gateway) is the host that puts the read path on a
port.

Above the whole engine sits the
[`smithers` command-line interface](/api/cli), which runs flows out of a
project directory without your composing any of this by hand.

## Next steps

- [Installation](./installation.md): the import forms, and what a follower and
  a server each add on top of this package.
- [Quickstart](./quickstart.md): a real server and a real client following one
  run end to end, with no network.
- [Scopes and cursors](./concepts/scopes-and-cursors.md): what a request covers,
  what a cursor claims, and why journal sequences have holes.
- [Replay then follow](./concepts/replay-then-follow.md): the two phases of a
  subscription and the bounds on each.
- [Authorization](./concepts/authorization.md): the two fail-closed boundaries
  and why a subscription carries its own expiry.
- [Follow a run](./guides/follow-a-run.md): the follower above, with cursors
  you persist and the failures that reach you.
- [Test a follower](./guides/test-a-follower.md): drop, stall, and corrupt
  frames against the production client.
- [Wire protocol](./protocol.md): the normative message shapes, for a client in
  another language.
- [API reference](./api.md): every public export, its bounds, and its defaults.
- [Troubleshooting](./troubleshooting.md): every error code, the symptom it
  produces, and the change that fixes it.
