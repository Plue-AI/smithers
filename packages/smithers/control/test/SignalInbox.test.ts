import { Deferred, Effect, Fiber, type Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { PersistenceError, RunNotFound } from "../src/ControlError.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import { durable } from "./DurableStack.ts"
import { memoryRuntime } from "./TestStack.ts"

const start = Effect.gen(function*() {
  const runtime = yield* ControlRuntime
  const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
  const token = yield* runtime.lookupApproval(card.approval.target)
  yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal())
  const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
  if (launched._tag !== "Started") return yield* Effect.die("expected launch")
  return launched.run.runId
})
const backends: ReadonlyArray<readonly [string, Layer.Layer<ControlRuntime>]> = [
  ["memory", memoryRuntime()],
  ["sql", durable()]
]

for (const [name, layer] of backends) {
  describe(`signal inbox (${name})`, () => {
    it("preserves admission, exclusive immutable binding, and terminal settlement", () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          const runId = yield* start
          const signal = { name: "ready", payload: { value: 1 } }
          yield* runtime.admitSignal("first", runId, signal)
          signal.payload.value = 2
          yield* runtime.admitSignal("first", runId, { name: "other", payload: null })
          const original = yield* runtime.signalCommand("first")
          expect(original).toMatchObject({
            signal: { name: "ready", payload: { value: 1 } },
            token: null,
            state: "pending"
          })
          Object.assign(original!.signal, { name: "changed snapshot" })
          expect((yield* runtime.signalCommand("first"))!.signal.name).toBe("ready")
          expect(yield* runtime.bindSignal("first", "wait-one")).toBe("wait-one")
          expect(yield* runtime.bindSignal("first", "wait-two")).toBe("wait-one")
          yield* runtime.admitSignal("second", runId, signal)
          expect(yield* runtime.bindSignal("second", "wait-one")).toBeNull()
          yield* runtime.settleSignal("first", "delivered")
          yield* runtime.settleSignal("first", "rejected")
          expect((yield* runtime.signalCommand("first"))!.state).toBe("delivered")
          expect(yield* runtime.bindSignal("first", "wait-three")).toBe("wait-one")
          yield* runtime.settleSignal("second", "terminal")
          expect(yield* runtime.bindSignal("second", "wait-four")).toBeNull()
          expect(yield* runtime.pendingSignals).toEqual([])
          yield* runtime.settleSignal("absent", "rejected")
          expect(yield* runtime.signalCommand("absent")).toBeUndefined()
          expect(yield* Effect.flip(runtime.bindSignal("absent", "wait-five"))).toBeInstanceOf(PersistenceError)
          expect(yield* Effect.flip(runtime.admitSignal("bad-run", "absent", signal))).toBeInstanceOf(RunNotFound)
        }).pipe(Effect.provide(layer), Effect.scoped)
      ))

    it("keeps legacy signal history readable without turning it into retryable inbox work", () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          const runId = yield* start
          const legacy = { name: "ready", payload: { legacy: true } }
          yield* runtime.deliverSignal(runId, legacy)
          legacy.payload.legacy = false
          expect(yield* runtime.deliveredSignals(runId)).toEqual([{ name: "ready", payload: { legacy: true } }])
          expect(yield* runtime.pendingSignals).toEqual([])
        }).pipe(Effect.provide(layer), Effect.scoped)
      ))

    it("a completed predecessor cannot remove the replacement drive", () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          const runId = yield* start
          const release = Deferred.makeUnsafe<void>()
          const first = yield* Deferred.await(release).pipe(Effect.forkChild({ startImmediately: true }))
          const second = yield* Effect.never.pipe(Effect.forkChild({ startImmediately: true }))
          yield* runtime.registerFiber(runId, first)
          yield* runtime.registerFiber(runId, second)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(first)
          yield* runtime.interrupt(runId)
          expect((yield* Effect.exit(Fiber.join(second)))._tag).toBe("Failure")
        }).pipe(Effect.provide(layer), Effect.scoped)
      ))

    it("rotates bounded pages without starving older commands and removes settled work", () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          const runId = yield* start
          expect(yield* runtime.pendingSignals).toEqual([])
          for (let index = 0; index < 101; index++) {
            yield* runtime.admitSignal(`command-${index}`, runId, { name: "ready", payload: index })
          }
          const first = yield* runtime.pendingSignals
          const second = yield* runtime.pendingSignals
          const again = yield* runtime.pendingSignals
          expect(first.map((item) => item.commandId)).toEqual(
            Array.from({ length: 100 }, (_, index) => `command-${index}`)
          )
          expect(second.map((item) => item.commandId)).toEqual(["command-100"])
          expect(again).toEqual(first)
          for (const command of [...first, ...second]) yield* runtime.settleSignal(command.commandId, "rejected")
          expect(yield* runtime.pendingSignals).toEqual([])
        }).pipe(Effect.provide(layer), Effect.scoped)
      ))
  })
}

it("quarantines malformed SQL inbox rows without blocking valid commands", () =>
  Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const sql = yield* SqlClient.SqlClient
      const runId = yield* start
      yield* runtime.admitSignal("bad", runId, { name: "ready", payload: null })
      yield* runtime.admitSignal("good", runId, { name: "ready", payload: "valid" })
      yield* sql`UPDATE control_signal_commands SET payload_json = '{"unexpected":true}' WHERE command_id = 'bad'`
      expect((yield* runtime.pendingSignals).map((command) => command.commandId)).toEqual(["good"])
      expect(
        (yield* sql<{ state: string }>`SELECT state FROM control_signal_commands WHERE command_id = 'bad'`)[0]!.state
      ).toBe("rejected")
      yield* runtime.settleSignal("good", "delivered")
      expect(yield* runtime.pendingSignals).toEqual([])
      expect(yield* Effect.flip(runtime.signalCommand("bad"))).toBeInstanceOf(PersistenceError)
    }).pipe(Effect.provide(durable()), Effect.scoped)
  ))

it("reports a failed durable claim rather than pretending another submitter won", () =>
  Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const sql = yield* SqlClient.SqlClient
      yield* sql`DROP TABLE control_run_keys ${
        sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
      }`
      expect(yield* Effect.flip(runtime.claimRunKey("claim", "fingerprint"))).toBeInstanceOf(PersistenceError)
    }).pipe(Effect.provide(durable()), Effect.scoped)
  ))
