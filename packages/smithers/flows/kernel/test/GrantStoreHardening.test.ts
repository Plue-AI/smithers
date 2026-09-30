import { describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern, format } from "@smthrs/capability/Capability"
import { GrantStoreError, Rule } from "@smthrs/capability/Permission"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { createHash } from "node:crypto"
import * as GrantStore from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

const safe = new Capability({ action: "fs:read", resource: "/workspace/safe.txt" })
const other = new Capability({ action: "fs:read", resource: "/workspace/other.txt" })
const outside = new Capability({ action: "fs:read", resource: "/outside/secret.txt" })
const safePattern = () => new CapabilityPattern({ action: "fs:read", resource: "/workspace/safe.txt" })
const workspacePattern = () => new CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
const deny = () => new Rule({ effect: "deny", pattern: new CapabilityPattern({ action: "net:get", resource: "none" }) })

const make = (options?: GrantStore.MakeOptions) =>
  GrantStore.make(options).pipe(Effect.provide(Workspace.layer("/workspace")))

const awaitPending = (
  store: GrantStore.Service,
  count: number
): Effect.Effect<ReadonlyArray<GrantStore.PendingRequest>> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending.length >= count
        ? Effect.succeed(pending)
        : Effect.yieldNow.pipe(Effect.andThen(awaitPending(store, count))))
  )

const invalidCheck = (
  store: GrantStore.Service,
  meta: Record<string, unknown>
) => Effect.flip(store.check(safe, meta))

const stalled = (persisting: Deferred.Deferred<void>) => () =>
  Deferred.succeed(persisting, undefined).pipe(Effect.andThen(Effect.never))

describe("GrantStore immutable authority", () => {
  it.effect("does not retain constructor or envelope pattern objects", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const configured = safePattern()
        const configuredStore = yield* make({
          attended: false,
          rules: [new Rule({ effect: "allow", pattern: configured })]
        })
        expect(Reflect.set(configured, "resource", "/workspace/**")).toBe(true)
        yield* configuredStore.check(safe)
        expect((yield* Effect.flip(configuredStore.check(other))).code).toBe("permission_required")

        const envelope = safePattern()
        const envelopeStore = yield* make({ attended: false, planDigest: "plan-1" })
        yield* envelopeStore.grantEnvelope({ planDigest: "plan-1", patterns: [envelope] })
        expect(Reflect.set(envelope, "resource", "/workspace/**")).toBe(true)
        yield* envelopeStore.check(safe)
        expect((yield* Effect.flip(envelopeStore.check(other))).code).toBe("permission_required")
      })
    ))

  it.effect("parks and lists detached immutable capability and metadata snapshots", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const events: Array<unknown> = []
        const store = yield* make({
          persist: (event) => Effect.sync(() => events.push(event))
        })
        const capability = new Capability({ action: "fs:read", resource: "/workspace/safe.txt" })
        const meta = { nested: { mode: "safe" }, values: [1, 2] }
        const waiting = yield* store.check(capability, meta).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const [listed] = yield* awaitPending(store, 1)

        expect(Reflect.set(capability, "resource", "/outside/secret.txt")).toBe(true)
        meta.nested.mode = "unsafe"
        meta.values[0] = 9
        expect(Reflect.set(listed!.capability, "resource", "/outside/other")).toBe(false)
        expect(Reflect.set(listed!.meta.nested as object, "mode", "listed-mutation")).toBe(false)
        expect(Reflect.set(listed!.meta.values as object, "0", 8)).toBe(false)

        const [again] = yield* store.list
        expect(again).toMatchObject({
          capability: { action: "fs:read", resource: "/workspace/safe.txt" },
          meta: { nested: { mode: "safe" }, values: [1, 2] }
        })
        expect(again).not.toBe(listed)
        expect(again!.capability).not.toBe(listed!.capability)
        // The metadata snapshot was frozen at allocation; list returns it
        // without re-walking or re-serializing the graph.
        expect(again!.meta).toBe(listed!.meta)

        yield* store.reply(again!.requestId, "once")
        yield* Fiber.join(waiting)
        expect(events).toMatchObject([{
          capability: { action: "fs:read", resource: "/workspace/safe.txt" }
        }])
      })
    ))
})

describe("GrantStore journal stall isolation", () => {
  it.effect("a suspended reply journal write does not stall checks, list, cancellation, or scope close", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const persisting = yield* Deferred.make<void>()
        const store = yield* make({
          rules: [new Rule({ effect: "allow", pattern: safePattern() })],
          persist: stalled(persisting)
        })
        yield* store.check(other).pipe(Effect.forkChild({ startImmediately: true }))
        const [pending] = yield* awaitPending(store, 1)
        yield* store.reply(pending!.requestId, "once").pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(persisting)

        // A policy-allowed check needs no journal write and must not queue
        // behind the suspended one.
        yield* store.check(safe)

        // list copies the parked requests without waiting on the journal.
        expect((yield* store.list).map(({ requestId }) => requestId)).toEqual([pending!.requestId])

        // Cancelling a parked check is released without the journal.
        const parked = yield* store.check(
          new Capability({ action: "fs:read", resource: "/workspace/parked.txt" })
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* awaitPending(store, 2)
        yield* Fiber.interrupt(parked)
        expect(yield* store.list).toHaveLength(1)
      })
      // Scope closure interrupts the suspended reply and fails the waiter.
    ))

  it.effect("a suspended envelope journal write does not stall checks, list, or scope close", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const persisting = yield* Deferred.make<void>()
        const store = yield* make({
          planDigest: "plan-1",
          rules: [new Rule({ effect: "allow", pattern: safePattern() })],
          persist: stalled(persisting)
        })
        yield* store.grantEnvelope({ planDigest: "plan-1", patterns: [workspacePattern()] }).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(persisting)

        yield* store.check(safe)
        expect(yield* store.list).toEqual([])
      })
    ))
})

describe("GrantStore journal write boundaries", () => {
  it.effect("a journal write that outlasts its deadline fails the reply and leaves the request parked", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const persisting = yield* Deferred.make<void>()
        const store = yield* make({ persist: stalled(persisting) })
        const waiter = yield* store.check(other).pipe(Effect.forkChild({ startImmediately: true }))
        const [pending] = yield* awaitPending(store, 1)
        const reply = yield* Effect.flip(store.reply(pending!.requestId, "once")).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(persisting)

        yield* TestClock.adjust(GrantStore.maximumPersistMillis + 1)
        expect((yield* Fiber.join(reply)).code).toBe("journal_failed")
        expect(waiter.pollUnsafe()).toBeUndefined()
        expect(yield* store.list).toHaveLength(1)
      })
    ))

  it.effect("a completed write for a waiter cancelled mid-persist fails with request_not_found", () =>
    Effect.scoped(
      Effect.gen(function*() {
        for (const resolution of ["once", "deny"] as const) {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const store = yield* make({
            persist: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
          })
          const waiter = yield* store.check(other).pipe(Effect.forkChild({ startImmediately: true }))
          const [pending] = yield* awaitPending(store, 1)
          const reply = yield* Effect.flip(store.reply(pending!.requestId, resolution)).pipe(
            Effect.forkChild({ startImmediately: true })
          )
          yield* Deferred.await(started)

          yield* Fiber.interrupt(waiter)
          expect(yield* store.list).toEqual([])
          yield* Deferred.succeed(release, undefined)
          expect((yield* Fiber.join(reply)).code).toBe("request_not_found")
        }
      })
    ))

  it.effect("a concurrent identical envelope admission adopts the in-flight outcome", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const events: Array<unknown> = []
        const store = yield* make({
          planDigest: "plan-1",
          persist: (event) =>
            Effect.sync(() => events.push(event)).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release))
            )
        })
        const envelope = { planDigest: "plan-1", patterns: [workspacePattern()] }
        const first = yield* store.grantEnvelope(envelope).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        const second = yield* store.grantEnvelope(envelope).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        expect(second.pollUnsafe()).toBeUndefined()

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(events).toHaveLength(1)
        yield* store.check(other)
      })
    ))

  it.effect("a concurrent identical envelope admission receives a failed write instead of retrying it", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let writes = 0
        const store = yield* make({
          planDigest: "plan-1",
          attended: false,
          persist: () =>
            Effect.sync(() => {
              writes += 1
            }).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.fail(new GrantStoreError({ code: "journal_failed", message: "journal offline" })))
            )
        })
        const envelope = { planDigest: "plan-1", patterns: [workspacePattern()] }
        const first = yield* Effect.flip(store.grantEnvelope(envelope)).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(started)
        const second = yield* Effect.flip(store.grantEnvelope(envelope)).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow

        yield* Deferred.succeed(release, undefined)
        expect((yield* Fiber.join(first)).code).toBe("journal_failed")
        expect((yield* Fiber.join(second)).code).toBe("journal_failed")
        // One admission, one write: the waiter adopted the outcome rather than
        // turning a journal outage into a loop of fresh writes.
        expect(writes).toBe(1)
        expect((yield* Effect.flip(store.check(other))).code).toBe("permission_required")
      })
    ))

  it.effect("a concurrent identical envelope admission retries when the first admission is interrupted", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        let writes = 0
        const store = yield* make({
          planDigest: "plan-1",
          attended: false,
          persist: () =>
            Effect.suspend(() => {
              writes += 1
              return writes === 1
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.void
            })
        })
        const envelope = { planDigest: "plan-1", patterns: [workspacePattern()] }
        const first = yield* store.grantEnvelope(envelope).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        const second = yield* store.grantEnvelope(envelope).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow

        yield* Fiber.interrupt(first)
        yield* Fiber.join(second)
        expect(writes).toBe(2)
        yield* store.check(other)
      })
    ))

  it.effect("an envelope write that completes after scope close fails with store_closed", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const storeScope = yield* Scope.make()
      const store = yield* make({
        planDigest: "plan-1",
        persist: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
      }).pipe(Scope.provide(storeScope))
      const admission = yield* Effect.flip(
        store.grantEnvelope({ planDigest: "plan-1", patterns: [workspacePattern()] })
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)

      yield* Scope.close(storeScope, Exit.void)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(admission)).code).toBe("store_closed")
    }))

  it.effect("a reply write that completes after scope close fails with store_closed", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const storeScope = yield* Scope.make()
      const store = yield* make({
        persist: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
      }).pipe(Scope.provide(storeScope))
      const waiter = yield* store.check(other).pipe(Effect.forkDetach({ startImmediately: true }))
      const [pending] = yield* awaitPending(store, 1)
      const reply = yield* Effect.flip(store.reply(pending!.requestId, "once")).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(started)

      yield* Scope.close(storeScope, Exit.void)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(reply)).code).toBe("store_closed")
      void waiter
    }))
})

describe("GrantStore bounded input", () => {
  it.effect("rejects malformed store identities and policy collections", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const cases: ReadonlyArray<readonly [GrantStore.MakeOptions, string]> = [
          [{ runId: "" }, "runId is empty, malformed, or too long"],
          [{ runId: "\ud800" }, "runId is empty, malformed, or too long"],
          [{ runId: "\udc00" }, "runId is empty, malformed, or too long"],
          [
            { planDigest: "x".repeat(GrantStore.maximumIdentityLength + 1) },
            "planDigest is empty, malformed, or too long"
          ],
          [
            { rules: Array.from({ length: GrantStore.maximumRules + 1 }, deny) },
            `rules exceed ${GrantStore.maximumRules} entries`
          ],
          [
            { rules: [Array.from({ length: 600 }, deny), Array.from({ length: 600 }, deny)] },
            `rules exceed ${GrantStore.maximumRules} entries`
          ],
          [
            { runRules: Array.from({ length: GrantStore.maximumRules + 1 }, deny) },
            `runRules exceed ${GrantStore.maximumRules} entries`
          ],
          [
            { rules: Array.from({ length: 600 }, deny), runRules: Array.from({ length: 600 }, deny) },
            `rules exceed ${GrantStore.maximumRules} entries`
          ],
          [{ envelopeSignatures: "invalid" as never }, `envelopeSignatures exceed ${GrantStore.maximumRules} entries`],
          [{
            envelopeSignatures: Array.from({ length: GrantStore.maximumRules + 1 }, (_, index) => `signature-${index}`)
          }, `envelopeSignatures exceed ${GrantStore.maximumRules} entries`],
          [{ envelopeSignatures: [""] }, "envelopeSignatures[0] is malformed or too long"]
        ]
        for (const [options, message] of cases) {
          const failure = yield* Effect.flip(make(options))
          expect(failure).toMatchObject({ code: "invalid_resolution", message })
        }
      })
    ))

  it.effect("accepts store identities at exactly the identity length limit", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const exact = "x".repeat(GrantStore.maximumIdentityLength)
        const store = yield* make({ runId: exact, planDigest: exact })
        expect(yield* store.list).toEqual([])
      })
    ))

  it.effect("rejects malformed, cyclic, deep, wide, and oversized metadata", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make()
        const cycle: Record<string, unknown> = {}
        cycle.self = cycle
        let deep: Record<string, unknown> = {}
        for (let index = 0; index <= GrantStore.maximumMetadataDepth; index += 1) deep = { child: deep }
        const sparse = new Array(2)
        sparse[1] = "value"
        const wideArray = Array.from({ length: GrantStore.maximumMetadataMembers + 1 }, () => null)
        const accessor = Object.defineProperty({}, "value", {
          enumerable: true,
          get: () => "secret getter"
        })
        const arrayAccessor = ["value"]
        Object.defineProperty(arrayAccessor, "0", { enumerable: true, get: () => "getter" })
        class NotPlain {
          readonly value = "x"
        }
        const wide = Object.fromEntries(
          Array.from({ length: GrantStore.maximumMetadataMembers + 1 }, (_, index) => [`k${index}`, index])
        )
        const invalid: ReadonlyArray<readonly [Record<string, unknown>, RegExp]> = [
          [{ value: Number.NaN }, /non-finite/],
          [{ value: "\ud800" }, /ill-formed/],
          [{ value: "x".repeat(GrantStore.maximumMetadataBytes + 1) }, /exceeds .* bytes/],
          [{ value: 1n }, /JSON data/],
          [cycle, /cycles/],
          [deep, /depth/],
          [{ values: sparse }, /dense data/],
          [{ values: wideArray }, /members/],
          [{ values: arrayAccessor }, /dense data/],
          [{ value: new NotPlain() }, /plain records/],
          [accessor, /well-formed data properties/],
          [wide, /members/],
          [{ value: "🙂".repeat(20_000) }, /exceeds .* bytes/]
        ]
        for (const [meta, message] of invalid) {
          const failure = yield* invalidCheck(store, meta)
          expect(failure).toMatchObject({ code: "invalid_resolution" })
          expect(failure.message).toMatch(message)
        }

        const hostile = new Proxy({}, {
          ownKeys: () => ["value"],
          getOwnPropertyDescriptor: () => {
            throw new Error("hidden getter value")
          }
        })
        expect(yield* invalidCheck(store, hostile)).toMatchObject({
          code: "invalid_resolution",
          message: "permission request is invalid"
        })
        expect(yield* invalidCheck(store, [] as never)).toMatchObject({
          code: "invalid_resolution",
          message: "metadata must be a record"
        })
      })
    ))

<<<<<<< conflict 1 of 1
%%%%%%% diff from: xpztrsny b7552cfd "🐛 fix(review): pin PR comparisons to immutable base commits" (parents of rebased revision)
\\\\\\\        to: vksnmmsy 86b6be07 "🐛 fix(harbor): release failed startup slots without verifier handoff (#2683)" (parents of squashed revision)
   it.effect("preserves __proto__ metadata in attended and unattended requests", () =>
     Effect.scoped(
       Effect.gen(function*() {
-        const meta = JSON.parse('{"ordinary":"kept","__proto__":{"note":"kept-meta"},"nested":{"__proto__":{"note":"nested"},"ordinary":true}}') as Record<string, unknown>
+        const meta = JSON.parse(
+          "{\"ordinary\":\"kept\",\"__proto__\":{\"note\":\"kept-meta\"},\"nested\":{\"__proto__\":{\"note\":\"nested\"},\"ordinary\":true}}"
+        ) as Record<string, unknown>
         const unattended = yield* make({ attended: false })
         const failure = yield* Effect.flip(unattended.check(safe, meta))
         expect(failure).toBeInstanceOf(PermissionRequired)
         if (!(failure instanceof PermissionRequired)) throw new Error("expected typed permission failure")
         expect(Object.getOwnPropertyDescriptor(failure.meta, "__proto__")?.value).toEqual({ note: "kept-meta" })
         expect(failure.meta).toMatchObject({ ordinary: "kept" })
         const attended = yield* make()
         const waiting = yield* attended.check(safe, meta).pipe(Effect.forkChild({ startImmediately: true }))
         const [pending] = yield* awaitPending(attended, 1)
         expect(Object.getOwnPropertyDescriptor(pending!.meta, "__proto__")?.value).toEqual({ note: "kept-meta" })
         expect(pending!.meta).toMatchObject({ ordinary: "kept" })
         const nested = pending!.meta.nested as Record<string, unknown>
         expect(Object.getOwnPropertyDescriptor(nested, "__proto__")?.value).toEqual({ note: "nested" })
         expect(nested.ordinary).toBe(true)
         yield* attended.reply(pending!.requestId, "once")
         yield* Fiber.join(waiting)
       })
     ))
 
+++++++ lwrwyqzq 0347f302 (rebased revision)
>>>>>>> conflict 1 of 1 ends
  it.effect("accepts the metadata boundary without retaining optional members", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make()
        const meta = Object.create(null) as Record<string, unknown>
        meta.null = null
        meta.boolean = true
        meta.number = 1
        meta.text = "ok"
        meta.optional = undefined
        Object.defineProperty(meta, "hidden", { enumerable: false, value: "ignored" })
        meta.values = Array.from({ length: GrantStore.maximumMetadataMembers - 6 }, () => null)
        const waiting = yield* store.check(safe, meta).pipe(Effect.forkChild({ startImmediately: true }))
        const [pending] = yield* awaitPending(store, 1)
        expect(pending!.meta).toMatchObject({ null: null, boolean: true, number: 1, text: "ok" })
        expect(pending!.meta).not.toHaveProperty("optional")
        expect(pending!.meta).not.toHaveProperty("hidden")
        yield* store.reply(pending!.requestId, "once")
        yield* Fiber.join(waiting)
      })
    ))

  it.effect("bounds envelope inputs, durable events, rules, and envelope signatures", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({ planDigest: "plan-1" })
        const tooMany = Array.from(
          { length: GrantStore.maximumEnvelopePatterns + 1 },
          (_, index) => new CapabilityPattern({ action: "fs:read", resource: `/workspace/${index}` })
        )
        expect(yield* Effect.flip(store.grantEnvelope({ planDigest: "plan-1", patterns: tooMany }))).toMatchObject({
          code: "invalid_resolution",
          message: `patterns exceed ${GrantStore.maximumEnvelopePatterns} entries`
        })
        expect(
          yield* Effect.flip(store.grantEnvelope({
            planDigest: "plan-1",
            patterns: "invalid" as never
          }))
        ).toMatchObject({
          code: "invalid_resolution",
          message: "patterns must be an array"
        })
        expect(
          yield* Effect.flip(store.grantEnvelope({
            planDigest: "",
            patterns: [safePattern()]
          }))
        ).toMatchObject({
          code: "invalid_resolution",
          message: "planDigest is empty, malformed, or too long"
        })
        const authorityFree = yield* make()
        yield* authorityFree.grantEnvelope({ planDigest: "", patterns: [] })

        const large = Array.from(
          { length: GrantStore.maximumEnvelopePatterns },
          (_, index) =>
            new CapabilityPattern({
              action: "fs:read",
              resource: `/workspace/${index}/${"x".repeat(2_000)}`
            })
        )
        expect(yield* Effect.flip(store.grantEnvelope({ planDigest: "plan-1", patterns: large }))).toMatchObject({
          code: "invalid_resolution",
          message: `grant event exceeds ${GrantStore.maximumEventBytes} bytes`
        })

        const fullRules = yield* make({
          planDigest: "plan-1",
          rules: Array.from({ length: GrantStore.maximumRules }, deny)
        })
        expect(
          yield* Effect.flip(fullRules.grantEnvelope({
            planDigest: "plan-1",
            patterns: [safePattern()]
          }))
        ).toMatchObject({
          code: "invalid_resolution",
          message: `rules exceed ${GrantStore.maximumRules} entries`
        })

        const fullSignatures = yield* make({
          planDigest: "plan-1",
          envelopeSignatures: Array.from({ length: GrantStore.maximumRules }, (_, index) => `signature-${index}`)
        })
        expect(
          yield* Effect.flip(fullSignatures.grantEnvelope({
            planDigest: "plan-1",
            patterns: [safePattern()]
          }))
        ).toMatchObject({
          code: "invalid_resolution",
          message: `grant envelopes exceed ${GrantStore.maximumRules} entries`
        })
      })
    ))

  it.effect("refuses a permission request beyond the parked-request limit", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make()
        for (let index = 0; index < GrantStore.maximumPendingRequests; index += 1) {
          yield* store.check(
            new Capability({
              action: "fs:read",
              resource: `/workspace/pending-${index}`
            })
          ).pipe(Effect.forkChild({ startImmediately: true }))
        }
        yield* awaitPending(store, GrantStore.maximumPendingRequests)
        const failure = yield* Effect.flip(store.check(other))
        expect(failure).toMatchObject({
          code: "invalid_resolution",
          message: `pending requests exceed ${GrantStore.maximumPendingRequests} entries`
        })
      })
    ))

  it.effect("refuses run and remembered rules once the policy is full", () =>
    Effect.scoped(
      Effect.gen(function*() {
        for (const resolution of ["run", "remembered"] as const) {
          const store = yield* make({
            planDigest: "plan-1",
            rules: Array.from({ length: GrantStore.maximumRules }, deny)
          })
          const waiting = yield* store.check(safe).pipe(Effect.forkChild({ startImmediately: true }))
          const [pending] = yield* awaitPending(store, 1)
          expect(yield* Effect.flip(store.reply(pending!.requestId, resolution))).toMatchObject({
            code: "invalid_resolution",
            message: `rules exceed ${GrantStore.maximumRules} entries`
          })
          yield* store.reply(pending!.requestId, "once")
          yield* Fiber.join(waiting)
        }
      })
    ))
})

describe("envelope admission boundaries", () => {
  for (const scope of ["run", "remembered"] as const) {
    for (const count of [GrantStore.maximumRules - 1, GrantStore.maximumRules]) {
      for (const admission of ["construction", "runtime"] as const) {
        it.effect(`${admission} ${scope} envelope with ${count} existing rules`, () =>
          Effect.scoped(Effect.gen(function*() {
            let writes = 0
            const envelope = { planDigest: "plan-1", scope, patterns: [safePattern()] }
            const options = {
              attended: false,
              planDigest: "plan-1",
              rules: Array.from({ length: count }, deny),
              persist: () =>
                Effect.sync(() => {
                  writes += 1
                })
            }
            const admissionEffect = admission === "construction"
              ? make({ ...options, envelope })
              : Effect.gen(function*() {
                const store = yield* make(options)
                yield* store.grantEnvelope(envelope)
                return store
              })
            const result = yield* Effect.result(admissionEffect)
            if (count === GrantStore.maximumRules) {
              expect(result).toMatchObject({ _tag: "Failure", failure: { code: "invalid_resolution" } })
              expect(writes).toBe(0)
            } else {
              expect(result._tag).toBe("Success")
              if (result._tag === "Success") yield* result.success.check(safe)
              expect(writes).toBe(1)
            }
          })))
      }
    }
  }
})

describe("bounded envelope identities", () => {
  it("hashes the canonical encoding with SHA-256", () => {
    const patterns = [safePattern(), workspacePattern()]
    const canonical = JSON.stringify({
      planDigest: "plan-1",
      scope: "run",
      patterns: GrantStore.canonicalEnvelopePatterns(patterns).map(format)
    })
    const signature = GrantStore.envelopeSignature("plan-1", "run", patterns)
    expect(signature).toBe(`sha256:${createHash("sha256").update(canonical).digest("hex")}`)
    expect(GrantStore.envelopeSignature("plan-1", "run", [...patterns].reverse())).toBe(signature)
    expect(GrantStore.envelopeSignature("plan-2", "run", patterns)).not.toBe(signature)
    expect(GrantStore.envelopeSignature("plan-1", "remembered", patterns)).not.toBe(signature)
  })

  it.effect("normalizes legacy full-JSON signatures before construction and runtime deduplication", () =>
    Effect.scoped(Effect.gen(function*() {
      const patterns = Array.from(
        { length: 256 },
        (_, index) => new CapabilityPattern({ action: "fs:read", resource: `/workspace/file-${index}` })
      )
      const legacy = JSON.stringify({
        planDigest: "plan-1",
        scope: "run",
        patterns: GrantStore.canonicalEnvelopePatterns(patterns).map(format)
      })
      expect(legacy.length).toBeGreaterThan(GrantStore.maximumIdentityLength)
      let writes = 0
      const envelope = { planDigest: "plan-1", patterns }
      const store = yield* make({
        attended: false,
        planDigest: "plan-1",
        envelope,
        envelopeSignatures: [legacy],
        persist: () =>
          Effect.sync(() => {
            writes += 1
          })
      })
      yield* store.grantEnvelope(envelope)
      yield* store.check(new Capability({ action: "fs:read", resource: patterns[0]!.resource }))
      expect(writes).toBe(0)
    })))
})

describe("legacy signature admission bounds", () => {
  it.effect("rejects oversized or non-string seeds without persisting", () =>
    Effect.scoped(Effect.gen(function*() {
      for (
        const seed of [42, "x".repeat(4097), "{" + "x".repeat(GrantStore.maximumEventBytes), "{" + "界".repeat(100_000)]
      ) {
        let writes = 0
        const failure = yield* Effect.flip(make({
          envelopeSignatures: [seed as string],
          persist: () =>
            Effect.sync(() => {
              writes += 1
            })
        }))
        expect(failure.code).toBe("invalid_resolution")
        expect(writes).toBe(0)
      }
    })))

  it.effect("does not treat noncanonical JSON seeds as durable envelope digests", () =>
    Effect.scoped(Effect.gen(function*() {
      const fields = { planDigest: "plan-1", scope: "run", patterns: [format(safePattern())] }
      const seeds = [
        "{",
        JSON.stringify({ ...fields, planDigest: "" }),
        JSON.stringify({ ...fields, patterns: ["invalid"] }),
        JSON.stringify({ ...fields, patterns: [format(safePattern()), format(safePattern())] })
      ]
      for (const seed of seeds) {
        let writes = 0
        yield* make({
          planDigest: "plan-1",
          envelopeSignatures: [seed],
          envelope: { planDigest: "plan-1", patterns: [safePattern()] },
          persist: () =>
            Effect.sync(() => {
              writes += 1
            })
        })
        expect(writes).toBe(1)
      }
    })))

  it.effect("counts seeded patterns missing from replay and preserves captured run ceilings", () =>
    Effect.scoped(Effect.gen(function*() {
      const patterns = [safePattern()]
      const envelope = { planDigest: "plan-1", patterns }
      const envelopeSignatures = [GrantStore.envelopeSignature("plan-1", "run", patterns)]
      const failure = yield* Effect.flip(
        make({
          planDigest: "plan-1",
          envelope,
          envelopeSignatures,
          rules: Array.from({ length: GrantStore.maximumRules - 1 }, deny),
          runRules: [{ rule: new Rule({ effect: "allow", pattern: safePattern() }), ceiling: [[]] }]
        })
      )
      expect(failure.code).toBe("invalid_resolution")
      const store = yield* make({
        attended: false,
        planDigest: "plan-1",
        envelope,
        envelopeSignatures,
        runRules: [deny()]
      })
      yield* store.check(safe)
    })))
})

it.effect("reactivates a seeded remembered envelope after a supplied ask rule", () =>
  Effect.scoped(Effect.gen(function*() {
    const pattern = safePattern()
    const store = yield* make({
      attended: false,
      planDigest: "plan-1",
      rules: [[], [new Rule({ effect: "allow", pattern }), new Rule({ effect: "ask", pattern })]],
      envelopeSignatures: [GrantStore.envelopeSignature("plan-1", "remembered", [pattern])],
      envelope: { planDigest: "plan-1", scope: "remembered", patterns: [pattern] }
    })
    yield* store.check(safe)
  })))
