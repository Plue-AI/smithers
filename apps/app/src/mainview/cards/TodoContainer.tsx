import type { ComponentType } from "react"
import { TodoCardSchema, type TodoCard } from "@smthrs/rpc/TodoCard"
import type { CardProps } from "@smthrs/rpc/CardAction"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import type { TodoEntry } from "../state/seams/TodoSeam"

export interface TodoViewProps extends CardProps<TodoCard> {
  readonly answer?: { readonly text: string; readonly answered_by: string }
}
export interface TodoContainerProps {
  /** The subscribed todo:<n> collection entry, populated by TodoSeam. */
  readonly card: TodoEntry
  readonly role: "owner" | "maintainer" | "member"
  readonly dispatch: CardCommandDispatch
  readonly View: ComponentType<TodoViewProps>
  readonly view: CardProps<TodoCard>["view"]
  readonly onView: CardProps<TodoCard>["onView"]
}
const requiredChecks = (model: TodoCard) => {
  const evidence = model.evidence.at(-1)
  return evidence && model.pr && evidence.revision === model.pr.head
    ? evidence.items.flatMap(item => item.kind === "github_check" && item.required ? [item] : []) : []
}
const mergeLabel = (model: TodoCard) => {
  if (model.merge.reason === "order") return `Merges after ${model.merge.detail ?? "the previous TODO"}`
  const pending = requiredChecks(model).some(item => item.state === "pending")
  if (model.merge.reason === "checks" && pending) return "Checks running"
  return model.merge.detail ?? (pending ? "Checks running" : "Merge")
}
export const todoActionDefinitions = (model: TodoCard, role: TodoContainerProps["role"], lateAnswer?: string, lateWait?: string): CardActionDefinition[] => {
  const n = model.n
  const live = !["merged", "dropped"].includes(model.state)
  const definitions: CardActionDefinition[] = [{ tag: "branch", label: "Open branch", args: { name: model.branch.name, wait: "" }, command_input: { name: model.branch.name } }]
  if (!live) return definitions
  const textField = (label: string, name: string, value?: string) => [{ name, label, kind: "text" as const, required: true, multiline: true, value }]
  for (const wait of model.waits) {
    for (const action of wait.actions) {
      switch (action.tag) {
        case "todo.answer":
          if (!lateAnswer || (lateWait ? wait.id !== lateWait : model.waits.length > 1)) definitions.push({ ...action, tag: "todo.answer", args: { ...action.args, wait: wait.id },
            command_input: { n, wait: wait.id, answer: "" },
            resolve_input: input => ({ n, wait: wait.id, answer: input.answer ?? "" }) })
          break
        case "branch":
          definitions.push({ ...action, tag: "branch", args: { ...action.args, wait: wait.id }, command_input: { name: model.branch.name } }); break
        case "branch.bring-in": case "branch.discard-foreign":
          if (wait.sha) definitions.push({ ...action, tag: action.tag, args: { ...action.args, wait: wait.id }, command_input: { branch: model.branch.name, revision: wait.sha } })
          break
        case "todo.return-to-item": case "todo.keep-moved":
          definitions.push({ ...action, tag: action.tag, args: { ...action.args, wait: wait.id }, command_input: { n } }); break
      }
    }
  }
  definitions.push({ tag: "todo.steer", label: lateAnswer ? "Send as steer" : "Steer", command_input: { n, text: lateAnswer ?? "" },
    input: textField("Steer", "text", lateAnswer), resolve_input: input => ({ n, text: input.text ?? lateAnswer ?? "" }) })
  if (model.state === "paused") definitions.push({ tag: "todo.resume", label: "Resume", command_input: { n } })
  if (["starting", "working"].includes(model.state) || model.state === "needs_you" && model.waits.some(wait => !["question", "approval"].includes(wait.kind))) definitions.push({ tag: "todo.stop", label: "Stop", command_input: { n } })
  if (model.state === "failed" && model.failure?.retryable) definitions.push({ tag: "todo.retry", label: "Retry", command_input: { n },
    input: [{ name: "text", label: "Steer", kind: "text", required: false, multiline: true }],
    resolve_input: input => ({ n, text: input.text }) })
  definitions.push({ tag: "todo.amend", label: "Amend", command_input: { n, text: "" }, input: textField("Prompt", "text"),
    resolve_input: input => ({ n, text: input.text ?? "" }) }, { tag: "todo.drop", label: "Drop", command_input: { n } })
  if (model.pr && model.state === "in_review") {
    const checks = requiredChecks(model)
    const ready = model.merge.state === "ready" && model.place === 1 && role !== "member"
      && checks.length > 0 && checks.every(item => item.state === "passed") && !model.pr.draft
    // The head is bound to the command, even though the provisional catalog types only name n.
    const mergeInput = { n, reviewed_head_sha: model.pr.head }
    definitions.push({ tag: "merge", label: ready ? "Merge" : mergeLabel(model), command_input: mergeInput,
      ...(ready ? { primary: true } : { disabled: { reason: role === "member" ? "A maintainer merges" : mergeLabel(model) } }) })
  }
  return definitions
}
export const TodoContainer = ({ card, role, dispatch, View, view, onView }: TodoContainerProps) => {
  if (!card.payload.model) return null
  const model = TodoCardSchema.parse(card.payload.model)
  const lateWait = [...card.payload.requests].reverse().find(request => request.operation === "answer" && request.state === "failed")?.body.wait
  const bindings = cardActions(dispatch, todoActionDefinitions(model, role, card.payload.answeredBy ? card.payload.answerDraft : undefined,
    typeof lateWait === "string" ? lateWait : undefined))
  return <View model={model} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView}
    answer={card.payload.answeredBy ? { text: card.payload.answerDraft ?? "", answered_by: card.payload.answeredBy } : undefined} />
}
