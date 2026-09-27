/**
 * A run that ends on its own terms takes its attached children with it.
 *
 * Cancellation already cascaded (`CancelCascade.test.ts`), but the other two
 * terminal outcomes did not: a parent that COMPLETED or FAILED left every
 * linked child row exactly as it was. A `.child()` boundary whose parent died
 * on an unrelated branch therefore left a durable orphan — parked forever,
 * owned by nobody, waited for by nobody, and reachable only by an operator who
 * knew its id.
 *
 * The fix is a policy the child records for itself at spawn
 * (`RunState.onParentExit`) and the parent applies inside its own terminal
 * compare-and-swap. `cancel` is the default and what a caller that waits for
 * the child's value gets; `detach` is what a caller that discarded the result
 * gets, because outliving the parent is the point of a fire-and-forget spawn.
 *
 * Real SQLite, because the property under test is that the child's
 * cancellation and the parent's terminal row commit together: under the
 * in-memory engine state `transaction` is a pass-through and the claim would
 * be untestable.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import * as Notifying from "@smthrs/journal/test/Notifying"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OnParentExit } from "../src/RunState.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const ExitFlow = Flow.make("ChildExitPolicy/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const owner: Ownership.OwnerId = {
  hostId: "child-exit-host",
  pid: 1,
  nonce: "child-exit-owner"
}

const makeDriver = () =>
  RunDriver.make({
    owner,
    journalSource: "child-exit",
    engine: Effect.succeed(fakeEngine)
  })

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(migratedDatabase))

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withCrypto(
    Effect.scoped(effect as Effect.Effect<A, E, Scope.Scope>).pipe(
      Effect.provide(services),
      Effect.provide(TestClock.layer())
    ) as Effect.Effect<A>
  )

const stateJson = (policy?: OnParentExit) =>
  JSON.stringify({
    version: 1,
    flowName: ExitFlow._tag,
    payload: {},
    ...(policy === undefined ? {} : { parentExecutionId: "parent", onParentExit: policy })
  })

/** Creates a linked child run row with the policy it recorded at spawn. */
const linkChild = (
  parentId: string,
  childId: string,
  policy?: OnParentExit
) =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    const engineState = yield* DurableEngineState.DurableEngineState
    yield* store.create(childId, stateJson(policy))
    yield* engineState.recordRunParent(childId, parentId)
  })

const decisionsOf = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const entries = yield* journal.entries({ runId: runId as never, limit: 200 })
    return entries.entries
      .filter((entry) => entry.eventType === "flows.engine.run-decision")
      .map((entry) =>
        entry.payload as {
          readonly decision: string
          readonly cancelled?: ReadonlyArray<string>
          readonly detached?: ReadonlyArray<string>
        }
      )
  })

/** An owner that will never heartbeat again: a worker killed mid-child. */
const deadOwner: Ownership.OwnerId = {
  hostId: "child-exit-dead-host",
  pid: 424242,
  nonce: "child-exit-dead-owner"
}

const heartbeatMs = Duration.toMillis(Ownership.heartbeatInterval)
const staleAfterMs = Duration.toMillis(Ownership.heartbeatStaleAfter)

describe("a terminal run applies its children's exit policy", () => {
  it.effect("cancels an attached child when the parent fails, and journals what it decided", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* linkChild("parent", "parent-attached-child", "cancel")
        // A row written before the policy existed names none. It is still a
        // linked child, and the contract for one is that it ends with its
        // parent.
        yield* linkChild("parent", "parent-legacy-child")
        yield* driver.register(ExitFlow, () => Effect.die(new Error("parent exploded")))
        yield* driver.execute(ExitFlow, {
          executionId: "parent",
          payload: {},
          discard: true
        })

        return {
          parent: yield* store.get("parent"),
          attached: yield* store.get("parent-attached-child"),
          legacy: yield* store.get("parent-legacy-child"),
          decisions: yield* decisionsOf("parent")
        }
      }))

      expect(result.parent.status).toBe("failed")
      expect(result.attached.cancelRequestedAtMs).not.toBeNull()
      expect(result.legacy.cancelRequestedAtMs).not.toBeNull()
      const applied = result.decisions.find((decision) => decision.decision === "child-policy-applied")
      expect(applied?.cancelled).toEqual(["parent-attached-child", "parent-legacy-child"])
      expect(applied?.detached).toEqual([])
    }))

  it.effect("cancels a parked attached child, which the sweep then drives to cancelled", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engineState = yield* DurableEngineState.DurableEngineState
        const driver = yield* makeDriver()
        yield* linkChild("parked-parent", "parked-child", "cancel")

        // Park the child for real: owned, suspended, and carrying a durable
        // waiting row, which is the state a `.child()` boundary leaves behind
        // when it waits on an event.
        const created = yield* store.get("parked-child")
        const claimedAtMs = yield* Clock.currentTimeMillis
        yield* store.claimAndOwn(
          "parked-child",
          { status: created.status, owner: created.owner, heartbeatAtMs: created.heartbeatAtMs },
          owner,
          claimedAtMs
        )
        yield* engineState.park("parked-child", { reason: "event" }, owner)
        yield* store.transitionOwned("parked-child", owner, "suspended", stateJson("cancel"))

        yield* driver.register(ExitFlow, () => Effect.die(new Error("parent exploded")))
        yield* driver.execute(ExitFlow, {
          executionId: "parked-parent",
          payload: {},
          discard: true
        })
        const requested = yield* store.get("parked-child")

        // The cancel sweep is what delivers a request to a run nobody drives.
        yield* driver.register(ExitFlow, () => Effect.succeed("must not run"))
        yield* TestClock.adjust(heartbeatMs * 2)

        yield* TestDatabase.until(
          TestClock.adjust(Ownership.heartbeatInterval).pipe(
            Effect.andThen(store.get("parked-child").pipe(Effect.map((row) => row.status === "cancelled")))
          )
        )
        return { requested, settled: yield* store.get("parked-child") }
      }))

      expect(result.requested.status).toBe("suspended")
      expect(result.requested.cancelRequestedAtMs).not.toBeNull()
      expect(result.settled.status).toBe("cancelled")
    }))

  it.effect("settles an orphaned attached child whose own owner is dead", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* linkChild("orphan-parent", "orphan-child", "cancel")

        // The child is owned by a HOST THAT IS GONE: claimed, running, and
        // heartbeating nowhere. That is the shape a `.child()` boundary leaves
        // when the worker driving the child is killed while the parent keeps
        // going on another host. Nothing will ever answer for this child, so
        // the parent's cancel request has to be delivered by something that
        // takes the run away from its dead owner first.
        const created = yield* store.get("orphan-child")
        yield* store.claimAndOwn(
          "orphan-child",
          { status: created.status, owner: created.owner, heartbeatAtMs: created.heartbeatAtMs },
          deadOwner,
          yield* Clock.currentTimeMillis
        )

        yield* driver.register(ExitFlow, () => Effect.die(new Error("parent exploded")))
        yield* driver.execute(ExitFlow, {
          executionId: "orphan-parent",
          payload: {},
          discard: true
        })
        const requested = yield* store.get("orphan-child")

        // No probe, no operator, no second call: this driver supplies no
        // `isAlive`, so the expired lease is the only evidence it has, and the
        // stale-running sweep is the only thing that runs.
        yield* driver.register(ExitFlow, () => Effect.succeed("must not run"))
        yield* TestClock.adjust(staleAfterMs + heartbeatMs)
        let settled = yield* store.get("orphan-child")
        for (let i = 0; i < 2000 && settled.status !== "cancelled"; i++) {
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
          yield* TestClock.adjust(heartbeatMs)
          settled = yield* store.get("orphan-child")
        }
        return { requested, settled }
      }))

      // The request landed on the child in the parent's own terminal
      // transaction, while the child still belonged to the dead owner.
      expect(result.requested.owner).toEqual(deadOwner)
      expect(result.requested.cancelRequestedAtMs).not.toBeNull()
      // And the sweep took it away from that owner and finished the job.
      expect(result.settled.status).toBe("cancelled")
      expect(result.settled.owner).toBeNull()
    }))

  it.effect("leaves a detached child running and does not walk its subtree", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* linkChild("detach-parent", "detached-child", "detach")
        // The detached child's OWN child: it hangs off a run that is still
        // going, so the parent's exit must not reach it either.
        yield* linkChild("detached-child", "detached-grandchild", "cancel")
        yield* driver.register(ExitFlow, () => Effect.succeed("parent done"))
        yield* driver.execute(ExitFlow, {
          executionId: "detach-parent",
          payload: {},
          discard: true
        })

        return {
          parent: yield* store.get("detach-parent"),
          child: yield* store.get("detached-child"),
          grandchild: yield* store.get("detached-grandchild"),
          decisions: yield* decisionsOf("detach-parent")
        }
      }))

      expect(result.parent.status).toBe("completed")
      expect(result.child.cancelRequestedAtMs).toBeNull()
      expect(result.grandchild.cancelRequestedAtMs).toBeNull()
      const applied = result.decisions.find((decision) => decision.decision === "child-policy-applied")
      expect(applied?.detached).toEqual(["detached-child"])
      expect(applied?.cancelled).toEqual([])
    }))

  it.effect("reaches a transitive attached grandchild through the durable edge table", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* linkChild("deep-parent", "deep-child", "cancel")
        yield* linkChild("deep-child", "deep-grandchild", "cancel")
        yield* driver.register(ExitFlow, () => Effect.succeed("parent done"))
        yield* driver.execute(ExitFlow, {
          executionId: "deep-parent",
          payload: {},
          discard: true
        })

        return {
          child: yield* store.get("deep-child"),
          grandchild: yield* store.get("deep-grandchild"),
          decisions: yield* decisionsOf("deep-parent")
        }
      }))

      expect(result.child.cancelRequestedAtMs).not.toBeNull()
      expect(result.grandchild.cancelRequestedAtMs).not.toBeNull()
      const applied = result.decisions.find((decision) => decision.decision === "child-policy-applied")
      expect(applied?.cancelled).toEqual(["deep-child", "deep-grandchild"])
    }))

  it.effect("visits a grandchild shared by two children exactly once", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engineState = yield* DurableEngineState.DurableEngineState
        const driver = yield* makeDriver()
        // The diamond `flows_run_parents` permits: one run linked to two
        // parents that are themselves children of the exiting run.
        yield* linkChild("diamond-parent", "diamond-a", "cancel")
        yield* linkChild("diamond-parent", "diamond-b", "cancel")
        yield* linkChild("diamond-a", "diamond-shared", "cancel")
        yield* engineState.recordRunParent("diamond-shared", "diamond-b")

        yield* driver.register(ExitFlow, () => Effect.succeed("parent done"))
        yield* driver.execute(ExitFlow, {
          executionId: "diamond-parent",
          payload: {},
          discard: true
        })

        return {
          shared: yield* store.get("diamond-shared"),
          decisions: yield* decisionsOf("diamond-parent")
        }
      }))

      expect(result.shared.cancelRequestedAtMs).not.toBeNull()
      const applied = result.decisions.find((decision) => decision.decision === "child-policy-applied")
      expect(applied?.cancelled).toEqual(["diamond-a", "diamond-b", "diamond-shared"])
    }))

  it.effect("touches neither a child that already settled nor an edge whose row is gone", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engineState = yield* DurableEngineState.DurableEngineState
        const driver = yield* makeDriver()

        // A child that finished before its parent applied this same policy to
        // its own children when it settled.
        yield* linkChild("quiet-parent", "settled-child", "cancel")
        const settled = yield* store.get("settled-child")
        const claimedAtMs = yield* Clock.currentTimeMillis
        yield* store.claimAndOwn(
          "settled-child",
          { status: settled.status, owner: settled.owner, heartbeatAtMs: settled.heartbeatAtMs },
          owner,
          claimedAtMs
        )
        yield* store.transitionOwned("settled-child", owner, "completed", stateJson("cancel"))
        // An edge whose child row a retention lane already deleted.
        yield* engineState.recordRunParent("ghost-child", "quiet-parent")

        yield* driver.register(ExitFlow, () => Effect.succeed("parent done"))
        yield* driver.execute(ExitFlow, {
          executionId: "quiet-parent",
          payload: {},
          discard: true
        })

        return {
          settled: yield* store.get("settled-child"),
          decisions: yield* decisionsOf("quiet-parent")
        }
      }))

      expect(result.settled.status).toBe("completed")
      expect(result.settled.cancelRequestedAtMs).toBeNull()
      // Nothing was decided, so nothing was journaled.
      expect(result.decisions.map((decision) => decision.decision)).not.toContain("child-policy-applied")
    }))

  it.effect("commits the parent's exit and its children's cancellation together or not at all", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* linkChild("atomic-parent", "atomic-child", "cancel")

        // Crash between the parent's terminal write and the child's
        // cancellation. Before the two shared a transaction, this is exactly
        // the window that committed a completed parent over a live child.
        const crashOnCancel: Notifying.Hook = (op, order) =>
          op === "requestCancel" && order === "before"
            ? Effect.die(new Error("host lost power mid-transaction"))
            : Effect.void

        const exit = yield* Effect.exit(
          Effect.gen(function*() {
            const driver = yield* makeDriver()
            yield* driver.register(ExitFlow, () => Effect.succeed("parent done"))
            yield* driver.execute(ExitFlow, {
              executionId: "atomic-parent",
              payload: {},
              discard: true
            })
          }).pipe(
            Effect.provideService(RunStore.RunStore, Notifying.wrap(yield* RunStore.RunStore, crashOnCancel)),
            Effect.scoped
          )
        )

        return {
          exit,
          parent: yield* store.get("atomic-parent"),
          child: yield* store.get("atomic-child")
        }
      }))

      expect(Exit.isFailure(result.exit)).toBe(true)
      // No completed parent over a live child: the terminal transition rolled
      // back with the cancellation it could not write.
      expect(result.parent.status).not.toBe("completed")
      expect(result.child.cancelRequestedAtMs).toBeNull()
    }))
})

describe("a child linked after its parent already exited", () => {
  it.effect("inherits the exit of a parent that completed before the edge existed", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* driver.register(ExitFlow, () => Effect.succeed("parent done"))
        yield* driver.execute(ExitFlow, {
          executionId: "late-parent",
          payload: {},
          discard: true
        })
        const parent = yield* store.get("late-parent")

        // The parent's exit walk ran when nothing was linked to it. This
        // admission is the other interleaving of issue #83, for the terminal
        // exit rather than for cancellation.
        yield* driver.execute(ExitFlow, {
          executionId: "late-attached-child",
          payload: {},
          discard: false,
          parent: { executionId: "late-parent" } as FlowRuntime.FlowInstance["Service"]
        })
        yield* driver.execute(ExitFlow, {
          executionId: "late-detached-child",
          payload: {},
          discard: true,
          parent: { executionId: "late-parent" } as FlowRuntime.FlowInstance["Service"]
        })

        return {
          parent,
          attached: yield* store.get("late-attached-child"),
          detached: yield* store.get("late-detached-child")
        }
      }))

      expect(result.parent.status).toBe("completed")
      expect(result.attached.cancelRequestedAtMs).not.toBeNull()
      // The detached child was spawned to outlive the parent, and it does.
      expect(result.detached.cancelRequestedAtMs).toBeNull()
    }))
})

describe("the policy is recorded from what the caller did with the result", () => {
  it.effect("records cancel for an awaited child and detach for a discarded one", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* driver.register(ExitFlow, () => Effect.succeed("child done"))
        yield* driver.execute(ExitFlow, {
          executionId: "recorded-attached",
          payload: {},
          discard: false,
          parent: { executionId: "recording-parent" } as FlowRuntime.FlowInstance["Service"]
        })
        yield* driver.execute(ExitFlow, {
          executionId: "recorded-detached",
          payload: {},
          discard: true,
          parent: { executionId: "recording-parent" } as FlowRuntime.FlowInstance["Service"]
        })
        return {
          attached: yield* store.get("recorded-attached"),
          detached: yield* store.get("recorded-detached")
        }
      }))

      expect(JSON.parse(result.attached.stateJson).onParentExit).toBe("cancel")
      expect(JSON.parse(result.detached.stateJson).onParentExit).toBe("detach")
    }))
})
