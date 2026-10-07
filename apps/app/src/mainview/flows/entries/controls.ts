import { carriedPayload } from "../SlashPayload"
import { parseTodoArgs } from "@smthrs/rpc/TodoCommands"
import { pendingControls } from "@smthrs/ui/app-operations/controls"
import { bind, type CommandActions, type Handlers } from "./Declare"
import type { Refusal } from "@smthrs/rpc/Refusal"
const unavailable: Refusal = { code: null, rawCode: "not_available", fault: "infra", status: 503,
  origin: "client", retryAfter: null, message: "Not available yet" }
export const pendingControlFlows = (actions: CommandActions) => bind(pendingControls.map(operation => operation.name === "todo.takeover"
  ? { ...operation, grammar: parseTodoArgs(), form: { submitLabel: "Take over", args: (payload: Readonly<Record<string, unknown>>) => JSON.stringify(payload) } } : operation.name === "branch.bring-in"
  ? { ...operation, grammar: (args: string | undefined) => args?.trim() ? carriedPayload(operation.name)(args) : { payload: {} }, form: { args: (payload: Readonly<Record<string, unknown>>) => JSON.stringify(payload) }, confirm: "bring in this outside push", confirmArgs: (payload: Readonly<Record<string, unknown>>) => JSON.stringify(payload) }
  : operation.name === "branch.discard-foreign"
  ? { ...operation, grammar: (args: string | undefined) => args?.trim() ? carriedPayload(operation.name)(args) : { payload: {} },
      form: { args: (payload: Readonly<Record<string, unknown>>) => JSON.stringify(payload) }, confirm: "discard this outside push", confirmArgs: (payload: Readonly<Record<string, unknown>>) => JSON.stringify(payload) }
    : operation.name === "learning.accept" || operation.name === "learning.dismiss"
    ? { ...operation, grammar: carriedPayload(operation.name),
        form: { submitLabel: operation.summary, args: (payload: Readonly<Record<string, unknown>>) => JSON.stringify(payload) },
        preflight: (_payload: unknown, invoker?: "user" | "agent" | "system") => invoker === "agent" || invoker === "system" ? "Confirmation execution unavailable." : undefined }
    : operation),
  Object.fromEntries(pendingControls.map(operation => [operation.name, operation.name === "todo.preapprove" || operation.name === "todo.unapprove" ? (input: { n: number }) => actions.preapproveTodo(input.n, operation.name === "todo.preapprove")
    : operation.name === "order.ok" ? (input: { id: string; revision: number }) => actions.orderOK(input.id, input.revision)
    : operation.name === "todo.takeover" ? (input: { n: number }) => actions.controlTodo(input.n, "takeover")
    : operation.name === "branch.rebase-now" ? (input: { branch: string }) => actions.branchControls?.request("rebase", input.branch) ?? { refusal: unavailable }
    : operation.name === "todo.return-to-item" || operation.name === "todo.keep-moved" ? (input: { n: number }) => actions.branchControls?.request(operation.name === "todo.return-to-item" ? "return-to-item" : "keep-moved", `T${input.n}`) ?? { refusal: unavailable }
    : operation.name === "branch.bring-in" ? (input: { branch: string; id: string; revision: string }) => actions.bringIn(input.branch, input.id, input.revision)
    : operation.name === "branch.discard-foreign" ? (input: { branch: string; id: string; revision: string }) => actions.discardForeign(input.branch, input.id, input.revision)
    : operation.name === "learning.accept" ? (input: { id: string }) => actions.resolveProposal(input.id, "accept")
    : operation.name === "learning.dismiss" ? (input: { id: string }) => actions.resolveProposal(input.id, "dismiss")
    : operation.name === "settings.model.set" ? (input: { role: string; model: string }) => actions.assignAgentModel(input.role === "decisions" ? "jev" : input.role, input.model)
    : () => ({ refusal: unavailable })])) as unknown as Handlers<typeof pendingControls>)
