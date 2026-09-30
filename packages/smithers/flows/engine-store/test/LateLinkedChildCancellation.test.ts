import { executeAndDrain } from "./ExecuteAndDrain.ts"
/**
 * Closes the late-linked-child cancellation race (issue #83).
 *
 * Cancellation and admission are two separate serialized write transactions
 * over the same store:
 *
 * - `interrupt` requests cancellation for the parent AND for every durable
 *   descendant visible in `flows_run_parents` at that instant.
 * - `ensureRun` records the parent edge and creates the child run row in a
 *   transaction of its own.
 *
 * They interleave in both orders. Admission-first is safe by construction:
 * the edge is committed before the cascade walks it. Cancellation-first used
 * to leak a live child — the cascade saw no edge because none existed yet,
 * and the admission that followed created a fresh, uncancelled run row under
 * a parent that was already cancelled and whose drive may have been gone. The
 * in-process finalizer that "usually" caught this is best-effort and can have
 * requested the child before its row existed, so nothing necessarily
 * re-cascaded and the child ran to completion under a cancelled parent.
 *
 * The invariant these tests pin is that the two transactions are closed under
 * ordering, with no third interleaving: whichever serializes first, the child
 * ends up cancel-requested. Admission inherits the parent's durable
 * cancellation inside the same transaction that created the child row, so the
 * activation guard cancels the run instead of executing the flow body.
 *
 * Everything here is ordered by explicit transaction sequencing and latches.
 * There are no sleeps, and the assertions on `executed` are what prove the
 * flow body never ran.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const LateFlow = Flow.make("LateLinkedChildCancellation/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

/**
 * The real SQL stores, so `DurableEngineState.transaction` is an actual write
 * transaction rather than the in-memory twin's pass-through. The ordering this
 * file asserts is a property of transaction composition, so it has to be
 * exercised against the implementation that has transactions.
 */
const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(migratedDatabase))

type Services = Layer.Success<typeof services> | TestClock.TestClock | Crypto.Crypto | Scope.Scope

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  withCrypto(Effect.scoped(effect).pipe(Effect.provide(services), Effect.provide(TestClock.layer())))

/**
 * Distinct driver instances over ONE store: separate owners, separate live
 * instance maps, no shared in-process state. Anything one of them delivers to
 * the other's runs, it delivered through durable state alone.
 */
const makeDriver = (nonce: string) =>
  RunDriver.make({
    owner: { hostId: "late-link-host", pid: 1, nonce: `late-link-${nonce}` },
    journalSource: `late-link-${nonce}`,
    isAlive: () => Effect.succeed(true),
    engine: Effect.succeed(fakeEngine)
  })

const parentInstance = (executionId: string) => ({ executionId } as FlowRuntime.FlowInstance["Service"])

const stateJson = JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: LateFlow._tag, payload: {} })

/** Admits a child under `parentId` and drives it, the way a spawn does. */
const admit = (
  driver: RunDriver.Service,
  executionId: string,
  parentId: string
) =>
  executeAndDrain(driver, LateFlow, {
    executionId,
    payload: {},
    discard: true,
    parent: parentInstance(parentId)
  })

describe("cancellation that serializes before a child's admission", () => {
  it.effect("inherits the parent's durable cancellation onto the late-linked child", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engineState = yield* DurableEngineState.DurableEngineState
        const canceller = yield* makeDriver("canceller")
        const admitter = yield* makeDriver("admitter")
        const executed: Array<string> = []
        yield* admitter.register(
          LateFlow,
          () => Effect.sync(() => (executed.push("child"), "ran"))
        )

        // The parent exists durably and is driven by nobody in this process.
        yield* store.create("late-parent", stateJson)

        // ORDER: the cancellation transaction commits FIRST. At this instant no
        // edge exists, so the cascade provably had no child to request — which
        // is exactly the window the race lived in.
        yield* canceller.interrupt(LateFlow, "late-parent")
        const cascadeSaw = yield* engineState.runChildren("late-parent")
        const parentRow = yield* store.get("late-parent")

        // The admission transaction commits SECOND.
        yield* admit(admitter, "late-child", "late-parent")

        return {
          cascadeSaw,
          parentRequestedAtMs: parentRow.cancelRequestedAtMs,
          child: yield* store.get("late-child"),
          edges: yield* engineState.runParents("late-child"),
          executed
        }
      }))

      // The premise: the cascade could not have seen this child.
      expect(result.cascadeSaw).toEqual([])
      expect(result.parentRequestedAtMs).not.toBeNull()
      // The invariant: the child is cancel-requested anyway, carrying the
      // parent's own request timestamp rather than an independent later one.
      expect(result.child.cancelRequestedAtMs).toBe(result.parentRequestedAtMs)
      // And the activation guard turned that into a real terminal cancellation
      // without ever running the flow body.
      expect(result.child.status).toBe("cancelled")
      expect(result.executed).toEqual([])
      // Cycle detection's single source of truth is untouched by inheritance.
      expect(result.edges.map((edge) => edge.parentId)).toEqual(["late-parent"])
    }))

  it.effect("inherits from a parent that is already terminally cancelled", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const canceller = yield* makeDriver("terminal-canceller")
        const admitter = yield* makeDriver("terminal-admitter")
        const executed: Array<string> = []
        yield* admitter.register(
          LateFlow,
          () => Effect.sync(() => (executed.push("child"), "ran"))
        )

        // The parent runs, is cancelled, and settles terminally BEFORE the
        // child is ever linked: its drive is gone, so nothing will walk the
        // edge table on its behalf again.
        const started = yield* Latch.make(false)
        yield* canceller.register(
          LateFlow,
          () => Latch.open(started).pipe(Effect.andThen(Effect.never))
        )
        const parentFiber = yield* executeAndDrain(canceller, LateFlow, {
          executionId: "terminal-parent",
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(started)
        yield* canceller.interrupt(LateFlow, "terminal-parent")
        // The parent's drive fiber is interrupted by its own cancellation, so
        // its exit is an interruption; only its durable settlement matters here.
        yield* Fiber.await(parentFiber)
        const parentRow = yield* store.get("terminal-parent")

        yield* admit(admitter, "terminal-child", "terminal-parent")

        return { parentRow, child: yield* store.get("terminal-child"), executed }
      }))

      expect(result.parentRow.status).toBe("cancelled")
      expect(result.child.cancelRequestedAtMs).not.toBeNull()
      expect(result.child.status).toBe("cancelled")
      expect(result.executed).toEqual([])
    }))

  it.effect("inherits transitively onto a grandchild linked after its parent inherited", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engineState = yield* DurableEngineState.DurableEngineState
        const canceller = yield* makeDriver("nested-canceller")
        const admitter = yield* makeDriver("nested-admitter")
        const executed: Array<string> = []
        yield* admitter.register(
          LateFlow,
          () => Effect.sync(() => (executed.push("body"), "ran"))
        )

        yield* store.create("nested-parent", stateJson)
        yield* canceller.interrupt(LateFlow, "nested-parent")

        // Generation one is admitted late and inherits.
        yield* admit(admitter, "nested-child", "nested-parent")
        const childRow = yield* store.get("nested-child")
        // Generation two is admitted later still, under a parent that itself
        // only ever held an INHERITED cancellation — no operator ever named it.
        yield* admit(admitter, "nested-grandchild", "nested-child")

        return {
          childRow,
          grandchild: yield* store.get("nested-grandchild"),
          grandchildEdges: yield* engineState.runParents("nested-grandchild"),
          executed
        }
      }))

      expect(result.childRow.cancelRequestedAtMs).not.toBeNull()
      expect(result.grandchild.cancelRequestedAtMs).not.toBeNull()
      expect(result.grandchild.status).toBe("cancelled")
      expect(result.grandchildEdges.map((edge) => edge.parentId)).toEqual(["nested-child"])
      expect(result.executed).toEqual([])
    }))

  it.effect("is idempotent across repeated admissions and repeated cancellations", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engineState = yield* DurableEngineState.DurableEngineState
        const canceller = yield* makeDriver("idem-canceller")
        const other = yield* makeDriver("idem-other")
        const admitter = yield* makeDriver("idem-admitter")
        const executed: Array<string> = []
        yield* admitter.register(
          LateFlow,
          () => Effect.sync(() => (executed.push("body"), "ran"))
        )

        yield* store.create("idem-parent", stateJson)
        yield* canceller.interrupt(LateFlow, "idem-parent")
        yield* admit(admitter, "idem-child", "idem-parent")
        const first = yield* store.get("idem-child")

        // Time moves on, so a second write would be visible as a different
        // timestamp rather than hidden behind equality.
        yield* TestClock.adjust(Duration.minutes(1))
        yield* admit(admitter, "idem-child", "idem-parent")
        yield* canceller.interrupt(LateFlow, "idem-parent")
        yield* other.interrupt(LateFlow, "idem-parent")
        yield* admit(admitter, "idem-child", "idem-parent")

        return {
          first,
          second: yield* store.get("idem-child"),
          edges: yield* engineState.runParents("idem-child"),
          executed
        }
      }))

      expect(result.first.cancelRequestedAtMs).not.toBeNull()
      // First-writer-wins on both sides: nothing was rewritten, and the edge was
      // not duplicated by the repeat admissions.
      expect(result.second.cancelRequestedAtMs).toBe(result.first.cancelRequestedAtMs)
      expect(result.second.status).toBe("cancelled")
      expect(result.edges).toHaveLength(1)
      expect(result.executed).toEqual([])
    }))
})

describe("the order the cancellation transaction writes in", () => {
  /**
   * Inheritance reads the parent row only after the child row exists, so a
   * cancellation that walked the edge table BEFORE marking its own run could
   * miss an edge whose admission also missed the mark. Two serialized
   * transactions make that redundant, but `DurableEngineState.makeMemory`'s
   * `transaction` is a pass-through, and there the write order is the only
   * thing closing the interleaving. Pinned here so a refactor of `interrupt`
   * cannot reopen it silently.
   */
  it.effect("records the run's own request before it walks the edge table", () =>
    Effect.gen(function*() {
      const order = yield* run(Effect.gen(function*() {
        const engineState = yield* DurableEngineState.DurableEngineState
        const actual = yield* RunStore.RunStore
        yield* actual.create("ordering-parent", stateJson)
        const observed: Array<string> = []
        const observing: DurableEngineState.Service = {
          ...engineState,
          runChildren: (parentId) =>
            Effect.sync(() => {
              observed.push(`walk:${parentId}`)
              return []
            })
        }
        const store: RunStore.Service = {
          ...actual,
          lineage: () => Effect.succeed([]),
          requestCancel: (runId, nowMs) =>
            Effect.sync(() => {
              observed.push(`request:${runId}`)
            }).pipe(Effect.andThen(actual.requestCancel(runId, nowMs)))
        }
        const driver = yield* makeDriver("ordering").pipe(
          Effect.provideService(DurableEngineState.DurableEngineState, observing),
          Effect.provideService(RunStore.RunStore, store)
        )

        yield* driver.interrupt(LateFlow, "ordering-parent")
        return observed
      }))

      expect(order).toEqual(["request:ordering-parent", "walk:ordering-parent"])
    }))

  it.effect("visits a diamond once and terminates defensively if persisted edges contain a cycle", () =>
    Effect.gen(function*() {
      const requested = yield* run(Effect.gen(function*() {
        const engineState = yield* DurableEngineState.DurableEngineState
        const actual = yield* RunStore.RunStore
        yield* Effect.forEach(["parent", "left", "right", "leaf"], (runId) => actual.create(runId, stateJson))
        const graph: Readonly<Record<string, ReadonlyArray<DurableEngineState.RunParentEdge>>> = {
          parent: [
            { parentId: "parent", childId: "left", seq: 1 },
            { parentId: "parent", childId: "right", seq: 2 }
          ],
          left: [{ parentId: "left", childId: "leaf", seq: 3 }],
          right: [{ parentId: "right", childId: "leaf", seq: 4 }],
          leaf: [{ parentId: "leaf", childId: "parent", seq: 5 }]
        }
        const cyclic: DurableEngineState.Service = {
          ...engineState,
          runChildren: (parentId) => Effect.succeed(graph[parentId] ?? [])
        }
        const observed: Array<string> = []
        const store: RunStore.Service = {
          ...actual,
          lineage: () => Effect.succeed([]),
          requestCancel: (runId, nowMs) =>
            Effect.sync(() => {
              observed.push(runId)
            }).pipe(Effect.andThen(actual.requestCancel(runId, nowMs)))
        }
        const driver = yield* makeDriver("diamond-cycle").pipe(
          Effect.provideService(DurableEngineState.DurableEngineState, cyclic),
          Effect.provideService(RunStore.RunStore, store)
        )

        yield* driver.interrupt(LateFlow, "parent")
        return observed
      }))

      expect(requested).toEqual(["parent", "left", "right", "leaf"])
    }))
})

describe("admission that serializes before the parent's cancellation", () => {
  it.effect("lets the parent's own cascade reach the child over the committed edge", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engineState = yield* DurableEngineState.DurableEngineState
        const canceller = yield* makeDriver("early-canceller")
        const admitter = yield* makeDriver("early-admitter")
        const started = yield* Latch.make(false)
        const release = yield* Latch.make(false)
        yield* admitter.register(
          LateFlow,
          () => Latch.open(started).pipe(Effect.andThen(Latch.await(release)), Effect.as("ran"))
        )

        yield* store.create("early-parent", stateJson)
        // ORDER: the admission transaction commits FIRST — the latch opens from
        // inside the child's body, which only runs once the row and the edge are
        // durable.
        const childFiber = yield* admit(admitter, "early-child", "early-parent").pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Latch.await(started)
        const cascadeSaw = yield* engineState.runChildren("early-parent")

        // The cancellation transaction commits SECOND and walks the edge itself.
        yield* canceller.interrupt(LateFlow, "early-parent")
        const requestedWhileRunning = yield* store.get("early-child")

        yield* Latch.open(release)
        yield* Fiber.join(childFiber)

        return {
          cascadeSaw,
          requestedWhileRunning,
          child: yield* store.get("early-child")
        }
      }))

      // The premise: this ordering needs no inheritance, because the cascade
      // sees the edge.
      expect(result.cascadeSaw.map((edge) => edge.childId)).toEqual(["early-child"])
      expect(result.requestedWhileRunning.cancelRequestedAtMs).not.toBeNull()
      // The child's own terminal transition is cancel-guarded, so a body that
      // finishes after the request still settles cancelled rather than completed.
      expect(result.child.status).toBe("cancelled")
    }))
})

/**
 * A terminally cancelled parent is inherited from even when its request
 * column no longer carries a timestamp. `cancel_requested_at_ms` is request
 * state, not settlement state, so a retention or compaction lane is free to
 * clear it once the run has settled — and after that the ONLY evidence left
 * that the run was cancelled rather than completed is `status`. Reading the
 * timestamp alone would have admitted a live child under a cancelled parent
 * for exactly as long as the column stayed clear.
 *
 * The store is wrapped rather than compacted for real: there is no compaction
 * lane to invoke here, and the property under test is what the driver does
 * with the row it reads.
 */
describe("a terminally cancelled parent whose request timestamp was cleared", () => {
  it.effect("inherits from its status and stamps the request from the clock", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const executed: Array<string> = []
        yield* store.create("compacted-parent", stateJson)

        // Non-zero and distinguishable, so the timestamp the child receives is
        // provably read from the clock rather than defaulted.
        yield* TestClock.adjust(Duration.millis(1234))
        const clearedAtMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

        const compacted: RunStore.Service = {
          ...store,
          lineage: (runId) =>
            store.lineage(runId).pipe(Effect.map((rows) =>
              rows.map((row) =>
                row.runId === "compacted-parent"
                  ? { ...row, status: "cancelled" as const, cancelRequestedAtMs: null }
                  : row
              )
            )),
          get: (runId) =>
            store.get(runId).pipe(
              Effect.map((row) =>
                runId === "compacted-parent"
                  ? { ...row, status: "cancelled" as const, cancelRequestedAtMs: null }
                  : row
              )
            )
        }
        const admitter = yield* makeDriver("compacted").pipe(
          Effect.provideService(RunStore.RunStore, compacted)
        )
        yield* admitter.register(
          LateFlow,
          () => Effect.sync(() => (executed.push("body"), "ran"))
        )

        yield* admit(admitter, "compacted-child", "compacted-parent")

        return { child: yield* store.get("compacted-child"), clearedAtMs, executed }
      }))

      expect(result.child.cancelRequestedAtMs).toBe(result.clearedAtMs)
      expect(result.child.status).toBe("cancelled")
      // The activation guard read the inherited request, so the body never ran.
      expect(result.executed).toEqual([])
    }))
})

describe("a parent that was never cancelled", () => {
  it.effect("does not cancel a child linked after it completed normally", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver("normal")
        const executed: Array<string> = []
        yield* driver.register(
          LateFlow,
          () => Effect.sync(() => (executed.push("body"), "ran"))
        )

        yield* executeAndDrain(driver, LateFlow, {
          executionId: "normal-parent",
          payload: {},
          discard: true
        })
        const parentRow = yield* store.get("normal-parent")
        // Linked long after the parent settled — successfully.
        yield* admit(driver, "normal-child", "normal-parent")

        return { parentRow, child: yield* store.get("normal-child"), executed }
      }))

      expect(result.parentRow.status).toBe("completed")
      expect(result.parentRow.cancelRequestedAtMs).toBeNull()
      // Ordinary completion is not cancellation: nothing is inherited and the
      // child runs.
      expect(result.child.cancelRequestedAtMs).toBeNull()
      expect(result.child.status).toBe("completed")
      expect(result.executed).toEqual(["body", "body"])
    }))

  it.effect("admits a child whose parent run row does not exist at all", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver("orphan")
        yield* driver.register(LateFlow, () => Effect.succeed("ran"))

        // A detached spawn whose parent row was never created (or was already
        // reaped) must still admit, and must inherit nothing.
        yield* admit(driver, "orphan-child", "orphan-parent")

        return yield* store.get("orphan-child")
      }))

      expect(result.cancelRequestedAtMs).toBeNull()
      expect(result.status).toBe("completed")
    }))
})
