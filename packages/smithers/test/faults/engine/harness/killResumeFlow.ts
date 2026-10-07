/**
 * The flow the crash family kills.
 *
 * One declared step whose implementation runs two sealed actions in order. The
 * first commits immediately; the second announces itself with a marker file,
 * starts a real detached process, and then sleeps long enough for the test to
 * reach in and `SIGKILL` the host while it is genuinely in flight.
 *
 * Every observable this makes is a file, because the only reader that survives
 * a `SIGKILL` is the filesystem. The execution counter is append-only and
 * cross-process: one line per dispatch, so a replayed sealed result adds
 * nothing and a re-executed action adds a line. That is the whole exactly-once
 * assertion, written where a killed process cannot rewrite it.
 *
 * @since 1.0.0
 */
import { Capability, Permission } from "@smthrs/capability"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The first action's identifier in the execution counter. */
export const firstStep = "first"

/** The second action's identifier in the execution counter. */
export const secondStep = "second"

/**
 * The marker files the flow writes, relative to the marker directory.
 *
 * @since 1.0.0
 * @category models
 */
export const markers = {
  firstDone: "first.done",
  secondStarted: "second.started",
  secondDone: "second.done",
  /** Holds the pid of the detached process the second action starts. */
  spawnedPid: "spawned.pid"
} as const

/**
 * What the child runner needs to build the flow.
 *
 * @since 1.0.0
 * @category models
 */
export interface FlowOptions {
  /** The SQLite file the durable engine opens. */
  readonly filename: string
  /** Where the marker files go. */
  readonly markerDir: string
  /** The append-only execution counter. */
  readonly counterFile: string
  /** How long the second action stays in flight. Long enough to be killed. */
  readonly secondSleepMs: number
  /** The host identity both incarnations share; it is what makes the reap theirs. */
  readonly hostId: string
  readonly crossing?: "keyed-write" | "sealed-check" | "keyless-shell"
}

const record = (counterFile: string, step: string): void => {
  appendFileSync(counterFile, `${step}\n`)
}

const mark = (markerDir: string, name: string, contents = ""): void => {
  writeFileSync(join(markerDir, name), contents)
}

/** The step the flow body names. Its implementation holds both actions. */
export const Settle = Action.make("e2e/kill-resume/Settle", {
  payload: { label: Schema.String },
  success: Schema.String,
  error: Action.IrreversibleRetryRequiresIdempotencyKey
})

/** The flow under the kill. */
export const KillResume = Flow.make("e2e/kill-resume", {
  payload: { label: Schema.String },
  success: Schema.String,
  error: Action.IrreversibleRetryRequiresIdempotencyKey,
  body: (payload) => Settle.call(payload)
})

/**
 * Builds the registration layer for one incarnation.
 *
 * @since 1.0.0
 * @category layers
 */
export const registration = (options: FlowOptions) => {
  const First = Action.make({
    name: "e2e/kill-resume/First",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "e2e/kill-resume/first/v1",
    execute: Effect.sync(() => {
      record(options.counterFile, firstStep)
      mark(options.markerDir, markers.firstDone)
      return "first-value"
    })
  })

  const Second = Action.make({
    name: "e2e/kill-resume/Second",
    success: Schema.String,
    error: Action.IrreversibleRetryRequiresIdempotencyKey,
    tier: options.crossing === "keyed-write" || options.crossing === "keyless-shell" ? "irreversible" : "sealed",
    idempotencyKey: options.crossing === "keyless-shell" ? undefined : "e2e/kill-resume/second/v1",
    execute: Effect.gen(function*() {
      if (options.crossing !== undefined) {
        record(options.counterFile, secondStep)
        if (options.crossing === "keyed-write") {
          record(options.counterFile, "lookup")
          if (existsSync(join(options.markerDir, "remote.result"))) return "second-value"
        }
        record(options.counterFile, "write")
        mark(options.markerDir, "remote.result", "second-value")
        mark(options.markerDir, markers.secondStarted)
        yield* Effect.sleep(options.secondSleepMs)
        mark(options.markerDir, markers.secondDone)
        return "second-value"
      }
      const spawner = yield* ChildProcessSpawner
      // A two-process tree that only a group signal reaches. It is what turns
      // a `SIGKILL` of the host into a real orphan for the next incarnation's
      // reaper to find.
      const handle = yield* Effect.orDie(
        spawner.spawn(ChildProcess.make("sh", ["-c", `sleep 300 & sleep 300`]))
      )
      yield* Effect.sync(() => {
        mark(options.markerDir, markers.spawnedPid, String(handle.pid as number))
        record(options.counterFile, secondStep)
        mark(options.markerDir, markers.secondStarted)
      })
      yield* Effect.sleep(options.secondSleepMs)
      yield* Effect.sync(() => mark(options.markerDir, markers.secondDone))
      return "second-value"
    })
  })

  const settle = ({ label }: { readonly label: string }) =>
    Effect.gen(function*() {
      const first = yield* First
      const second = yield* Second
      return `${label}:${first}:${second}`
    })

  return Interpreter.layer(KillResume).pipe(
    Layer.provideMerge(Settle.toLayer(settle)),
    Layer.provideMerge(Action.layerImplementations)
  )
}

/** The capability rules the spawning action needs. */
export const rules: ReadonlyArray<Permission.Rule> = [
  new Permission.Rule({
    effect: "allow",
    pattern: new Capability.CapabilityPattern({ action: "proc:spawn", resource: "*" })
  })
]

/**
 * The complete host for one incarnation.
 *
 * @since 1.0.0
 * @category layers
 */
export const host = (options: FlowOptions) =>
  NodeRuntime.layerHost(
    {
      filename: options.filename,
      workspaceRoot: options.markerDir,
      owner: { hostId: options.hostId },
      // A killed host never runs a handler, and a shut-down host is not what
      // this family tests. Nothing here installs one.
      signals: [],
      rules
    },
    registration(options)
  )
