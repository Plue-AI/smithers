/**
 * Run a child flow's code inside a provisioned environment as one parent action.
 *
 * `SandboxedFlow` bundles the child module and guest runner, starts Node inside
 * the session, and validates the guest's result against the child schema. The
 * parent records this as one durable action.
 *
 * A second drive over the same SQLite state reuses the recorded result without
 * acquiring another session. `captureWork` returns the guest-written file as
 * a `Sandbox.Work` patch against the commit the workdir started at, so the
 * workdir must be a git repository; this example's provider makes each
 * scratch workdir one. Applying the work with `SandboxMerge.apply` remains the
 * caller's decision.
 */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as SandboxedFlow from "@smthrs/flows/SandboxedFlow"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import { DirectorySandbox, type Sandbox } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { durableEngine } from "./durable-layer.ts"
import { Greet, Greeting } from "./sandboxed-child.ts"

/** The parent's action: one sandboxed execution of the child flow. */
export const RunGreet = SandboxedFlow.action(Greet)

/** A durable parent flow whose one step is the sandboxed child. */
export const SandboxedGreeting = Flow.make("examples/SandboxedGreeting", {
  payload: { name: Schema.String },
  success: SandboxedFlow.resultSchema(Greeting),
  error: SandboxedFlow.ExecuteError,
  body: (payload) => RunGreet.call(payload)
})

export interface MainOptions {
  /** The local SQLite file that holds the engine and journal. */
  readonly filename: string
  /** The local parent under which the provider provisions its scratch machine. */
  readonly root: string
}

export interface MainResult {
  /** The child's validated output and the work it left in the checkout. */
  readonly result: typeof SandboxedGreeting.successSchema.Type
  /** How many machines the provider was asked for during this `main`. */
  readonly acquisitions: number
}

/** Makes a fresh scratch workdir a git repository with one empty commit, the base its work is measured from. */
const initialize = (session: Sandbox.Session) =>
  Effect.scoped(Effect.gen(function*() {
    const process = yield* session.spawn(
      "git init -q && git -c user.name=Example -c user.email=example@example.test -c commit.gpgsign=false " +
        "commit -q --allow-empty -m base",
      {}
    )
    const [, , code] = yield* Effect.all(
      [Stream.runDrain(process.stdout), Stream.runDrain(process.stderr), process.exitCode],
      { concurrency: "unbounded" }
    )
    if (code !== 0) return yield* Effect.die(`git could not initialize ${session.workdir}`)
    return session
  }))

/** Runs the parent once over `filename` and closes every acquired layer before resolving. */
export const main = (options: MainOptions): Promise<MainResult> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner
      const directory = DirectorySandbox.make({ fs, spawner, root: options.root })
      let acquisitions = 0
      const provider: Sandbox.Provider = {
        acquire: (session) => {
          acquisitions++
          return Effect.flatMap(directory.acquire(session), initialize)
        }
      }
      const stack = Layer.mergeAll(
        SandboxedFlow.toLayer(RunGreet, Greet, ({ executionId }) => ({
          provider,
          session: `greet:${executionId}`,
          entry: new URL("./sandboxed-child.ts", import.meta.url),
          captureWork: true
        })),
        Interpreter.layer(SandboxedGreeting)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(durableEngine(options.filename, "examples-sandboxed-flow"))
      )

      const result = yield* SandboxedGreeting.execute(
        { name: "Ada" },
        { executionId: "sandboxed-greeting" }
      ).pipe(
        Effect.provide(stack),
        Effect.scoped
      )
      return { result, acquisitions }
    }).pipe(
      Effect.provide(
        NodeHost.layerContained().pipe(
          Layer.provide(ProcessLedger.layerMemory({ hostId: "examples-sandboxed-flow", ownerPid: process.pid }))
        )
      ),
      Effect.orDie
    )
  )
