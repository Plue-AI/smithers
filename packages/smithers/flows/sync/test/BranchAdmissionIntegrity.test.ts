import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Deferred, Effect, Fiber, Layer, Redacted } from "effect"
import * as BranchCommands from "../src/BranchCommands.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"

const branchId = "authorized-branch" as BranchProtocol.BranchId
describe("branch write admission integrity", () => {
  for (const kind of ["foreign run", "descending", "malformed"] as const) {
    it.effect(`rolls back hydration progress and writes nothing after a ${kind} second page`, () =>
      Effect.gen(function*() {
        const runId = BranchProtocol.branchRunId(branchId)
        const row = (position: number) =>
          new JournalEvent.Entry({
            runId,
            seq: position as JournalEvent.Seq,
            eventId: `event-${position}`,
            sourceId: "source" as JournalEvent.SourceId,
            sourceSeq: position as JournalEvent.SourceSeq,
            emittedAtMs: 0,
            eventType: BranchProtocol.CommandEvent,
            payload: {
              branchId,
              commandId: `c-${position}`,
              participantId: "alice",
              name: "branch.say",
              args: "hello",
              target: ""
            },
            meta: null
          })
        const afters: Array<number | undefined> = []
        let writes = 0
        const commands = yield* BranchCommands.makeLive.pipe(Effect.provideService(
          Journal.Journal,
          Journal.makeNoop({
            entries: ({ after }) =>
              Effect.sync(() => {
                afters.push(after)
                if (after === undefined) return { entries: [row(0)], hasMore: true }
                const invalid = kind === "foreign run"
                  ? { ...row(1), runId: "foreign" }
                  : kind === "descending"
                  ? row(0)
                  : { ...row(1), payload: { commandId: "c-1" } }
                return { entries: [invalid as JournalEvent.Entry], hasMore: false }
              }),
            emitDurableUnfenced: () => {
              writes++
              return Effect.die("unexpected write")
            }
          })
        ))
        const share = yield* BranchShare.BranchShare
        const capability = yield* share.mint({ branchId, capabilityId: "hydrate", access: "write", ttlMs: 60_000 })
        const request = {
          capability,
          submission: yield* BranchCommands.submission({
            branchId,
            commandId: "c-0" as BranchProtocol.CommandId,
            participantId: "alice" as BranchProtocol.ParticipantId,
            name: "branch.say"
          })
        }
        for (let retry = 0; retry < 2; retry++) {
          expect(yield* Effect.flip(commands.submit(request)))
            .toMatchObject({
              code: kind === "malformed" ? "decode_failed" : "protocol_violation",
              cause: expect.any(String)
            })
        }
        expect(afters).toEqual([undefined, 0, undefined, 0])
        expect(writes).toBe(0)
      }).pipe(
        Effect.provide(
          BranchShare.layerHmac({
            activeKid: "primary",
            keys: [{ kid: "primary", secret: Redacted.make("hydrate-test-0123456789abcdefghi") }]
          })
        )
      ))
  }
  it.effect("refuses malformed submissions before authorization or durable writes", () =>
    Effect.gen(function*() {
      let authorized = 0
      const commands = yield* BranchCommands.makeLive.pipe(Effect.provide(Layer.mergeAll(
        Journal.layerNoop(),
        Layer.succeed(
          BranchShare.BranchShare,
          BranchShare.makeNoop({
            verify: () => {
              authorized++
              return Effect.die("unexpected authorization")
            }
          })
        )
      )))
      for (const invalid of [null, {}, { capability: {}, submission: { branchId } }]) {
        expect(yield* Effect.flip(commands.submit(invalid as BranchProtocol.SubmitRequest)))
          .toMatchObject({ code: "invalid_request", cause: expect.any(String) })
      }
      expect(authorized).toBe(0)
    }))

  it.effect("persists the exact submission authorized before an asynchronous signature check", () =>
    Effect.gen(function*() {
      const share = yield* BranchShare.BranchShare
      const journal = yield* Journal.Journal
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const commands = yield* BranchCommands.makeLive.pipe(Effect.provideService(BranchShare.BranchShare, {
        ...share,
        verify: (capability, request) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(share.verify(capability, request))
          )
      }))
      const capability = yield* share.mint({ branchId, capabilityId: "write", access: "write", ttlMs: 60_000 })
      const submission = yield* BranchCommands.submission({
        branchId,
        commandId: "c" as BranchProtocol.CommandId,
        participantId: "alice" as BranchProtocol.ParticipantId,
        name: "branch.say",
        args: "authorized bytes"
      })
      const submitting = yield* commands.submit({ capability, submission }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      Object.assign(submission, { branchId: "foreign", args: "mutated after authorization began" })
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(submitting)).toMatchObject({ status: "admitted", branchId })
      const stored = (yield* journal.entries({ runId: BranchProtocol.branchRunId(branchId), limit: 10 })).entries
      expect(stored.map((entry) => entry.payload)).toEqual([{
        branchId,
        commandId: "c",
        participantId: "alice",
        name: "branch.say",
        args: "authorized bytes",
        target: "",
        capabilityId: "write"
      }])
      expect(
        (yield* journal.entries({ runId: BranchProtocol.branchRunId("foreign" as BranchProtocol.BranchId), limit: 10 }))
          .entries
      ).toEqual([])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestJournal.layer(),
          BranchShare.layerHmac({
            activeKid: "primary",
            keys: [{ kid: "primary", secret: Redacted.make("admission-test-0123456789abcdefg") }]
          })
        )
      )
    ))
})
