import { pendingControls } from "@smthrs/ui/app-operations/controls"
import { bind, type CommandActions, type Handlers } from "./Declare"
import type { Refusal } from "@smthrs/rpc/Refusal"
const unavailable: Refusal = { code: null, rawCode: "not_available", fault: "infra", status: 503,
  origin: "client", retryAfter: null, message: "Not available yet" }
export const pendingControlFlows = (actions: CommandActions) => bind(pendingControls,
  Object.fromEntries(pendingControls.map(operation => [operation.name, operation.name === "todo.takeover" ? (input: { n: number }) => actions.controlTodo(input.n, "takeover")
    : operation.name === "settings.model.set" ? (input: { role: string; model: string }) => actions.assignAgentModel(input.role === "decisions" ? "jev" : input.role, input.model)
    : () => ({ refusal: unavailable })])) as unknown as Handlers<typeof pendingControls>)
