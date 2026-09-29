/** An exported layer's construction budget cannot replace the approved run budget. */
import * as Budget from "@smthrs/agent/Budget"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Schema, Stream } from "effect"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"

describe("an exported module's approved budget", () => {
  it.each([
    { label: "pure module", capabilities: [], reads: [] },
    { label: "module with read permission", capabilities: ["fs:read:**"], reads: ["**"] }
  ])("$label uses the finite approved budget at dispatch", async ({ capabilities, reads }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-exported-module-budget-")))
    const observed: Array<{ sameBudget: boolean; before: string; after: string; tokens: number }> = []
    try {
      await mkdir(join(root, "flows", "budget"), { recursive: true })
      await writeFile(
        join(root, "flows", "budget", "flow.ts"),
        `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("budget", {
  description: "Check the approved budget.", payload: {}, success: Schema.Unknown,
  capabilities: ${JSON.stringify(capabilities)}, effects: { reads: ${
          JSON.stringify(reads)
        }, writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  body: Node.capture({}, () => Node.succeed(null))
})
`
      )
      const Probe = Action.make("fixture/Budget", { payload: {}, success: Schema.Unknown, error: Schema.Unknown })
      const flow = Flow.make("budget", {
        description: "Check the approved budget.",
        payload: {},
        success: Schema.Unknown,
        error: Schema.Unknown,
        capabilities,
        effects: { reads, writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
        body: Node.capture({ action: Probe.name }, () => Probe.call({}))
      })
      const implementation = Layer.unwrap(
        Effect.map(Budget.Budget, (constructionBudget) =>
          Probe.toLayer(() =>
            Effect.gen(function*() {
              const budget = yield* Budget.Budget
              const before = yield* budget.check("before")
              yield* budget.record("charged", { totalTokens: 3 })
              const after = yield* budget.check("next")
              const usage = yield* budget.usage
              const result = {
                sameBudget: budget === constructionBudget,
                before: before._tag,
                after: after._tag,
                tokens: usage.tokens
              }
              observed.push(result)
              return result
            })
          ))
      )
      const modules = Executable.layer({
        delegates: [],
        load: () => Effect.succeed({ default: flow, layer: implementation })
      }).pipe(Layer.orDie)
      const registry = NodeControl.layerRegistry(root)
      const engine = NodeControl.engineDurable(root, registry)
      const events = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({ flowId: "budget", input: {}, budget: { tokens: 3, onExceeded: "fail" } })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "exported-budget"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected admission")
          return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
            Stream.takeUntil((event) => event.kind === "control.run.completed" || event.kind === "control.run.failed"),
            Stream.runCollect,
            Effect.timeout("30 seconds")
          )
        }).pipe(
          Effect.provide(
            NodeControl.layerControl({ root, evaluator: ScriptedJudge.layerAll }, registry, engine, modules)
          ),
          Effect.scoped
        )
      )
      expect(events.at(-1)?.kind).toBe("control.run.completed")
      expect(observed).toEqual([{ sameBudget: false, before: "proceed", after: "refuse", tokens: 3 }])
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    }
  }, 60_000)
})
