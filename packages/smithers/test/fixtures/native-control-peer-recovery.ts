import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Schema } from "effect"
import { access, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as CoreFlow from "../../flows/core/src/Flow.ts"
import * as NodeControl from "../../src/NodeControl.ts"

export const source = `
import * as Flow from "@smthrs/core/Flow"
import { Schema } from "effect"
export default Flow.make({ name: "peer", description: "Peer recovery probe", input: Schema.Struct({}), output: Schema.String,
capabilities: [], flows: ["peer/Delegate"], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" } })
`

/** A real native execution stays alive until the test releases its file gate. */
export const host = (root: string) => {
  const Probe = Action.make("peer/Probe", { payload: {}, success: Schema.String, error: Schema.Unknown })
  const Delegate = Flow.make("peer/Delegate", {
    payload: Executable.Invocation,
    success: Schema.String,
    error: Schema.Unknown,
    body: () => Probe.call({})
  })
  const wait: Effect.Effect<void> = Effect.suspend(() =>
    Effect.promise(() => access(join(root, "release")).then(() => true, () => false)).pipe(
      Effect.flatMap((released) => released ? Effect.void : Effect.sleep("20 millis").pipe(Effect.andThen(wait)))
    )
  )
  const modules = Executable.layer({
    delegates: [Delegate],
    load: () =>
      Effect.succeed({
        default: CoreFlow.make({
          name: "peer",
          description: "Peer recovery probe",
          input: Schema.Struct({}),
          output: Schema.String,
          capabilities: [],
          flows: ["peer/Delegate"],
          effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" }
        })
      })
  }).pipe(
    Layer.provideMerge(Layer.mergeAll(
      Interpreter.layer(Delegate),
      Probe.toLayer(() =>
        Effect.promise(() => writeFile(join(root, `entered-${process.pid}`), "entered")).pipe(
          Effect.andThen(wait),
          Effect.as("recovered")
        )
      )
    )),
    Layer.orDie
  )
  return NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer }, undefined, undefined, modules)
}

if (process.argv[2] === "peer-original") {
  const root = process.argv[3]!
  await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const card = yield* control.plan({ flowId: "peer", input: {} })
      yield* control.approve(card.approval)
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: "peer"
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("Run was not accepted")
      yield* Effect.promise(() => writeFile(join(root, "run-id"), receipt.runId!))
      yield* Effect.never
    }).pipe(Effect.provide(host(root)), Effect.scoped)
  )
}
