import { describe, expect, it } from "@effect/vitest"
import { Journal } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Exit, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import * as BranchCommands from "../src/BranchCommands.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import { SyncError } from "../src/SyncError.ts"
import { died, refusalOf } from "./refusal.ts"

const branchId = "ambiguous-commit" as BranchProtocol.BranchId
const runId = BranchProtocol.branchRunId(branchId)
const participantId = "alice" as BranchProtocol.ParticipantId

describe("BranchCommands ambiguous commit recovery", () => {
  it.effect("rehydrates a durable append whose response was lost before the ledger update", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const share = yield* BranchShare.BranchShare
          let loseResponse = true
          const responseLosingJournal = Journal.make({
            ...journal,
            emitDurableUnfenced: (input) =>
              journal.emitDurableUnfenced(input).pipe(
                Effect.flatMap((receipt) => {
                  if (!loseResponse) return Effect.succeed(receipt)
                  loseResponse = false
                  return Effect.fail(
                    new Journal.JournalError({
                      code: "journal_closed",
                      message: "connection closed after commit"
                    })
                  )
                })
              )
          })
          const beforeRestart = yield* BranchCommands.makeLive.pipe(
            Effect.provideService(Journal.Journal, responseLosingJournal)
          )
          const capability = yield* share.mint({
            branchId,
            capabilityId: "ambiguous-capability",
            access: "write",
            ttlMs: 60_000
          })
          const request = {
            capability,
            submission: yield* BranchCommands.submission({
              branchId,
              commandId: "ambiguous-command" as BranchProtocol.CommandId,
              participantId,
              name: BranchProtocol.SayCommand,
              args: "persisted before disconnect"
            })
          }

          const ambiguous = yield* Effect.exit(beforeRestart.submit(request))
          // Reconstruct before the first service can record its receipt in the
          // process-local ledger. The durable journal is the only recovery state.
          const afterRestart = yield* BranchCommands.makeLive
          const retry = yield* afterRestart.submit(request)
          const page = yield* journal.entries({ runId, limit: 10 })
          return { ambiguous, page, retry }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              TestJournal.layer(),
              BranchShare.layerHmac({
                activeKid: "primary",
                keys: [{ kid: "primary", secret: Redacted.make("ambiguous-secret-0123456789abcde") }]
              })
            )
          ),
          Effect.provide(TestClock.layer())
        )
      )

      // The lost response reaches the caller as this package's own typed
      // error, not as the journal's error and not as a defect: a writer that
      // must decide whether to retry can only do so from the declared channel.
      const ambiguous = refusalOf(result.ambiguous)
      expect(died(result.ambiguous)).toBe(false)
      expect(SyncError.is(ambiguous)).toBe(true)
      expect(ambiguous?.code).toBe("closed")
      expect(result.retry).toMatchObject({ status: "duplicate", seq: result.page.entries[0]?.seq })
      expect(result.page.entries).toHaveLength(1)
    }))
})
