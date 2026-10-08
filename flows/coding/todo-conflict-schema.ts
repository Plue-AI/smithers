import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action } from "@smthrs/flow"
import { Schema } from "effect"
import { NativeCodingError } from "./native.ts"
import { CodingError } from "./schema.ts"

export const ConflictInput = Schema.Struct({
  kind: Schema.Literal("rebase-conflict"), change: Schema.NonEmptyString,
  onto: Schema.NonEmptyString, paths: Schema.Array(Schema.NonEmptyString),
  intent: Schema.optionalKey(Schema.String),
  limit: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 8 })), name: Schema.NonEmptyString
})
export const Repair = AgentAction.make("coding/resolve-rebase-conflict", {
  payload: ConflictInput,
  output: Schema.Struct({ summary: Schema.String, reads: Schema.Array(Schema.String), writes: Schema.Array(Schema.String) }),
  seat: "coding/implement",
  system: [
    "Resolve the retained rebase conflicts in the owning workspace using the provided filesystem tools.",
    "Preserve the TODO's intent and the new main changes. Read the conflicted files and repository instructions before editing.",
    "The workflow owns Git and JJ. Do not invoke them, commit, change branches, or select a different workspace.",
    "Report actual files read and written. Native inspection and independent checks decide completion."
  ],
  prompt: (input) => input.paths.map((path) => `Resolve the conflict in path ${JSON.stringify(path)}.`).join("\n") + "\n" + JSON.stringify(input)
})
export const Resolved = Action.make("coding/rebase-conflict-resolved", {
  payload: ConflictInput, success: Schema.Boolean, error: NativeCodingError, nondeterministic: true
})
export const Done = Action.make("coding/rebase-conflict-done", {
  payload: ConflictInput, success: Schema.Void
})
export const RepairPayload = Schema.Struct({ input: ConflictInput, remaining: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 8 })) })
export const RepairError = Schema.Union([AgentAction.AgentFailure, NativeCodingError, CodingError])
