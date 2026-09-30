/** One issue bundle, worked end to end by one coding agent on one account. */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Layer, Schema } from "effect"
import { brief } from "../brief.ts"
import { layerPlacement } from "../cloud-placement.ts"
import { layerRunAgent, RunAgent } from "../run-agent.ts"
import { Assignment, WorkerResult } from "../schema.ts"

export default Flow.make("burndown/worker", {
  description: "Works one issue bundle end to end with one coding agent on one subscription account.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:*", "net:get:*", "net:post:*", "model:call:*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Assignment,
  success: WorkerResult,
  error: Schema.String,
  body: Node.capture({ version: "burndown/worker/v1" }, (assignment: Assignment) => RunAgent.call(assignment))
})

/** RunAgent uses each assignment's declared local or Cloud placement. */
const briefFor = (assignment: Assignment, machine: { readonly workdir: string; readonly stateDir: string }) =>
  [
    brief({
      repo: assignment.repo,
      lead: assignment.lead,
      extras: assignment.extras,
      workdir: machine.workdir,
      execution: assignment.placement,
      tool: assignment.tool,
      model: assignment.model,
      landing: {
        claimBy: `burndown-${assignment.key}`,
        ...assignment.placement === "cloud" ? { lockPath: `${machine.stateDir}/vcs_lock.py` } : {}
      }
    }),
    ...(assignment.fix === undefined ? [] : [
      "",
      `FIX: the merge queue could not land your earlier change for this issue. Its error:\n${assignment.fix}\nRebase or redo the change on current main, then report READY lines again.`
    ])
  ].join("\n")

export const layer = layerRunAgent(briefFor).pipe(Layer.provide(layerPlacement))
