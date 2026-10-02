import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Effect } from "effect"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import * as NodeControl from "../../../../src/NodeControl.ts"

const root = process.argv[3]!
await Effect.runPromise(
  Effect.gen(function*() {
    const control = yield* Control.Control
    if (process.argv[2] === "start") {
      const card = yield* control.plan({ flowId: "retained", input: { root } })
      yield* control.approve(card.approval)
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: "retained"
      })
      if (receipt._tag !== "Accepted" || !receipt.runId) return yield* Effect.die(receipt)
      writeFileSync(join(root, "run-id"), receipt.runId)
    }
    writeFileSync(join(root, `host-${process.argv[2]}-ready`), String(process.pid))
    yield* Effect.never
  }).pipe(Effect.provide(NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer })), Effect.scoped)
)
