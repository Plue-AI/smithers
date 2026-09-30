import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Effect } from "effect"
import { access, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as NodeControl from "../../src/NodeControl.ts"

export const host = (root: string) => NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer })
if (process.argv[2] === "original") {
  const root = process.argv[3]!
  NodeRuntime.runMain(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const card = yield* control.plan({ flowId: "external-peer", input: { root } })
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

if (process.argv[2] === "observer") {
  const root = process.argv[3]!
  await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      yield* Effect.promise(() => writeFile(join(root, "observer-ready"), "ready"))
      while (!(yield* Effect.promise(() => access(join(root, "observer-close")).then(() => true, () => false)))) {
        yield* control.list({ _tag: "runs", filters: {} })
        yield* Effect.sleep("20 millis")
      }
    }).pipe(Effect.provide(host(root)), Effect.scoped)
  )
}
