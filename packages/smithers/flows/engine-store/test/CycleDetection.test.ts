import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("CycleDetection/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const owner: Ownership.OwnerId = {
  hostId: "host-cycles",
  pid: 1,
  nonce: "owner-cycles"
}

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const makeDriver = () =>
  RunDriver.make({
    owner,
    journalSource: "cycles",
    isAlive: () => Effect.succeed(true),
    engine: Effect.succeed(fakeEngine)
  })

const provideJournal = <A, E, R>(
  effect: Effect.Effect<A, E, R | Journal.Journal | RunStore.RunStore>
) =>
  effect.pipe(
    Effect.scoped,
    // All transaction participants must share one database. Mixing the map
    // state's mutex with SQL stores permits a map -> SQL / SQL -> map lock
    // inversion when a completed child's parent wakes during a second spawn.
    Effect.provide(TestStores.layerAt(":memory:")),
    Effect.provide(TestClock.layer())
  )

const findCycleFailure = (cause: Cause.Cause<unknown>) => cause.reasons.find(Cause.isFailReason)?.error

/**
 * Creates a run row the way the driver would have: the creating parent goes
 * into `state_json` AND the durable edge table. Since the redesign
 * (issues #54/#55/#56) the durable edge table is the single source of truth
 * for cycle detection — a persisted `parentExecutionId` whose edge does not
 * exist is not a cycle-detection input.
 */
const createRun = (id: string, parent?: string) =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    const state = yield* DurableEngineState.DurableEngineState
    yield* store.create(
      id,
      JSON.stringify({
        version: 1,
        flowName: TestFlow._tag,
        payload: {},
        ...(parent === undefined ? {} : { parentExecutionId: parent })
      }),
      { lineageId: id, roundOrdinal: 0 }
    )
    if (parent !== undefined) {
      yield* state.recordRunParent(id, parent)
    }
  })

describe("RunDriver cycle detection", () => {
  it.effect("fails a direct self-execute with a 1-element cycle path", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(Effect.exit(provideJournal(Effect.gen(function*() {
        const driver = yield* makeDriver()
        yield* driver.register(TestFlow, () => Effect.succeed("never runs"))
        return yield* driver.execute(TestFlow, {
          executionId: "self",
          payload: {},
          discard: true,
          parent: { executionId: "self" } as FlowRuntime.FlowInstance["Service"]
        })
      }))))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      const failure = findCycleFailure(exit.cause)
      expect(failure).toBeInstanceOf(RunDriver.FlowCycleDetected)
      expect((failure as RunDriver.FlowCycleDetected).code).toBe("flow_cycle_detected")
      expect((failure as RunDriver.FlowCycleDetected)._tag).toBe("@smthrs/flow/FlowCycleDetected")
      expect((failure as RunDriver.FlowCycleDetected).path).toEqual(["self"])
    }))

  it.effect("executes a legitimate deep parent chain with no cycle", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const driver = yield* makeDriver()
        yield* driver.register(TestFlow, () => Effect.succeed("ok"))

        yield* createRun("root")
        yield* createRun("child", "root")
        yield* createRun("grandchild", "child")

        return yield* driver.execute(TestFlow, {
          executionId: "great-grandchild",
          payload: {},
          discard: true,
          parent: { executionId: "grandchild" } as FlowRuntime.FlowInstance["Service"]
        })
      })))

      expect(result).toBeUndefined()
    }))

  it.effect("catches a mutual A -> B -> A cycle from the B -> A entry point", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(Effect.exit(provideJournal(Effect.gen(function*() {
        const driver = yield* makeDriver()
        yield* driver.register(TestFlow, () => Effect.succeed("never runs"))

        // A already exists and previously started B as a child.
        yield* createRun("a")
        yield* createRun("b", "a")

        // Now B attempts to execute A as its child: a cycle.
        return yield* driver.execute(TestFlow, {
          executionId: "a",
          payload: {},
          discard: true,
          parent: { executionId: "b" } as FlowRuntime.FlowInstance["Service"]
        })
      }))))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      const failure = findCycleFailure(exit.cause)
      expect(failure).toBeInstanceOf(RunDriver.FlowCycleDetected)
      expect((failure as RunDriver.FlowCycleDetected).code).toBe("flow_cycle_detected")
      expect((failure as RunDriver.FlowCycleDetected)._tag).toBe("@smthrs/flow/FlowCycleDetected")
      expect((failure as RunDriver.FlowCycleDetected).path).toEqual(["a", "b"])
    }))

  it.effect("catches the same mutual cycle from the other entry point", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(Effect.exit(provideJournal(Effect.gen(function*() {
        const driver = yield* makeDriver()
        yield* driver.register(TestFlow, () => Effect.succeed("never runs"))

        yield* createRun("x")
        yield* createRun("y", "x")
        yield* createRun("z", "y")

        // z attempts to execute x, its grandparent: a cycle.
        return yield* driver.execute(TestFlow, {
          executionId: "x",
          payload: {},
          discard: true,
          parent: { executionId: "z" } as FlowRuntime.FlowInstance["Service"]
        })
      }))))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      const failure = findCycleFailure(exit.cause)
      expect(failure).toBeInstanceOf(RunDriver.FlowCycleDetected)
      expect((failure as RunDriver.FlowCycleDetected).code).toBe("flow_cycle_detected")
      expect((failure as RunDriver.FlowCycleDetected)._tag).toBe("@smthrs/flow/FlowCycleDetected")
      expect((failure as RunDriver.FlowCycleDetected).path).toEqual(["x", "y", "z"])
    }))

  it.effect("catches a diamond cycle reachable only through the second parent edge", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(Effect.exit(provideJournal(Effect.gen(function*() {
        const driver = yield* makeDriver()
        yield* driver.register(TestFlow, () => Effect.succeed("ok"))

        // A previously created C, so C's persisted parent is A. B exists too.
        yield* createRun("a")
        yield* createRun("b")
        yield* createRun("c", "a")

        // B executes C: the row already exists, so this second parent edge is
        // never persisted — it must still be recorded for cycle detection.
        yield* driver.execute(TestFlow, {
          executionId: "c",
          payload: {},
          discard: true,
          parent: { executionId: "b" } as FlowRuntime.FlowInstance["Service"]
        })

        // C executes B: a cycle reachable only through the C -> B request edge.
        return yield* driver.execute(TestFlow, {
          executionId: "b",
          payload: {},
          discard: true,
          parent: { executionId: "c" } as FlowRuntime.FlowInstance["Service"]
        })
      }))))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      const failure = findCycleFailure(exit.cause)
      expect(failure).toBeInstanceOf(RunDriver.FlowCycleDetected)
      expect((failure as RunDriver.FlowCycleDetected).path).toEqual(["b", "c"])
    }))

  it.effect("admits a legitimate cycle-free fan-in diamond (issue #37)", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const driver = yield* makeDriver()
        yield* driver.register(TestFlow, () => Effect.succeed("ok"))
        const store = yield* RunStore.RunStore

        // Root fans out to A and B; both converge on C. Two parents, no cycle:
        // an over-reporting detector regression must not refuse this shape.
        yield* createRun("diamond-root")
        yield* createRun("diamond-a", "diamond-root")
        yield* createRun("diamond-b", "diamond-root")

        // A creates C (persisted first-parent edge), then B converges on C
        // (request-only second-parent edge). Both must succeed.
        const first = yield* Effect.exit(driver.execute(TestFlow, {
          executionId: "diamond-c",
          payload: {},
          discard: true,
          parent: { executionId: "diamond-a" } as FlowRuntime.FlowInstance["Service"]
        }))
        const second = yield* Effect.exit(driver.execute(TestFlow, {
          executionId: "diamond-c",
          payload: {},
          discard: true,
          parent: { executionId: "diamond-b" } as FlowRuntime.FlowInstance["Service"]
        }))
        const row = yield* store.get("diamond-c")
        return { first, second, status: row.status }
      })))

      expect(Exit.isSuccess(result.first)).toBe(true)
      expect(Exit.isSuccess(result.second)).toBe(true)
      expect(result.status).toBe("completed")
    }))

  it.effect("rejects a concurrently formed mutual cycle instead of admitting both edges (issue #29)", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        // Force an async boundary inside every parent-chain read so the two
        // fibers' cycle checks provably interleave: without serialization both
        // checks complete before either edge is recorded (the TOCTOU race).
        const yieldingStore: RunStore.Service = {
          ...store,
          get: (runId) => Effect.yieldNow.pipe(Effect.andThen(store.get(runId)))
        }
        const driver = yield* makeDriver().pipe(
          Effect.provideService(RunStore.RunStore, yieldingStore)
        )
        yield* driver.register(TestFlow, () => Effect.succeed("ok"))

        yield* createRun("race-a")
        yield* createRun("race-b")

        // Fiber 1: A executes B. Fiber 2: B executes A. Together they close a
        // cycle; exactly one must be refused.
        const exits = yield* Effect.all([
          Effect.exit(driver.execute(TestFlow, {
            executionId: "race-b",
            payload: {},
            discard: true,
            parent: { executionId: "race-a" } as FlowRuntime.FlowInstance["Service"]
          })),
          Effect.exit(driver.execute(TestFlow, {
            executionId: "race-a",
            payload: {},
            discard: true,
            parent: { executionId: "race-b" } as FlowRuntime.FlowInstance["Service"]
          }))
        ], { concurrency: "unbounded" })
        return { exits }
      })))

      const failures = result.exits.filter(Exit.isFailure)
      expect(failures).toHaveLength(1)
      const failure = findCycleFailure(failures[0]!.cause)
      expect(failure).toBeInstanceOf(RunDriver.FlowCycleDetected)
    }))

  it.effect(
    "rejects a mutual cycle formed across two driver instances over one shared store (issue #40)",
    () =>
      Effect.gen(function*() {
        const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          // Force an async boundary inside every parent-chain read so the two
          // drivers' cycle checks provably interleave: each driver has its own
          // in-process cycle gate, so nothing in-process serializes them.
          const yieldingStore: RunStore.Service = {
            ...store,
            get: (runId) => Effect.yieldNow.pipe(Effect.andThen(store.get(runId)))
          }
          // Two owner processes over the same shared RunStore/state.
          const driverOne = yield* makeDriver().pipe(
            Effect.provideService(RunStore.RunStore, yieldingStore)
          )
          const driverTwo = yield* makeDriver().pipe(
            Effect.provideService(RunStore.RunStore, yieldingStore)
          )
          yield* driverOne.register(TestFlow, () => Effect.succeed("ok"))
          yield* driverTwo.register(TestFlow, () => Effect.succeed("ok"))

          yield* createRun("xrace-a")
          yield* createRun("xrace-b")

          // Worker 1: A executes B. Worker 2: B executes A. Together they
          // close a cycle; exactly one must be refused, and neither may
          // deadlock on mutual coordinator awaits.
          const exits = yield* Effect.all([
            Effect.exit(driverOne.execute(TestFlow, {
              executionId: "xrace-b",
              payload: {},
              discard: true,
              parent: { executionId: "xrace-a" } as FlowRuntime.FlowInstance["Service"]
            })),
            Effect.exit(driverTwo.execute(TestFlow, {
              executionId: "xrace-a",
              payload: {},
              discard: true,
              parent: { executionId: "xrace-b" } as FlowRuntime.FlowInstance["Service"]
            }))
          ], { concurrency: "unbounded" })
          return { exits }
        })))

        const failures = result.exits.filter(Exit.isFailure)
        expect(failures).toHaveLength(1)
        const failure = findCycleFailure(failures[0]!.cause)
        expect(failure).toBeInstanceOf(RunDriver.FlowCycleDetected)
      }),
    10_000
  )

  it.effect(
    "keeps a diamond's second-parent edge across a restart so the cycle it closes is still detected (issue #41)",
    () =>
      Effect.gen(function*() {
        const exit = yield* withCrypto(Effect.exit(provideJournal(Effect.gen(function*() {
          yield* createRun("restart-a")
          yield* createRun("restart-b")
          yield* createRun("restart-c", "restart-a")

          // Process 1: B converges on C — a second-parent edge C -> B the run
          // row cannot carry. Then the process dies.
          const firstScope = yield* Scope.make()
          const first = yield* makeDriver().pipe(Scope.provide(firstScope))
          yield* first.register(TestFlow, () => Effect.succeed("ok"))
          yield* first.execute(TestFlow, {
            executionId: "restart-c",
            payload: {},
            discard: true,
            parent: { executionId: "restart-b" } as FlowRuntime.FlowInstance["Service"]
          })
          yield* Scope.close(firstScope, Exit.void)

          // Process 2 (fresh driver, same store): C executes B — a cycle
          // reachable only through the edge process 1 recorded. It must be
          // refused, not admitted into a durable mutual deadlock.
          const second = yield* makeDriver()
          yield* second.register(TestFlow, () => Effect.succeed("ok"))
          return yield* second.execute(TestFlow, {
            executionId: "restart-b",
            payload: {},
            discard: true,
            parent: { executionId: "restart-c" } as FlowRuntime.FlowInstance["Service"]
          })
        }))))

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        expect(findCycleFailure(exit.cause)).toBeInstanceOf(RunDriver.FlowCycleDetected)
      }),
    10_000
  )

  it.effect(
    "terminates on a pre-existing corrupt store cycle instead of hanging",
    () =>
      Effect.gen(function*() {
        const exit = yield* withCrypto(Effect.exit(provideJournal(Effect.gen(function*() {
          const driver = yield* makeDriver()
          yield* driver.register(TestFlow, () => Effect.succeed("ok"))
          const store = yield* RunStore.RunStore
          const state = yield* DurableEngineState.DurableEngineState
          const sql = yield* Effect.service(SqlClient.SqlClient)

          // A corrupt store: p -> q -> p, unrelated to the target being
          // executed. `recordRunParent` refuses the edge that closes a cycle,
          // so the pair only exists when it is written underneath that guard —
          // a hand edit, a restore from a foreign dump, or a migration that
          // reinstated edges out of order. The rows go in through raw SQL for
          // the same reason, and the run rows go in first because the edge
          // table's revision trigger reads them.
          yield* store.create(
            "p",
            JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {}, parentExecutionId: "q" })
          )
          yield* store.create(
            "q",
            JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {}, parentExecutionId: "p" })
          )
          yield* sql`INSERT INTO flows_run_parents (child_id, parent_id, seq) VALUES ('p', 'q', 1)`.pipe(
            Effect.orDie
          )
          yield* sql`INSERT INTO flows_run_parents (child_id, parent_id, seq) VALUES ('q', 'p', 2)`.pipe(
            Effect.orDie
          )

          // The cycle is in the durable edge table the walk actually reads,
          // not only in the run JSON it ignores. Without these two rows the
          // case walks an acyclic graph and proves nothing.
          expect((yield* state.runParents("p")).map((edge) => edge.parentId)).toEqual(["q"])
          expect((yield* state.runParents("q")).map((edge) => edge.parentId)).toEqual(["p"])

          return yield* driver.execute(TestFlow, {
            executionId: "unrelated-target",
            payload: {},
            discard: true,
            parent: { executionId: "p" } as FlowRuntime.FlowInstance["Service"]
          })
        }))))

        // No cycle involving "unrelated-target" exists, so the walk terminates
        // on the repeated id (rather than looping the p <-> q cycle forever)
        // and the run proceeds. The case bound is the assertion: a walk that
        // does not stop on a repeated id never returns and fails here.
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    10_000
  )

  it.effect(
    "refuses the closing writer, never a legitimate chord, when both race (issue #54)",
    () =>
      Effect.gen(function*() {
        const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
          // Lineage chord-a -> chord-b -> chord-c (child -> parent edges).
          yield* createRun("chord-c")
          yield* createRun("chord-b", "chord-c")
          yield* createRun("chord-a", "chord-b")

          // Two owner processes over the same shared store.
          const driverOne = yield* makeDriver()
          const driverTwo = yield* makeDriver()
          yield* driverOne.register(TestFlow, () => Effect.succeed("ok"))
          yield* driverTwo.register(TestFlow, () => Effect.succeed("ok"))

          // Worker 1 closes the cycle (C gets A as a parent); worker 2 records
          // a legitimate chord (A gets its grandparent C as a second parent).
          // Whatever the interleaving, the closing edge must be the one
          // refused — the max-seq arbitration this replaces picked the chord.
          const [closing, chord] = yield* Effect.all([
            Effect.exit(driverOne.execute(TestFlow, {
              executionId: "chord-c",
              payload: {},
              discard: true,
              parent: { executionId: "chord-a" } as FlowRuntime.FlowInstance["Service"]
            })),
            Effect.exit(driverTwo.execute(TestFlow, {
              executionId: "chord-a",
              payload: {},
              discard: true,
              parent: { executionId: "chord-c" } as FlowRuntime.FlowInstance["Service"]
            }))
          ], { concurrency: "unbounded" })
          return { closing, chord }
        })))

        expect(Exit.isSuccess(result.chord)).toBe(true)
        expect(Exit.isFailure(result.closing)).toBe(true)
        if (Exit.isSuccess(result.closing)) return
        expect(findCycleFailure(result.closing.cause)).toBeInstanceOf(RunDriver.FlowCycleDetected)
      }),
    10_000
  )

  it.effect(
    "leaves no durable trace of a rejected fresh-run edge: the winner replays and both nodes stay usable (issues #55/#56)",
    () =>
      Effect.gen(function*() {
        const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const driverOne = yield* makeDriver()
          const driverTwo = yield* makeDriver()
          yield* driverOne.register(TestFlow, () => Effect.succeed("ok"))
          yield* driverTwo.register(TestFlow, () => Effect.succeed("ok"))

          // Neither run row exists yet: both writers race fresh creates whose
          // creating parents jointly close a cycle. The loser's rejection must
          // leave nothing behind — no edge, no run row with a persisted
          // `parentExecutionId` that would keep the cycle durably visible.
          const runA = {
            executionId: "wd-a",
            payload: {},
            discard: true as const,
            parent: { executionId: "wd-b" } as FlowRuntime.FlowInstance["Service"]
          }
          const runB = {
            executionId: "wd-b",
            payload: {},
            discard: true as const,
            parent: { executionId: "wd-a" } as FlowRuntime.FlowInstance["Service"]
          }
          const exits = yield* Effect.all([
            Effect.exit(driverOne.execute(TestFlow, runA)),
            Effect.exit(driverTwo.execute(TestFlow, runB))
          ], { concurrency: "unbounded" })

          const loserOptions = Exit.isFailure(exits[0]) ? runA : runB
          const winnerOptions = Exit.isFailure(exits[0]) ? runB : runA
          // The winner replays idempotently — under the withdrawn-edge design
          // the loser's persisted `state_json` parent made this spuriously
          // fail with FlowCycleDetected forever (issue #55).
          const winnerReplay = yield* Effect.exit(driverOne.execute(TestFlow, winnerOptions))
          // A fresh child of the winner is also unaffected.
          const freshChild = yield* Effect.exit(driverOne.execute(TestFlow, {
            executionId: "wd-child",
            payload: {},
            discard: true,
            parent: { executionId: winnerOptions.executionId } as FlowRuntime.FlowInstance["Service"]
          }))
          // The loser's rejected create left no run row behind.
          const loserRow = yield* Effect.exit(store.get(loserOptions.executionId))
          return { exits, winnerReplay, freshChild, loserRow }
        })))

        expect(result.exits.filter(Exit.isFailure)).toHaveLength(1)
        expect(Exit.isSuccess(result.winnerReplay)).toBe(true)
        expect(Exit.isSuccess(result.freshChild)).toBe(true)
        expect(Exit.isFailure(result.loserRow)).toBe(true)
      }),
    10_000
  )

  it.effect("a sequentially rejected edge leaves the graph exactly as it was (issue #56)", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const driver = yield* makeDriver()
        yield* driver.register(TestFlow, () => Effect.succeed("ok"))

        yield* createRun("seq-a")
        yield* createRun("seq-b", "seq-a")

        // seq-b executing seq-a would close a cycle: refused.
        const rejected = yield* Effect.exit(driver.execute(TestFlow, {
          executionId: "seq-a",
          payload: {},
          discard: true,
          parent: { executionId: "seq-b" } as FlowRuntime.FlowInstance["Service"]
        }))
        // The rejection is atomic: no half-recorded edge survives it, so both
        // runs stay fully usable afterwards (the crash window between insert
        // and withdrawal that poisoned the pair no longer exists).
        const edgesOfA = yield* state.runParents("seq-a")
        const replay = yield* Effect.exit(driver.execute(TestFlow, {
          executionId: "seq-b",
          payload: {},
          discard: true,
          parent: { executionId: "seq-a" } as FlowRuntime.FlowInstance["Service"]
        }))
        const freshChild = yield* Effect.exit(driver.execute(TestFlow, {
          executionId: "seq-c",
          payload: {},
          discard: true,
          parent: { executionId: "seq-a" } as FlowRuntime.FlowInstance["Service"]
        }))
        return { rejected, edgesOfA, replay, freshChild }
      })))

      expect(Exit.isFailure(result.rejected)).toBe(true)
      if (Exit.isSuccess(result.rejected)) return
      expect(findCycleFailure(result.rejected.cause)).toBeInstanceOf(RunDriver.FlowCycleDetected)
      expect(result.edgesOfA).toEqual([])
      expect(Exit.isSuccess(result.replay)).toBe(true)
      expect(Exit.isSuccess(result.freshChild)).toBe(true)
    }))
})
