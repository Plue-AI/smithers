import { afterEach, describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import { PermissionRequired, Rule } from "@smthrs/capability/Permission"
import { layer as writerLayer } from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalError } from "@smthrs/journal/Journal"
import { Input } from "@smthrs/journal/JournalEvent"
import * as Migrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encode, EnvelopeGrant } from "../src/GrantEvent.ts"
import { maximumRules, type Service } from "../src/GrantStore.ts"
import * as JournalGrantStore from "../src/JournalGrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

const directories = new Set<string>()
const options = {
  runId: "run-capacity",
  policyRunId: "policy-capacity",
  sourceId: "kernel",
  planDigest: "plan-1",
  attended: false
} as const
const pattern = (name: string) => new CapabilityPattern({ action: "fs:read", resource: `/workspace/${name}` })
const capability = (name: string) => new Capability({ action: "fs:read", resource: `/workspace/${name}` })
const configured = Array.from(
  { length: maximumRules - 1 },
  () => new Rule({ effect: "ask", pattern: pattern("configured") })
)
const awaitPending = (
  store: Service,
  count: number
): Effect.Effect<ReadonlyArray<{ readonly requestId: string; readonly capability: Capability }>> =>
  Effect.suspend(() =>
    Effect.flatMap(
      store.list,
      (pending) =>
        pending.length >= count
          ? Effect.succeed(pending)
          : Effect.yieldNow.pipe(Effect.andThen(awaitPending(store, count)))
    )
  )

afterEach(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

const withJournal = <A, E>(effect: Effect.Effect<A, E, Journal | Workspace.Workspace | Scope.Scope>) =>
  Effect.gen(function*() {
    const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "grant-capacity-")))
    directories.add(directory)
    const filename = join(directory, "journal.sqlite")
    const database = Layer.provideMerge(
      Migrations.layer,
      Layer.provideMerge(writerLayer(), NodeDatabase.layer({ filename }))
    )
    return yield* effect.pipe(
      Effect.provide(SqlJournal.layer({ capacity: 64, overflow: "reject" }).pipe(Layer.provide(database))),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.scoped
    )
  })

describe("JournalGrantStore capacity during concurrent durable writes", () => {
  it.effect("admits at most one distinct envelope at the final rule slot and replays its real SQLite journal", () =>
    withJournal(Effect.gen(function*() {
      const journal = yield* Journal
      const firstEntered = yield* Deferred.make<void>()
      const secondEntered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let writes = 0
      const gated = Journal.of({
        ...journal,
        emitDurableUnfenced: (input) =>
          Effect.gen(function*() {
            writes += 1
            yield* Deferred.succeed(writes === 1 ? firstEntered : secondEntered, undefined)
            yield* Deferred.await(release)
            return yield* journal.emitDurableUnfenced(input)
          })
      })
      const store = yield* JournalGrantStore.make({ ...options, rules: [configured] }).pipe(
        Effect.provideService(Journal, gated)
      )
      const first = yield* store.grantEnvelope({
        planDigest: options.planDigest,
        patterns: [pattern("new-a")],
        scope: "run"
      }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(firstEntered)
      const second = yield* store.grantEnvelope({
        planDigest: options.planDigest,
        patterns: [pattern("new-b")],
        scope: "run"
      }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      // A rejected admission settles before reaching the writer. The race also
      // releases the old implementation, where both writes enter the journal.
      yield* Effect.race(
        Fiber.await(second).pipe(Effect.asVoid),
        Deferred.await(secondEntered)
      )
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
      const failure = yield* Effect.flip(Fiber.join(second))
      expect(failure.code).toBe("invalid_resolution")
      expect(failure.message).toContain(`rules exceed ${maximumRules} entries`)
      yield* store.check(capability("new-a"))
      expect(yield* Effect.flip(store.check(capability("new-b")))).toBeInstanceOf(PermissionRequired)
      const entries = yield* journal.entries({ runId: options.runId as never, limit: 10 })
      expect(entries.entries).toHaveLength(1)
      const reopened = yield* JournalGrantStore.make({ ...options, rules: [configured] })
      yield* reopened.check(capability("new-a"))
      expect(yield* Effect.flip(reopened.check(capability("new-b")))).toBeInstanceOf(PermissionRequired)
    })))

  for (const resolution of ["run", "remembered"] as const) {
    it.effect(`reserves the final rule slot across two ${resolution} replies`, () =>
      withJournal(Effect.gen(function*() {
        const journal = yield* Journal
        const firstEntered = yield* Deferred.make<void>()
        const secondEntered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let writes = 0
        const gated = Journal.of({
          ...journal,
          emitDurableUnfenced: (input) =>
            Effect.gen(function*() {
              writes += 1
              yield* Deferred.succeed(writes === 1 ? firstEntered : secondEntered, undefined)
              yield* Deferred.await(release)
              return yield* journal.emitDurableUnfenced(input)
            })
        })
        const store = yield* JournalGrantStore.make({ ...options, attended: true, rules: [configured] }).pipe(
          Effect.provideService(Journal, gated)
        )
        const waiterA = yield* store.check(capability("reply-a")).pipe(Effect.forkChild({ startImmediately: true }))
        const waiterB = yield* store.check(capability("reply-b")).pipe(Effect.forkChild({ startImmediately: true }))
        const pending = yield* awaitPending(store, 2)
        const requestA = pending.find((request) => request.capability.resource.endsWith("reply-a"))!
        const requestB = pending.find((request) => request.capability.resource.endsWith("reply-b"))!
        const first = yield* store.reply(requestA.requestId, resolution).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(firstEntered)
        const second = yield* store.reply(requestB.requestId, resolution).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.race(Fiber.await(second).pipe(Effect.asVoid), Deferred.await(secondEntered))
        yield* Deferred.succeed(release, undefined)
        expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
        const failure = yield* Effect.flip(Fiber.join(second))
        expect(failure.code).toBe("invalid_resolution")
        expect(failure.message).toContain(`rules exceed ${maximumRules} entries`)
        yield* Fiber.join(waiterA)
        expect(waiterB.pollUnsafe()).toBeUndefined()
        expect((yield* store.list).map((request) => request.requestId)).toEqual([requestB.requestId])
        const entries = yield* journal.entries({
          runId: (resolution === "run" ? options.runId : options.policyRunId) as never,
          limit: 10
        })
        expect(entries.entries).toHaveLength(1)
        const reopened = yield* JournalGrantStore.make({ ...options, rules: [configured] })
        yield* reopened.check(capability("reply-a"))
        expect(yield* Effect.flip(reopened.check(capability("reply-b")))).toBeInstanceOf(PermissionRequired)
        yield* Fiber.interrupt(waiterB)
      })))
  }

  for (const firstKind of ["envelope", "reply"] as const) {
    it.effect(`shares the final rule slot when a ${firstKind} write precedes the other admission type`, () =>
      withJournal(Effect.gen(function*() {
        const journal = yield* Journal
        const firstEntered = yield* Deferred.make<void>()
        const secondEntered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let writes = 0
        const gated = Journal.of({
          ...journal,
          emitDurableUnfenced: (input) =>
            Effect.gen(function*() {
              writes += 1
              yield* Deferred.succeed(writes === 1 ? firstEntered : secondEntered, undefined)
              yield* Deferred.await(release)
              return yield* journal.emitDurableUnfenced(input)
            })
        })
        const store = yield* JournalGrantStore.make({ ...options, attended: true, rules: [configured] }).pipe(
          Effect.provideService(Journal, gated)
        )
        const replyName = firstKind === "reply" ? "reply-first" : "reply-second"
        const envelopeName = firstKind === "envelope" ? "envelope-first" : "envelope-second"
        const waiter = yield* store.check(capability(replyName)).pipe(Effect.forkChild({ startImmediately: true }))
        const [request] = yield* awaitPending(store, 1)
        const envelope = store.grantEnvelope({
          planDigest: options.planDigest,
          patterns: [pattern(envelopeName)],
          scope: "run"
        })
        const reply = store.reply(request!.requestId, "run")
        const first = yield* (firstKind === "envelope" ? envelope : reply).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(firstEntered)
        const second = yield* (firstKind === "envelope" ? reply : envelope).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.race(Fiber.await(second).pipe(Effect.asVoid), Deferred.await(secondEntered))
        yield* Deferred.succeed(release, undefined)
        expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
        const failure = yield* Effect.flip(Fiber.join(second))
        expect(failure.code).toBe("invalid_resolution")
        expect(failure.message).toContain(`rules exceed ${maximumRules} entries`)
        const admitted = firstKind === "envelope" ? envelopeName : replyName
        const refused = firstKind === "envelope" ? replyName : envelopeName
        yield* store.check(capability(admitted))
        if (firstKind === "reply") yield* Fiber.join(waiter)
        else {
          expect(waiter.pollUnsafe()).toBeUndefined()
          yield* Fiber.interrupt(waiter)
        }
        const entries = yield* journal.entries({ runId: options.runId as never, limit: 10 })
        expect(entries.entries).toHaveLength(1)
        const reopened = yield* JournalGrantStore.make({ ...options, rules: [configured] })
        yield* reopened.check(capability(admitted))
        expect(yield* Effect.flip(reopened.check(capability(refused)))).toBeInstanceOf(PermissionRequired)
      })))
  }

  it.effect("retains a reply reservation after its waiter cancels while SQLite is blocked", () =>
    withJournal(Effect.gen(function*() {
      const journal = yield* Journal
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let writes = 0
      const gated = Journal.of({
        ...journal,
        emitDurableUnfenced: (input) =>
          Effect.gen(function*() {
            writes += 1
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return yield* journal.emitDurableUnfenced(input)
          })
      })
      const store = yield* JournalGrantStore.make({ ...options, attended: true, rules: [configured] }).pipe(
        Effect.provideService(Journal, gated)
      )
      const waiter = yield* store.check(capability("cancelled-waiter")).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      const [request] = yield* awaitPending(store, 1)
      const reply = yield* store.reply(request!.requestId, "run").pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(waiter)
      const blocked = yield* Effect.flip(store.grantEnvelope({
        planDigest: options.planDigest,
        patterns: [pattern("after-waiter-cancel")],
        scope: "run"
      }))
      expect(blocked.code).toBe("invalid_resolution")
      expect(blocked.message).toContain(`rules exceed ${maximumRules} entries`)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(reply)
      expect(writes).toBe(1)
      yield* store.check(capability("cancelled-waiter"))
      const reopened = yield* JournalGrantStore.make({ ...options, rules: [configured] })
      yield* reopened.check(capability("cancelled-waiter"))
      expect(yield* Effect.flip(reopened.check(capability("after-waiter-cancel")))).toBeInstanceOf(PermissionRequired)
    })))

  for (const resolution of ["run", "remembered"] as const) {
    for (const outcome of ["failure", "interruption"] as const) {
      it.effect(`releases a ${resolution} reply reservation after writer ${outcome}`, () =>
        withJournal(Effect.gen(function*() {
          const journal = yield* Journal
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let writes = 0
          const controlled = Journal.of({
            ...journal,
            emitDurableUnfenced: (input) =>
              Effect.gen(function*() {
                writes += 1
                if (writes === 1) {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                  return yield* Effect.fail(
                    new JournalError({ code: "sink_failed", message: "injected write failure" })
                  )
                }
                return yield* journal.emitDurableUnfenced(input)
              })
          })
          const store = yield* JournalGrantStore.make({ ...options, attended: true, rules: [configured] }).pipe(
            Effect.provideService(Journal, controlled)
          )
          const waiter = yield* store.check(capability("reply-write-fails")).pipe(
            Effect.forkChild({ startImmediately: true })
          )
          const [request] = yield* awaitPending(store, 1)
          const reply = yield* store.reply(request!.requestId, resolution).pipe(
            Effect.forkChild({ startImmediately: true })
          )
          yield* Deferred.await(entered)
          const blocked = yield* Effect.flip(store.grantEnvelope({
            planDigest: options.planDigest,
            patterns: [pattern("after-reply")],
            scope: "run"
          }))
          expect(blocked.code).toBe("invalid_resolution")
          if (outcome === "failure") {
            yield* Deferred.succeed(release, undefined)
            expect((yield* Effect.flip(Fiber.join(reply))).code).toBe("journal_failed")
          } else {
            yield* Fiber.interrupt(reply)
          }
          expect(waiter.pollUnsafe()).toBeUndefined()
          yield* store.grantEnvelope({
            planDigest: options.planDigest,
            patterns: [pattern("after-reply")],
            scope: "run"
          })
          expect(writes).toBe(2)
          const entries = yield* journal.entries({ runId: options.runId as never, limit: 10 })
          expect(entries.entries).toHaveLength(1)
          const reopened = yield* JournalGrantStore.make({ ...options, rules: [configured] })
          yield* reopened.check(capability("after-reply"))
          expect(yield* Effect.flip(reopened.check(capability("reply-write-fails")))).toBeInstanceOf(PermissionRequired)
          yield* Fiber.interrupt(waiter)
        })))
    }
  }

  it.effect("deduplicates the same envelope while its final-slot write is blocked", () =>
    withJournal(Effect.gen(function*() {
      const journal = yield* Journal
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let writes = 0
      const gated = Journal.of({
        ...journal,
        emitDurableUnfenced: (input) =>
          Effect.gen(function*() {
            writes += 1
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return yield* journal.emitDurableUnfenced(input)
          })
      })
      const store = yield* JournalGrantStore.make({ ...options, rules: [configured] }).pipe(
        Effect.provideService(Journal, gated)
      )
      const grant = () =>
        store.grantEnvelope({ planDigest: options.planDigest, patterns: [pattern("duplicate")], scope: "run" })
      const first = yield* grant().pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      const second = yield* grant().pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      expect(writes).toBe(1)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(writes).toBe(1)
      const entries = yield* journal.entries({ runId: options.runId as never, limit: 10 })
      expect(entries.entries).toHaveLength(1)
      const reopened = yield* JournalGrantStore.make({ ...options, rules: [configured] })
      yield* reopened.check(capability("duplicate"))
    })))

  it.effect("converts each successful reservation into one rule slot", () =>
    withJournal(Effect.gen(function*() {
      const journal = yield* Journal
      const rules = configured.slice(1)
      const store = yield* JournalGrantStore.make({ ...options, rules: [rules] })
      for (const name of ["sequential-a", "sequential-b"]) {
        yield* store.grantEnvelope({ planDigest: options.planDigest, patterns: [pattern(name)], scope: "run" })
        yield* store.check(capability(name))
      }
      const failure = yield* Effect.flip(
        store.grantEnvelope({ planDigest: options.planDigest, patterns: [pattern("sequential-c")], scope: "run" })
      )
      expect(failure.code).toBe("invalid_resolution")
      expect(failure.message).toContain(`rules exceed ${maximumRules} entries`)
      const entries = yield* journal.entries({ runId: options.runId as never, limit: 10 })
      expect(entries.entries).toHaveLength(2)
      const reopened = yield* JournalGrantStore.make({ ...options, rules: [rules] })
      yield* reopened.check(capability("sequential-a"))
      yield* reopened.check(capability("sequential-b"))
      expect(yield* Effect.flip(reopened.check(capability("sequential-c")))).toBeInstanceOf(PermissionRequired)
    })))

  it.effect("releases rule capacity after a failed durable write", () =>
    withJournal(Effect.gen(function*() {
      const journal = yield* Journal
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let writes = 0
      const failing = Journal.of({
        ...journal,
        emitDurableUnfenced: (input) =>
          Effect.gen(function*() {
            writes += 1
            if (writes === 1) {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return yield* Effect.fail(new JournalError({ code: "sink_failed", message: "injected write failure" }))
            }
            return yield* journal.emitDurableUnfenced(input)
          })
      })
      const store = yield* JournalGrantStore.make({ ...options, rules: [configured] }).pipe(
        Effect.provideService(Journal, failing)
      )
      const first = yield* Effect.flip(
        store.grantEnvelope({ planDigest: options.planDigest, patterns: [pattern("failed")], scope: "run" })
      ).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      const blocked = yield* Effect.flip(
        store.grantEnvelope({ planDigest: options.planDigest, patterns: [pattern("retry")], scope: "run" })
      )
      expect(blocked.code).toBe("invalid_resolution")
      expect(blocked.message).toContain(`rules exceed ${maximumRules} entries`)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(first)).code).toBe("journal_failed")
      yield* store.grantEnvelope({ planDigest: options.planDigest, patterns: [pattern("retry")], scope: "run" })
      expect(writes).toBe(2)
      const entries = yield* journal.entries({ runId: options.runId as never, limit: 10 })
      expect(entries.entries).toHaveLength(1)
      const reopened = yield* JournalGrantStore.make({ ...options, rules: [configured] })
      yield* reopened.check(capability("retry"))
      expect(yield* Effect.flip(reopened.check(capability("failed")))).toBeInstanceOf(PermissionRequired)
    })))

  it.effect("releases rule capacity when a blocked admission is interrupted", () =>
    withJournal(Effect.gen(function*() {
      const journal = yield* Journal
      const entered = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      let writes = 0
      const blocking = Journal.of({
        ...journal,
        emitDurableUnfenced: (input) =>
          Effect.gen(function*() {
            writes += 1
            if (writes === 1) {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(never)
            }
            return yield* journal.emitDurableUnfenced(input)
          })
      })
      const store = yield* JournalGrantStore.make({ ...options, rules: [configured] }).pipe(
        Effect.provideService(Journal, blocking)
      )
      const first = yield* store.grantEnvelope({
        planDigest: options.planDigest,
        patterns: [pattern("interrupted")],
        scope: "run"
      }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      const blocked = yield* Effect.flip(
        store.grantEnvelope({ planDigest: options.planDigest, patterns: [pattern("after-interrupt")], scope: "run" })
      )
      expect(blocked.code).toBe("invalid_resolution")
      yield* Fiber.interrupt(first)
      yield* store.grantEnvelope({
        planDigest: options.planDigest,
        patterns: [pattern("after-interrupt")],
        scope: "run"
      })
      expect(writes).toBe(2)
      const entries = yield* journal.entries({ runId: options.runId as never, limit: 10 })
      expect(entries.entries).toHaveLength(1)
      const reopened = yield* JournalGrantStore.make({ ...options, rules: [configured] })
      yield* reopened.check(capability("after-interrupt"))
      expect(yield* Effect.flip(reopened.check(capability("interrupted")))).toBeInstanceOf(PermissionRequired)
    })))

  it.effect("reserves the final envelope signature slot during distinct SQLite writes", () =>
    withJournal(Effect.gen(function*() {
      const journal = yield* Journal
      // Seed valid durable envelope events with many signatures but only 16
      // distinct predicates, so this boundary exercises signatures alone.
      const predicates = Array.from({ length: 16 }, (_, index) => pattern(`signature-seed-${index}`))
      let seeded = 0
      for (let a = 0; a < predicates.length && seeded < maximumRules - 1; a += 1) {
        for (let b = a + 1; b < predicates.length && seeded < maximumRules - 1; b += 1) {
          for (let c = b + 1; c < predicates.length && seeded < maximumRules - 1; c += 1) {
            for (let d = c + 1; d < predicates.length && seeded < maximumRules - 1; d += 1) {
              const event = new EnvelopeGrant({
                eventType: "flows.kernel.grant.envelope.v1",
                runId: options.runId,
                planDigest: options.planDigest,
                patterns: [predicates[a]!, predicates[b]!, predicates[c]!, predicates[d]!],
                scope: "run"
              })
              const payload = encode(event)
              if (payload._tag === "Failure") throw new Error("valid envelope failed encoding")
              yield* journal.emitDurableUnfenced(
                new Input({
                  runId: options.runId as never,
                  sourceId: options.sourceId as never,
                  eventType: event.eventType,
                  payload: payload.success
                })
              )
              seeded += 1
            }
          }
        }
      }
      expect(seeded).toBe(maximumRules - 1)
      const firstEntered = yield* Deferred.make<void>()
      const secondEntered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let writes = 0
      const gated = Journal.of({
        ...journal,
        emitDurableUnfenced: (input) =>
          Effect.gen(function*() {
            writes += 1
            yield* Deferred.succeed(writes === 1 ? firstEntered : secondEntered, undefined)
            yield* Deferred.await(release)
            return yield* journal.emitDurableUnfenced(input)
          })
      })
      const store = yield* JournalGrantStore.make(options).pipe(Effect.provideService(Journal, gated))
      const first = yield* store.grantEnvelope({
        planDigest: options.planDigest,
        patterns: [pattern("signature-a")],
        scope: "run"
      }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(firstEntered)
      const second = yield* store.grantEnvelope({
        planDigest: options.planDigest,
        patterns: [pattern("signature-b")],
        scope: "run"
      }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.race(Fiber.await(second).pipe(Effect.asVoid), Deferred.await(secondEntered))
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
      const failure = yield* Effect.flip(Fiber.join(second))
      expect(failure.code).toBe("invalid_resolution")
      expect(failure.message).toContain(`grant envelopes exceed ${maximumRules} entries`)
      expect(writes).toBe(1)
      const reopened = yield* JournalGrantStore.make(options)
      yield* reopened.check(capability("signature-a"))
      expect(yield* Effect.flip(reopened.check(capability("signature-b")))).toBeInstanceOf(PermissionRequired)
    })))
})
