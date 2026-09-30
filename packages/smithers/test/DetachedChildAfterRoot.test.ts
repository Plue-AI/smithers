/** A detached child keeps its launch authority after its control root completes (#3209). */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Action, Flow, FlowRuntime, Interpreter, Sleep } from "@smthrs/flow"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

const effects = { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" } as const
const source = `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("detached", {
  description: "Launch a detached child and complete.", payload: {}, success: Schema.Unknown,
  capabilities: [], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  body: Node.capture({}, () => Node.succeed(null))
})
`

const rows = (root: string) => {
  const db = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
  try {
    return db.prepare("SELECT run_id, status FROM flows_runs").all() as unknown as Array<
      { run_id: string; status: string }
    >
  } finally {
    db.close()
  }
}

describe("detached child of a completed control root", () => {
  // `root-first`: the root completes without waiting, so the child's first drive
  // may land before or after it. `child-first`: the root completes only after
  // the child has entered. Either way the child then parks, re-enters after the
  // root completed, and launches a grandchild whose first drive is after it.
  it.each(["root-first", "child-first"] as const)("runs to completion when %s", async (order) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-detached-child-")))
    const ran: Array<string> = []
    try {
      await mkdir(join(root, "flows", "detached"), { recursive: true })
      await writeFile(join(root, "flows", "detached", "flow.ts"), source)
      const entered = await Effect.runPromise(Deferred.make<void>())
      const rootCompleted = await Effect.runPromise(Deferred.make<void>())

      const Record = Action.make("detached/Record", { payload: {}, success: Schema.Void })
      const Grand = Flow.make("detached/grand", {
        payload: {},
        success: Schema.Void,
        body: Node.capture({}, () => Record.call({}))
      })
      const Enter = Action.make("detached/Enter", { payload: {}, success: Schema.Void })
      const Spawn = Action.make("detached/Spawn", { payload: {}, success: Schema.Void, error: Schema.Unknown })
      const Child = Flow.make("detached/child", {
        payload: {},
        success: Schema.Void,
        error: Schema.Unknown,
        body: Node.capture(
          {},
          () =>
            Enter.call({}).pipe(
              Node.andThen(Sleep.action.call({ millis: 10 })),
              Node.andThen(Spawn.call({}))
            )
        )
      })
      const Start = Action.make("detached/Start", { payload: {}, success: Schema.Void, error: Schema.Unknown })
      const Done = Action.make("detached/Done", { payload: {}, success: Schema.Number })
      const Main = Flow.make("detached", {
        description: "Launch a detached child and complete.",
        capabilities: [],
        effects,
        payload: {},
        success: Schema.Number,
        error: Schema.Unknown,
        body: Node.capture({}, () => Start.call({}).pipe(Node.andThen(Done.call({}))))
      })
      const modules = Executable.layer({
        delegates: [],
        load: () =>
          Effect.succeed({
            default: Main,
            layer: Layer.mergeAll(
              Interpreter.layer(Child),
              Interpreter.layer(Grand),
              Sleep.layer,
              Start.toLayer(() =>
                Effect.gen(function*() {
                  const instance = yield* FlowRuntime.FlowInstance
                  yield* Child.execute({}, { executionId: `${instance.executionId}/child`, discard: true })
                })
              ),
              Done.toLayer(() => (order === "child-first" ? Deferred.await(entered) : Effect.void).pipe(Effect.as(0))),
              // Every entry after the first waits for nothing: the root has
              // completed by then, which is the point.
              Enter.toLayer(() =>
                Deferred.succeed(entered, void 0).pipe(Effect.andThen(Deferred.await(rootCompleted)))
              ),
              Spawn.toLayer(() =>
                Effect.gen(function*() {
                  const instance = yield* FlowRuntime.FlowInstance
                  yield* Grand.execute({}, { executionId: `${instance.executionId}/grand`, discard: true })
                })
              ),
              Record.toLayer(() =>
                Effect.sync(() => {
                  ran.push("grand")
                })
              )
            )
          })
      }).pipe(Layer.orDie)
      const within = (label: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.timeout("60 seconds"),
          Effect.catchTag("TimeoutError", () => Effect.die(new Error(`${label}: ${JSON.stringify(rows(root))}`)))
        )
      const registry = NodeControl.layerRegistry(root)
      const engine = NodeControl.engineDurable(root, registry)
      const executor = NodeControl.layerExecutor(registry, engine, root, {
        evaluator: ScriptedJudge.layerAll,
        environment: {},
        grants: GrantStore.layerNoop,
        modules
      })
      const runId = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({ flowId: "detached", input: {} })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: order
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die(receipt)
          const events = yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
            Stream.takeUntil((event) => event.kind === "control.run.completed" || event.kind === "control.run.failed"),
            Stream.runCollect,
            within("root completion")
          )
          expect(events.at(-1)?.kind).toBe("control.run.completed")
          yield* Deferred.succeed(rootCompleted, void 0)
          // The module execution, the child and the grandchild all complete;
          // a refused entry settles one `failed` instead.
          yield* Effect.promise(async () => {
            const deadline = Date.now() + 60_000
            for (;;) {
              const children = rows(root).filter((row) => row.run_id !== receipt.runId)
              if (children.some((row) => row.status === "failed" || row.status === "cancelled")) {
                throw new Error(`a descendant did not run: ${JSON.stringify(children)}`)
              }
              if (children.length === 3 && children.every((row) => row.status === "completed")) return
              if (Date.now() > deadline) throw new Error(`descendants never settled: ${JSON.stringify(children)}`)
              await new Promise((resolve) => setTimeout(resolve, 20))
            }
          })
          const page = yield* control.list({ _tag: "runs", filters: { runId: receipt.runId } })
          expect(page._tag === "runs" && page.items[0]?.status).toBe("completed")
          return receipt.runId
        }).pipe(
          Effect.provide(Application.layer({ root }, registry, engine, executor) as Layer.Layer<Control.Control>),
          Effect.scoped
        )
      )

      expect(ran).toEqual(["grand"])
      expect(rows(root).filter((row) => row.run_id !== runId).map((row) => row.status)).toEqual([
        "completed",
        "completed",
        "completed"
      ])
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    }
  }, 180_000)
})
