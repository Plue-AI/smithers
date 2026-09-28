import { expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Effect, Layer, Stream } from "effect"
import * as RpcClientError from "effect/unstable/rpc/RpcClientError"
import * as SyncClient from "../src/SyncClient.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestSocket from "../src/test/TestSocket.ts"
import * as TestSync from "../src/test/TestSync.ts"

it.effect("treats RPC decode defects as terminal protocol failures instead of retryable disconnects", () =>
  Effect.gen(function*() {
    let calls = 0
    const failure = new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "bad peer",
        cause: new Error("private-envelope")
      })
    })
    const client = yield* SyncClient.make({
      client: {
        "Sync.Read": () => Effect.succeed({ entries: [], cursors: [], done: true }),
        "Sync.Subscribe": () => {
          calls++
          return Stream.fail(failure)
        }
      } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
    })
    const refused = yield* Effect.flip(
      client.subscribe({ scope: { _tag: "Workspace" }, cursors: [] }).pipe(Stream.runDrain)
    )
    expect(refused).toMatchObject({ code: "protocol_violation", cause: expect.any(String) })
    expect(JSON.stringify(refused)).not.toContain("private-envelope")
    expect(calls).toBe(1)
    expect((yield* client.progress).applied).toEqual([])
  }))

for (const live of [false, true]) {
  it.live(`rejects a schema-malformed JSON RPC ${live ? "live" : "bootstrap"} response without partial application`, () =>
    Effect.gen(function*() {
      const runId = "wire-admission" as JournalEvent.RunId
      const entries = [0, 1].map((seq) =>
        new JournalEvent.Entry({
          runId,
          seq: seq as JournalEvent.Seq,
          eventId: `event-${seq}`,
          sourceId: "source" as JournalEvent.SourceId,
          sourceSeq: seq as JournalEvent.SourceSeq,
          emittedAtMs: 0,
          eventType: "event",
          payload: seq,
          meta: null
        })
      )
      const server = SyncServer.makeNoop({
        read: () => Effect.succeed({ entries: live ? [] : entries, cursors: [], done: true }),
        subscribe: () =>
          Stream.succeed({
            generation: 0,
            _tag: "Entries",
            runId,
            fromSeq: 0 as JournalEvent.Seq,
            toSeq: 1 as JournalEvent.Seq,
            entries
          })
      })
      const pair = yield* TestSocket.makePair()
      let corrupted = 0
      pair.faults.installFilter((bytes) => {
        // Replace exactly the serialized envelope field; RPC framing stays valid.
        const text = new TextDecoder().decode(bytes)
        if (!text.includes("\"sourceSeq\":1")) return true
        corrupted++
        return new TextEncoder().encode(text.replace("\"sourceSeq\":1", "\"sourceSeq\":-1"))
      })
      const client = yield* TestSync.connect(pair).pipe(Effect.provideService(SyncServer.SyncServer, server))
      let applied = 0
      const failure = yield* Effect.flip(
        client.subscribe({
          scope: { _tag: "Run", runId },
          cursors: [],
          apply: () =>
            Effect.sync(() => {
              applied++
            })
        }).pipe(Stream.runDrain)
      )
      expect(failure).toMatchObject({ code: "decode_failed", cause: "SchemaError" })
      expect(corrupted).toBe(1)
      expect(applied).toBe(0)
      expect((yield* client.progress).delivered).toEqual([])
    }).pipe(Effect.provide(Layer.mergeAll(TestSync.layerTrustAllAsOwner)), Effect.scoped))
}

it.live("refuses a malformed snapshot on the actual JSON wire without advancing progress", () =>
  Effect.gen(function*() {
    const identity = {
      protocolVersion: 1,
      runId: "snapshot-wire" as JournalEvent.RunId,
      lineageId: "one",
      projection: "count",
      projectionVersion: 1
    } as const
    const server = SyncServer.makeNoop({
      snapshot: () => Effect.succeed({ ...identity, seq: 0 as JournalEvent.Seq, state: { count: 1 } })
    })
    const pair = yield* TestSocket.makePair()
    let corrupted = 0
    pair.faults.installFilter((bytes) => {
      const text = new TextDecoder().decode(bytes)
      if (!text.includes("\"state\":")) return true
      corrupted++
      return new TextEncoder().encode(text.replace("\"seq\":0", "\"seq\":-1"))
    })
    const client = yield* TestSync.connect(pair).pipe(Effect.provideService(SyncServer.SyncServer, server))
    expect(yield* Effect.flip(client.snapshot({ ...identity, atLeastSeq: 0 as JournalEvent.Seq })))
      .toMatchObject({ code: "decode_failed", cause: "SchemaError" })
    expect(corrupted).toBe(1)
    expect((yield* client.progress).delivered).toEqual([])
    expect((yield* client.progress).applied).toEqual([])
  }).pipe(Effect.provide(TestSync.layerTrustAllAsOwner), Effect.scoped))
