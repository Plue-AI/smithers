import { Schema } from "effect"
/* The catalog entries and grammar the model host binds its TODO commands to as well (@smthrs/rpc/TodoCommands). */
import { parseTodoArgs, TODO_COMMAND, TODO_NEW_COMMAND } from "@smthrs/rpc/TodoCommands"
import { flow, type CommandActions } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"

export const namespace: Namespace = { id: "todo", label: "TODOs", summary: "Write and work on TODOs" }
const N = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Target = Schema.Struct({ n: N })
const Text = Schema.NonEmptyString
/**
 * `text` is optional: New TODO opens an empty Draft, filled on the card (design Home → Draft). The model host reads
 * the same fields with @smthrs/rpc TodoNewInputSchema; todo.test.ts decodes both.
 */
export const TodoNewInput = Schema.Struct({
  text: Schema.optional(Schema.String), title: Schema.optional(Text), acceptance: Schema.optional(Schema.Array(Schema.String)),
  before: Schema.optional(N), cardId: Schema.optional(Schema.String), idempotencyKey: Schema.optional(Text)
})
export const TodoAmendInput = Schema.Struct({
  n: N, text: Text, acceptance: Schema.optional(Schema.Array(Schema.String)), cardId: Schema.optional(Schema.String), idempotencyKey: Schema.optional(Text)
})

const form = (submitLabel: string) => ({ submitLabel,
  fields: { cardId: { hidden: true }, idempotencyKey: { hidden: true }, n: { label: "TODO" }, text: { label: "Prompt" } },
  args: (payload: Record<string, unknown>) => JSON.stringify(payload) })

export const todoFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "draft.discard", agent: "run", minimumRole: "member", actors: ["person","app_agent"], visibility: "in-card",  summary: "Discard a private Draft", hidden: true,
    input: Schema.Struct({ draft: Text }), args: "<draft>", grammar: args => ({ payload: args?.trim() ? { draft: args.trim() } : {} }),
    handler: ({ draft }) => actions.dismissTodoDraft(draft) }),
  flow({ name: "todo.new",   slash: "/todo.new", cli: ["todo","new"], journey: ["J1","J2"], group: "TODOs and the stack", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/todos",body:{prompt:"text",title:"title",acceptance:"acceptance"},defaults:{place:{mode:"append"}}}, summary: TODO_NEW_COMMAND.summary, args: TODO_NEW_COMMAND.args, agent: "confirm", input: TodoNewInput,
    grammar: parseTodoArgs("text", false), form: form("Commit"),
    confirm: (payload) => payload.cardId ? "commit this TODO" : undefined,
    handler: (input) => actions.newTodo(input) }),
  flow({ name: "todo",   slash: "/todo", cli: ["todo","show"], journey: ["J2","J4"], group: "TODOs and the stack", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"GET","path":"/api/todos/{n}"}, summary: TODO_COMMAND.summary, args: TODO_COMMAND.args, agent: "run", input: Target,
    grammar: parseTodoArgs(), form: form("Open"), handler: ({ n }) => actions.showTodo(n) }),
  flow({ name: "todo.answer",   slash: "/todo.answer", cli: ["todo","answer"], journey: ["J2","J3","J4"], group: "TODOs and the stack", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/todos/{n}/answer"}, summary: "Answer the agent's question", args: "<Tn> <answer>",
    agent: "run", input: Schema.Struct({ n: N, answer: Text, wait: Schema.optional(Text) }), grammar: parseTodoArgs("answer"), form: form("Answer"),
    handler: ({ n, answer, wait }) => actions.answerTodo(n, answer, wait) }),
  flow({ name: "todo.steer",   slash: "/todo.steer", cli: ["todo","steer"], journey: ["J3","J4"], group: "TODOs and the stack", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/todos/{n}",defaults:{op:"steer"}}, summary: "Send the agent a correction", args: "<Tn> <text>",
    agent: "run", input: Schema.Struct({ n: N, text: Text }), grammar: parseTodoArgs("text"), form: form("Steer"),
    handler: ({ n, text }) => actions.steerTodo(n, text) }),
  flow({ name: "todo.amend",   slash: "/todo.amend", cli: ["todo","amend"], journey: ["J7"], group: "TODOs and the stack", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"PATCH","path":"/api/todos/{n}",body:{prompt:"text"}}, summary: "Change an unmerged TODO's prompt", args: "<Tn> <text>",
    agent: "confirm", input: TodoAmendInput, grammar: parseTodoArgs("text"), form: form("Amend"), confirm: "amend this TODO",
    handler: (input) => actions.amendTodo(input) }),
  flow({ name: "todo.stop",   slash: "/todo.stop", cli: ["todo","stop"], journey: ["J4"], group: "TODOs and the stack", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/todos/{n}",defaults:{op:"stop"}}, summary: "Pause a working TODO", args: "<Tn>", agent: "run", input: Target,
    grammar: parseTodoArgs(), form: form("Stop"), handler: ({ n }) => actions.controlTodo(n, "stop") }),
  flow({ name: "todo.resume",   slash: "/todo.resume", cli: ["todo","resume"], journey: ["J4"], group: "TODOs and the stack", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/todos/{n}",defaults:{op:"resume"}}, summary: "Resume a paused TODO", args: "<Tn>", agent: "run", input: Target,
    grammar: parseTodoArgs(), form: form("Resume"), handler: ({ n }) => actions.controlTodo(n, "resume") }),
  flow({ name: "todo.retry",   slash: "/todo.retry", cli: ["todo","retry"], journey: ["J4"], group: "TODOs and the stack", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/todos/{n}",defaults:{op:"retry"}}, summary: "Retry a failed TODO", args: "<Tn>",
    agent: "run", input: Schema.Struct({ n: N, text: Schema.optional(Schema.String) }), grammar: parseTodoArgs("text"), form: form("Retry"),
    handler: ({ n, text }) => actions.controlTodo(n, "retry", text) }),
  flow({ name: "todo.retry-current-flow", agent: "run", minimumRole: "member", actors: ["person","app_agent"], visibility: "in-card",  summary: "Retry with the current flow", hidden: true, discloseToAgent: true,
    input: Schema.Struct({ n: N, text: Schema.optional(Schema.String) }), grammar: parseTodoArgs("text"), form: form("Retry"),
    handler: ({ n, text }) => actions.controlTodo(n, "retry-current-flow", text) }),
  flow({ name: "todo.drop",   slash: "/todo.drop", cli: ["todo","drop"], journey: ["J4","J7"], group: "TODOs and the stack", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/todos/{n}",defaults:{op:"drop"}}, summary: "Abandon an unmerged TODO", args: "<Tn>", agent: "confirm", input: Target,
    grammar: parseTodoArgs(), form: form("Drop"), confirm: "drop this TODO",
    handler: ({ n }) => actions.controlTodo(n, "drop") })
]
