/**
 * The end of a cross-owner cancel: what the operator sees once the owner acts.
 *
 * `TerminalControl.test.ts` proves the request half — a cancel from a
 * composition that does not own the run answers `Accepted` and writes
 * `cancel_requested_at_ms` on the engine row. This file proves the other half
 * against the real durable engine: the owner observes that column on its next
 * cancel poll (`Ownership.heartbeatInterval`, one second) and settles the run,
 * and the control plane's own projection of the run moves to `cancelled` with
 * it (triage B-10 and B-11).
 *
 * One database is this file's test layering, not the product's shape. The
 * shipped CLI keeps two: `.flows/control.db` holds the control plane's
 * `flows_runs` row and `.flows/engine.db` holds the engine's, so one run has
 * two rows in two files. They converge because the cancel is recorded durably
 * on the ENGINE row through the `requestCancel` port and the owning driver
 * settles from that request at its next tick; nothing projects one row onto
 * the other. Here both halves share one database, which is why the case can
 * assert the engine row and the control projection in one read — and why it
 * proves the convergence rather than the impossibility of divergence.
 *
 * Separately constructed SQL runtimes mint distinct default identities, so a
 * second runtime cannot write through the first runtime's fence. The shipped
 * CLI supplies its real host and pid identity as well, which also enables
 * same-host liveness probes.
 *
 * The `Flow.execute` fiber's own settlement after a cross-driver cancel is a
 * separate defect (triage N-09, `RunDriver.ts`, the cancel-durability lane), so
 * this case reads the row rather than joining the fiber and interrupts the
 * fiber at the end the way `packages/smithers/flows/test/NodeRuntime.test.ts` does.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Jj from "@smthrs/jj"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import { Clock, Duration, Effect, Fiber, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { PersistenceError } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import * as ControlLive from "../src/ControlLive.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { RunSummary } from "../src/ControlSchema.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"

/** A step that never returns, so the run is RUNNING when the cancel arrives. */
const Block = Action.make("cancel-convergence/block", { payload: {}, success: Schema.String })

const Blocked = Flow.make("cancel-convergence/blocked", {
  payload: {},
  success: Schema.String,
  body: () => Block.call({})
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "cancel-convergence" as never, changeId: "cancel-convergence" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/** One database, provided once, so the engine and the control plane share rows. */
const database = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  AttemptStore.layer,
  CacheStore.layer,
  DurableEngineState.layer
).pipe(
  Layer.provideMerge(Layer.effectDiscard(EngineMigrations.run)),
  Layer.provideMerge(Layer.merge(TestDatabase.layer, NodeCrypto.layer))
)

/** The owner identity the ENGINE claims runs under; the plane's is its own. */
const engineHostId = "cancel-convergence-engine"

const engine = Layer.mergeAll(
  Block.toLayer(() => Effect.never),
  Interpreter.layer(Blocked)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(
    EngineStore.layer({
      owner: { hostId: engineHostId },
      journalSource: engineHostId,
      isAlive: () => Effect.succeed(false)
    })
  ),
  Layer.provideMerge(Layer.mergeAll(StepBoundary.layerTest(), Layer.succeed(Jj.Jj, jj), OwnerIdentity.layer))
)

/**
 * The cancel half of the executor port, as `AgentSession` implements it.
 *
 * One `RunStore.requestCancel` on the engine row. Nothing else in the port is
 * reachable from a cancel, so the rest stays noop.
 */
const cancelBridge = Layer.effect(ControlExecutor.ControlExecutor)(
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    return ControlExecutor.makeNoop({
      requestCancel: Effect.fn("TestExecutor.requestCancel")(({ runId }) =>
        Effect.gen(function*() {
          const at = yield* Clock.currentTimeMillis
          const outcome = yield* store.requestCancel(runId, at).pipe(
            Effect.mapError((cause) =>
              new PersistenceError({
                operation: "executor.requestCancel",
                message: `The engine could not record a cancellation for ${runId}`,
                cause
              })
            )
          )
          return outcome._tag === "NotFound" ? "unknown" as const : "recorded" as const
        })
      )
    })
  })
)

const stack = Layer.merge(
  Layer.provideMerge(
    ControlLive.layer,
    Layer.mergeAll(
      SqlControlRuntime.layer({}).pipe(Layer.orDie),
      NotificationQueue.layer,
      cancelBridge,
      Registry.layerNoop()
    )
  ),
  engine
).pipe(Layer.provideMerge(database))

const run = <A, E, R>(body: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(body, stack as unknown as Layer.Layer<R>).pipe(Effect.scoped, Effect.orDie)
  )

/**
 * Polls the run row until its status satisfies `predicate`.
 *
 * Real sleeps, because the owner's cancel poll is a real one-second heartbeat
 * and the engine under test is the durable one rather than a `TestClock`
 * fixture. The bound is fifteen seconds, which is fourteen more than the
 * contract allows the owner.
 */
const awaitStatus = (
  runId: string,
  predicate: (status: string) => boolean,
  attempts = 600
): Effect.Effect<string, unknown, RunStore.RunStore> =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    const row = yield* store.get(runId).pipe(
      Effect.catchTag("@smthrs/run-store/RunStoreError", () => Effect.succeed({ status: "missing" }))
    )
    if (predicate(row.status) || attempts <= 0) return row.status
    yield* Effect.sleep(Duration.millis(25))
    return yield* awaitStatus(runId, predicate, attempts - 1)
  })

const listed = (items: ReadonlyArray<RunSummary>, runId: string): RunSummary | undefined =>
  items.find((item) => item.runId === runId)

describe("cancelling a run the engine owns", () => {
  it("records the cancel on the engine row, and the owner converges the run to cancelled", async () => {
    const runId = "engine-owned-cancel"
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const store = yield* RunStore.RunStore

      const fiber = yield* Blocked.execute({}, { executionId: runId, discard: true }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      // The engine owns the row from the moment it activates it.
      yield* awaitStatus(runId, (status) => status === "running")
      const owner = (yield* store.get(runId)).owner

      const receipt = yield* control.cancel({
        runId,
        idempotencyKey: `cancel:${runId}`,
        reason: "the operator asked"
      })
      const requestedAtMs = (yield* store.get(runId)).cancelRequestedAtMs

      const status = yield* awaitStatus(runId, (value) => value !== "running")
      const summary = yield* runtime.getRun(runId)
      const runs = yield* control.list({ _tag: "runs" })
      // N-09 owns the fiber's own settlement; this case owns the two statuses.
      yield* Fiber.interrupt(fiber)
      return {
        receipt,
        owner,
        requestedAtMs,
        status,
        summary,
        items: runs._tag === "runs" ? runs.items : []
      }
    }))

    // The engine owned the run, so the control plane cancelled nothing itself:
    // it took the request and answered `Accepted` rather than `ClaimLost`.
    expect(observed.owner?.hostId).toBe(engineHostId)
    expect(observed.receipt).toEqual({ _tag: "Accepted", receiptId: `cancel:${runId}`, runId })
    expect(observed.requestedAtMs).not.toBeNull()

    // The owner acted on the durable request within its poll, and both views of
    // the run agree about how it ended.
    expect(observed.status).toBe("cancelled")
    expect(observed.summary.status).toBe("cancelled")
    expect(listed(observed.items, runId)?.status).toBe("cancelled")
    // The attribution the control plane journaled survives the engine's own
    // terminal write: an operator can still read who cancelled, and why.
    expect(observed.summary.cancellation).toMatchObject({
      source: "control",
      reason: "the operator asked"
    })
  })
})
