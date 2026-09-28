/**
 * The multiplayer invariants, end to end over the real server and client: two
 * independently instantiated clients on one branch converge, and a reconnect
 * resumes from the canonical cursor without gaps or replayed side effects.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Layer, Redacted, Stream } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as BranchCommands from "../src/BranchCommands.ts"
import * as BranchProjection from "../src/BranchProjection.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncClient from "../src/SyncClient.ts"
import type * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"

const branchId = "live-branch" as BranchProtocol.BranchId
const runId = BranchProtocol.branchRunId(branchId)
const scope = { _tag: "Run", runId } as const
const alice = "alice" as BranchProtocol.ParticipantId
const bob = "bob" as BranchProtocol.ParticipantId

const layer = Layer.mergeAll(
  TestJournal.layer(),
  BranchShare.layerHmac({
    activeKid: "primary",
    keys: [{ kid: "primary", secret: Redacted.make("convergence-secret-0123456789abc") }]
  }),
  RunCatalog.layerStatic([runId])
)

const run = <A, E>(
  effect: Effect.Effect<A, E, Journal.Journal | BranchShare.BranchShare | RunCatalog.RunCatalog | Scope.Scope>
) => effect.pipe(Effect.scoped, Effect.provide(layer), Effect.provide(TestClock.layer()))

/**
 * One browser client: its own cursor state over a shared server, which is what
 * makes "two clients converge" a claim about replication rather than about two
 * views of one in-process object.
 */
const client = (server: SyncServer.Service) =>
  Effect.runSync(SyncClient.make({
    client: {
      "Sync.Read": server.read,
      "Sync.Subscribe": server.subscribe
    } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
  }))

const collect = (
  sync: SyncClient.Service,
  count: number,
  capability: BranchProtocol.ShareCapability
) => Stream.runCollect(Stream.take(sync.subscribe({ scope, cursors: [], capability }), count))

describe("branch convergence", () => {
  it.effect("converges two independently instantiated clients on one ordered projection", () =>
    Effect.gen(function*() {
      const [left, right, seqs] = yield* run(
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          const commands = yield* BranchCommands.makeLive
          const capability = yield* Effect.flatMap(
            BranchShare.BranchShare,
            (share) => share.mint({ branchId, capabilityId: "cap", access: "write", ttlMs: 600_000 })
          )
          const say = (participantId: BranchProtocol.ParticipantId, id: string, text: string) =>
            Effect.flatMap(
              BranchCommands.submission({
                branchId,
                commandId: id as BranchProtocol.CommandId,
                participantId,
                name: BranchProtocol.SayCommand,
                args: text
              }),
              (submission) => commands.submit({ capability, submission })
            )
          yield* say(alice, "c1", "opening the branch")
          yield* say(bob, "c2", "joined from another tab")
          yield* say(alice, "c3", "renaming next")
          yield* commands.submit({
            capability,
            submission: yield* BranchCommands.submission({
              branchId,
              commandId: "c4" as BranchProtocol.CommandId,
              participantId: bob,
              name: "branch.rename",
              args: "Shared branch",
              target: "title"
            })
          })

          const entriesLeft = yield* collect(client(server), 4, capability)
          const entriesRight = yield* collect(client(server), 4, capability)
          return [
            BranchProjection.project(branchId, entriesLeft),
            BranchProjection.project(branchId, entriesRight),
            Array.from(entriesLeft, (entry) => entry.seq)
          ] as const
        })
      )

      expect(left).toEqual(right)
      expect(left.messages.map((message) => message.text)).toEqual([
        "opening the branch",
        "joined from another tab",
        "renaming next"
      ])
      expect(left.fields).toEqual([{
        target: "title",
        value: "Shared branch",
        seq: left.seq,
        participantId: bob,
        capabilityId: "cap"
      }])
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    }))

  it.effect("resumes a reconnect from the canonical cursor with no gap and no replay", () =>
    Effect.gen(function*() {
      const [beforeDrop, afterReconnect, resumedSeqs, cursors] = yield* run(
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          const commands = yield* BranchCommands.makeLive
          const capability = yield* Effect.flatMap(
            BranchShare.BranchShare,
            (share) => share.mint({ branchId, capabilityId: "cap", access: "write", ttlMs: 600_000 })
          )
          const say = (id: string, text: string) =>
            Effect.flatMap(
              BranchCommands.submission({
                branchId,
                commandId: id as BranchProtocol.CommandId,
                participantId: alice,
                name: BranchProtocol.SayCommand,
                args: text
              }),
              (submission) => commands.submit({ capability, submission })
            )
          yield* say("c1", "first")
          yield* say("c2", "second")

          const sync = client(server)
          const firstPass = yield* collect(sync, 2, capability)
          const partial = BranchProjection.project(branchId, firstPass)

          // The connection drops here; the branch keeps moving without us.
          yield* say("c3", "sent while disconnected")
          const resumed = yield* collect(sync, 1, capability)
          return [
            partial,
            Array.from(resumed).reduce(BranchProjection.apply, partial),
            Array.from(resumed, (entry) => entry.seq),
            (yield* sync.progress).delivered
          ] as const
        })
      )

      expect(beforeDrop.messages.map((message) => message.text)).toEqual(["first", "second"])
      expect(afterReconnect.messages.map((message) => message.text)).toEqual([
        "first",
        "second",
        "sent while disconnected"
      ])
      expect(resumedSeqs).toHaveLength(1)
      expect(cursors).toEqual([{ generation: 0, runId, afterSeq: afterReconnect.seq }])
    }))

  it.effect("holds a duplicate submission to one applied command across both clients", () =>
    Effect.gen(function*() {
      const [projections, entryCount] = yield* run(
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          const commands = yield* BranchCommands.makeLive
          const capability = yield* Effect.flatMap(
            BranchShare.BranchShare,
            (share) => share.mint({ branchId, capabilityId: "cap", access: "write", ttlMs: 600_000 })
          )
          const request = {
            capability,
            submission: yield* BranchCommands.submission({
              branchId,
              commandId: "optimistic" as BranchProtocol.CommandId,
              participantId: alice,
              name: BranchProtocol.SayCommand,
              args: "sent once, retried twice"
            })
          }
          yield* commands.submit(request)
          yield* commands.submit(request)
          yield* commands.submit(request)
          const journal = yield* Journal.Journal
          const page = yield* journal.entries({ runId, limit: 10 })
          return [
            [
              BranchProjection.project(branchId, yield* collect(client(server), 1, capability)),
              BranchProjection.project(branchId, yield* collect(client(server), 1, capability))
            ],
            page.entries.length
          ] as const
        })
      )

      expect(entryCount).toBe(1)
      expect(projections[0]).toEqual(projections[1])
      expect(projections[0]?.messages).toHaveLength(1)
    }))

  // The projection folds a late lower-sequence edit into canonical order
  // instead of dropping it, so both delivery orders reach the same document.
  it.effect("converges two writers on one target under duplicate and out-of-order client delivery", () =>
    Effect.gen(function*() {
      const [left, right] = yield* run(
        Effect.gen(function*() {
          const commands = yield* BranchCommands.makeLive
          const journal = yield* Journal.Journal
          const capability = yield* Effect.flatMap(
            BranchShare.BranchShare,
            (share) => share.mint({ branchId, capabilityId: "field-cap", access: "write", ttlMs: 600_000 })
          )
          yield* commands.submit({
            capability,
            submission: yield* BranchCommands.submission({
              branchId,
              commandId: "alice-title" as BranchProtocol.CommandId,
              participantId: alice,
              name: "branch.rename",
              args: "Alice title",
              target: "title"
            })
          })
          yield* commands.submit({
            capability,
            submission: yield* BranchCommands.submission({
              branchId,
              commandId: "bob-title" as BranchProtocol.CommandId,
              participantId: bob,
              name: "branch.rename",
              args: "Bob title",
              target: "title"
            })
          })
          const page = yield* journal.entries({ runId, limit: 10 })
          const first = page.entries[0]
          const second = page.entries[1]
          if (first === undefined || second === undefined) {
            return yield* Effect.die(new Error("expected both canonical edits"))
          }
          // The projection is the unit under test, and it is asked the
          // question directly: the same entries in two different arrival
          // orders, with a duplicate in each, must fold to one document. The
          // client is deliberately NOT the delivery mechanism here — it
          // refuses a page that repeats or reorders a sequence as a protocol
          // violation, which is a different guarantee, covered by its own
          // suite.
          return [
            BranchProjection.project(branchId, [first, first, second]),
            BranchProjection.project(branchId, [second, first, second])
          ] as const
        })
      )

      expect(left).toEqual(right)
      expect(left.commands).toHaveLength(2)
      expect(right.commands).toHaveLength(2)
      expect(left.fields).toEqual([{
        target: "title",
        value: "Bob title",
        seq: left.seq,
        participantId: bob,
        capabilityId: "field-cap"
      }])
    }))
})
