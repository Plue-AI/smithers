import { describe, expect, it } from "@effect/vitest"
import { Journal } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Deferred, Effect, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import * as BranchCommands from "../src/BranchCommands.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"

const branchId = "multi-writer" as BranchProtocol.BranchId
const runId = BranchProtocol.branchRunId(branchId)
const alice = "alice" as BranchProtocol.ParticipantId
const bob = "bob" as BranchProtocol.ParticipantId
const commandId = "one-intent" as BranchProtocol.CommandId

const runRace = (rightParticipant: BranchProtocol.ParticipantId) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const share = yield* BranchShare.BranchShare
    const bothHydrated = yield* Deferred.make<void>()
    let hydrationReads = 0

    // Capture both empty pages before either independently constructed
    // service may append. This is the cross-server race hidden by one
    // service's process-local semaphore and ledger.
    const alignedJournal = Journal.make({
      ...journal,
      entries: (options) =>
        Effect.gen(function*() {
          const page = yield* journal.entries(options)
          hydrationReads += 1
          if (hydrationReads === 2) yield* Deferred.succeed(bothHydrated, undefined)
          yield* Deferred.await(bothHydrated)
          return page
        })
    })
    const left = yield* BranchCommands.makeLive.pipe(
      Effect.provideService(Journal.Journal, alignedJournal)
    )
    const right = yield* BranchCommands.makeLive.pipe(
      Effect.provideService(Journal.Journal, alignedJournal)
    )
    const capability = yield* share.mint({
      branchId,
      capabilityId: "multi-writer-capability",
      access: "write",
      ttlMs: 60_000
    })
    const request = (participantId: BranchProtocol.ParticipantId) =>
      Effect.map(
        BranchCommands.submission({
          branchId,
          commandId,
          participantId,
          name: BranchProtocol.SayCommand,
          args: "execute exactly once"
        }),
        (submission) => ({ capability, submission })
      )
    const receipts = yield* Effect.all(
      [left.submit(yield* request(alice)), right.submit(yield* request(rightParticipant))],
      { concurrency: "unbounded" }
    )
    const page = yield* journal.entries({ runId, limit: 10 })
    return { page, receipts }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        TestJournal.layer(),
        BranchShare.layerHmac({
          activeKid: "primary",
          keys: [{ kid: "primary", secret: Redacted.make("multi-writer-secret-0123456789ab") }]
        })
      )
    ),
    Effect.provide(TestClock.layer())
  )

describe("BranchCommands across independently constructed writers", () => {
  // Identical submissions collide on the journal's producer identity: the
  // second writer's append deduplicates durably to the first one's sequence.
  it.effect("admits one durable command when both writers use the same participant", () =>
    Effect.gen(function*() {
      const result = yield* runRace(alice)

      expect(result.receipts.map((receipt) => receipt.status).sort()).toEqual(["admitted", "duplicate"])
      expect(new Set(result.receipts.map((receipt) => receipt.seq)).size).toBe(1)
      expect(result.page.entries).toHaveLength(1)
    }))

  // Differing submissions of one commandId conflict on the same identity: the
  // losing writer replays the branch and reports the canonical admission.
  it.effect("admits one durable command when the writers use different participants", () =>
    Effect.gen(function*() {
      const result = yield* runRace(bob)

      expect(result.receipts.map((receipt) => receipt.status).sort()).toEqual(["admitted", "duplicate"])
      expect(new Set(result.receipts.map((receipt) => receipt.seq)).size).toBe(1)
      expect(result.page.entries).toHaveLength(1)
    }))
})
