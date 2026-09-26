import { FlowRuntime } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import * as Budget from "../src/Budget.ts"

const instance = (executionId: string) => ({ executionId }) as FlowRuntime.FlowInstance["Service"]
const failure = new Journal.JournalError({ code: "sink_failed", message: "injected usage write failure" })
const inRun = <A, E, R>(runId: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(FlowRuntime.FlowInstance, instance(runId)))
const run = <A, E>(effect: Effect.Effect<A, E, Journal.Journal>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestJournal.layer()), Effect.scoped))
const records = (journal: Journal.Service, runId: string) =>
  journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 100 }).pipe(
    Effect.map((page) => page.entries.filter((entry) => entry.eventType === Budget.usageEvent))
  )

describe("budget usage durability", () => {
  it("records weighted usage once and recovers the charge without repricing", async () => {
    await run(inRun(
      "weighted",
      Effect.gen(function*() {
        const weights = { "gpt-6-astra": { input: 1, cachedInput: 0.1, output: 4.5 } }
        const budget = yield* Budget.make({ weights })
        const usage = {
          inputTokens: 1000,
          cachedInputTokens: 800,
          outputTokens: 100,
          reasoningTokens: 50,
          totalTokens: 1100
        }
        yield* budget.record("paid", usage, "gpt-6-astra")
        yield* budget.record("paid", usage, "gpt-6-astra")
        expect((yield* budget.usage).tokens).toBe(730)
        const restarted = yield* Budget.make({})
        expect(yield* restarted.usage).toEqual(yield* budget.usage)
        expect(yield* records(yield* Journal.Journal, "weighted")).toHaveLength(1)
        expect(Number.isNaN(Budget.tokensOf({ totalTokens: 100 }, weights["gpt-6-astra"]))).toBe(true)
      })
    ))
  })

  it("keeps paid usage pending when its first recovery fails", async () => {
    await run(inRun(
      "failed-first-recovery",
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const budget = yield* Budget.make({})
        const wrapped: Journal.Service = { ...journal, flush: Effect.fail(failure) }
        expect(
          (yield* budget.record("paid", { totalTokens: 100 }).pipe(
            Effect.provideService(Journal.Journal, wrapped),
            Effect.exit
          ))._tag
        ).toBe("Failure")
        expect((yield* budget.check("new").pipe(Effect.exit))._tag).toBe("Failure")
        expect((yield* budget.check("paid"))._tag).toBe("proceed")
        yield* budget.record("paid", { totalTokens: 100 })
        const fresh = yield* Budget.make({})
        expect(yield* fresh.usage).toEqual(yield* budget.usage)
      })
    ))
  })

  it("refuses initial recovery inside a transaction before flushing or caching speculative state", async () => {
    await run(inRun(
      "initial-transaction",
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const budget = yield* Budget.make({})
        const result = yield* journal.transact(budget.check("first")).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect(JSON.stringify(result)).toContain("outside a journal transaction")
        expect((yield* budget.check("first"))._tag).toBe("proceed")
        yield* budget.record("first", { totalTokens: 100 })
        const fresh = yield* Budget.make({})
        expect(yield* fresh.usage).toEqual(yield* budget.usage)
      })
    ))
  })

  it("keeps long and ill-formed step keys distinct with bounded producer identifiers", async () => {
    await run(inRun(
      "key-identity",
      Effect.gen(function*() {
        const budget = yield* Budget.make({})
        const keys = ["x".repeat(10_000), "\ud800", "\ud801", "\ufffd"]
        for (const key of keys) {
          yield* budget.record(key, { totalTokens: 1 })
          yield* budget.record(key, { totalTokens: 1 })
        }
        const journal = yield* Journal.Journal
        const entries = yield* records(journal, "key-identity")
        expect(entries).toHaveLength(keys.length)
        expect(entries.every((entry) => entry.sourceId.length < 100)).toBe(true)
        const fresh = yield* Budget.make({})
        expect(yield* fresh.usage).toEqual({ tokens: 4, calls: 4, largestCall: 1 })
      })
    ))
  })

  it("cannot clear a later accounting error with an earlier commit callback", async () => {
    await run(inRun(
      "late-conflict",
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const budget = yield* Budget.make({})
        yield* budget.check("paid")
        yield* journal.transact(Effect.gen(function*() {
          yield* budget.record("paid", { totalTokens: 100 })
          expect((yield* budget.record("paid", { totalTokens: 200 }).pipe(Effect.exit))._tag).toBe("Failure")
        }))
        expect((yield* budget.check("next").pipe(Effect.exit))._tag).toBe("Failure")
        yield* budget.record("paid", { totalTokens: 100 })
        const fresh = yield* Budget.make({})
        expect(yield* fresh.usage).toEqual(yield* budget.usage)
      })
    ))
  })

  it("does not evict an account while its first recovery is in flight", async () => {
    await run(Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const budget = yield* Budget.make({}, { maxRuns: 1 })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const wrapped: Journal.Service = {
        ...journal,
        flush: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(journal.flush)
        )
      }
      const first = yield* inRun("recovering", budget.record("paid", { totalTokens: 300 })).pipe(
        Effect.provideService(Journal.Journal, wrapped),
        Effect.forkChild
      )
      yield* Deferred.await(entered)
      const other = yield* inRun("other", budget.check("new")).pipe(Effect.exit)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      expect(other._tag).toBe("Failure")
      expect(yield* budget.usageOf("recovering")).toEqual({ tokens: 300, calls: 1, largestCall: 300 })
      expect((yield* inRun("other", budget.check("new")))._tag).toBe("proceed")
    }))
  })

  it("cannot reset a memory-only run's allowance by evicting it", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 500 } }, { maxRuns: 1 })
      yield* inRun("memory", budget.record("paid", { totalTokens: 400 }))
      expect((yield* inRun("other", budget.check("new")).pipe(Effect.exit))._tag).toBe("Failure")
      expect((yield* inRun("memory", budget.check("new")))._tag).toBe("refuse")
      expect(yield* budget.usageOf("memory")).toEqual({ tokens: 400, calls: 1, largestCall: 400 })
    }))
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "rejects invalid usage %s without poisoning the tally",
    async (spent) => {
      await run(inRun(
        "invalid",
        Effect.gen(function*() {
          const budget = yield* Budget.make({})
          expect((yield* budget.record("paid", { totalTokens: spent }).pipe(Effect.exit))._tag).toBe("Failure")
          expect((yield* budget.check("next").pipe(Effect.exit))._tag).toBe("Failure")
          yield* budget.record("paid", { totalTokens: 100 })
          expect(yield* budget.usage).toEqual({ tokens: 100, calls: 1, largestCall: 100 })
          const fresh = yield* Budget.make({})
          expect(yield* fresh.usage).toEqual(yield* budget.usage)
        })
      ))
    }
  )

  it.each([
    { inputTokens: 600, outputTokens: -600 },
    { totalTokens: 100, inputTokens: -1 },
    { totalTokens: 100, outputTokens: Number.NaN },
    { totalTokens: 100, reasoningTokens: Number.POSITIVE_INFINITY },
    { totalTokens: 100, cachedInputTokens: -1 },
    { totalTokens: 100, cacheWriteTokens: Number.NEGATIVE_INFINITY }
  ])("rejects malformed component counters even when the chosen total looks valid %#", async (usage) => {
    await run(inRun(
      "invalid-components",
      Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 1_000 } })
        expect((yield* budget.record("paid", usage).pipe(Effect.exit))._tag).toBe("Failure")
        expect((yield* budget.check("next").pipe(Effect.exit))._tag).toBe("Failure")
        expect(yield* budget.usage).toEqual({ tokens: 0, calls: 0, largestCall: 0 })
        yield* budget.record("paid", { totalTokens: 600 })
        expect(yield* budget.usage).toEqual({ tokens: 600, calls: 1, largestCall: 600 })
        const fresh = yield* Budget.make({ tokens: { max: 1_000 } })
        expect(yield* fresh.usage).toEqual(yield* budget.usage)
      })
    ))
  })

  it("does not accept changed usage while retrying an uncommitted model step", async () => {
    await run(inRun(
      "changed-usage",
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const budget = yield* Budget.make({})
        yield* budget.check("paid")
        yield* journal.transact(
          budget.record("paid", { totalTokens: 100 }).pipe(
            Effect.andThen(Effect.fail("rollback"))
          )
        ).pipe(Effect.exit)
        expect((yield* budget.record("paid", { totalTokens: 90 }).pipe(Effect.exit))._tag).toBe("Failure")
        expect(yield* records(journal, "changed-usage")).toHaveLength(0)
        yield* budget.record("paid", { totalTokens: 100 })
        const fresh = yield* Budget.make({})
        expect(yield* fresh.usage).toEqual(yield* budget.usage)
      })
    ))
  })

  it("keeps an interrupted write pending and retries it", async () => {
    await run(inRun(
      "interrupted",
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const budget = yield* Budget.make({})
        const entered = yield* Deferred.make<void>()
        const wrapped: Journal.Service = {
          ...journal,
          emitDurableUnfenced: (input) =>
            input.eventType === Budget.usageEvent
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : journal.emitDurableUnfenced(input)
        }
        const fiber = yield* budget.record("paid", { totalTokens: 200 }).pipe(
          Effect.provideService(Journal.Journal, wrapped),
          Effect.forkChild
        )
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        expect((yield* budget.check("next").pipe(Effect.exit))._tag).toBe("Failure")
        yield* budget.record("paid", { totalTokens: 200 })
        expect(yield* records(journal, "interrupted")).toHaveLength(1)
        const fresh = yield* Budget.make({})
        expect(yield* fresh.usage).toEqual(yield* budget.usage)
      })
    ))
  })

  it("retries failed usage, blocks new spend meanwhile, and recovers the same total", async () => {
    await run(Effect.gen(function*() {
      const journal = yield* Journal.Journal
      let writes = 0
      const wrapped: Journal.Service = {
        ...journal,
        emitDurableUnfenced: (input) =>
          input.eventType === Budget.usageEvent
            ? Effect.suspend(() => ++writes === 1 ? Effect.fail(failure) : journal.emitDurableUnfenced(input))
            : journal.emitDurableUnfenced(input)
      }
      yield* inRun(
        "retry",
        Effect.gen(function*() {
          const budget = yield* Budget.make({ tokens: { max: 10_000 } })
          expect((yield* budget.record("paid-step", { totalTokens: 600 }).pipe(Effect.exit))._tag).toBe("Failure")
          expect(yield* budget.usage).toEqual({ tokens: 600, calls: 1, largestCall: 600 })
          expect((yield* budget.check("new-step").pipe(Effect.exit))._tag).toBe("Failure")
          expect((yield* budget.check("paid-step"))._tag).toBe("proceed")
          yield* budget.record("paid-step", { totalTokens: 600 })
          yield* budget.record("paid-step", { totalTokens: 600 })
          expect(writes).toBe(2)
          expect(yield* records(journal, "retry")).toHaveLength(1)
          const fresh = yield* Budget.make({})
          expect(yield* fresh.usage).toEqual(yield* budget.usage)
          expect((yield* budget.check("new-step"))._tag).toBe("proceed")
        }).pipe(Effect.provideService(Journal.Journal, wrapped))
      )
    }))
  })

  it("keeps a rolled-back usage pending until a later transaction really commits", async () => {
    await run(Effect.gen(function*() {
      const journal = yield* Journal.Journal
      yield* inRun(
        "outer-rollback",
        Effect.gen(function*() {
          const budget = yield* Budget.make({})
          yield* budget.check("paid")
          yield* journal.transact(
            budget.record("paid", { totalTokens: 400 }).pipe(
              Effect.andThen(Effect.fail("outer rollback"))
            )
          ).pipe(Effect.exit)
          expect(yield* records(journal, "outer-rollback")).toHaveLength(0)
          expect((yield* budget.check("next").pipe(Effect.exit))._tag).toBe("Failure")
          yield* budget.record("paid", { totalTokens: 400 })
          expect(yield* records(journal, "outer-rollback")).toHaveLength(1)
          const fresh = yield* Budget.make({})
          expect(yield* fresh.usage).toEqual(yield* budget.usage)
        })
      )
    }))
  })

  it("deduplicates a retry when commit succeeded but the caller was interrupted", async () => {
    await run(Effect.gen(function*() {
      const journal = yield* Journal.Journal
      let interruptOnce = true
      const wrapped: Journal.Service = {
        ...journal,
        emitDurableUnfenced: (input) =>
          journal.emitDurableUnfenced(input).pipe(Effect.tap(() => {
            if (input.eventType !== Budget.usageEvent || !interruptOnce) return Effect.void
            interruptOnce = false
            return Effect.interrupt
          }))
      }
      yield* inRun(
        "commit-interrupt",
        Effect.gen(function*() {
          const budget = yield* Budget.make({})
          const fiber = yield* budget.record("paid", { totalTokens: 200 }).pipe(Effect.forkChild)
          expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
          yield* budget.record("paid", { totalTokens: 200 })
          expect(yield* records(journal, "commit-interrupt")).toHaveLength(1)
          const fresh = yield* Budget.make({})
          expect(yield* fresh.usage).toEqual({ tokens: 200, calls: 1, largestCall: 200 })
        }).pipe(Effect.provideService(Journal.Journal, wrapped))
      )
    }))
  })

  it("records concurrent duplicate usage once in live and durable state", async () => {
    await run(inRun(
      "duplicates",
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const budget = yield* Budget.make({})
        yield* Effect.all(Array.from({ length: 8 }, () => budget.record("paid", { totalTokens: 300 })), {
          concurrency: "unbounded"
        })
        expect(yield* records(journal, "duplicates")).toHaveLength(1)
        const fresh = yield* Budget.make({})
        expect(yield* fresh.usage).toEqual(yield* budget.usage)
        expect(yield* budget.usage).toEqual({ tokens: 300, calls: 1, largestCall: 300 })
      })
    ))
  })

  it("does not evict pending spend to admit another run", async () => {
    await run(Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const budget = yield* Budget.make({}, { maxRuns: 1 })
      const wrapped: Journal.Service = {
        ...journal,
        emitDurableUnfenced: (input) =>
          input.eventType === Budget.usageEvent
            ? Effect.fail(failure)
            : journal.emitDurableUnfenced(input)
      }
      yield* inRun("pending", budget.record("paid", { totalTokens: 100 })).pipe(
        Effect.provideService(Journal.Journal, wrapped),
        Effect.exit
      )
      expect((yield* inRun("other", budget.check("new")).pipe(Effect.exit))._tag).toBe("Failure")
      yield* inRun("pending", budget.record("paid", { totalTokens: 100 }))
      expect((yield* inRun("other", budget.check("new")))._tag).toBe("proceed")
      expect(yield* budget.usageOf("pending")).toEqual({ tokens: 100, calls: 1, largestCall: 100 })
    }))
  })

  it("fails closed when its journal cannot observe the outer commit", async () => {
    await run(inRun(
      "unmanaged",
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const budget = yield* Budget.make({})
        const wrapped: Journal.Service = { ...journal, whenCommitted: () => Effect.succeed(false) }
        yield* budget.check("paid")
        expect(
          (yield* budget.record("paid", { totalTokens: 100 }).pipe(
            Effect.provideService(Journal.Journal, wrapped),
            Effect.exit
          ))._tag
        ).toBe("Failure")
        expect((yield* budget.check("next").pipe(Effect.exit))._tag).toBe("Failure")
        yield* budget.record("paid", { totalTokens: 100 })
        expect((yield* budget.check("next"))._tag).toBe("proceed")
        expect(yield* records(journal, "unmanaged")).toHaveLength(1)
      })
    ))
  })

  it("refuses a recovered ledger with conflicting records for one model step", async () => {
    await run(inRun(
      "conflicting-ledger",
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        for (const spent of [100, 200]) {
          yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: JournalEvent.RunId.make("conflicting-ledger"),
              sourceId: JournalEvent.SourceId.make(`legacy-${spent}`),
              eventType: Budget.usageEvent,
              payload: { stepKey: "paid", spent }
            })
          )
        }
        const budget = yield* Budget.make({})
        expect((yield* budget.check("next").pipe(Effect.exit))._tag).toBe("Failure")
      })
    ))
  })
})
