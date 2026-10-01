/**
 * The trampoline against the durable store: what a lineage leaves behind, and
 * what survives a process that dies in the middle of one.
 *
 * `packages/smithers/flows/engine/docs/concepts/trampoline-rounds.md` makes each round its own
 * execution, chained under one lineage. That is four durable claims, and each
 * has a case here: the chain is `parent_run_id` plus the lineage pair and NOT
 * a `flows_run_parents` edge; the next round's id is derived, so a re-drive
 * lands on the round that already exists; a settled lineage replays flat; and
 * the round budget terminates a lineage with a typed failure instead of
 * running forever.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import * as Notifying from "@smthrs/journal/test/Notifying"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as WakeBus from "../src/WakeBus.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "trampoline-snapshot" as never, changeId: "trampoline-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const Increment = Action.make("trampoline/increment", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

/** The declaration shape every counter in this suite shares. */
type CounterFlow = Flow.Flow<
  string,
  Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Schema.Never,
  // `.to()` drops the callee's requirements, so a lineage that hands off to
  // itself names only what one round calls and the type stays finite.
  Action.Requirement<"trampoline/increment">
>

/** The recursion edge a body cannot name inside its own declaration. */
const counters = new Map<string, CounterFlow>()

const counter = (tag: string, maxRounds?: number): CounterFlow => {
  const flow = Flow.make(tag, {
    payload: { value: Schema.Number, target: Schema.Number },
    success: Schema.Number,
    ...(maxRounds === undefined ? {} : { maxRounds }),
    body: ({ target, value }: { readonly value: number; readonly target: number }) =>
      Increment.call({ value }).pipe(
        Node.branch({
          if: (next) => next >= target,
          then: (next) => Flow.done(next),
          else: (next) => counters.get(tag)!.to({ value: next, target })
        })
      )
  })
  counters.set(tag, flow)
  return flow
}

const Counter = counter("trampoline/counter")
const Bounded = counter("trampoline/bounded", 2)

/** A two-leg lineage, so host routing can admit one leg while refusing the other. */
const LegTwo = Flow.make("trampoline/leg-two", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Increment.call({ value })
})

const LegOne = Flow.make("trampoline/leg-one", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) =>
    Increment.call({ value }).pipe(
      Node.bindPlanned((next) => LegTwo.to({ value: next }))
    )
})

const OriginBounded = Flow.make("trampoline/origin-bounded", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  maxRounds: 1,
  body: ({ value }) => LegTwo.to({ value })
})

const ParentActionDeclaration = Action.make("trampoline/parent/action", {
  payload: { target: Schema.Number },
  success: Schema.Number
})
const Parent = Flow.make("trampoline/parent", {
  payload: { target: Schema.Number },
  success: Schema.Number,
  body: (payload) => ParentActionDeclaration.call(payload)
})

/** A round that parks instead of answering. */
const Gate = Flow.make("trampoline/gate", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: () => Flow.park({ reason: "approval", token: "gate-token" })
})

const Opening = Flow.make("trampoline/opening", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) =>
    Increment.call({ value }).pipe(
      Node.bindPlanned((next) => Gate.to({ value: next }))
    )
})

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  AttemptStore.layer,
  CacheStore.layer,
  DurableEngineState.layer
).pipe(
  Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)),
  Layer.merge(OwnerIdentity.layer),
  Layer.merge(StepBoundary.layerTest()),
  Layer.merge(Layer.succeed(Jj.Jj, jj))
)

/** One engine incarnation over already-provided stores, and what it dispatched. */
const incarnation = (
  hostId: string,
  interpreters: ReadonlyArray<Layer.Layer<never, never, FlowRuntime.FlowRuntime | Action.Implementations>>,
  storeOverride?: RunStore.RunStore["Service"],
  canExecute?: EngineStore.Options["canExecute"]
) =>
  Effect.gen(function*() {
    const calls: Array<number> = []
    const makeEngine = EngineStore.make({
      owner: { hostId },
      journalSource: `trampoline-${hostId}`,
      isAlive: () => Effect.succeed(false),
      ...(canExecute === undefined ? {} : { canExecute })
    })
    const engine = yield* storeOverride === undefined
      ? makeEngine
      : makeEngine.pipe(Effect.provideService(RunStore.RunStore, storeOverride))
    const wiring = Layer.mergeAll(
      Increment.toLayer(({ value }) =>
        Effect.sync(() => {
          calls.push(value)
          return value + 1
        })
      ),
      ...interpreters
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
    )
    return { calls, wiring: yield* Layer.build(wiring) }
  })

/** Lands one external cancel in the seam immediately before its guarded transition. */
const cancelRaceStore = (
  store: RunStore.RunStore["Service"],
  executionId: string,
  terminalStatus: RunStore.RunStatus
): RunStore.RunStore["Service"] => {
  let requested = false
  return Notifying.wrap(store, (op, order, args) => {
    if (
      !requested &&
      op === "transitionOwned" &&
      order === "before" &&
      args[0] === executionId &&
      args[2] === terminalStatus
    ) {
      requested = true
      return store.requestCancel(executionId, 1).pipe(Effect.asVoid, Effect.orDie)
    }
    return Effect.void
  })
}

/** Presents one otherwise-valid persisted row with a malformed round ordinal. */
const invalidRoundStore = (
  store: RunStore.RunStore["Service"],
  executionId: string
): RunStore.RunStore["Service"] =>
  RunStore.makeNoop({
    ...store,
    get: (runId) =>
      store.get(runId).pipe(
        Effect.map((row) =>
          runId === executionId
            ? { ...row, lineageId: executionId, roundOrdinal: -1 }
            : row
        )
      )
  })

type DurableServices = Layer.Success<typeof services>

/** Runs one body against a fresh database and the real durable stores. */
const durable = <A, E>(body: Effect.Effect<A, E, DurableServices | Crypto.Crypto | Scope.Scope>) =>
  withCrypto(body.pipe(Effect.scoped, Effect.provide(services)))

const roundId = (lineageId: string, ordinal: number) => sha256(JSON.stringify(["flow-round/v2", lineageId, ordinal]))

const Suspended = Flow.make("trampoline/suspended", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const suspensionPolicy = RetryPolicy.make({
  initialMs: 5_000,
  factor: 1,
  maxMs: 5_000,
  maxAttempts: 2
})

const PollingGate = Flow.make("trampoline/polling-gate", {
  payload: {},
  success: Schema.String,
  suspendedRetryPolicy: RetryPolicy.make({ initialMs: 5_000, factor: 1, maxMs: 5_000 }),
  body: () => Flow.park({ reason: "approval", token: "polling-gate" })
})

const claimsFor = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 100 })
    return page.entries.filter((entry) =>
      entry.eventType === "flows.engine.run-decision" &&
      (entry.payload as { readonly decision?: string }).decision === "claimed-and-activated"
    ).length
  })

describe("a durable suspended caller", () => {
  it.effect("survives three wake signals with maxAttempts 2 and completes when its wait is answered", () =>
    Effect.gen(function*() {
      const gate = DurableDeferred.make("trampoline-repeated-wakes", { success: Schema.String })
      const baseBus = WakeBus.makeUnsafe()
      let waitRegistrations = 0
      const bus: WakeBus.Service = {
        ...baseBus,
        awaitWake: (executionId) =>
          Effect.sync(() => {
            waitRegistrations++
          }).pipe(Effect.andThen(baseBus.awaitWake(executionId)))
      }
      const observed = yield* durable(
        Effect.gen(function*() {
          const engine = (yield* EngineStore.make({
            owner: { hostId: "repeated-wake-host" },
            journalSource: "trampoline-repeated-wakes",
            isAlive: () => Effect.succeed(false)
          })) as FlowRuntime.FlowRuntime["Service"]
          yield* engine.register(Suspended, () => DurableDeferred.await(gate))
          const caller = yield* engine.execute(Suspended, {
            executionId: "repeated-wake-lineage",
            payload: {},
            discard: false,
            suspendedRetryPolicy: suspensionPolicy
          }).pipe(Effect.forkChild({ startImmediately: true }))

          yield* TestDatabase.until(Effect.gen(function*() {
            return waitRegistrations === 1 && (yield* bus.waiters("repeated-wake-lineage")) === 1
          }))
          for (const nextRegistration of [2, 3, 4]) {
            yield* bus.wake("repeated-wake-lineage")
            yield* TestDatabase.until(Effect.gen(function*() {
              return caller.pollUnsafe() !== undefined ||
                (waitRegistrations >= nextRegistration && (yield* bus.waiters("repeated-wake-lineage")) === 1)
            }))
            if (caller.pollUnsafe() !== undefined) break
          }
          const premature = caller.pollUnsafe() !== undefined
          yield* engine.deferredDone(gate, {
            flowName: Suspended._tag,
            executionId: "repeated-wake-lineage",
            deferredName: gate.name,
            exit: Exit.succeed("answered")
          })
          const answer = yield* Effect.exit(Fiber.join(caller))
          return { premature, waitRegistrations, answer }
        }).pipe(
          Effect.provideService(WakeBus.WakeBus, bus),
          Effect.provide(TestClock.layer())
        )
      )

      expect(observed.premature).toBe(false)
      expect(observed.waitRegistrations).toBe(4)
      expect(observed.answer).toEqual(Exit.succeed("answered"))
    }))

  it.effect("makes exactly one durable claim for one elapsed suspension poll", () =>
    Effect.gen(function*() {
      const bus = WakeBus.makeUnsafe()
      const observed = yield* durable(
        Effect.gen(function*() {
          const engine = (yield* EngineStore.make({
            owner: { hostId: "elapsed-poll-host" },
            journalSource: "trampoline-elapsed-poll",
            isAlive: () => Effect.succeed(false)
          })) as FlowRuntime.FlowRuntime["Service"]
          const registered = yield* Layer.build(
            Interpreter.layer(PollingGate).pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
            )
          )
          const caller = yield* PollingGate.execute({}, { executionId: "elapsed-poll-lineage" }).pipe(
            Effect.provide(registered),
            Effect.forkChild({ startImmediately: true })
          )
          yield* TestDatabase.until(Effect.map(bus.waiters("elapsed-poll-lineage"), (count) => count === 1))
          const before = yield* claimsFor("elapsed-poll-lineage")

          yield* TestClock.adjust("5 seconds")
          yield* TestDatabase.until(Effect.gen(function*() {
            return (yield* claimsFor("elapsed-poll-lineage")) > before &&
              (yield* bus.waiters("elapsed-poll-lineage")) === 1
          }))
          const after = yield* claimsFor("elapsed-poll-lineage")
          yield* Fiber.interrupt(caller)
          return { before, after }
        }).pipe(
          Effect.provideService(WakeBus.WakeBus, bus),
          Effect.provide(TestClock.layer())
        )
      )

      expect(observed.before).toBe(1)
      expect(observed.after - observed.before).toBe(1)
    }))
})

describe("a durable lineage", () => {
  it.effect("counts to its target across rounds, chaining each one under the lineage", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState
        const { calls, wiring } = yield* incarnation("counter-host", [Interpreter.layer(Counter)])

        const value = yield* Counter.execute({ value: 0, target: 3 }, {
          executionId: "durable-lineage"
        }).pipe(Effect.provide(wiring))

        const rows = yield* Effect.forEach(
          ["durable-lineage", roundId("durable-lineage", 1), roundId("durable-lineage", 2)],
          (runId) => store.get(runId)
        )
        const edges = yield* Effect.forEach(
          rows.map((row) => row.runId),
          (runId) => state.runParents(runId)
        )
        const journal = yield* Journal.Journal
        yield* journal.flush
        const journalLineages = yield* Effect.forEach(
          rows,
          (row) =>
            journal.entries({ runId: row.runId as never, limit: 100 }).pipe(
              Effect.map((page) =>
                page.entries
                  .filter((entry) => entry.eventType === "flows.engine.run-decision")
                  .map((entry) => (entry.meta as { readonly lineageId?: string }).lineageId)
              )
            )
        )
        return { calls, value, rows, edges, journalLineages }
      }))

      expect(observed.value).toBe(3)
      // One dispatch per round: the lineage ran three rounds, not three copies
      // of one round.
      expect(observed.calls).toEqual([0, 1, 2])
      expect(observed.rows.map((row) => row.status)).toEqual(["completed", "completed", "completed"])
      // Round 0 records the lineage and ordinal too; only its continue-as-new
      // parent is absent.
      expect(observed.rows[0]?.parentRunId).toBeNull()
      expect(observed.rows[0]?.lineageId).toBe("durable-lineage")
      expect(observed.rows[0]?.roundOrdinal).toBe(0)
      expect(observed.rows[1]?.parentRunId).toBe("durable-lineage")
      expect(observed.rows[1]?.lineageId).toBe("durable-lineage")
      expect(observed.rows[1]?.roundOrdinal).toBe(1)
      expect(observed.rows[2]?.parentRunId).toBe(roundId("durable-lineage", 1))
      expect(observed.rows[2]?.lineageId).toBe("durable-lineage")
      expect(observed.rows[2]?.roundOrdinal).toBe(2)
      // A round is the same run continuing, not a spawned child, so the subflow
      // edge table the cycle walk reads stays empty.
      expect(observed.edges).toEqual([[], [], []])
      // A round's decisions address that round's own JOURNAL lineage — the same
      // one its attempt and snapshot records carry, so a rewind of the round
      // does not skip the decisions that describe it. The trampoline lineage is
      // the run row's `lineageId` above, and it travels in the `created` and
      // `handed-off` decision payloads.
      expect(
        observed.journalLineages.every((lineages, index) =>
          lineages.length > 0 &&
          lineages.every((lineage) => lineage === FlowEngine.Lineage.root(observed.rows[index]!.runId))
        )
      ).toBe(true)
    }))

  it.effect("keeps child ancestry across every round so the parent can cancel the lineage", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const engine = yield* EngineStore.make({
          owner: { hostId: "child-host" },
          journalSource: "trampoline-child-host",
          isAlive: () => Effect.succeed(false)
        })
        const calls: Array<number> = []
        const increment = Increment.toLayer(({ value }) =>
          Effect.sync(() => {
            calls.push(value)
            return value + 1
          })
        )
        const wiring = Layer.mergeAll(
          increment,
          Interpreter.layer(Counter),
          Layer.mergeAll(
            // The constructed child payload always satisfies its schema, so
            // the typed SchemaError on execute cannot occur and is disposed of
            // as a defect.
            ParentActionDeclaration.toLayer(({ target }) =>
              Effect.orDie(Counter.execute({ value: 0, target }, { executionId: "durable-child-lineage" }))
            ),
            Interpreter.layer(Parent)
          ).pipe(
            // `Counter.execute` declares the increment it hands off to.
            Layer.provide(increment),
            Layer.provideMerge(Action.layerImplementations)
          )
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )

        const value = yield* Parent.execute({ target: 3 }, {
          executionId: "durable-parent"
        }).pipe(Effect.provide(wiring))
        const childEdges = yield* state.runParents("durable-child-lineage")
        const laterEdges = yield* Effect.forEach(
          [roundId("durable-child-lineage", 1), roundId("durable-child-lineage", 2)],
          (runId) => state.runParents(runId)
        )
        return { calls, childEdges, laterEdges, value }
      }))

      expect(observed.value).toBe(3)
      expect(observed.calls).toEqual([0, 1, 2])
      expect(observed.childEdges.map((edge) => edge.parentId)).toEqual(["durable-parent"])
      expect(observed.laterEdges.map((edges) => edges.map((edge) => edge.parentId))).toEqual([["durable-parent"], [
        "durable-parent"
      ]])
    }))

  it.effect("replays a settled lineage flat, without re-running any earlier round", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const first = yield* incarnation("replay-first", [Interpreter.layer(Counter)])
        const value = yield* Counter.execute({ value: 0, target: 3 }, {
          executionId: "replay-lineage"
        }).pipe(Effect.provide(first.wiring))

        // A second incarnation over the same storage: the lineage is settled, so
        // asking for it again is a read.
        const second = yield* incarnation("replay-second", [Interpreter.layer(Counter)])
        const replayed = yield* Counter.execute({ value: 0, target: 3 }, {
          executionId: "replay-lineage"
        }).pipe(Effect.provide(second.wiring))

        const rows = yield* Effect.forEach(
          [roundId("replay-lineage", 1), roundId("replay-lineage", 2)],
          (runId) => store.get(runId)
        )
        const beyond = yield* Effect.exit(store.get(roundId("replay-lineage", 3)))
        return { first: first.calls, second: second.calls, value, replayed, rows, beyond }
      }))

      expect(observed.value).toBe(3)
      expect(observed.replayed).toBe(3)
      expect(observed.first).toEqual([0, 1, 2])
      // Nothing re-executed, and no fourth round was opened by the replay.
      expect(observed.second).toEqual([])
      expect(observed.rows.map((row) => row.roundOrdinal)).toEqual([1, 2])
      expect(Exit.isFailure(observed.beyond)).toBe(true)
    }))

  it.effect("re-derives the same round after a worker that could not run it goes away", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        expect(sql.onDialectOrElse({ pg: () => "pg", orElse: () => "sqlite" })).toBe(
          process.env.SMITHERS_TEST_PG_URL ? "pg" : "sqlite"
        )
        const store = yield* RunStore.RunStore
        // Reachable handoffs register their declarations now. This host is
        // routed only to leg one: it commits the successor but cannot claim it.
        // Closing its actual engine scope leaves the next worker only storage.
        const partial = yield* Effect.scoped(Effect.gen(function*() {
          const refused: Array<string> = []
          const worker = yield* incarnation("crash-partial", [Interpreter.layer(LegOne)], undefined, (row) =>
            Effect.sync(() => {
              if (row.runId !== roundId("crash-lineage", 1)) {
                return true
              }
              refused.push(row.runId)
              return false
            }))
          yield* LegOne.execute({ value: 0 }, {
            executionId: "crash-lineage",
            discard: true
          }).pipe(Effect.provide(worker.wiring))
          yield* TestDatabase.until(Effect.map(store.get("crash-lineage"), (row) =>
            row.status === "completed"))
          yield* TestDatabase.until(Effect.sync(() =>
            refused.length > 0
          ))
          return {
            calls: worker.calls,
            refused,
            stranded: yield* store.get(roundId("crash-lineage", 1)),
            settledRoot: yield* store.get("crash-lineage")
          }
        }))

        // A worker that knows both legs picks the lineage up from the root, and
        // re-derives the id of the round that is already durable.
        const whole = yield* incarnation("crash-whole", [Interpreter.layer(LegOne), Interpreter.layer(LegTwo)])
        const value = yield* LegOne.execute({ value: 0 }, {
          executionId: "crash-lineage"
        }).pipe(Effect.provide(whole.wiring))

        const finished = yield* store.get(roundId("crash-lineage", 1))
        return {
          partial: partial.calls,
          refused: partial.refused,
          whole: whole.calls,
          stranded: partial.stranded,
          settledRoot: partial.settledRoot,
          value,
          finished
        }
      }))

      expect(observed.settledRoot.status).toBe("completed")
      expect(observed.stranded.status).toBe("pending")
      expect(observed.stranded.roundOrdinal).toBe(1)
      expect(observed.stranded.owner).toBeNull()
      expect(observed.refused).toContain(roundId("crash-lineage", 1))
      expect(observed.value).toBe(2)
      // Round 0's increment ran on the first worker and was NOT run again on the
      // second: the re-drive resolved the settled round from storage.
      expect(observed.partial).toEqual([0])
      expect(observed.whole).toEqual([1])
      expect(observed.finished.status).toBe("completed")
      expect(observed.finished.runId).toBe(observed.stranded.runId)
    }))

  it.effect("rolls successor creation back when cancellation races the handoff transition", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const racing = cancelRaceStore(store, "handoff-cancel-race", "completed")
        const { calls, wiring } = yield* incarnation("handoff-cancel-host", [Interpreter.layer(Counter)], racing)
        yield* Counter.execute({ value: 0, target: 2 }, {
          executionId: "handoff-cancel-race",
          discard: true
        }).pipe(Effect.provide(wiring))
        yield* TestDatabase.until(Effect.map(store.get("handoff-cancel-race"), (row) => row.status === "cancelled"))
        const successor = yield* Effect.exit(store.get(roundId("handoff-cancel-race", 1)))
        return { calls, root: yield* store.get("handoff-cancel-race"), successor }
      }))

      expect(observed.calls).toEqual([0])
      expect(observed.root.status).toBe("cancelled")
      expect(Exit.isFailure(observed.successor)).toBe(true)
    }))

  it.effect("rolls successor creation back when the handoff transition loses ownership", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        let refused = false
        const fenceLost = RunStore.makeNoop({
          ...store,
          transitionOwned: (runId, claimant, status, stateJson, guard) =>
            runId === "handoff-fence-race" && status === "completed"
              ? store.transitionOwned(runId, { hostId: "other", pid: 1, nonce: "other" }, status, stateJson, guard)
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      refused = true
                    })
                  )
                )
              : store.transitionOwned(runId, claimant, status, stateJson, guard)
        })
        const { calls, wiring } = yield* incarnation("handoff-fence-host", [Interpreter.layer(Counter)], fenceLost)
        yield* Counter.execute({ value: 0, target: 2 }, {
          executionId: "handoff-fence-race",
          discard: true
        }).pipe(Effect.provide(wiring))
        yield* TestDatabase.until(Effect.sync(() => refused))
        return {
          calls,
          successor: yield* Effect.exit(store.get(roundId("handoff-fence-race", 1)))
        }
      }))

      expect(observed.calls).toEqual([0])
      expect(Exit.isFailure(observed.successor)).toBe(true)
    }))

  it.effect("tags every derived-id collision in persisted round metadata", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const successorPayload = yield* Schema.encodeEffect(
          Schema.toCodecJson(Counter.payloadSchema)
        )({ value: 1, target: 2 })
        const rootPayload = yield* Schema.encodeEffect(
          Schema.toCodecJson(Counter.payloadSchema)
        )({ value: 0, target: 2 })
        const cases = [
          {
            name: "missing-lineage",
            metadata: undefined,
            field: "lineage",
            expected: "no lineage",
            actual: "missing-lineage"
          },
          {
            name: "other-lineage",
            metadata: { lineageId: "someone-else", roundOrdinal: 1, parentRunId: "other-lineage" },
            field: "lineage",
            expected: "someone-else",
            actual: "other-lineage"
          },
          {
            name: "other-round",
            metadata: { lineageId: "other-round", roundOrdinal: 2, parentRunId: "other-round" },
            field: "round",
            expected: "2",
            actual: "1"
          },
          {
            name: "missing-parent",
            metadata: { lineageId: "missing-parent", roundOrdinal: 1 },
            field: "parent",
            expected: "no parent",
            actual: "missing-parent"
          },
          {
            name: "other-parent",
            metadata: { lineageId: "other-parent", roundOrdinal: 1, parentRunId: "someone-else" },
            field: "parent",
            expected: "someone-else",
            actual: "other-parent"
          }
        ] as const

        yield* store.create(
          "someone-else",
          JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: Counter._tag, payload: rootPayload })
        )

        return yield* Effect.forEach(cases, (testCase) =>
          Effect.gen(function*() {
            // Keep the colliding rows intact: this worker admits only the root under test.
            const { wiring } = yield* incarnation(
              `${testCase.name}-host`,
              [Interpreter.layer(Counter)],
              undefined,
              (row) => Effect.succeed(row.runId === testCase.name)
            )
            const successor = roundId(testCase.name, 1)
            yield* store.create(
              testCase.name,
              JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: Counter._tag, payload: rootPayload }),
              { lineageId: testCase.name, roundOrdinal: 0 }
            )
            yield* testCase.metadata === undefined
              ? store.create(
                successor,
                JSON.stringify({
                  capabilityCeilings: [[]],
                  version: 1,
                  flowName: Counter._tag,
                  payload: successorPayload
                })
              )
              : store.create(
                successor,
                JSON.stringify({
                  capabilityCeilings: [[]],
                  version: 1,
                  flowName: Counter._tag,
                  payload: successorPayload
                }),
                testCase.metadata
              )

            const exit = yield* Counter.execute({ value: 0, target: 2 }, {
              executionId: testCase.name
            }).pipe(Effect.exit, Effect.provide(wiring))
            const defect = Exit.isFailure(exit)
              ? exit.cause.reasons.find(Cause.isFailReason)?.error
              : undefined
            return { testCase, defect }
          }))
      }))

      for (const { defect, testCase } of observed) {
        expect(defect).toBeInstanceOf(FlowEngine.ExecutionIdentityConflict)
        expect(defect).toMatchObject({
          code: "execution_identity_conflict",
          executionId: roundId(testCase.name, 1),
          field: testCase.field,
          expected: testCase.expected,
          actual: testCase.actual
        })
      }
    }))

  it.effect("ends the lineage with the typed refusal when the round budget is spent", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const { calls, wiring } = yield* incarnation("bounded-host", [Interpreter.layer(Bounded)])
        const exit = yield* Bounded.execute({ value: 0, target: 99 }, {
          executionId: "bounded-lineage"
        }).pipe(Effect.exit, Effect.provide(wiring))

        const last = yield* store.get(roundId("bounded-lineage", 1))
        const beyond = yield* Effect.exit(store.get(roundId("bounded-lineage", 2)))
        return { calls, exit, last, beyond }
      }))

      expect(Exit.isFailure(observed.exit)).toBe(true)
      expect(Exit.isFailure(observed.exit) && observed.exit.cause.toString()).toContain("MaxRoundsExceeded")
      expect(observed.calls).toEqual([0, 1])
      // The round that asked for the handoff is the one that fails, and no
      // successor is opened for it.
      expect(observed.last.status).toBe("failed")
      expect(Exit.isFailure(observed.beyond)).toBe(true)
    }))

  it.effect("fails a handoff whose persisted round identity is malformed", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const malformed = invalidRoundStore(store, "invalid-round-lineage")
        const { calls, wiring } = yield* incarnation("invalid-round-host", [Interpreter.layer(Counter)], malformed)
        const exit = yield* Counter.execute({ value: 0, target: 2 }, {
          executionId: "invalid-round-lineage"
        }).pipe(Effect.exit, Effect.provide(wiring))
        return {
          calls,
          exit,
          root: yield* store.get("invalid-round-lineage"),
          successor: yield* Effect.exit(store.get(roundId("invalid-round-lineage", 0)))
        }
      }))

      expect(observed.calls).toEqual([0])
      expect(observed.root.status).toBe("failed")
      expect(Exit.isFailure(observed.exit) && observed.exit.cause.toString()).toContain("InvalidRound")
      expect(Exit.isFailure(observed.successor)).toBe(true)
    }))

  it.effect("honors cancellation that races an invalid-round terminal transition", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const racing = cancelRaceStore(store, "invalid-round-cancel-race", "failed")
        const malformed = invalidRoundStore(racing, "invalid-round-cancel-race")
        const { calls, wiring } = yield* incarnation(
          "invalid-round-cancel-host",
          [Interpreter.layer(Counter)],
          malformed
        )
        yield* Counter.execute({ value: 0, target: 2 }, {
          executionId: "invalid-round-cancel-race",
          discard: true
        }).pipe(Effect.provide(wiring))
        yield* TestDatabase.until(
          Effect.map(store.get("invalid-round-cancel-race"), (row) => row.status === "cancelled")
        )
        return { calls, root: yield* store.get("invalid-round-cancel-race") }
      }))

      expect(observed.calls).toEqual([0])
      expect(observed.root.status).toBe("cancelled")
    }))

  it.effect("honors cancellation that races the max-round terminal transition", () =>
    Effect.gen(function*() {
      const SingleRound = counter("trampoline/single-round", 1)
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const racing = cancelRaceStore(store, "budget-cancel-race", "failed")
        const { calls, wiring } = yield* incarnation("budget-cancel-host", [Interpreter.layer(SingleRound)], racing)
        yield* SingleRound.execute({ value: 0, target: 2 }, {
          executionId: "budget-cancel-race",
          discard: true
        }).pipe(Effect.provide(wiring))
        yield* TestDatabase.until(Effect.map(store.get("budget-cancel-race"), (row) => row.status === "cancelled"))
        return { calls, root: yield* store.get("budget-cancel-race") }
      }))

      expect(observed.calls).toEqual([0])
      expect(observed.root.status).toBe("cancelled")
    }))

  it.effect.each(
    [
      ["the max-round", "budget-fence-race", 1, undefined],
      ["an invalid-round", "invalid-round-fence-race", 99, "invalid"]
    ] as const
  )(
    "leaves %s terminal transition that lost ownership to its new owner",
    ([_name, executionId, rounds, malformed]) =>
      Effect.gen(function*() {
        const Limited = counter(`trampoline/fence-${executionId}`, rounds)
        const observed = yield* durable(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          let refused = false
          const fenceLost = RunStore.makeNoop({
            ...store,
            transitionOwned: (runId, claimant, status, stateJson, guard) =>
              runId === executionId && status === "failed"
                ? store.transitionOwned(runId, { hostId: "other", pid: 1, nonce: "other" }, status, stateJson, guard)
                  .pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        refused = true
                      })
                    )
                  )
                : store.transitionOwned(runId, claimant, status, stateJson, guard)
          })
          const racing = malformed === undefined ? fenceLost : invalidRoundStore(fenceLost, executionId)
          const { calls, wiring } = yield* incarnation(`${executionId}-host`, [Interpreter.layer(Limited)], racing)
          yield* Limited.execute({ value: 0, target: 2 }, { executionId, discard: true }).pipe(Effect.provide(wiring))
          yield* TestDatabase.until(Effect.sync(() => refused))
          return { calls, root: yield* store.get(executionId) }
        }))

        expect(observed.calls).toEqual([0])
        // The refused transition wrote nothing: the row is still the running
        // round the lost owner held, not a failure it could not commit.
        expect(observed.root.status).toBe("running")
      })
  )

  it.effect("persists the origin flow's budget across a handoff to another flow", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const { calls, wiring } = yield* incarnation("origin-budget-host", [
          Interpreter.layer(OriginBounded),
          Interpreter.layer(LegTwo)
        ])
        const exit = yield* OriginBounded.execute({ value: 0 }, {
          executionId: "origin-budget-lineage"
        }).pipe(Effect.exit, Effect.provide(wiring))
        const root = yield* store.get("origin-budget-lineage")
        const beyond = yield* Effect.exit(store.get(roundId("origin-budget-lineage", 1)))
        return { calls, exit, root, beyond }
      }))

      expect(Exit.isFailure(observed.exit)).toBe(true)
      expect(Exit.isFailure(observed.exit) && observed.exit.cause.toString()).toContain("MaxRoundsExceeded")
      expect(observed.calls).toEqual([])
      expect(observed.root.status).toBe("failed")
      expect(Exit.isFailure(observed.beyond)).toBe(true)
    }))

  it.effect("parks the round it is in, and a wake re-drives that same round", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState
        const { calls, wiring } = yield* incarnation("park-host", [Interpreter.layer(Opening), Interpreter.layer(Gate)])
        const registered = wiring

        yield* Opening.execute({ value: 0 }, {
          executionId: "park-lineage",
          discard: true
        }).pipe(Effect.provide(registered))

        yield* TestDatabase.until(
          store.get(roundId("park-lineage", 1)).pipe(
            Effect.map((row) => row.status === "suspended"),
            Effect.catchIf((error) => error.code === "not_found_row", () => Effect.succeed(false))
          )
        )
        const readPark = state.transaction(Effect.gen(function*() {
          return {
            parked: yield* store.get(roundId("park-lineage", 1)),
            waiting: yield* state.waiting(roundId("park-lineage", 1))
          }
        }))
        let snapshot = yield* readPark
        // Handoff also enqueues its successor; a concurrent queued wake can be
        // running when discard returns. Assert one coherent settled park.
        for (let attempt = 0; attempt < 2_000 && snapshot.parked.status !== "suspended"; attempt++) {
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
          snapshot = yield* readPark
        }
        const { parked, waiting } = snapshot

        yield* Gate.resume(roundId("park-lineage", 1)).pipe(Effect.provide(registered))

        const resumed = yield* store.get(roundId("park-lineage", 1))
        const beyond = yield* Effect.exit(store.get(roundId("park-lineage", 2)))
        return { calls, parked, waiting, resumed, beyond }
      }))

      // The lineage is suspended AT round 1, under the reason and token the body
      // declared rather than the derived timer/event default.
      expect(observed.parked.status).toBe("suspended")
      expect(observed.parked.lineageId).toBe("park-lineage")
      expect(observed.parked.roundOrdinal).toBe(1)
      expect(observed.waiting._tag).toBe("Some")
      expect(observed.waiting._tag === "Some" && observed.waiting.value.reason).toBe("approval")
      expect(observed.waiting._tag === "Some" && observed.waiting.value.token).toBe("gate-token")
      // The wake re-entered round 1 rather than opening a round 2, and round 0's
      // work was not repeated.
      expect(observed.resumed.roundOrdinal).toBe(1)
      expect(Exit.isFailure(observed.beyond)).toBe(true)
      expect(observed.calls).toEqual([0])
    }))
})

describe("the lineage columns", () => {
  it.effect("are indexed together so a lineage reads back in round order", () =>
    Effect.gen(function*() {
      const ordinals = yield* durable(Effect.gen(function*() {
        const { wiring } = yield* incarnation("order-host", [Interpreter.layer(Counter)])
        yield* Counter.execute({ value: 0, target: 3 }, {
          executionId: "order-lineage"
        }).pipe(Effect.provide(wiring))
        const sql = yield* Effect.service(SqlClient.SqlClient)
        return yield* sql<{ readonly roundOrdinal: number }>`
        SELECT round_ordinal AS "roundOrdinal"
        FROM flows_runs
        WHERE lineage_id = 'order-lineage'
        ORDER BY round_ordinal
      `
      }))

      expect(ordinals.map((row) => Number(row.roundOrdinal))).toEqual([0, 1, 2])
    }))
})
