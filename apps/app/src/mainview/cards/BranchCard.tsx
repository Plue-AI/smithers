import { useSyncExternalStore } from "react"
/* T-APP-10: live topics map to BranchView; demo projections remain isolated. */
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import type { BranchCard as BranchModel } from "@smthrs/rpc/BranchCard"
import { useBranchPresence, useTopic } from "../state/useTopic"
import { branchModel, branchSeedAvailable, projectBranchActivity } from "../state/seams/BranchSeam"
import { useController } from "../ControllerContext"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import type { CardActions, CardFamily, CardOf } from "./CardFamily"
import { BranchView } from "./views/BranchView"
import { useDesignWorld } from "../state/seams/DesignWorld/hooks"
import { designBranchModel } from "../state/seams/DesignWorld/branch"
import { branchOf, todoOf, type DesignBranch, type DesignWorldRows } from "../state/seams/DesignWorld"

type Gesture = "item" | "file" | "terminal" | "run"
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

/** Only composed providers bind live presses; topic payloads carry no command authority. */
export const liveBranchActionDefinitions = (model: BranchModel, providers: ReadonlySet<CatalogTag>, questionWait?: string): Definition[] => {
  const definitions: Definition[] = []
  if (model.terminals.length) definitions.push({ tag: "terminal.watch", label: "Watch", gesture: "terminal",
    command_input: { id: "" }, resolve_input: input => ({ id: input.id ?? "" }) })
  if (model.presence.some(row => row.where.kind === "step" && row.actor.kind === "agent" && row.actor.run_id)) definitions.push({
    tag: "run", label: "Open", gesture: "run", command_input: { id: "" },
    resolve_input: input => ({ id: input.id ?? "" })
  })
  const n = model.item?.n
  if (n !== undefined) definitions.push({ tag: "todo", label: model.item!.title, gesture: "item",
    command_input: { n }, resolve_input: () => ({ n }) })
  definitions.push({ tag: "file", label: "Open", gesture: "file", args: { navigation: "file" },
    command_input: { path: "", branch: model.name },
    resolve_input: input => ({ path: input.path ?? "", branch: model.name,
      ...(input.line === undefined ? {} : { line: Number(input.line) }) }) })
  if (model.machine.state !== "closed") {
    if (model.machine.state === "awake") definitions.push({ tag: "box.suspend", label: "Sleep", command_input: { branch: model.name } })
    if (model.machine.state === "failed") definitions.push({ tag: "box.resume", label: "Retry", command_input: { branch: model.name } })
    if (model.machine.state === "asleep") definitions.push({ tag: "box.resume", label: "Wake", command_input: { branch: model.name } })
    if (model.scratch) definitions.push({ tag: "branch.add-to-stack", label: "Add to stack", command_input: { text: model.name } })
    if (model.moved_off) definitions.push(
      { tag: "todo.return-to-item", label: `Return to T${model.moved_off.item}`, command_input: { n: model.moved_off.item } },
      { tag: "todo.keep-moved", label: "Keep for now", command_input: { n: model.moved_off.item } }
    )
    if (model.scratch && model.rebase?.state === "conflict") {
      for (const path of model.rebase.paths) definitions.push({
        tag: "file", label: "Resolve", args: { conflict_path: path },
        command_input: { branch: model.name, path }
      })
    }
    if (model.scratch && model.rebase?.state === "conflict" && model.rebase.conflict_change && model.rebase.onto_revision) definitions.push({
      tag: "branch.rebase", label: "Done", command_input: { branch: model.name, conflict_change: model.rebase.conflict_change, onto_revision: model.rebase.onto_revision }
    })
    if (model.rebase?.state === "pending") definitions.push({ tag: "branch.rebase-now", label: "Rebase now", command_input: { branch: model.name } })
  }
  if (model.machine.state !== "closed" && n !== undefined) {
    const question = [...model.activity].reverse().find(entry => entry.kind === "question" || entry.kind === "answer")
    if (model.item?.state === "needs_you" && (questionWait !== undefined || question?.kind === "question")) definitions.push({
      tag: "todo.answer", label: "Answer", primary: true,
      input: [{ name: "answer", label: "Answer the coding agent", kind: "text", required: true, multiline: true }],
      command_input: { n, answer: "", ...(questionWait === undefined ? {} : { wait: questionWait }) },
      resolve_input: input => ({ n, answer: input.answer ?? "", ...(questionWait === undefined ? {} : { wait: questionWait }) })
    })
    definitions.push({ tag: "todo.steer", label: "Steer",
      input: [{ name: "text", label: "Steer the coding agent", kind: "text", required: true, multiline: true }],
      command_input: { n, text: "" }, resolve_input: input => ({ n, text: input.text ?? "" }) })
  }
  if (model.scratch && model.machine.state !== "closed") definitions.push({ tag: "branch.add-to-stack", label: "Add to stack", primary: true, command_input: { text: model.name } })
  // The current Fork provider accepts main or a TODO. A scratch branch must not silently fork main.
  if (n !== undefined || model.name === "main") definitions.push({ tag: "branch.fork", label: "Fork", command_input: { from: n === undefined ? "main" : `T${n}` } })
  return definitions.filter(definition => providers.has(definition.tag))
}

/** Each change burst's Diff; the burst id rides as `args` so the View tells rows apart. */
export const changeActionDefinitions = (model: BranchModel): CardActionDefinition[] =>
  model.activity.filter(entry => entry.kind === "change")
    .map(entry => ({ tag: "diff", label: "Diff", args: { burst: entry.id }, command_input: undefined }))

/** View selections use the same durable card transition on installs and demos. */
function persistBranchView(controller: ReturnType<typeof useController>, card: CardOf<"branch">, patch: { tab?: string }) {
  if (patch.tab !== "activity" && patch.tab !== "files" && patch.tab !== "terminals") return
  controller.setCardTab(card.id, patch.tab)
}

const DesignBranchBody = ({ card, actions }: { readonly card: CardOf<"branch">; readonly actions: CardActions }) => {
  const controller = useController()
  const world = useDesignWorld()
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
    view={{ maximized: actions.presentation === "maximized", ...(card.payload.tab === undefined ? {} : { tab: card.payload.tab }) }}
    onView={patch => persistBranchView(controller, card, patch)} />
}

/** Live facts never inherit seed rows or server-supplied command authority. Dependent actions stay dark. */
export const LiveBranchBody = ({ card, actions }: { readonly card: CardOf<"branch">; readonly actions: CardActions }) => {
  const controller = useController()
  const topic = controller.live ? `branch:${card.payload.id}` : undefined
  if (topic) controller.live?.registerProjection?.(`${topic}:activity`, projectBranchActivity)
  const roster = useSyncExternalStore(controller.membersRoster?.subscribe ?? (() => () => {}),
    controller.membersRoster?.get ?? (() => undefined), controller.membersRoster?.get ?? (() => undefined))
  const branch = useTopic(topic, controller.live)
  const activity = useTopic(topic && `${topic}:activity`, controller.live)
  const files = useTopic(topic && `${topic}:files`, controller.live)
  // An unserved optional stream must not hide the composed branch roster.
  // Permission failures and malformed snapshots still refuse the projection;
  // no seed rows stand in for unavailable activity or changed files.
  const optionalData = (snapshot: typeof activity) => snapshot?.error === "unsupported" ? [] : snapshot?.data
  const refused = (snapshot: typeof activity) => snapshot?.error !== undefined && snapshot.error !== "unsupported"
  const model = branch?.error || refused(activity) || refused(files) ? undefined
    : branchModel(branch?.data, optionalData(activity), optionalData(files), card.payload.id, { roster: roster?.model?.members.map(member => ({ ...member, id: member.login })) })
  const todos = useSyncExternalStore(controller.todoList?.subscribe ?? (() => () => {}),
    controller.todoList?.get ?? (() => undefined), controller.todoList?.get ?? (() => undefined))
  const questionWait = todos?.todos?.find(todo => todo.n === model?.item?.n)?.waits
    .find(wait => wait.kind === "question" && wait.actions.some(action => action.tag === "todo.answer"))?.id
  useBranchPresence(card.payload.id, controller.live)
  // Outside an install, an unanswered or absent provider keeps the existing seed visible.
  if (branchSeedAvailable(controller) && branch?.data === undefined
    && (branch?.error === undefined || branch.error === "unknown_topic" || branch.error === "unsupported")) return <DesignBranchBody card={card} actions={actions} />
  const providers = new Set<CatalogTag>()
  if (typeof controller.showTodo === "function") providers.add("todo")
  if (controller.branchFiles?.available()) providers.add("file")
  if (controller.terminalCards?.available()) providers.add("terminal.watch")
  if (controller.forkBranch) providers.add("branch.fork")
  if (controller.runMonitors && typeof controller.openRunMonitor === "function") providers.add("run")
  const controls = controller.branchControls
  if (controls?.available("sleep")) providers.add("box.suspend")
  if (controls?.available("wake")) providers.add("box.resume")
  if (controls?.available("rebase")) { providers.add("branch.rebase-now"); providers.add("branch.rebase") }
  if (controls?.available("return-to-item")) providers.add("todo.return-to-item")
  if (controls?.available("keep-moved")) providers.add("todo.keep-moved")
  if (controller.addBranchToStack) providers.add("branch.add-to-stack")
  if (typeof controller.answerTodo === "function" && questionWait !== undefined) providers.add("todo.answer")
  if (typeof controller.steerTodo === "function") providers.add("todo.steer")
  const dispatch: CardCommandDispatch = (tag, input) => controller.commands.submit({
    name: tag, payload: { branch: model?.name ?? card.payload.id, ...(input ?? {}) }, actor: "user", originCardId: card.id
  })
  const bindings = cardActions<Gesture>(dispatch, model ? liveBranchActionDefinitions(model, providers, questionWait) : [])
  if (!model) return branchSeedAvailable(controller) ? <DesignBranchBody card={card} actions={actions} /> : null
  return <BranchView model={model} actions={bindings.actions} gestures={bindings.gestures}
    onAction={bindings.onAction} view={{ maximized: actions.presentation === "maximized", tab: card.payload.tab }}
    onView={patch => persistBranchView(controller, card, patch)} />
}

const BranchBody = (props: { readonly card: CardOf<"branch">; readonly actions: CardActions }) => {
  const controller = useController()
  return controller.live || controller.bootstrap ? <LiveBranchBody {...props} /> : <DesignBranchBody {...props} />
}

/** The `branch` kind: a subject-only card (card-kinds.md), one per branch. */
export const branchCardFamily: CardFamily<"branch"> = {
  branch: { render: (card, actions) => <BranchBody card={card} actions={actions} />, pill: () => "" }
}
