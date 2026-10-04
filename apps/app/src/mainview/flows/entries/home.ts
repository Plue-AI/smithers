/** Home catalog doors refuse unavailable production providers without mock effects. */
import { Schema } from "effect"
import { flow, NoPayload, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"
import type { Grammar } from "../SlashPayload"
/** Agents may request Review; only a person may merge. */
export const MERGE_USER_ONLY_REASON = "a person merges; an agent's Merge opens the Review card"

/** Production doors stay dark until snapshot, authority and isolated admission are composed. */
const unavailable = () => "Home provider unavailable"

const N = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Id = Schema.String.check(Schema.isMinLength(1))
/** JSON for button doors; `T12 up` or `12` for the slash door. */
const todoGrammar = (field?: "direction"): Grammar => args => {
  const line = (args ?? "").trim()
  if (line.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(line)
      return value && typeof value === "object" && !Array.isArray(value) ? { payload: value as Record<string, unknown> } : { error: "Invalid input" }
    } catch { return { error: "Invalid input" } }
  }
  const match = /^(?:T)?([1-9]\d*)(?:\s+(\S+))?$/.exec(line)
  return { payload: match ? { n: Number(match[1]), ...(field && match[2] ? { [field]: match[2] } : {}) } : {} }
}
const idGrammar: Grammar = args => {
  const line = (args ?? "").trim()
  if (line.startsWith("{")) {
    try { return { payload: JSON.parse(line) as Record<string, unknown> } } catch { return { error: "Invalid input" } }
  }
  return { payload: line ? { id: line } : {} }
}

export const homeFlows = (_actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "stack", summary: "Show the stack and background runs", input: NoPayload,
    handler: unavailable }),
  flow({ name: "stack.move", summary: "Reorder an item", args: "<Tn> <up|down>", hidden: true, grammar: todoGrammar("direction"),
    input: Schema.Struct({ n: N, direction: Schema.Literals(["up", "down"]) }),
    handler: unavailable }),
  flow({ name: "merge", summary: "Merge the next item", args: "<Tn>", hidden: true, userOnly: true, userOnlyReason: MERGE_USER_ONLY_REASON, grammar: todoGrammar(),
    input: Schema.Struct({ n: N, reviewed_head_sha: Schema.optional(Schema.String) }),
    handler: unavailable }),
  flow({ name: "background.retry", summary: "Retry a background run", args: "<id>", hidden: true, grammar: idGrammar,
    input: Schema.Struct({ id: Id }),
    handler: unavailable }),
  flow({ name: "background.dismiss", summary: "Dismiss a background run", args: "<id>", hidden: true, grammar: idGrammar,
    input: Schema.Struct({ id: Id }),
    handler: unavailable }),
  flow({ name: "github", summary: "Show sync status and retry", hidden: true, input: NoPayload,
    handler: unavailable })
]
