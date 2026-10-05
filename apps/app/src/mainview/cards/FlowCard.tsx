import { ViewSkeleton } from "../ViewSkeleton"
import { flowAction, flowProps } from "../flows/FlowAction"
import { runSourceCommand } from "@smthrs/ui/run-command"
import { Button, Markdown } from "@smthrs/ui"
import { useId, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import type { Card } from "../state/AppState"
import { rovingKeyDown } from "../RovingKeyDown"
import type { CardFamily, CardOf, RunCommand } from "./CardFamily"
import { defaultPill, settledPill } from "./CardFamily"
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
  const definitions: CardActionDefinition[] = []
  for (const [tag, label] of [["flow.source", "Source"], ["flow.plan", "Plan"], ["flow.run", "Run"], ["flow.edit", "Edit"]] as const) {
    if (allowed.has(tag) && (!model.system || tag === "flow.plan")) definitions.push({ tag, label, command_input: { name: model.name } })
  }
  if (!model.system && model.proposal && allowed.has("todo.new")) definitions.push({ tag: "todo.new", label: "Make TODO", primary: true, command_input: { cardId: model.proposal.draftId } })
  const bindings = cardActions(dispatch, definitions)
  return <View model={model} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView} />
}

/*
 * Wave 12 §2 — which loaded repository. Embedded, keyboard-complete (arrows
 * move, Enter chooses), and one act: choosing IS the confirm, so the create
 * resumes immediately on the repo the human named.
 */
const WorkflowRepoCardBody = ({
  card,
  onChooseWorkflowRepo
}: {
  readonly card: Extract<Card, { kind: "workflow-repo" }>
  readonly onChooseWorkflowRepo: (fullName: string) => void
}) => {
  const optionId = useId()
  const { repos, chosen, description } = card.payload
  const [highlighted, setHighlighted] = useState(0)
  const index = Math.min(highlighted, Math.max(repos.length - 1, 0))
  if (chosen !== null) {
    return <p className="smithers-card-note">Creating it on {chosen}.</p>
  }
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const move = rovingKeyDown(event.key, { count: repos.length, current: index })
    if (move.kind === "move") {
      event.preventDefault()
      setHighlighted(move.index)
      return
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      const repo = repos[index]
      if (repo !== undefined) onChooseWorkflowRepo(repo)
    }
  }
  return (
    <div className="workflow-repo-chooser">
      <p className="smithers-card-note">{description}</p>
      <ul
        className="workflow-repo-list"
        role="listbox"
        aria-label="Your loaded repositories"
        aria-activedescendant={repos.length ? `${optionId}-${index}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {repos.map((repo, position) => (
          <li key={repo}>
            <button
              type="button"
              role="option"
              id={`${optionId}-${position}`}
              tabIndex={-1}
              aria-selected={position === index}
              data-highlighted={position === index}
              className="workflow-repo-row"
              {...flowProps("flow.repo.choose")}
              onMouseEnter={() => setHighlighted(position)}
              onClick={() => onChooseWorkflowRepo(repo)}
            >
              {repo}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
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
              <strong>{workflow.description ?? workflow.key.replace(/^issue\//, "issue.")}</strong>
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

export const workflowCardFamily: CardFamily<"workflow-repo" | "workflow-list"> = {
  "workflow-repo": {
    render: (card, actions) => <WorkflowRepoCardBody card={card} onChooseWorkflowRepo={actions.onChooseWorkflowRepo} />,
    pill: defaultPill
  },
  "workflow-list": {
    render: (card, actions) => <WorkflowListCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}

/*
 * The `flow` kind (card-kinds.md L5, T-APP-05): the card names its flow; this
 * reads the model. On an install it is GET /api/flows (controller.flowCatalog),
 * where Edit is the one press: Source, Plan and Run wait on their providers.
 * MOCK SEAM elsewhere: the seeded design world (state/seams/DesignWorld/run.ts),
 * whose Source and Edit are the design seam's presses.
 */
const DESIGN_FLOW_ACTIONS: ReadonlySet<CatalogTag> = new Set<CatalogTag>(["flow.source", "flow.edit"])
const INSTALL_FLOW_ACTIONS: ReadonlySet<CatalogTag> = new Set<CatalogTag>(["flow.edit", "todo.new"])
const NO_FLOWS: FlowsSnapshot = {}
const noCatalog: FlowsSnapshots = { subscribe: () => () => {}, get: () => NO_FLOWS }
const FlowBody = ({ card, maximized }: { readonly card: CardOf<"flow">; readonly maximized: boolean }) => {
  const controller = useController()
  const world = useDesignWorld()
  const catalog = controller.flowCatalog ?? noCatalog
  const served = useSyncExternalStore(catalog.subscribe, catalog.get, catalog.get)
  const model = controller.flowCatalog === undefined ? flowCardOf(world, card.payload.name) : served.flows?.find(flow => flow.name === card.payload.name)
  const dispatch: CardCommandDispatch = (tag, input) =>
    controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user", originCardId: card.id })
  return <FlowCard model={model && card.payload.proposal ? { ...model, proposal: card.payload.proposal } : model} allowed={controller.flowCatalog === undefined ? DESIGN_FLOW_ACTIONS : INSTALL_FLOW_ACTIONS} dispatch={dispatch}
    view={{ maximized }} onView={() => {}} />
}
export const flowCardFamily: CardFamily<"flow"> = {
  flow: { render: (card, actions) => <FlowBody card={card} maximized={actions.presentation === "maximized"} />, pill: () => "" }
}
