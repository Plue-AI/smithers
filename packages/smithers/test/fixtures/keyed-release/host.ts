import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Effect } from "effect"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import * as NodeControl from "../../../src/NodeControl.ts"

const mode = process.argv[2]!
const root = process.argv[3]!
NodeRuntime.runMain(
  Effect.gen(function*() {
    const control = yield* Control.Control
    if (mode === "original") {
      const card = yield* control.plan({ flowId: "keyed-release", input: { root } })
      yield* control.approve(card.approval)
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: "keyed-release"
      })
      if (receipt._tag !== "Accepted" || !receipt.runId) return yield* Effect.die(receipt)
      writeFileSync(join(root, "run-id"), receipt.runId)
    }
    writeFileSync(join(root, `host-${mode}-ready`), String(process.pid))
    // Public observations keep this host alive; they do not grant consent.
    for (;;) {
      yield* control.list({ _tag: "runs", filters: {} })
      yield* Effect.sleep("100 millis")
    }
  }).pipe(Effect.provide(NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer })), Effect.scoped)
)
