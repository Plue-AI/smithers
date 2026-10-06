import { Schema } from "effect"
import { flow, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"

// T-APP-17: read-only, one command for slash, button and agent.
export const contextFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "context.inspect", summary: "Inspect an answer’s stored context", args: "<branch> <answer>",
    hidden: !actions.contextAvailable(), discloseToAgent: actions.contextAvailable(),
    input: Schema.Struct({ branch: Schema.String.pipe(Schema.check(Schema.isMinLength(1))), answer: Schema.String.pipe(Schema.check(Schema.isMinLength(1))) }),
    grammar: args => {
      try { if (args?.trim().startsWith("{")) return { payload: JSON.parse(args) } } catch { return { error: "Invalid context input" } }
      const [branch, answer] = (args ?? "").trim().split(/\s+/)
      return { payload: { ...(branch ? { branch } : {}), ...(answer ? { answer } : {}) } }
    },
    handler: ({ branch, answer }) => actions.inspectContext(branch, answer) })
]
