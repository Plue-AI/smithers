import { useLiveQuery } from "@tanstack/react-db"
import { flowEditTodoInput } from "../flows/entries/flow"
import { ViewSkeleton } from "../ViewSkeleton"
import { flowAction, flowProps } from "../flows/FlowAction"
import { runSourceCommand } from "@smthrs/ui/run-command"
import { Button, Markdown } from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import type { Card } from "../state/AppState"
import type { CardFamily, CardOf, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { flowArgs } from "../flows/FlowArgs"
import type { ComponentType } from "react"
import { type FlowCard as FlowModel, type FlowViewProps } from "@smthrs/rpc/FlowCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import { FlowView } from "./views/FlowView"
import { useController } from "../ControllerContext"
import { useDesignWorld } from "../state/seams/DesignWorld/hooks"
import { flowCardOf } from "../state/seams/DesignWorld/run"
import type { FlowsSnapshot, FlowsSnapshots } from "../state/seams/FlowsSeam"

export interface FlowCardProps {
  /** The flow's model: GET /api/flows on an install, the seeded flows elsewhere. */
  readonly model: FlowModel | null | undefined
  readonly allowed: ReadonlySet<CatalogTag>
  readonly dispatch: CardCommandDispatch
  readonly View?: ComponentType<FlowViewProps>
  readonly view: FlowViewProps["view"]
  readonly onView: FlowViewProps["onView"]
}
/** Only a system flow (spec §11.1.1) is read-only; a built-in flow like TODO keeps Edit. */
export const FlowCard = ({ model: source, allowed, dispatch, View = FlowView, view, onView }: FlowCardProps) => {
  if (source === undefined || source === null) return null
  const activeVersion = source.versions.find(version => version.state === "active")
  const active = new Set(activeVersion?.steps.map(step => step.id))
  const model = { ...source, versions: source.versions.map(version => ({ ...version,
    steps: version.steps.map(step => "wait" in step ? step : { ...step, added: activeVersion !== undefined && version.state !== "active" && !active.has(step.id) }) })) }
  const definitions: CardActionDefinition<CatalogTag, "agent">[] = []
  for (const [tag, label] of [["flow.source", "Source"], ["flow.plan", "Plan"], ["flow.run", "Run"], ["flow.edit", "Edit"]] as const) {
    if (allowed.has(tag) && (!model.system || tag === "flow.plan")) definitions.push({ tag, label, command_input: { name: model.name } })
  }
  if (!model.system && allowed.has("flow.edit") && model.proposal !== undefined) definitions.push({ tag: "todo.new", label: "Make TODO", command_input: flowEditTodoInput(model.name, model.proposal.request, model.proposal.diff) })
  if (allowed.has("agent")) definitions.push({ tag: "agent", label: "Agent", gesture: "agent", command_input: { name: "" }, resolve_input: input => ({ name: input.name ?? "" }) })
  const bindings = cardActions<"agent">(dispatch, definitions)
  return <View model={model} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView} />
}

/*
 * The workspace's workflows (flow.list) — each row's Run is a command binding.
 * Exported because the Flows pane (ask 5, App.tsx) renders THESE rows: one
 * list with two mounts, never a second implementation of the same listing.
 */
export const WorkflowListCardBody = ({
  card,
  onRunCommand: sendRunCommand
}: {
  readonly card: Extract<Card, { kind: "workflow-list" }>
  readonly onRunCommand: RunCommand
}) => {
  const onRunCommand = runSourceCommand(card.id, sendRunCommand)
  const { workflows, issueContext, research, repo } = card.payload
  if (card.loading) return <ViewSkeleton />
  if (card.payload.catalogRequest?.state === "failed") return <div role="alert"><p>{card.body}</p><Button size="sm" {...flowAction(onRunCommand, "flow.list")}>Retry</Button></div>
  return (
    <div>
      {issueContext ? <p className="smithers-card-note">Issue #{issueContext.number} · {issueContext.title}</p> : null}
      {workflows.length === 0 ? <p className="smithers-card-note">No flows yet</p> : null}
      <ul className="workflow-list">
        {workflows.map((workflow) => (
          <li key={workflow.key} className="workflow-list-row">
            <div className="workflow-list-text">
              <button type="button" {...flowAction(onRunCommand, "flow", flowArgs("flow", { name: workflow.key }))}><strong>{workflow.description ?? workflow.key.replace(/^issue\//, "issue.")}</strong></button>
              {workflow.description !== null ? <span>{workflow.key.replace(/^issue\//, "issue.")}</span> : null}
              {workflow.prompt ? <Markdown className="smithers-card-markdown" content={workflow.prompt} /> : null}
            </div>
            {issueContext && (workflow.key === "issue.repro" || workflow.key === "issue/repro") ?
              <Button size="sm" variant="outline" {...flowProps("issue.repro")} onClick={() => sendRunCommand("issue.repro", flowArgs("issue.repro", { number: issueContext.number, repo }))}>Run repro</Button> :
              <Button size="sm" variant="outline"  {...flowAction(onRunCommand, "flow.run", flowArgs("flow.run", { name: workflow.key, input: issueContext ? { args: JSON.stringify({ issue: issueContext }) } : undefined }))}>Run</Button>}
            <Button size="sm" variant="ghost" {...flowAction(onRunCommand, "flow.plan", flowArgs("flow.plan", { name: workflow.key }))}>Plan</Button>
          </li>
        ))}
      </ul>
      {research ? <Markdown className="smithers-card-markdown" content={research} /> : null}
      {issueContext ? <Button size="sm" variant="outline" {...flowProps("issue.add-flow")} onClick={() => sendRunCommand("issue.add-flow", flowArgs("issue.add-flow", { number: issueContext.number, repo }))}>Add flow</Button> : null}
    </div>
  )
}

export const workflowCardFamily: CardFamily<"workflow-list"> = {
  "workflow-list": {
    render: (card, actions) => <WorkflowListCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}

/*
 * The `flow` kind (card-kinds.md L5, T-APP-05): the card names its flow; this
 * reads the model. On an install it is GET /api/flows (controller.flowCatalog),
 * where Edit, Source and agent navigation use install providers; Plan and Run await machine composition.
 * MOCK SEAM elsewhere: the seeded design world (state/seams/DesignWorld/run.ts),
 * whose Source and Edit are the design seam's presses.
 */
const DESIGN_FLOW_ACTIONS: ReadonlySet<CatalogTag> = new Set<CatalogTag>(["flow.source", "flow.edit", "agent"])
const INSTALL_FLOW_ACTIONS: ReadonlySet<CatalogTag> = new Set<CatalogTag>(["flow.edit", "flow.source", "agent"])
const UNAVAILABLE_FLOW_ACTIONS: ReadonlySet<CatalogTag> = new Set()
const NO_FLOWS: FlowsSnapshot = {}
const noCatalog: FlowsSnapshots = { subscribe: () => () => {}, get: () => NO_FLOWS }
const FlowBody = ({ card, maximized }: { readonly card: CardOf<"flow">; readonly maximized: boolean }) => {
  const controller = useController()
  const world = useDesignWorld()
  const identity = useLiveQuery(controller.store.collections.identitySessions).data[0]
  const member = controller.design.enabled ? controller.design.viewer() : identity?.login
  const saved = useLiveQuery(controller.store.collections.cards).data.find(row => row.id === card.id)
  const payload = saved?.kind === "flow" ? saved.payload : card.payload
  const catalog = controller.flowCatalog ?? noCatalog
  const served = useSyncExternalStore(catalog.subscribe, catalog.get, catalog.get)
  const model = controller.flowCatalog === undefined ? flowCardOf(world, card.payload.name) : served.flows?.find(flow => flow.name === card.payload.name)
  const dispatch: CardCommandDispatch = (tag, input) =>
    controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user", originCardId: card.id })
  if (model === undefined && controller.flowCatalog !== undefined) return served.error !== undefined
    ? <p role="alert">{served.error}</p>
    : served.flows === undefined ? <ViewSkeleton /> : <p role="alert">{`No flow ${card.payload.name}`}</p>
  const proposed = model === undefined || payload.proposal === undefined ? model : { ...model, proposal: payload.proposal }
  return <FlowCard model={proposed} allowed={controller.flowCatalog === undefined ? DESIGN_FLOW_ACTIONS : served.error !== undefined ? UNAVAILABLE_FLOW_ACTIONS : INSTALL_FLOW_ACTIONS} dispatch={dispatch}
    view={{ maximized, tab: member === undefined || member === null ? undefined : payload.memberVersions?.[member] ?? payload.version }} onView={patch => {
      if (!member || patch.tab === undefined || !model?.versions.some(version => version.id === patch.tab)) return
      const current = controller.store.collections.cards.get(card.id)
      if (current?.kind !== "flow" || current.payload.memberVersions?.[member] === patch.tab) return
      controller.store.dispatch({ type: "card.upsert", actor: "user", card: { ...current,
        payload: { ...current.payload, memberVersions: { ...current.payload.memberVersions, [member]: patch.tab } } } })
    }} />
}
export const flowCardFamily: CardFamily<"flow"> = {
  flow: { render: (card, actions) => <FlowBody card={card} maximized={actions.presentation === "maximized"} />, pill: () => "" }
}
