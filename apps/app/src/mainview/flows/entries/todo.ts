import { Schema } from "effect"
import { flow, type CommandActions } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { Grammar } from "../SlashPayload"

export const namespace: Namespace = { id: "todo", label: "TODOs", summary: "Write and work on TODOs" }
const N = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Target = Schema.Struct({ n: N })
const Text = Schema.NonEmptyString
/** `text` is optional: New TODO opens an empty Draft, filled on the card (design Home → Draft). */
export const TodoNewInput = Schema.Struct({
  text: Schema.optional(Schema.String), title: Schema.optional(Text), acceptance: Schema.optional(Schema.Array(Schema.String)),
  before: Schema.optional(N), cardId: Schema.optional(Schema.String), idempotencyKey: Schema.optional(Text)
})
export const TodoAmendInput = Schema.Struct({
  n: N, text: Text, cardId: Schema.optional(Schema.String), idempotencyKey: Schema.optional(Text)
})

/** JSON is lossless for button/form doors; partial slash input preserves the TODO number. */
export const todoGrammar = (field?: "text" | "answer", target = true): Grammar => (args) => {
  const line = (args ?? "").trim()
  if (line.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(line)
      return value && typeof value === "object" && !Array.isArray(value)
        ? { payload: value as Record<string, unknown> } : { error: "Invalid TODO input" }
    } catch { return { error: "Invalid TODO input" } }
  }
  if (!target) return { payload: line ? { text: line } : {} }
  const match = /^(?:T)?([1-9]\d*)(?:\s+([\s\S]*))?$/.exec(line)
  return { payload: match ? { n: Number(match[1]), ...(field && match[2] ? { [field]: match[2] } : {}) } : {} }
}
const form = (submitLabel: string) => ({ submitLabel,
  fields: { cardId: { hidden: true }, idempotencyKey: { hidden: true }, n: { label: "TODO" }, text: { label: "Prompt" } },
  args: (payload: Record<string, unknown>) => JSON.stringify(payload) })

export const todoFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "draft.discard", summary: "Discard a private Draft", hidden: true,
    input: Schema.Struct({ draft: Text }), args: "<draft>", grammar: args => ({ payload: args?.trim() ? { draft: args.trim() } : {} }),
    handler: ({ draft }) => actions.dismissTodoDraft(draft) }),
  flow({ name: "todo.new", summary: "Write and place a TODO", args: "[text]", input: TodoNewInput,
    grammar: todoGrammar("text", false), form: form("Commit"),
    confirm: (payload) => payload.cardId ? "commit this TODO" : undefined,
    handler: (input) => actions.newTodo(input) }),
  flow({ name: "todo", summary: "Open a TODO", args: "<Tn>", input: Target,
    grammar: todoGrammar(), form: form("Open"), handler: ({ n }) => actions.showTodo(n) }),
  flow({ name: "todo.answer", summary: "Answer the agent's question", args: "<Tn> <answer>",
    input: Schema.Struct({ n: N, answer: Text, wait: Schema.optional(Text) }), grammar: todoGrammar("answer"), form: form("Answer"),
    handler: ({ n, answer, wait }) => actions.answerTodo(n, answer, wait) }),
  flow({ name: "todo.steer", summary: "Send the agent a correction", args: "<Tn> <text>",
    input: Schema.Struct({ n: N, text: Text }), grammar: todoGrammar("text"), form: form("Steer"),
    handler: ({ n, text }) => actions.steerTodo(n, text) }),
  flow({ name: "todo.amend", summary: "Change an unmerged TODO's prompt", args: "<Tn> <text>",
    input: TodoAmendInput, grammar: todoGrammar("text"), form: form("Amend"), confirm: "amend this TODO",
    handler: (input) => actions.amendTodo(input) }),
  flow({ name: "todo.stop", summary: "Pause a working TODO", args: "<Tn>", input: Target,
    grammar: todoGrammar(), form: form("Stop"), handler: ({ n }) => actions.controlTodo(n, "stop") }),
  flow({ name: "todo.resume", summary: "Resume a paused TODO", args: "<Tn>", input: Target,
    grammar: todoGrammar(), form: form("Resume"), handler: ({ n }) => actions.controlTodo(n, "resume") }),
  flow({ name: "todo.retry", summary: "Retry a failed TODO", args: "<Tn>",
    input: Schema.Struct({ n: N, text: Schema.optional(Schema.String) }), grammar: todoGrammar("text"), form: form("Retry"),
    handler: ({ n, text }) => actions.controlTodo(n, "retry", text) }),
  flow({ name: "todo.retry-current-flow", summary: "Retry with the current flow", hidden: true, discloseToAgent: true,
    input: Schema.Struct({ n: N, text: Schema.optional(Schema.String) }), grammar: todoGrammar("text"), form: form("Retry"),
    handler: ({ n, text }) => actions.controlTodo(n, "retry-current-flow", text) }),
  flow({ name: "todo.drop", summary: "Abandon an unmerged TODO", args: "<Tn>", input: Target,
    grammar: todoGrammar(), form: form("Drop"), confirm: "drop this TODO",
    handler: ({ n }) => actions.controlTodo(n, "drop") })
]
