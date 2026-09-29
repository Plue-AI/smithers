/**
 * Cancellation attribution over a cancellation the ENGINE actually performed.
 *
 * `ControlCancellation` drives the projection with rows and journal entries a
 * test wrote, which proves the fold and nothing about the contract: the
 * `flows.engine.interrupted` record and the cascade onto a child both belong
 * to `@smthrs/engine-store`, and a payload key renamed there would leave a
 * hand-written fixture green. This suite runs a real flow that starts a real
 * child, interrupts the parent through `Flow.interrupt`, and asks the control
 * plane who cancelled what.
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
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import { Effect, Fiber, Latch, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { ListResponse, RunSummary } from "../src/ControlSchema.ts"
import { controlPlane } from "./DurableStack.ts"

const parentRunId = "engine-cancel-parent"
const childRunId = "engine-cancel-child"

/** Opened once the child's own step is running, so the test interrupts a live tree. */
const running = Latch.makeUnsafe(false)

/** The child's step. It never returns, so the child is alive when the parent dies. */
const Hold = Action.make("engine-cancel/hold", { payload: {}, success: Schema.String })

const Child = Flow.make("engine-cancel/child", {
  payload: {},
  success: Schema.String,
  body: () => Hold.call({})
})

/** The parent's step: start the child, and stay in it. */
const StartChild = Action.make("engine-cancel/start-child", { payload: {}, success: Schema.String })

const Parent = Flow.make("engine-cancel/parent", {
  payload: {},
  success: Schema.String,
  body: () => StartChild.call({})
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "engine-cancel" as never, changeId: "engine-cancel" as never }),
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

const engine = Layer.mergeAll(
  StartChild.toLayer(() =>
    Child.execute({}, { executionId: childRunId, discard: true }).pipe(Effect.orDie, Effect.as("started"))
  ),
  Interpreter.layer(Parent),
  Interpreter.layer(Child)
).pipe(
  // `StartChild` runs `Child`, whose body calls `Hold`, so `Hold` goes under it.
  Layer.provideMerge(Hold.toLayer(() => Latch.open(running).pipe(Effect.andThen(Effect.never)))),
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(
    EngineStore.layer({
      owner: { hostId: "engine-cancel-test" },
      journalSource: "engine-cancel-test",
      isAlive: () => Effect.succeed(false)
    })
  ),
  Layer.provideMerge(
    Layer.mergeAll(StepBoundary.layerTest(), Layer.succeed(Jj.Jj, jj), OwnerIdentity.layer)
  )
)

const stack = Layer.merge(controlPlane(), engine).pipe(
  Layer.provideMerge(database)
)

const summaries = (listed: ListResponse): ReadonlyArray<RunSummary> => listed._tag === "runs" ? listed.items : []

describe("cancellation attribution over an engine-performed interrupt", () => {
  it("reports the interrupted parent as engine-decided and its child as a cascade", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Parent.execute({}, { executionId: parentRunId }).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        // The child's own step is running: the tree is live, not a fixture.
        yield* Latch.await(running)
        yield* Parent.interrupt(parentRunId).pipe(Effect.orDie)
        yield* Fiber.await(fiber)
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const listed = yield* control.list({ _tag: "runs" })
        const byId = new Map(summaries(listed).map((item) => [item.runId, item]))
        return {
          parent: byId.get(parentRunId),
          child: byId.get(childRunId),
          // The single-run projection reads the run and its ancestors, not the
          // whole database, and the child's ancestor is on the spawn edge
          // rather than in its own row. It has to reach the same answer.
          childAlone: yield* runtime.getRun(childRunId)
        }
      }).pipe(Effect.provide(stack), Effect.scoped, Effect.orDie)
    )

    // Nobody named this run on the control plane's journal, so there is no
    // principal to report and inventing one would be worse than saying nothing.
    expect(observed.parent?.cancellation).toMatchObject({ source: "engine" })
    expect(observed.parent?.cancellation?.principal).toBeUndefined()
    expect(observed.parent?.cancellation?.cascadedFrom).toBeUndefined()
    // The child was swept up in the parent's cancellation, and the projection
    // names the ancestor it was swept up with.
    expect(observed.child?.cancellation).toMatchObject({
      source: "cascade",
      cascadedFrom: parentRunId
    })
    expect(observed.child?.cancellation?.principal).toBeUndefined()
    expect(observed.childAlone.cancellation).toEqual(observed.child?.cancellation)
    expect(observed.childAlone.parentRunId).toBe(parentRunId)
  })
})
