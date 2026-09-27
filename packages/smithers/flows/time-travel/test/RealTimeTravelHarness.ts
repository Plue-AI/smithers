import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as Jj from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Journal from "@smthrs/journal/Journal"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as Node from "@smthrs/plan/Node"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { execFileSync, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { TimeTravel } from "../src/TimeTravel.ts"

export const jjInstalled = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0

export interface RealFixture {
  readonly databaseFile: string
  readonly directory: string
  readonly repository: string
}

export const withRealFixture = <A, E>(
  prefix: string,
  body: (fixture: RealFixture) => Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const directory = await mkdtemp(join(tmpdir(), prefix))
      const repository = join(directory, "repository")
      execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
      const previousCwd = process.cwd()
      const previousEditor = process.env.JJ_EDITOR
      process.env.JJ_EDITOR = "true"
      process.chdir(repository)
      return { directory, repository, previousCwd, previousEditor }
    }),
    ({ directory, repository }) => body({ databaseFile: join(directory, "flows.sqlite"), directory, repository }),
    ({ directory, previousCwd, previousEditor }) =>
      Effect.promise(async () => {
        process.chdir(previousCwd)
        if (previousEditor === undefined) delete process.env.JJ_EDITOR
        else process.env.JJ_EDITOR = previousEditor
        await rm(directory, { recursive: true, force: true })
      })
  )

export const realLayer = (filename: string) => {
  const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
  const migrated = Layer.provideMerge(Migrations.layer, database)
  const persistence = Layer.mergeAll(
    SqlJournal.layer({ capacity: 128, overflow: "reject" }),
    RunStore.layer,
    CacheStore.layer,
    SqlTimeTravelStore.layer,
    NodeJj.layer
  ).pipe(Layer.provideMerge(migrated))
  return TimeTravel.layer.pipe(Layer.provideMerge(persistence))
}

const ownerIsAlive = (owner: OwnerId): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(owner.pid, 0)
      return true
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code !== "ESRCH"
    }
  })

/**
 * The fully production node composition used by the real e2e cases.
 *
 * Every call creates a new SQLite connection, journal queue, owner identity,
 * engine, time-travel service, filesystem boundary, and NodeJj service. The
 * filename is the only state carried between calls.
 */
export const realEngineLayer = (filename: string, hostId: string) => {
  const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
  const migrated = Layer.provideMerge(Migrations.layer, database)
  const stores = Layer.mergeAll(
    SqlJournal.layer({ capacity: 128, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer,
    SqlTimeTravelStore.layer
  ).pipe(Layer.provideMerge(migrated))
  const hostAndArtifacts = Layer.provideMerge(
    ArtifactStore.layerFileSystem({ directory: join(dirname(filename), "artifacts") }),
    Layer.merge(NodeFileSystem.layer, NodePath.layer)
  )
  const boundary = Layer.provideMerge(StepBoundary.layer, hostAndArtifacts)
  const infrastructure = Layer.mergeAll(
    stores,
    boundary,
    OwnerIdentity.layer,
    NodeJj.layer,
    Action.layerCacheEnvironment({ layers: [TimeTravel.key], capabilities: {} })
  ).pipe(Layer.provideMerge(NodeCrypto.layer))
  return Layer.merge(
    EngineStore.layer({ owner: { hostId }, journalSource: `${hostId}-time-travel-e2e`, isAlive: ownerIsAlive }),
    TimeTravel.layer
  ).pipe(Layer.provideMerge(infrastructure)) satisfies Layer.Layer<never, unknown, Scope.Scope>
}

export const runRealEngine = <A, E, R>(
  filename: string,
  hostId: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A> => Effect.scoped(effect.pipe(Effect.provide(realEngineLayer(filename, hostId)))) as Effect.Effect<A>

const SealedStep = Action.make("time-travel/e2e/sealed-step", {
  payload: {},
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "time-travel/e2e/sealed-step/v1"
})

const CompensableStep = Action.make("time-travel/e2e/compensable-step", {
  payload: {},
  success: Schema.String,
  tier: "compensable",
  idempotencyKey: "time-travel/e2e/compensable-step/v1"
})

const SealedParked = Flow.make("time-travel/e2e/sealed-parked", {
  payload: {},
  success: Schema.String,
  body: (payload) =>
    SealedStep.call(payload).pipe(
      Node.bindPlanned(() => Flow.park({ reason: "approval", token: "time-travel-e2e-sealed" }))
    )
})

const CompensableParked = Flow.make("time-travel/e2e/compensable-parked", {
  payload: {},
  success: Schema.String,
  body: (payload) =>
    CompensableStep.call(payload).pipe(
      Node.bindPlanned(() => Flow.park({ reason: "approval", token: "time-travel-e2e-compensable" }))
    )
})

type StepEffect = Effect.Effect<string>

const flowWiring = <ROut>(
  runtime: FlowRuntime.FlowRuntime["Service"],
  implementation: Layer.Layer<ROut, never, Crypto.Crypto | Action.Implementations | FlowRuntime.FlowRuntime>
) =>
  implementation.pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, runtime))
  )

/** Executes one sealed action and parks the real durable flow after it commits. */
export const parkSealedFlow = (
  executionId: string,
  execute: StepEffect = Effect.succeed("sealed")
) =>
  Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    const boundary = Action.make({
      name: "time-travel/e2e/sealed-effect",
      success: Schema.String,
      tier: "sealed",
      idempotencyKey: "time-travel/e2e/sealed-effect/v1",
      execute
    })
    const implementation = Layer.merge(
      SealedStep.toLayer(() => boundary),
      Interpreter.layer(SealedParked)
    )
    return yield* SealedParked.execute({}, { executionId, discard: true }).pipe(
      Effect.provide(flowWiring(runtime, implementation))
    )
  })

/** Executes one compensable action and parks the real durable flow after it commits. */
export const parkCompensableFlow = (
  executionId: string,
  execute: StepEffect = Effect.succeed("compensable")
) =>
  Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    const boundary = Action.make({
      name: "time-travel/e2e/compensable-effect",
      success: Schema.String,
      tier: "compensable",
      idempotencyKey: "time-travel/e2e/compensable-effect/v1",
      execute
    })
    const implementation = Layer.merge(
      CompensableStep.toLayer(() => boundary),
      Interpreter.layer(CompensableParked)
    )
    return yield* CompensableParked.execute({}, { executionId, discard: true }).pipe(
      Effect.provide(flowWiring(runtime, implementation))
    )
  })

export const runReal = <A, E, R>(
  filename: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A> => Effect.scoped(effect.pipe(Effect.provide(realLayer(filename)))) as Effect.Effect<A>

/**
 * Resolves with the first JSON object line a crash fixture prints on stdout.
 *
 * The fixture is a real process that is about to be killed, so every other
 * outcome has to reject and carry what it printed: a spawn error, an exit
 * before the checkpoint, and a 30 s ceiling. `settled` keeps whichever
 * arrives first the answer, and stdout is drained line by line so a chunk
 * boundary inside the JSON is buffered rather than parsed.
 *
 * `description` names the fixture in those rejections.
 */
export const awaitCheckpoint = <A>(
  child: ChildProcessWithoutNullStreams,
  description: string
): Promise<A> =>
  new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const timeout = setTimeout(
      () => finish(() => reject(new Error(`${description} timed out\n${stderr}\n${stdout}`))),
      30_000
    )
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      complete()
    }
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      const lines = stdout.split("\n")
      stdout = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("{")) continue
        finish(() => resolve(JSON.parse(line) as A))
        return
      }
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", (cause) => finish(() => reject(cause)))
    child.once(
      "exit",
      (code, signal) =>
        finish(() =>
          reject(new Error(`${description} exited before checkpoint: ${code ?? signal}\n${stderr}\n${stdout}`))
        )
    )
  })

/** SIGKILLs a still-running fixture and waits for the exit, so no lane outlives its case. */
export const killHard = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGKILL")
  await once(child, "exit")
}

export const runState = (flowName: string): string => JSON.stringify({ version: 1, flowName, payload: {} })

export { CacheStore, Jj, Journal, RunStore, TimeTravel }
