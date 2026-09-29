/**
 * A real run, in a real Jujutsu workspace, parked where time travel can reach
 * it.
 *
 * The time-travel family needs three things the other families do not: a run
 * whose journal has enough frames to scrub through, a workspace whose files
 * change as the run progresses, and a suspended run — `rewind` is a writer, so
 * it takes the ownership claim like any driver and refuses a live run.
 *
 * The flow below produces all three. `Ledger` writes a line to a tracked file
 * through a compensable action, so the engine takes a jj pre-image of the tree
 * before it runs, and then parks on a durable deferred nobody completes. A
 * composition that passes `compensation` also runs {@link notifyKind}, an
 * irreversible action, between the write and the park, and contributes the
 * given handlers for it.
 *
 * @since 1.0.0
 */
import { Capability, Permission } from "@smthrs/capability"
import { Action, DurableDeferred, Flow, Interpreter } from "@smthrs/flow"
import { Engine } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { RunStore } from "@smthrs/run-store"
import { CompensationHandlers, SqlTimeTravelStore, TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { execFileSync } from "node:child_process"
import { appendFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** The file the run writes, tracked by jj. */
export const ledgerFile = "ledger.txt"

/** The irreversible action a `compensation` composition runs after the write. */
export const notifyKind = "e2e/time-travel/Notify"

/**
 * The run's own lineage, built by the constructor that mints it.
 *
 * Re-derived on 2026-09-01. `FlowEngine.Lineage` moved the root address from
 * `<runId>/root` to a versioned encoded tuple so no two runs and node paths can
 * name one durable record, and this helper still spelled the old form. Every
 * frame the time-travel cases built therefore named a lineage the engine never
 * wrote, and `inspect` and `rewind` both refused with `not_found`.
 *
 * The engine is reached through `@smthrs/flows`, the barrel this package
 * already depends on, so nothing here takes a new dependency to mint an
 * address the engine owns.
 */
export const lineageOf = (executionId: string): string => Engine.FlowEngine.Lineage.root(executionId)

/** The wait the run parks on, so time travel finds it suspended. */
export const Settlement: DurableDeferred.DurableDeferred<typeof Schema.String> = DurableDeferred.make(
  "e2e/time-travel/settlement",
  { success: Schema.String }
)

/** The declared step whose implementation writes and then waits. */
export const Post = Action.make("e2e/time-travel/Post", {
  payload: { entry: Schema.String },
  success: Schema.String
})

/** The run under inspection. */
export const Ledger = Flow.make("e2e/time-travel/ledger", {
  payload: { entry: Schema.String },
  success: Schema.String,
  body: (payload) => Post.call(payload)
})

/** Stops a parked caller's automatic follow loop before inspecting its stable history. */
export const parkLedger = (executionId: string) =>
  Effect.gen(function*() {
    const running = yield* Ledger.execute({ entry: "posted" }, { executionId }).pipe(Effect.forkChild)
    const runs = yield* RunStore.RunStore
    for (let attempt = 0; attempt < 1_000; attempt++) {
      const row = yield* runs.get(executionId).pipe(Effect.option)
      if (Option.isSome(row) && row.value.status === "suspended") {
        yield* Fiber.interrupt(running)
        return
      }
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(new Error(`Run ${executionId} did not park`))
  })

/**
 * A jj repository with a committed baseline, and the paths inside it.
 *
 * `NodeJj` spawns `jj` in `process.cwd()`, so the caller has to chdir into
 * `root` before running anything the engine takes a pre-image for. `enter` and
 * `leave` are that, kept here so no case has to remember the rule.
 *
 * @since 1.0.0
 * @category constructors
 */
export const makeWorkspace = (label: string): {
  readonly root: string
  readonly filename: string
  readonly enter: () => void
  readonly leave: () => void
} => {
  const root = mkdtempSync(join(tmpdir(), `smithers-e2e-${label}-`))
  execFileSync("jj", ["git", "init", root], { stdio: "ignore" })
  appendFileSync(join(root, ledgerFile), "baseline\n")
  execFileSync("jj", ["describe", "-m", "baseline"], {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, JJ_EDITOR: "true" }
  })
  let previous: string | undefined
  return {
    root,
    filename: join(root, "run.sqlite"),
    enter: () => {
      previous = process.cwd()
      process.env.JJ_EDITOR = "true"
      process.chdir(root)
    },
    leave: () => {
      if (previous !== undefined) process.chdir(previous)
      previous = undefined
    }
  }
}

/**
 * The composition: the durable Node host over the workspace, plus the
 * time-travel service and its SQLite store.
 *
 * With `compensation`, the step also crosses an irreversible boundary after
 * the write, and `compensation.handlers` are contributed below `TimeTravel`,
 * which reads them once when it is built.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer = (
  root: string,
  filename: string,
  hostId: string,
  compensation?: { readonly handlers: ReadonlyArray<CompensationHandlers.Handler> }
) => {
  const post = ({ entry }: { readonly entry: string }) => {
    // Declared inside the implementation so it can close over the workspace
    // root; the tier is what makes the engine take a jj pre-image of the tree
    // before the write, which is what a rewind later restores.
    const Write = Action.make({
      name: "e2e/time-travel/Write",
      success: Schema.String,
      tier: "compensable",
      execute: Effect.sync(() => {
        appendFileSync(join(root, ledgerFile), `${entry}\n`)
        return entry
      })
    })
    const Notify = Action.make({
      name: notifyKind,
      success: Schema.String,
      tier: "irreversible",
      idempotencyKey: "e2e/time-travel/notify/v1",
      execute: Effect.succeed("notified")
    })
    return Effect.gen(function*() {
      const written = yield* Write
      if (compensation !== undefined) yield* Notify
      const settlement = yield* DurableDeferred.await(Settlement)
      return `${written}:${settlement}`
    })
  }
  return Layer.mergeAll(Post.toLayer(post), Interpreter.layer(Ledger)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(TimeTravel.layer),
    Layer.provideMerge(CompensationHandlers.layer(compensation?.handlers ?? [])),
    Layer.provideMerge(SqlTimeTravelStore.layer),
    Layer.provideMerge(
      NodeRuntime.layerHost(
        {
          filename,
          workspaceRoot: root,
          owner: { hostId },
          signals: [],
          // The engine takes a compensable action's pre-image on its privileged
          // Jj, which no rule governs. `TimeTravel.rewind` resolves the guarded
          // Jj instead: it snapshots the tree before restoring ("flows rewind
          // pre-restore") and then restores the frame's change. Those two jj
          // capabilities are all this host grants; anything else is denied.
          rules: [
            new Permission.Rule({
              effect: "allow",
              pattern: new Capability.CapabilityPattern({ action: "jj:snapshot", resource: "*" })
            }),
            new Permission.Rule({
              effect: "allow",
              pattern: new Capability.CapabilityPattern({ action: "jj:restore", resource: "*" })
            })
          ]
        },
        Layer.empty
      )
    )
  )
}
