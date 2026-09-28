import { expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Deferred, Effect, Fiber, Layer, Redacted, Stream } from "effect"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import type * as Protocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"

for (const live of [false, true]) {
  it.effect(`binds ${live ? "subscribe" : "read"} scope and cursors before asynchronous authorization`, () =>
    Effect.gen(function*() {
      const branchId = "authorized-scope" as BranchProtocol.BranchId
      const runId = BranchProtocol.branchRunId(branchId)
      const share = yield* BranchShare.makeHmac({
        activeKid: "primary",
        keys: [{ kid: "primary", secret: Redacted.make("authorization-race-0123456789abc") }]
      })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const capability = yield* share.mint({ branchId, capabilityId: "reader", access: "read", ttlMs: 60_000 })
      const readRuns: Array<string> = []
      const entry = (id: JournalEvent.RunId) =>
        new JournalEvent.Entry({
          runId: id,
          seq: 0 as JournalEvent.Seq,
          eventId: "e",
          sourceId: "s" as JournalEvent.SourceId,
          sourceSeq: 0 as JournalEvent.SourceSeq,
          emittedAtMs: 0,
          eventType: "public",
          payload: "authorized bytes",
          meta: null
        })
      const server = yield* SyncServer.makeLive.pipe(Effect.provide(Layer.mergeAll(
        Journal.layerNoop({
          entries: ({ runId }) =>
            Effect.sync(() => {
              readRuns.push(runId)
              return { entries: [entry(runId)], hasMore: false }
            }),
          stream: ({ runId }) =>
            Stream.suspend(() => {
              readRuns.push(runId)
              return Stream.succeed(entry(runId))
            })
        }),
        RunCatalog.layerStatic([runId]),
        Layer.succeed(BranchShare.BranchShare, {
          ...share,
          verify: (capability, request) =>
            Deferred.succeed(entered, undefined)
              .pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(share.verify(capability, request)))
        })
      )))
      const scope = { _tag: "Run", runId } as const
      const cursors: Array<Protocol.RunCursor> = []
      const running = yield* (live ?
        server.subscribe({ protocolVersion: 1, scope, cursors, capability, credit: 1 }).pipe(Stream.runCollect)
        : server.read({ protocolVersion: 1, scope, cursors, capability, limit: 1 })).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      Object.assign(scope, { runId: "private-engine-run" })
      cursors.push({ generation: 0, runId, afterSeq: 100 as JournalEvent.Seq })
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      expect(readRuns).toEqual([runId])
    }))
}
