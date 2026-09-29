---
title: "Test against a real gateway"
description: "Stand a gateway up over a real SQLite control plane on an ephemeral port, write the events a projection folds, and control the supervision port from a test."
sidebar:
  order: 7
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/gateway/docs/guides/testing.md"
---

Test a gateway client against one real stack: a durable journal, a durable run
store, the SQL control runtime, `ControlLive`, the served projections, the sync
read path, and the assembled HTTP surface bound to an ephemeral loopback port.
Stub nothing below the control plane.

The behaviours worth pinning are an approval projected out of a parked run, a
cancellation's attribution, and a child run's visibility. Those are exactly the
places a mocked control plane agrees with your assertion and disagrees with the
gateway a real workspace serves.

## Compose the stack

The stack reaches below this package's own dependencies. Add the packages
that supply storage, the selected SQLite driver, and the control runtime's ports:

```bash
pnpm add -D \
  @smthrs/database@1.0.0-rc.0 \
  @smthrs/journal@1.0.0-rc.0 \
  @smthrs/notifications@1.0.0-rc.0 \
  @smthrs/registry@1.0.0-rc.0 \
  effect@4.0.0-rc.115 \
  @effect/sql-sqlite-node@4.0.0-rc.115
```

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlLive from "@smthrs/control/ControlLive"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Projections from "@smthrs/gateway/Projections"
import { Migrations, SqlJournal } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Migrations as RunStoreMigrations, RunStore } from "@smthrs/run-store"
import * as RunCatalog from "@smthrs/sync/RunCatalog"
import * as SyncAuth from "@smthrs/sync/SyncAuth"
import * as SyncServer from "@smthrs/sync/SyncServer"
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"
import { Layer } from "effect"

const storage = (filename: string) =>
  Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer).pipe(
    Layer.provideMerge(
      Layer.provideMerge(
        Layer.merge(Migrations.layer, RunStoreMigrations.layer),
        Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
      )
    )
  )

export const stack = (filename: string) =>
  Layer.mergeAll(
    // A short cadence, so a keepalive assertion does not wait 30 seconds.
    Projections.layerWith({ heartbeatMillis: 50 }),
    SyncServer.layer,
    SyncAuth.layer
  ).pipe(
    Layer.provideMerge(Layer.merge(RunCatalog.layerNoop, WorkspaceShare.layerNoop)),
    Layer.provideMerge(ControlLive.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        SqlControlRuntime.layer({}).pipe(Layer.orDie),
        NotificationQueue.layer,
        ControlExecutor.layer(ControlExecutor.makeNoop()),
        Registry.layerNoop()
      )
    ),
    Layer.provideMerge(Layer.merge(storage(filename), NodeCrypto.layer))
  )
```

A worked version of this helper, with the temporary-file lifecycle around it,
is [`GatewayStack.ts`](https://github.com/smithersai/smithers/blob/main/packages/smithers/gateway/test/GatewayStack.ts)
in the package source.

## Bind an ephemeral port and read it back

```ts
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"

const served = NodeGateway.layer(health, { host: "127.0.0.1", port: 0 }).pipe(Layer.provideMerge(stack(filename)))

const baseUrl = Effect.map(HttpServer.HttpServer, (server) => {
  if (server.address._tag !== "InetAddressV4" && server.address._tag !== "InetAddressV6") {
    throw new Error("expected a TCP gateway")
  }
  return `http://127.0.0.1:${server.address.port}`
})
```

Port 0 lets the operating system pick, and the layer retains the concrete
`HttpServer`, so a test reads the address it actually got rather than racing
for a fixed port.

## Give a run something to project

Write events through the journal's durable channel, not its lossy one:

```ts
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Effect } from "effect"

const emit = (runId: string, eventType: string, payload: unknown, sourceSeq: number) =>
  Effect.flatMap(Journal.Journal, (journal) =>
    journal.emitDurableUnfenced(
      new JournalEvent.Input({
        runId: JournalEvent.RunId.make(runId),
        sourceId: JournalEvent.SourceId.make("gateway-test"),
        sourceSeq: JournalEvent.SourceSeq.make(sourceSeq),
        eventType,
        payload: JSON.parse(JSON.stringify(payload))
      })
    ))
```

`emitLossy` returns once the optimistic queue accepts an entry, so a projection
read straight afterwards can legitimately miss it, and a suite built on that
races its own fixture. Give each event a monotonic `sourceSeq`, or two
identical fixture events will not both admit.

## Fold without a stack at all

A test that only cares about a fold does not need any of the above. The folds
are pure functions of a run summary and its events:

```ts
import * as GatewayProjection from "@smthrs/gateway/GatewayProjection"

const rows = GatewayProjection.runTree(run, events)
```

This is the same code the served projection runs, so a fold test and an
end-to-end test cannot disagree about what a row means. Reach for the full
stack when what you are pinning is the _serving_: a status the run row owns, a
cursor, a refusal, or an HTTP status.
