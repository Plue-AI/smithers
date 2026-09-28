import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Deferred, Effect, Fiber, Layer, Redacted, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as BranchCommands from "../src/BranchCommands.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncClient from "../src/SyncClient.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestSocket from "../src/test/TestSocket.ts"
import * as TestSync from "../src/test/TestSync.ts"

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const base = Layer.mergeAll(
  TestJournal.layer(),
  BranchShare.layerHmac({
    activeKid: "primary",
    keys: [{ kid: "primary", secret: Redacted.make("boundary-secret-0123456789abcdef") }]
  })
)

// JSON round trips exercise the encoded protocol, rather than passing service
// instances directly to the client. The outer envelope is measured separately:
// maxFrameBytes deliberately limits entries, not transport/RPC overhead.
const wireRead = Schema.decodeUnknownSync(SyncProtocol.ReadResponse)
const wireFrame = Schema.decodeUnknownSync(SyncProtocol.Frame)

describe("command admission through durable synchronization", () => {
  for (const maxCommandBytes of [4096, BranchCommands.defaultMaxCommandBytes]) {
    for (const prefix of ["", "café😀\\\"\n"]) {
      for (const offset of [-1, 0, 1]) {
        it.effect(`consumes ${maxCommandBytes}${offset >= 0 ? "+" : ""}${offset} command bytes (${JSON.stringify(prefix)})`, () =>
          Effect.gen(function*() {
            const branchId = `${prefix === "" ? "short" : "branch-é".repeat(30)}` as BranchProtocol.BranchId
            const runId = BranchProtocol.branchRunId(branchId)
            const commandId = `${prefix === "" ? "command" : "command-😀".repeat(30)}` as BranchProtocol.CommandId
            const share = yield* BranchShare.BranchShare
            const journal = yield* Journal.Journal
            const commands = yield* BranchCommands.makeLiveWith({ maxCommandBytes })
            const server = yield* SyncServer.makeLive.pipe(Effect.provide(RunCatalog.layerStatic([runId])))
            const capability = yield* share.mint({ branchId, capabilityId: "test", access: "write", ttlMs: 60_000 })
            const fields = {
              branchId,
              commandId,
              participantId: "alice" as BranchProtocol.ParticipantId,
              name: BranchProtocol.SayCommand
            }
            const blank = yield* BranchCommands.submission({ ...fields, args: prefix })
            const submission = yield* BranchCommands.submission({
              ...fields,
              args: prefix + "x".repeat(maxCommandBytes + offset - bytes(blank))
            })
            expect(bytes(submission)).toBe(maxCommandBytes + offset)
            const request = { protocolVersion: 1, scope: { _tag: "Run" as const, runId }, cursors: [], capability }
            if (offset > 0) {
              expect(yield* Effect.flip(commands.submit({ capability, submission }))).toMatchObject({
                code: "frame_too_large"
              })
              expect((yield* journal.entries({ runId, limit: 1 })).entries).toEqual([])
              expect(yield* server.read({ ...request, limit: 1 })).toMatchObject({ entries: [], cursors: [] })
              return
            }
            const receipt = yield* commands.submit({ capability, submission })
            expect(receipt.status).toBe("admitted")
            const stored = (yield* journal.entries({ runId, limit: 1 })).entries
            expect(stored).toHaveLength(1)
            expect(stored[0]?.payload).toEqual({ ...submission, capabilityId: "test" })
            const read = yield* server.read({ ...request, limit: 1 })
            expect(wireRead(JSON.parse(JSON.stringify(read))).entries).toEqual(stored)
            const live = yield* server.subscribe({ ...request, credit: 1 }).pipe(
              Stream.filter((frame) => frame._tag === "Entries"),
              Stream.take(1),
              Stream.runCollect
            )
            expect(live).toHaveLength(1)
            expect(wireFrame(JSON.parse(JSON.stringify(live[0])))).toEqual(live[0])
            expect(bytes(read)).toBeLessThan(SyncProtocol.defaultMaxFrameBytes)
            expect(bytes(live[0])).toBeLessThan(SyncProtocol.defaultMaxFrameBytes)
            for (const bootstrap of [true, false]) {
              const client = yield* SyncClient.make({
                client: {
                  "Sync.Read": () =>
                    Effect.succeed(
                      bootstrap ? wireRead(JSON.parse(JSON.stringify(read))) : { entries: [], cursors: [], done: true }
                    ),
                  "Sync.Subscribe": () =>
                    Stream.fromIterable(live.map((frame) => wireFrame(JSON.parse(JSON.stringify(frame)))))
                } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
              })
              expect(yield* client.subscribe(request).pipe(Stream.take(1), Stream.runCollect)).toEqual(stored)
              expect((yield* client.progress).delivered).toEqual([{ generation: 0, runId, afterSeq: receipt.seq }])
            }
            // A fresh admission service recovers the receipt from durable data.
            const reopened = yield* BranchCommands.makeLiveWith({ maxCommandBytes })
            expect(yield* reopened.submit({ capability, submission })).toMatchObject({
              status: "duplicate",
              seq: receipt.seq
            })
          }).pipe(
            Effect.provide(base),
            Effect.provide(SyncPrincipal.layerWorkspace("boundaries")),
            Effect.provide(TestClock.layer())
          ))
      }
    }
  }

  it.effect("refuses an otherwise valid command whose durable envelope exceeds the configured frame budget", () =>
    Effect.gen(function*() {
      const branchId = "small-frame" as BranchProtocol.BranchId
      const runId = BranchProtocol.branchRunId(branchId)
      const share = yield* BranchShare.BranchShare
      const journal = yield* Journal.Journal
      const submission = yield* BranchCommands.submission({
        branchId,
        commandId: "command" as BranchProtocol.CommandId,
        participantId: "alice" as BranchProtocol.ParticipantId,
        name: BranchProtocol.SayCommand,
        args: "x".repeat(1024)
      })
      const capability = yield* share.mint({ branchId, capabilityId: "test", access: "write", ttlMs: 60_000 })
      const input = {
        runId,
        sourceId: BranchProtocol.commandSourceId(submission.commandId),
        sourceSeq: BranchProtocol.commandSourceSeq,
        eventType: BranchProtocol.CommandEvent,
        payload: { ...submission, capabilityId: "test" },
        meta: null
      }
      const reserved = bytes({
        ...input,
        seq: Number.MAX_SAFE_INTEGER - 1,
        eventId: JournalEvent.makeEventId(runId, input.sourceId, input.sourceSeq),
        emittedAtMs: Number.MAX_VALUE
      })
      const tooSmall = yield* BranchCommands.makeLiveWith({ maxFrameBytes: reserved - 1 })
      expect(yield* Effect.flip(tooSmall.submit({ capability, submission }))).toMatchObject({ code: "frame_too_large" })
      expect((yield* journal.entries({ runId, limit: 1 })).entries).toEqual([])
      const exact = yield* BranchCommands.makeLiveWith({ maxFrameBytes: reserved })
      expect(yield* exact.submit({ capability, submission })).toMatchObject({ status: "admitted" })
      const server = yield* SyncServer.makeLiveWith({ maxFrameBytes: reserved }).pipe(
        Effect.provide(RunCatalog.layerStatic([runId]))
      )
      expect(
        (yield* server.read({ protocolVersion: 1, scope: { _tag: "Run", runId }, capability, cursors: [], limit: 1 }))
          .entries
      )
        .toHaveLength(1)
    }).pipe(
      Effect.provide(base),
      Effect.provide(SyncPrincipal.layerWorkspace("boundaries")),
      Effect.provide(TestClock.layer())
    ))

  it.live("synchronizes maximum commands through encoded RPC bootstrap and live socket frames", () =>
    Effect.gen(function*() {
      const branchId = "rpc-boundary" as BranchProtocol.BranchId
      const runId = BranchProtocol.branchRunId(branchId)
      const share = yield* BranchShare.BranchShare
      const commands = yield* BranchCommands.makeLive
      const capability = yield* share.mint({ branchId, capabilityId: "rpc", access: "write", ttlMs: 60_000 })
      const server = yield* SyncServer.makeLive.pipe(Effect.provide(RunCatalog.layerStatic([runId])))
      const pair = yield* TestSocket.makePair()
      let largestWireFrame = 0
      pair.faults.installFilter((frame) => {
        largestWireFrame = Math.max(largestWireFrame, frame.byteLength)
        return true
      })
      const client = yield* TestSync.connect(pair).pipe(
        Effect.provideService(SyncServer.SyncServer, server),
        Effect.provide(TestSync.layerTrustAllAsOwner)
      )
      const submit = (id: string) =>
        Effect.gen(function*() {
          const fields = {
            branchId,
            commandId: id as BranchProtocol.CommandId,
            participantId: "alice" as BranchProtocol.ParticipantId,
            name: BranchProtocol.SayCommand
          }
          const empty = yield* BranchCommands.submission(fields)
          const submission = yield* BranchCommands.submission({
            ...fields,
            args: "x".repeat(BranchCommands.defaultMaxCommandBytes - bytes(empty))
          })
          expect(bytes(submission)).toBe(BranchCommands.defaultMaxCommandBytes)
          return yield* commands.submit({ capability, submission })
        })
      yield* submit("first")
      const bootstrapped = yield* Deferred.make<void>()
      const fiber = yield* client.subscribe({ scope: { _tag: "Run", runId }, cursors: [], capability }).pipe(
        Stream.tap((entry) => entry.seq === 0 ? Deferred.succeed(bootstrapped, undefined) : Effect.void),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Deferred.await(bootstrapped)
      yield* submit("second")
      const received = yield* Fiber.join(fiber)
      expect(received.map((entry) => (entry.payload as BranchProtocol.CommandSubmission).commandId)).toEqual([
        "first",
        "second"
      ])
      // The payload is the submission plus the verified capability id stamped on it.
      const stamp = bytes({ capabilityId: "rpc" }) - bytes({}) + 1
      expect(received.every((entry) => bytes(entry.payload) === BranchCommands.defaultMaxCommandBytes + stamp)).toBe(
        true
      )
      expect((yield* client.progress).delivered).toEqual([{ generation: 0, runId, afterSeq: 1 }])
      // This measures actual RPC envelopes traversing the socket pair, above
      // the journal-entry-only budget. The retained 1 MiB command maximum fits.
      expect(largestWireFrame).toBeGreaterThan(BranchCommands.defaultMaxCommandBytes)
      expect(largestWireFrame).toBeLessThan(SyncProtocol.defaultMaxFrameBytes)
    }).pipe(Effect.provide(base), Effect.provide(SyncPrincipal.layerWorkspace("boundaries")), Effect.scoped))

  it.effect("rejects an invalid configured admission frame budget", () =>
    Effect.gen(function*() {
      expect(yield* Effect.flip(BranchCommands.makeLiveWith({ maxFrameBytes: Number.NaN }))).toMatchObject({
        code: "invalid_request"
      })
    }).pipe(Effect.provide(base)))
})
