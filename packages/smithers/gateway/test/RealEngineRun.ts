/**
 * A whole gateway whose runs the durable engine really executes.
 *
 * `GatewayStack.ts` composes the control plane under
 * `ControlExecutor.makeNoop()`: a run there is planned, approved, and accepted,
 * and nothing executes it. That is enough to pin the read path's shape and not
 * enough to prove a launch reaches an engine at all.
 *
 * This stack replaces the noop with an executor that hands the launch to the
 * durable engine, in the shape a host composes it:
 *
 * - two databases, because that is what a host runs. `@smthrs/cli`
 *   `NodeControl.databasePath` is the control plane's (`control.db`) and
 *   `NodeControl.executionDatabasePath` is the engine's (`engine.db`), and the
 *   comment on the second says why: each composition owns its own migrations.
 * - the engine executes the flow under `executionId = runId`, the way
 *   `@smthrs/agent` `AgentSession` drives an accepted launch
 *   (`AgentSession.ts:994`). The two databases are what make that id reusable:
 *   the control plane created a `flows_runs` row for the run in ITS database,
 *   and an engine sharing that database would refuse the execution, because
 *   `ensureRun` decodes the existing row as `RunState` and the control plane's
 *   row holds a `RunSummary`.
 * - the terminal control status is written under the run's own fence and
 *   journaled into the CONTROL journal as `control.run.<status>`, which is
 *   what `AgentSession.settle` does and what a client watching the run reads.
 *
 * What this proves, and what it does not: the engine, the journals, the
 * control plane, the projections, and the ordering between them are real, and
 * a run really executes. The flow is a real `@smthrs/flow` `Flow` over a real
 * `Action` rather than an agent flow, because an agent flow needs a provider
 * credential and a suite that needed one would skip in exactly the
 * environments this proof matters in.
 *
 * The engine's own `flows.engine.*` records stay in the engine's journal.
 * {@link EngineRun} exposes them so a suite can assert that, which is the
 * reason `GatewayProjection` folds control records only.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import type * as ControlError from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlLive from "@smthrs/control/ControlLive"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { DurableFlow } from "@smthrs/control/SqlControlRuntime"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import { StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Jj } from "@smthrs/kernel"
import { NotificationQueue } from "@smthrs/notifications"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { Registry } from "@smthrs/registry"
import * as RunCatalog from "@smthrs/sync/RunCatalog"
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"
import { Cause, Context, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { dirname, join } from "node:path"
import * as Projections from "../src/Projections.ts"
import { databaseFile, storage } from "./GatewayStack.ts"

/** The flow the engine executes, and the id the control plane plans against. */
export const flowId = "gateway/RealRun"

/** The action the flow's one step runs. Its result is the run's result. */
export const Write = Action.make("gateway/Write", {
  payload: { path: Schema.String },
  success: Schema.String
})

/** One real durable flow: one payload, one action, one recorded result. */
export const RealRun = Flow.make(flowId, {
  payload: { path: Schema.String },
  success: Schema.String,
  body: (payload: { readonly path: string }) => Write.call(payload)
})

/** The one flow the control plane may plan, declared the way a host declares it. */
const durableFlow: DurableFlow = {
  flowId,
  description: "The gateway suite's real durable flow",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} }
}

/**
 * A Jujutsu service that records nothing. The engine calls it for compensable
 * snapshots; this flow's action is sealed, so a stub keeps the wiring honest
 * without requiring a `jj` binary on the machine running the suite.
 */
const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "gateway-suite" as never, changeId: "gateway-suite" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/**
 * The engine, reachable from the control plane's side of the composition.
 *
 * The engine's services are provided INTO this layer and not merged out of it,
 * so the control plane keeps its own `Journal` and the two never blur into one
 * service. That separation is the production fact this stack exists to keep:
 * a host's registration phase sees the engine's journal, not the control
 * plane's (`@smthrs/flows` `NodeRuntime.composition` provides the engine to
 * the registration layer).
 *
 * @since 1.0.0
 * @category models
 */
export class EngineRun extends Context.Service<EngineRun, {
  /** Executes the flow under `executionId`, reporting its exit. */
  readonly execute: (executionId: string, path: string) => Effect.Effect<Exit.Exit<string, unknown>>
  /** The event kinds the ENGINE journaled for that execution. */
  readonly kinds: (executionId: string) => Effect.Effect<ReadonlyArray<string>>
}>()("gateway/test/EngineRun") {}

/** The engine's own composition: its own SQLite file, its own journal. */
const engineLayer = (filename: string, implementation: (path: string) => Effect.Effect<string>) =>
  NodeRuntime.layer(
    {
      filename,
      workspaceRoot: dirname(filename),
      owner: { hostId: "gateway-suite" },
      isAlive: () => Effect.succeed(false)
    },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    Layer.mergeAll(
      Write.toLayer(({ path }: { readonly path: string }) => implementation(path)),
      Interpreter.layer(RealRun)
    ).pipe(Layer.provideMerge(Action.layerImplementations))
  ).pipe(Layer.provide([stubJj, NodeCrypto.layer, AtomicFileSystem.layer]))

const layerEngineRun = (filename: string, implementation: (path: string) => Effect.Effect<string>) =>
  Layer.effect(EngineRun)(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const services = yield* Effect.context<Effect.Services<ReturnType<typeof RealRun.execute>>>()
      return {
        execute: (executionId: string, path: string) =>
          Effect.exit(RealRun.execute({ path }, { executionId })).pipe(
            Effect.provideContext(services)
          ),
        kinds: (executionId: string) =>
          journal.entries({ runId: JournalEvent.RunId.make(executionId), limit: 500 }).pipe(
            Effect.map((page) => page.entries.map((entry) => entry.eventType)),
            Effect.orDie
          )
      }
    })
  ).pipe(Layer.provideMerge(engineLayer(filename, implementation)))

/**
 * The run never reached `running` before the driver gave up waiting.
 *
 * Carries the status the driver last observed so a suite that joins the
 * drive reads why it never executed, instead of a run that "never settled".
 */
export class RunNeverRunning extends Schema.TaggedError<RunNeverRunning>()("gateway/test/RunNeverRunning", {
  runId: Schema.String,
  status: Schema.String
}) {}

/**
 * Waits until the control plane has recorded the run as running.
 *
 * `Control.run` writes that status only after the executor has accepted, so a
 * driver that settled first would overwrite a status it never saw. This is the
 * same ordering guard `AgentSession.driver` applies.
 *
 * Fails, never silently returns: a run that never reaches `running` must not
 * be driven, and the reason must reach whoever joins the drive.
 */
const waitForRunning = (
  runtime: ControlRuntime["Service"],
  runId: string,
  attempts: number
): Effect.Effect<void, RunNeverRunning | ControlError.RunNotFound | ControlError.PersistenceError> =>
  runtime.getRun(runId).pipe(
    Effect.flatMap((run) =>
      run.status === "running"
        ? Effect.void
        : attempts <= 1
        ? Effect.fail(new RunNeverRunning({ runId, status: run.status }))
        : Effect.andThen(Effect.sleep("1 millis"), waitForRunning(runtime, runId, attempts - 1))
    )
  )

/**
 * The drives the executor forked, one fiber per accepted run.
 *
 * `drive` writes the terminal status and THEN journals `control.run.<status>`;
 * a suite that polled the status row would read the terminal status before
 * the journal record exists. Joining the drive fiber waits for both writes,
 * and surfaces the defect the drive died on instead of a run that never
 * settled.
 *
 * @since 1.0.0
 * @category models
 */
export class Drives extends Context.Service<Drives, {
  /** The drive fiber of each accepted run, keyed by run id. */
  readonly fibers: Map<string, Fiber.Fiber<void>>
  /** Waits for the drive of `runId` to finish; dies with its cause if it died. */
  readonly settled: (runId: string) => Effect.Effect<void>
}>()("gateway/test/Drives") {
  static readonly layer = Layer.sync(Drives)(() => {
    const fibers = new Map<string, Fiber.Fiber<void>>()
    return {
      fibers,
      settled: (runId: string) => {
        const fiber = fibers.get(runId)
        return fiber === undefined ? Effect.die(`no drive was forked for run ${runId}`) : Fiber.join(fiber)
      }
    }
  })
}

/** Everything the driver needs, named so the executor layer can capture it. */
type DriverServices = ControlRuntime | Journal.Journal | EngineRun

/**
 * Executes one accepted launch on the durable engine and settles the control
 * plane from its exit.
 */
const drive = (runId: string, path: string): Effect.Effect<void, never, DriverServices> =>
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime
    const journal = yield* Journal.Journal
    const engine = yield* EngineRun
    yield* waitForRunning(runtime, runId, 500)
    const exit = yield* engine.execute(runId, path)
    const status = Exit.isSuccess(exit) ? "completed" as const : "failed" as const
    const fence = yield* runtime.claimFence(runId)
    yield* runtime.writeStatus(runId, fence, status)
    yield* journal.emitDurableUnfenced(
      new JournalEvent.Input({
        runId: JournalEvent.RunId.make(runId),
        sourceId: JournalEvent.SourceId.make("gateway-suite-executor"),
        eventType: `control.run.${status}`,
        // A failed run carries the rendered cause, exactly as
        // `AgentSession.writeStatus` does, so the diagnosis has a reason to
        // report rather than "no cause recorded in the journal".
        payload: Exit.isSuccess(exit) ? { runId, status } : { runId, status, cause: Cause.pretty(exit.cause) }
      })
    )
  }).pipe(Effect.orDie)

/** The acceptance port: hand the launch to the engine, then report accepted. */
const executor = Layer.effect(ControlExecutor.ControlExecutor)(
  Effect.gen(function*() {
    const services = yield* Effect.context<DriverServices>()
    const drives = yield* Drives
    // `makeNoop` supplies the cancel, signal, and resume ports this suite does
    // not drive; only the acceptance port is this double's subject.
    return ControlExecutor.makeNoop({
      launch: (input) =>
        Effect.sync(() => {
          const path = (input.plan.decodedInput as { readonly path?: string } | undefined)?.path ?? "unknown"
          drives.fibers.set(input.run.runId, Effect.runForkWith(services)(drive(input.run.runId, path)))
          return "accepted" as const
        })
    })
  })
)

/**
 * The gateway read path over a control plane whose executor is the engine.
 *
 * @param implementation what the flow's action does, so a suite can prove a
 * success and a failure through the same composition
 */
export const stack = (implementation: (path: string) => Effect.Effect<string>) =>
  Layer.unwrap(
    Effect.map(databaseFile, (filename) =>
      Projections.layerWith({ heartbeatMillis: 50 }).pipe(
        Layer.provideMerge(Layer.merge(RunCatalog.layerNoop, WorkspaceShare.layerNoop)),
        Layer.provideMerge(ControlLive.layer),
        // The executor reads the control plane it settles: the runtime for the
        // fenced status write and the CONTROL journal for the record a client
        // watching the run reads. `Drives` is merged out so a suite can join
        // the drive it forked.
        Layer.provideMerge(
          executor.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                SqlControlRuntime.layer({ flows: [durableFlow] }).pipe(Layer.orDie),
                NotificationQueue.layer,
                Registry.layerNoop(),
                Drives.layer
              ).pipe(Layer.provideMerge(Layer.merge(storage(filename), NodeCrypto.layer)))
            )
          )
        ),
        Layer.provideMerge(layerEngineRun(join(dirname(filename), "engine.db"), implementation)),
        Layer.provideMerge(NodeCrypto.layer)
      ))
  )
