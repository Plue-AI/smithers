/* T-APP-10: live topics map to BranchView; demo projections remain isolated. */
import { useState } from "react"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import type { BranchCard as BranchModel } from "@smthrs/rpc/BranchCard"
import { useTopic } from "../state/useTopic"
import { branchModel } from "../state/seams/BranchSeam"
import { useController } from "../ControllerContext"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import type { CardActions, CardFamily, CardOf } from "./CardFamily"
import { BranchView } from "./views/BranchView"
import { useDesignWorld } from "../state/seams/DesignWorld/hooks"
import { designBranchModel } from "../state/seams/DesignWorld/branch"
import { branchOf, todoOf, type DesignBranch, type DesignWorldRows } from "../state/seams/DesignWorld"

type Gesture = "item" | "file" | "terminal"
type Definition = CardActionDefinition<CatalogTag, Gesture>

/**
 * The viewer-filtered presses for one branch, in the footer's order. A closed branch offers Fork only; the
 * gestures (the item, a file, a terminal) are reads and stay bound on every branch.
 */
export const branchActionDefinitions = (world: DesignWorldRows, branch: DesignBranch, model: BranchModel): Definition[] => {
  const item = branch.item === undefined ? undefined : todoOf(world, branch.item)
  const n = model.item?.n
  const asking = item?.state === "needs-you" && item.question !== undefined && item.question.answer === undefined
  const definitions: Definition[] = []
  if (n !== undefined) definitions.push({ tag: "todo", label: model.item!.title, gesture: "item", command_input: { n }, resolve_input: () => ({ n }) })
  definitions.push(
    { tag: "file", label: "Open", gesture: "file", command_input: { path: "" }, resolve_input: input => ({ path: input.path ?? "" }) },
    { tag: "terminal.watch", label: "Watch", gesture: "terminal", command_input: { id: "" }, resolve_input: input => ({ id: input.id ?? "" }) }
  )
  /* S1 forks name their source as main or the item (CardAction BranchForkInputSchema, T-MCH-08); the branch rides the dispatch. */
  const fork: Definition = { tag: "branch.fork", label: "Fork", command_input: { from: n === undefined ? "main" : `T${n}` } }
  if (branch.machine === "closed") return [...definitions, fork]
  if (branch.rebasePending !== undefined) definitions.push({ tag: "branch.rebase", label: "Rebase now", primary: true, command_input: { branch: branch.id } })
  if (n !== undefined && asking) definitions.push({ tag: "todo.answer", label: "Answer", primary: true,
    input: [{ name: "answer", label: "Answer the coding agent", kind: "text", required: true, multiline: true }],
    command_input: { n, answer: "" }, resolve_input: input => ({ n, answer: input.answer ?? "" }) })
  if (n !== undefined) definitions.push({ tag: "todo.steer", label: "Steer",
    input: [{ name: "text", label: "Steer the coding agent", kind: "text", required: true, multiline: true }],
    command_input: { n, text: "" }, resolve_input: input => ({ n, text: input.text ?? "" }) })
  if (model.scratch !== undefined) definitions.push({ tag: "branch.add-to-stack", label: "Add to stack", primary: !asking, command_input: { text: branch.name } })
  definitions.push({ tag: "terminal", label: "New terminal", command_input: { branch: branch.id } }, fork)
  return definitions
}

/** Each change burst's Diff; the burst id rides as `args` so the View tells rows apart. */
export const changeActionDefinitions = (model: BranchModel): CardActionDefinition[] =>
  model.activity.filter(entry => entry.kind === "change")
    .map(entry => ({ tag: "diff", label: "Diff", args: { burst: entry.id }, command_input: undefined }))

const DesignBranchBody = ({ card, actions }: { readonly card: CardOf<"branch">; readonly actions: CardActions }) => {
  const controller = useController()
  const world = useDesignWorld()
  const [tab, setTab] = useState<string | undefined>(undefined)
  const branch = branchOf(world, card.payload.id)
  if (branch === undefined) return null
  const item = branch.item === undefined ? undefined : todoOf(world, branch.item)
  const submit = (name: string, payload: Record<string, unknown>) =>
    controller.commands.submit({ name, payload, actor: "user", originCardId: card.id })
  /* Every press names its branch; a flow decodes the keys it declares and ignores the rest. */
  const dispatch: CardCommandDispatch = (tag, input) => submit(tag, { branch: branch.id, ...(input ?? {}) })
  /* MOCK: a burst's Diff opens the branch's diff (its item's ref) until `snapshot_before`/`snapshot_after` land. */
  const diffDispatch: CardCommandDispatch = (tag, input) => submit(tag, { branch: branch.id, subject: item?.ref ?? branch.name, ...(input ?? {}) })
  const base = designBranchModel(world, branch)
  const bindings = cardActions<Gesture>(dispatch, branchActionDefinitions(world, branch, base))
  const changes = cardActions(diffDispatch, changeActionDefinitions(base))
  const model: BranchModel = { ...base, activity: base.activity.map(entry => entry.kind !== "change" ? entry
    : { ...entry, actions: changes.actions.filter(action => action.args?.burst === entry.id) }) }
  return <BranchView model={model} actions={bindings.actions} gestures={bindings.gestures}
    onAction={(tag, input) => (tag === "diff" ? changes : bindings).onAction(tag, input)}
    view={{ maximized: actions.presentation === "maximized", ...(tab === undefined ? {} : { tab }) }}
    onView={patch => { if ("tab" in patch) setTab(patch.tab) }} />
}

/** Live facts never inherit seed rows or server-supplied command authority. Dependent actions stay dark. */
export const LiveBranchBody = ({ card, actions }: { readonly card: CardOf<"branch">; readonly actions: CardActions }) => {
  const controller = useController()
  const topic = controller.live ? `branch:${card.payload.id}` : undefined
  const branch = useTopic(topic, controller.live)
  const activity = useTopic(topic && `${topic}:activity`, controller.live)
  const files = useTopic(topic && `${topic}:files`, controller.live)
  const model = branch?.error || activity?.error || files?.error ? undefined
    : branchModel(branch?.data, activity?.data, files?.data, card.payload.id)
  const bindings = cardActions(() => {}, [])
  if (!model) return null
  return <BranchView model={model} actions={bindings.actions} gestures={bindings.gestures}
    onAction={bindings.onAction} view={{ maximized: actions.presentation === "maximized" }} onView={() => {}} />
}

const BranchBody = (props: { readonly card: CardOf<"branch">; readonly actions: CardActions }) => {
  const controller = useController()
  return controller.live || controller.bootstrap ? <LiveBranchBody {...props} /> : <DesignBranchBody {...props} />
}

/** The `branch` kind: a subject-only card (card-kinds.md), one per branch. */
export const branchCardFamily: CardFamily<"branch"> = {
  branch: { render: (card, actions) => <BranchBody card={card} actions={actions} />, pill: () => "" }
}
