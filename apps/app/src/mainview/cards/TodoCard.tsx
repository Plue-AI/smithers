import { useSyncExternalStore, type ComponentType } from "react"
import { MembersCardSchema } from "@smthrs/rpc/MembersCard"
import { useTopic } from "../state/useTopic"
import { useLiveQuery } from "@tanstack/react-db"
import { TodoCardSchema, type TodoCard } from "@smthrs/rpc/TodoCard"
import type { ConfirmCard } from "@smthrs/rpc/ConfirmCard"
import type { PersonRef } from "@smthrs/rpc/CardPrimitives"
import type { CardProps } from "@smthrs/rpc/CardAction"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import type { TodoEntry } from "../state/seams/TodoSeam"
import { useController } from "../ControllerContext"
import { useDesignTodoCard } from "../state/seams/DesignWorld/todo"
import type { CardFamily, CardOf } from "./CardFamily"
import { TodoView } from "./views/TodoView"

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
  const definitions: CardActionDefinition[] = model.branch ? [{ tag: "branch", label: "Open branch", args: { name: model.branch.name, wait: "" }, command_input: { name: model.branch.name } }] : []
  if (model.run) definitions.push({ tag: "run.inspect", label: "Inspect", command_input: { id: model.run.id } })
  if (!live) return definitions
  const waitsFrom = definitions.length
  for (const wait of model.waits) {
    for (const action of wait.actions) {
      switch (action.tag) {
        case "todo.answer":
          if (!lateAnswer || (lateWait ? wait.id !== lateWait : model.waits.length > 1)) definitions.push({ ...action, tag: "todo.answer", args: { ...action.args, wait: wait.id },
            command_input: { n, wait: wait.id, answer: "" },
            resolve_input: input => ({ n, wait: wait.id, answer: input.answer ?? "" }) })
          break
        case "branch":
          if (model.branch) definitions.push({ ...action, tag: "branch", args: { ...action.args, wait: wait.id }, command_input: { name: model.branch.name } }); break
        case "branch.bring-in": case "branch.discard-foreign":
          if (wait.kind === "foreign_push" && wait.id && wait.sha && model.branch) definitions.push({ ...action, tag: action.tag, args: { ...action.args, wait: wait.id }, command_input: { branch: model.branch.name, id: wait.id, revision: wait.sha } })
          break
        case "todo.return-to-item": case "todo.keep-moved":
          definitions.push({ ...action, tag: action.tag, args: { ...action.args, wait: wait.id }, command_input: { n } }); break
      }
    }
  }
  // A wait's own controls render inside that wait (TodoView reads wait.actions): bound as gestures they dispatch, yet stay out of the card's one actions row.
  for (let index = waitsFrom; index < definitions.length; index++) definitions[index] = { ...definitions[index]!, gesture: `wait:${index}` }
  // Steer and Amend are plain buttons: an empty text opens Chat on the flow's line (TodoBody); a late answer sends as is.
  definitions.push({ tag: "todo.steer", label: lateAnswer ? "Send as steer" : "Steer", command_input: { n, text: lateAnswer ?? "" } })
  if (model.state === "paused") definitions.push({ tag: "todo.resume", label: "Resume", command_input: { n } })
  if (["starting", "working"].includes(model.state) || model.state === "needs_you" && model.waits.some(wait => !["question", "approval"].includes(wait.kind))) definitions.push({ tag: "todo.stop", label: "Stop", command_input: { n } })
  if (model.state === "failed" && model.failure?.retryable) definitions.push({ tag: "todo.retry", label: "Retry", command_input: { n },
    input: [{ name: "text", label: "Steer", kind: "text", required: false, multiline: true }],
    resolve_input: input => ({ n, text: input.text }) })
  definitions.push({ tag: "todo.amend", label: "Amend", command_input: { n, text: "" } }, { tag: "todo.drop", label: "Drop", command_input: { n } })
  if (model.pr && model.state === "in_review") {
    const checks = requiredChecks(model)
    const ready = model.merge.state === "ready" && model.place === 1 && role !== "member"
      && model.evidence.at(-1)?.revision === model.pr.head && checks.every(item => item.state === "passed") && !model.pr.draft
    // The head is bound to the command, even though the provisional catalog types only name n.
    const mergeInput = { n, reviewed_head_sha: model.pr.head }
    definitions.push({ tag: "merge", label: ready ? "Merge" : mergeLabel(model), command_input: mergeInput,
      ...(ready ? { primary: true } : { disabled: { reason: role === "member" ? "A maintainer merges" : mergeLabel(model) } }) })
  }
  return definitions
}
/**
 * Review & merge (T-APP-04 `review_merge`) for a TODO this host serves: the TODO card's own Merge control, so one
 * merge rule gates both cards and the press sends the PR head the person reviews. Merged, the card is its receipt.
 */
export const reviewMergeOf = (model: TodoCard, role: TodoContainerProps["role"], viewer: PersonRef):
  { readonly model: ConfirmCard; readonly actions: CardActionDefinition[] } | undefined => {
  if (!model.pr) return undefined
  const { head, number, url } = model.pr
  const merged = model.state === "merged"
  const confirm: ConfirmCard = {
    kind: "review_merge", action: { tag: "merge", verb: "Merge" }, summary: `Merge T${model.n}`,
    subject: { kind: "todo", ref: `T${model.n}`, revision: head },
    asked_by: { kind: "person", ...viewer, color_index: ([...viewer.login].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6) as 0 | 1 | 2 | 3 | 4 | 5 },
    review: { title: model.title, place: model.place ?? 1, pr: { number, url },
      evidence: model.evidence.at(-1) ?? { attempt: model.run?.attempt ?? 1, revision: head, items: [] }, merge: model.merge },
    ...(merged ? { receipt: { by: viewer, result: "done" as const, at: "", text: `Merged T${model.n}` } } : {})
  }
  if (merged) return { model: confirm, actions: [] }
  const merge = todoActionDefinitions(model, role).find(definition => definition.tag === "merge")
  return { model: confirm, actions: [
    { tag: "confirm.cancel", label: "Cancel", command_input: { confirmation: `merge:todo:${model.n}`, revision: head } },
    ...(merge ? [merge] : [])
  ] }
}
/** The viewer's role on this host's TODOs: the members roster, else the install owner's own session. */
export const useTodoRole = (): TodoContainerProps["role"] => {
  const controller = useController()
  const identity = useLiveQuery(controller.store.collections.identitySessions).data[0]
  const members = useTopic(controller.bootstrap ? "members" : undefined)
  const roster = MembersCardSchema.safeParse(members?.data)
  const install = useSyncExternalStore(controller.installSnapshots.subscribe, controller.installSnapshots.get, controller.installSnapshots.get)
  const role = roster.success ? roster.data.members.find(member => member.login === identity?.login)?.role : undefined
  return role ?? (install.model?.github.signed_in && install.model.github.owner === identity?.login ? "owner" : "member")
}
export const TodoContainer =({ card, role, dispatch, View, view, onView }: TodoContainerProps) => {
  if (!card.payload.model) return null
  const model = TodoCardSchema.parse(card.payload.model)
  const lateWait = [...card.payload.requests].reverse().find(request => request.operation === "answer" && request.state === "failed")?.body.wait
  const bindings = cardActions(dispatch, todoActionDefinitions(model, role, card.payload.answeredBy ? card.payload.answerDraft : undefined,
    typeof lateWait === "string" ? lateWait : undefined))
  return <View model={model} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView}
    answer={card.payload.answeredBy ? { text: card.payload.answerDraft ?? "", answered_by: card.payload.answeredBy } : undefined} />
}

/** The `todo` kind: the seeded design world's Tn while the seed is mounted (mock seam), else the server projection. */
const TodoBody = ({ card, maximized }: { readonly card: CardOf<"todo">; readonly maximized: boolean }) => {
  const controller = useController()
  const seed = useDesignTodoCard(card.payload.n)
  const seeded = card.payload.model || card.payload.requests.length > 0 ? undefined : seed
  const role = useTodoRole()
  const dispatch: CardCommandDispatch = (tag, input) => {
    const payload = (input ?? {}) as Record<string, unknown>
    if ((tag === "todo.steer" || tag === "todo.amend") && !payload.text) {
      controller.changeDraft(`/${tag} T${card.payload.n} `)
      return controller.runCommand("chat.open")
    }
    return controller.commands.submit({ name: tag, payload, actor: "user", originCardId: card.id })
  }
  const entry: TodoEntry = seeded === undefined ? card : { ...card, payload: { ...card.payload, model: seeded.model } }
  return <TodoContainer card={entry} role={seeded?.role ?? role} dispatch={dispatch} View={TodoView}
    view={{ maximized }} onView={() => {}} />
}
export const todoCardFamily: CardFamily<"todo"> = {
  todo: { render: (card, { presentation }) => <TodoBody card={card} maximized={presentation === "maximized"} />, pill: () => "" }
}
