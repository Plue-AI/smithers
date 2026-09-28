import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Exit, Layer, Redacted, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as BranchCommands from "../src/BranchCommands.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncClient from "../src/SyncClient.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import type * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestEntry from "./fixtures/entry.ts"

const branchId = "payload-limits" as BranchProtocol.BranchId
const branchRunId = BranchProtocol.branchRunId(branchId)
const runId = "payload-limit-run" as JournalEvent.RunId
const twoMiB = "x".repeat(2 * 1024 * 1024)

const failureOf = <A>(exit: Exit.Exit<A, unknown>): unknown =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
    : undefined

const entry = (sequence: number, payload: unknown) =>
  TestEntry.entry(runId, sequence, { eventId: `payload-${sequence}`, payload })

const branchLayers = Layer.mergeAll(
  TestJournal.layer(),
  BranchShare.layerHmac({
    activeKid: "primary",
    keys: [{ kid: "primary", secret: Redacted.make("payload-secret-0123456789abcdefg") }]
  })
)

const submitOutcome = (
  ledger: Layer.Layer<BranchCommands.BranchCommands, SyncError, Journal.Journal | BranchShare.BranchShare>,
  args: string
) =>
  Effect.gen(function*() {
    const commands = yield* BranchCommands.BranchCommands
    const share = yield* BranchShare.BranchShare
    const journal = yield* Journal.Journal
    const capability = yield* share.mint({
      branchId,
      capabilityId: "payload-capability",
      access: "write",
      ttlMs: 60_000
    })
    const exit = yield* Effect.exit(
      commands.submit({
        capability,
        submission: yield* BranchCommands.submission({
          branchId,
          commandId: "oversized-command" as BranchProtocol.CommandId,
          participantId: "alice" as BranchProtocol.ParticipantId,
          name: BranchProtocol.SayCommand,
          args
        })
      })
    )
    return { exit, page: yield* journal.entries({ runId: branchRunId, limit: 10 }) }
  }).pipe(
    Effect.provide(Layer.mergeAll(branchLayers, ledger.pipe(Layer.provide(branchLayers)))),
    Effect.provide(TestClock.layer())
  )

describe("sync payload and frame limits", () => {
  // An oversized CommandSubmission is refused with frame_too_large BEFORE it
  // reaches the journal: nothing is appended, so no follower ever pulls it.
  it.effect("refuses a multi-megabyte command before appending it", () =>
    Effect.gen(function*() {
      const result = yield* submitOutcome(BranchCommands.layer, twoMiB)

      expect(failureOf(result.exit)).toBeInstanceOf(SyncError)
      expect(failureOf(result.exit)).toMatchObject({ code: "frame_too_large" })
      expect(result.page.entries).toEqual([])
    }))

  it.effect("honors a configured command ceiling below the default", () =>
    Effect.gen(function*() {
      const result = yield* submitOutcome(
        BranchCommands.layerWith({ maxCommandBytes: 64 }),
        "a modest command that still overflows a 64-byte ceiling"
      )

      expect(failureOf(result.exit)).toBeInstanceOf(SyncError)
      expect(failureOf(result.exit)).toMatchObject({ code: "frame_too_large" })
      expect(result.page.entries).toEqual([])
    }))

  // The read path refuses to serve one arbitrarily large journal payload:
  // a page that cannot fit the frame ceiling fails instead of shipping.
  it.effect("refuses a page containing one multi-megabyte journal payload", () =>
    Effect.gen(function*() {
      const exit = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          return yield* Effect.exit(
            server.read({ protocolVersion: 1, scope: { _tag: "Run", runId }, cursors: [], limit: 1 })
          )
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: () => Effect.succeed({ entries: [entry(0, twoMiB)], hasMore: false })
              }),
              RunCatalog.layerStatic([runId]),
              SyncPrincipal.layerWorkspace("payload-suite")
            )
          )
        )
      )

      expect(failureOf(exit)).toBeInstanceOf(SyncError)
      expect(failureOf(exit)).toMatchObject({ code: "frame_too_large" })
    }))

  // Entries that individually fit but together outgrow the ceiling are
  // ordinary traffic: branch commands are admitted up to 1 MiB each, so three
  // 800 KB commands compose one. The read truncates the page at the budget and
  // reports `done: false`, so the follower pages again from the cursor it was
  // actually served instead of being wedged on an unretryable refusal.
  it.effect("truncates an aggregate page at the byte budget and serves the rest on the next page", () =>
    Effect.gen(function*() {
      const entries = Array.from(
        { length: 4 },
        (_, sequence) => entry(sequence, "x".repeat(768 * 1024))
      )
      const read = (cursors: SyncProtocol.WorkspaceCursor) =>
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          return yield* server.read({
            protocolVersion: 1,
            scope: { _tag: "Run", runId },
            cursors,
            limit: entries.length
          })
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ after }) =>
                  Effect.succeed({
                    entries: entries.filter((candidate) => after === undefined || candidate.seq > after),
                    hasMore: false
                  })
              }),
              RunCatalog.layerStatic([runId]),
              SyncPrincipal.layerWorkspace("payload-suite")
            )
          )
        )

      const first = yield* read([])
      const second = yield* read(first.cursors)

      expect(first.entries.map((value) => value.seq)).toEqual([0, 1])
      expect(first.cursors).toEqual([{ generation: 0, runId, afterSeq: 1 }])
      expect(first.done).toBe(false)
      expect(second.entries.map((value) => value.seq)).toEqual([2, 3])
      expect(second.done).toBe(true)
    }))

  it.effect("honors a configured read frame ceiling below the default", () =>
    Effect.gen(function*() {
      const exit = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.SyncServer
          return yield* Effect.exit(
            server.read({ protocolVersion: 1, scope: { _tag: "Run", runId }, cursors: [], limit: 1 })
          )
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              SyncServer.layerWith({ maxFrameBytes: 64 }).pipe(
                Layer.provide(
                  Layer.mergeAll(
                    Journal.layerNoop({
                      entries: () => Effect.succeed({ entries: [entry(0, "x".repeat(128))], hasMore: false })
                    }),
                    RunCatalog.layerStatic([runId])
                  )
                )
              ),
              SyncPrincipal.layerWorkspace("payload-suite")
            )
          )
        )
      )

      expect(failureOf(exit)).toBeInstanceOf(SyncError)
      expect(failureOf(exit)).toMatchObject({ code: "frame_too_large" })
    }))

  it.effect("refuses a live subscription frame carrying an oversized journal payload", () =>
    Effect.gen(function*() {
      const exit = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          return yield* Effect.exit(
            Stream.runCollect(
              server.subscribe({ protocolVersion: 1, scope: { _tag: "Run", runId }, cursors: [], credit: 1 })
            )
          )
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({ stream: () => Stream.succeed(entry(0, twoMiB)) }),
              RunCatalog.layerStatic([runId]),
              SyncPrincipal.layerWorkspace("payload-suite")
            )
          )
        )
      )

      expect(failureOf(exit)).toBeInstanceOf(SyncError)
      expect(failureOf(exit)).toMatchObject({ code: "frame_too_large" })
    }))

  it.effect("client refuses a live frame whose encoded entries exceed its frame ceiling", () =>
    Effect.gen(function*() {
      const client = yield* SyncClient.makeWith({
        client: {
          "Sync.Read": () => Effect.succeed({ entries: [], cursors: [], done: true }),
          "Sync.Subscribe": () =>
            Stream.succeed<SyncProtocol.Frame>({
              generation: 0,
              _tag: "Entries",
              runId,
              fromSeq: 0 as JournalEvent.Seq,
              toSeq: 0 as JournalEvent.Seq,
              entries: [entry(0, "x".repeat(512))]
            })
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"],
        maxFrameBytes: 256
      })

      const exit = yield* Effect.exit(
        client.subscribe({ scope: { _tag: "Run", runId }, cursors: [] }).pipe(
          Stream.take(1),
          Stream.runCollect
        )
      )

      expect(failureOf(exit)).toBeInstanceOf(SyncError)
      expect(failureOf(exit)).toMatchObject({ code: "frame_too_large" })
      expect((yield* client.progress).delivered).toEqual([])
    }))

  it.effect("client refuses a bootstrap page whose encoded entries exceed its frame ceiling", () =>
    Effect.gen(function*() {
      const client = yield* SyncClient.makeWith({
        client: {
          "Sync.Read": () =>
            Effect.succeed({
              entries: [entry(0, "x".repeat(512))],
              cursors: [{ generation: 0, runId, afterSeq: 0 as JournalEvent.Seq }],
              done: true
            }),
          "Sync.Subscribe": () => Stream.empty
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"],
        maxFrameBytes: 256
      })

      const exit = yield* Effect.exit(
        client.subscribe({ scope: { _tag: "Run", runId }, cursors: [] }).pipe(
          Stream.take(1),
          Stream.runCollect
        )
      )

      expect(failureOf(exit)).toBeInstanceOf(SyncError)
      expect(failureOf(exit)).toMatchObject({ code: "frame_too_large" })
      expect((yield* client.progress).delivered).toEqual([])
    }))
})
