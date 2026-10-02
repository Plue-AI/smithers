/** #3412: a real cancel mutation followed by interruption at its postcommit boundary. */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control, ControlExecutor } from "@smthrs/control"
import { Cause, Effect, Exit, Layer } from "effect"
import { strict as assert } from "node:assert"
import * as Application from "../../src/Application.ts"
import * as NodeControl from "../../src/NodeControl.ts"

/** Only native cleanup is interrupted; requests, consensus and journals remain real. */
export const commitCancelBeforeCleanup = async (root: string, runId: string): Promise<void> => {
  const registry = NodeControl.layerRegistry(root)
  const engine = NodeControl.engineDurable(root, registry)
  const native = NodeControl.layerExecutor(registry, engine, root, {
    startsRuns: false,
    evaluator: ScriptedJudge.layer,
    environment: process.env
  })
  const checkpoint = Layer.effect(ControlExecutor.ControlExecutor)(
    Effect.map(ControlExecutor.ControlExecutor, (executor) => ({
      ...executor,
      settleCancelledPark: () => Effect.interrupt
    }))
  ).pipe(Layer.provide(native))
  const control = Application.layer({ root, startsRuns: false }, registry, engine, checkpoint) as Layer.Layer<
    Control.Control
  >
  const exit = await Effect.runPromise(
    Effect.gen(function*() {
      const service = yield* Control.Control
      return yield* service.cancel({ runId, idempotencyKey: "3412-cancel-crash-checkpoint" })
    }).pipe(Effect.exit, Effect.provide(control), Effect.scoped)
  )
  assert(Exit.isFailure(exit), "the fixture must interrupt at postcommit cleanup")
  assert(Cause.hasInterruptsOnly(exit.cause), "only the explicit cleanup checkpoint may interrupt")
}
