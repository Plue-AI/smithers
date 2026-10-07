import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Effect } from "effect"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import * as NodeControl from "../../src/NodeControl.ts"

export const source = (root: string) => `
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import { access, appendFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
const root = ${JSON.stringify(root)}
const Probe = Action.make("peer/Probe", {
  payload: {}, success: Schema.String, error: Schema.Unknown,
  tier: "irreversible", implementationVersion: "peer/v1", idempotencyKey: "peer-probe"
})
const wait = Effect.suspend(() =>
  Effect.promise(() => access(join(root, "release")).then(() => true, () => false)).pipe(
    Effect.flatMap((released) => released ? Effect.void : Effect.sleep("20 millis").pipe(Effect.andThen(wait)))
  )
)
export const layer = Probe.toLayer(() =>
  Effect.promise(async () => {
    await appendFile(join(root, "attempts.txt"), process.pid + "\\n")
    await writeFile(join(root, "entered-" + process.pid), "entered")
  }).pipe(
    Effect.andThen(wait), Effect.as("recovered")
  ), { implementationVersion: "peer/v1" }
)
export default Flow.make("peer", {
  description: "Peer recovery probe", payload: {}, success: Schema.String, error: Schema.Unknown,
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  body: Node.capture({ action: Probe.name, implementationVersion: "peer/v1" }, () => Probe.call({}))
})
`

/** A production host loads the file flow and waits on its external file gate. */
export const host = (root: string) => NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer })

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
