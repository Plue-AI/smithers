/**
 * The build flow: a prompt about an app, a plan for building it.
 *
 * This is aomi's smither pipeline as one flow: describe the app, plan the
 * files, generate them, validate, fix what validation found, smoke test, then
 * ship behind an approval. The stages are prompt files in `./prompts`; the
 * agent reads them as it works and reports the whole run as one `BuildPlan`.
 *
 * It is a pipeline flow, not a chat: it runs to completion from its payload and
 * returns a typed plan the Build page renders. `flows/build/AGENT.ts` gives it
 * a stronger seat than the root agent.
 */
import { Flow } from "@smthrs/flow"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Schema from "effect/Schema"

/** One file the plan intends to write. */
export const PlannedFile = Schema.Struct({
  path: Schema.String.annotate({ description: "App-root relative path" }),
  purpose: Schema.String.annotate({ description: "One line: what this file is for" })
})

/** One pipeline stage and where it got to. */
export const PlannedStep = Schema.Struct({
  name: Schema.String.annotate({ description: "Stage name: describe, plan, generate, validate, fix, smoke, or ship" }),
  status: Schema.Literals(["pending", "running", "done", "failed", "cached"])
})

/** What a build run reports. */
export const BuildPlan = Schema.Struct({
  name: Schema.String.annotate({ description: "The app's name, slug-safe" }),
  summary: Schema.String.annotate({ description: "One paragraph: what was built and what it does" }),
  files: Schema.Array(PlannedFile),
  steps: Schema.Array(PlannedStep),
  shipUrl: Schema.optionalKey(
    Schema.String.annotate({ description: "Deployed URL; present only after the ship stage was approved and ran" })
  )
})
export type BuildPlan = typeof BuildPlan.Type

export default Flow.make("build", {
  description: "Build or extend an app from a prompt: describe, plan, generate, validate, fix, smoke test, then ship.",
  payload: {
    app: Schema.String,
    prompt: Schema.String,
    source: Schema.optionalKey(Schema.Literals(["new", "existing"]))
  },
  success: BuildPlan,
  chat: false,
  error: AgentAction.AgentFailure,
  prompt: ({ app, prompt, source }) =>
    [
      `App: ${app}`,
      `Source: ${source ?? "new"}`,
      "",
      "Request:",
      prompt
    ].join("\n"),
  system: [
    "Work the stages in order: describe, plan, generate, validate, fix, smoke, ship. Read the matching prompt file under flows/build/prompts before each stage that has one.",
    "Do not skip validate. A plan that was never validated reports its steps as failed, not as done.",
    "Ship is gated on human approval. Never report a shipUrl for a deploy that was not approved and did not run.",
    "Report every stage you touched in `steps`, including the ones that failed, and every file in `files`."
  ]
})
