/*
 * The Run card (T-FLW-07): maps the run to RunView's props and binds every
 * press through cardActions. Embedded, the card offers Inspect; maximized (the
 * monitor) it offers Answer, Steer and Stop; a failed or interrupted run offers
 * Retry. MOCK: the model comes from the seeded design world
 * (state/seams/DesignWorld/run.ts) until topic `run:<id>` lands; the flows it
 * names are flows/entries/runs.ts (run.inspect) and todo.ts (the rest).
 */
import { useState, type ComponentType } from "react"
import type { MonitorCard, RunViewProps } from "@smthrs/rpc/MonitorCard"
import { useController } from "../ControllerContext"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import { useDesignWorld } from "../state/seams/DesignWorld/hooks"
import { monitorOf } from "../state/seams/DesignWorld/run"
import type { CardFamily, CardOf } from "./CardFamily"
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
  /** The run projection (topic `run:<id>` when it lands; the design seam now). */
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

/** The `run` kind: the card names its run (card-kinds.md L5); this reads the model and keeps the member's selection. */
const RunBody = ({ card, maximized }: { readonly card: CardOf<"run">; readonly maximized: boolean }) => {
  const controller = useController()
  const world = useDesignWorld()
  const [view, setView] = useState<Partial<RunViewProps["view"]>>({})
  const dispatch: CardCommandDispatch = (tag, input) =>
    controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user", originCardId: card.id })
  return <RunContainer model={monitorOf(world, card.payload.id)} dispatch={dispatch}
    view={{ ...view, maximized }} onView={patch => setView(current => ({ ...current, ...patch }))} />
}
export const runCardFamily: CardFamily<"run"> = {
  run: { render: (card, actions) => <RunBody card={card} maximized={actions.presentation === "maximized"} />, pill: () => "" }
}
