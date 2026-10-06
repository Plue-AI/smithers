import { carriedPayload } from "../SlashPayload"
import { parseTodoArgs } from "@smthrs/rpc/TodoCommands"
import { pendingControls } from "@smthrs/ui/app-operations/controls"
import { bind, type CommandActions, type Handlers } from "./Declare"
import type { Refusal } from "@smthrs/rpc/Refusal"
const unavailable: Refusal = { code: null, rawCode: "not_available", fault: "infra", status: 503,
  origin: "client", retryAfter: null, message: "Not available yet" }
export const pendingControlFlows = (actions: CommandActions) => bind(pendingControls.map(operation => operation.name === "todo.takeover"
  ? { ...operation, grammar: parseTodoArgs(), form: { submitLabel: "Take over", args: (payload: Readonly<Record<string, unknown>>) => JSON.stringify(payload) } } : operation.name === "branch.discard-foreign"
  ? { ...operation, grammar: (args: string | undefined) => args?.trim() ? carriedPayload(operation.name)(args) : { payload: {} },
      confirm: "discard this outside push", confirmArgs: (payload: Readonly<Record<string, unknown>>) => JSON.stringify(payload) } : operation),
  Object.fromEntries(pendingControls.map(operation => [operation.name, operation.name === "todo.takeover" ? (input: { n: number }) => actions.controlTodo(input.n, "takeover")
    : operation.name === "branch.discard-foreign" ? (input: { branch: string; id: string; revision: string }) => actions.discardForeign(input.branch, input.id, input.revision)
    : operation.name === "settings.model.set" ? (input: { role: string; model: string }) => actions.assignAgentModel(input.role === "decisions" ? "jev" : input.role, input.model)
    : () => ({ refusal: unavailable })])) as unknown as Handlers<typeof pendingControls>)
