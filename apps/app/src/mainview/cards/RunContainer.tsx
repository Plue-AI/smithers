import { unavailableFailure, FailureNotice } from "../FailureNotice"
/*
 * The Run card (T-FLW-07): maps the run to RunView's props and binds every
 * press through cardActions. Embedded, the card offers Inspect; maximized (the
 * monitor) it offers Answer, Steer and Stop; a failed or interrupted run offers
 * Retry. The authenticated run topic serves install runs; verified app-agent
 * preflight and the retained design provider supply their own evidence.
 */
import { useLiveQuery } from "@tanstack/react-db"
import { useCallback, useSyncExternalStore, type ComponentType } from "react"
import type { MonitorCard, RunViewProps } from "@smthrs/rpc/RunCard"
import { useController } from "../ControllerContext"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import { useDesignWorld } from "../state/seams/DesignWorld/hooks"
import { monitorOf } from "../state/seams/DesignWorld/run"
import type { CardFamily, CardOf } from "./CardFamily"
import { ViewSkeleton } from "../ViewSkeleton"
import { RunView } from "./views/RunView"

const finished = (state: MonitorCard["state"]): boolean => state === "done" || state === "failed" || state === "interrupted"

/** The presses for one run in one presentation, in the footer's order. */
export const runActionDefinitions = (model: MonitorCard, maximized: boolean): CardActionDefinition[] => {
  const definitions: CardActionDefinition[] = []
  const n = model.todo
  if (!maximized) definitions.push({ tag: "run.inspect", label: "Inspect", command_input: { id: model.id } })
  if (n === undefined) return definitions
  if (finished(model.state)) {
    if (model.state !== "done") definitions.push({ tag: "todo.retry", label: "Retry", primary: true, command_input: { n } })
    return definitions
  }
  if (!maximized) return definitions
  const question = model.waits.find(wait => wait.kind === "question" && wait.settled === undefined)
  if (question !== undefined) definitions.push({ tag: "todo.answer", label: "Answer", primary: true,
    input: [{ name: "answer", label: "Answer the coding agent", kind: "text", required: true }],
    command_input: { n, wait: question.id, answer: "" }, resolve_input: input => ({ n, wait: question.id, answer: input.answer ?? "" }) })
  definitions.push({ tag: "todo.steer", label: "Steer",
    input: [{ name: "text", label: "Steer the coding agent", kind: "text", required: true }],
    command_input: { n, text: "" }, resolve_input: input => ({ n, text: input.text ?? "" }) })
  if (model.state === "running") definitions.push({ tag: "todo.stop", label: "Stop", command_input: { n } })
  return definitions
}

export interface RunContainerProps {
  /** The validated run projection, or the retained design provider. */
  readonly model: MonitorCard | undefined
  readonly dispatch: CardCommandDispatch
  readonly View?: ComponentType<RunViewProps>
  readonly view: RunViewProps["view"]
  readonly onView: RunViewProps["onView"]
}
export const RunContainer = ({ model, dispatch, View = RunView, view, onView }: RunContainerProps) => {
  if (model === undefined) return null
  const bindings = cardActions(dispatch, runActionDefinitions(model, view.maximized))
  // The monitor opens on the latest attempt's newest cell, so its detail pane is never blank while the current step has none yet.
  const newest = view.maximized && view.selected === undefined ? model.attempts.at(-1)?.phases.flatMap(phase => phase.cells).at(-1)?.id : undefined
  return <View model={model} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction}
    view={newest === undefined ? view : { ...view, selected: newest }} onView={onView} />
}

const noRun: import("../state/seams/RunMonitorSeam").RunMonitorSnapshot = {}

/** The `run` kind: the card names its run (card-kinds.md L5); this reads the model and keeps the member's selection. */
const RunBody = ({ card, maximized }: { readonly card: CardOf<"run">; readonly maximized: boolean }) => {
  const controller = useController()
  const world = useDesignWorld()
  useLiveQuery(controller.store.collections.httpTurns)
  useLiveQuery(controller.store.collections.identitySessions)
  const shared = controller.sharedConversation
  useSyncExternalStore(shared?.subscribe ?? (() => () => {}), shared?.get ?? (() => undefined), shared?.get ?? (() => undefined))
  const source = controller.runMonitors
  const identity = controller.store.collections.identitySessions.get("identity")
  const member = controller.design.enabled ? controller.design.viewer() : identity?.login
  const subscribe = useCallback((notify: () => void) => source?.subscribe(card.payload.id, notify) ?? (() => {}), [source, card.payload.id, member, identity?.state])
  const get = useCallback(() => source?.get(card.payload.id) ?? noRun, [source, card.payload.id])
  const served = useSyncExternalStore(subscribe, get, get)
  const view = (member ? card.payload.memberViews?.[member] ?? (card.payload.memberViews === undefined ? card.payload.view : undefined) : card.payload.view) ?? {}
  const dispatch: CardCommandDispatch = (tag, input) =>
    controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user", originCardId: card.id })
  const model = served.model ?? controller.contextRun(card.payload.id) ?? monitorOf(world, card.payload.id)
  if (model === undefined && served.error) return <FailureNotice failure={unavailableFailure("RunUnavailable", "Run unavailable", served.error)} />
  if (model === undefined && source !== undefined) return <ViewSkeleton />
  return <RunContainer model={served.model && model ? { ...model, journal: model.journal ?? [] } : model} dispatch={dispatch}
    view={{ ...view, maximized }} onView={patch => { void dispatch("run.view", { cardId: card.id, ...patch }) }} />
}
export const runCardFamily: CardFamily<"run"> = {
  run: { render: (card, actions) => <RunBody card={card} maximized={actions.presentation === "maximized"} />, pill: () => "" }
}
