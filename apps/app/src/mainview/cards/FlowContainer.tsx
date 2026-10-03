import type { ComponentType } from "react"
import { FlowCardSchema, type FlowViewProps } from "@smthrs/rpc/FlowCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import { FlowView } from "./views/FlowView"

export interface FlowContainerProps {
  /** Versioned flows projection supplied by the topic adapter when T-FLW-03 lands. */
  readonly model: unknown
  readonly system: boolean
  readonly allowed: ReadonlySet<CatalogTag>
  readonly dispatch: CardCommandDispatch
  readonly View?: ComponentType<FlowViewProps>
  readonly view: FlowViewProps["view"]
  readonly onView: FlowViewProps["onView"]
}
export const FlowContainer = ({ model: source, system, allowed, dispatch, View = FlowView, view, onView }: FlowContainerProps) => {
  if (source === undefined || source === null) return null
  const parsed = FlowCardSchema.parse(source)
  const active = new Set(parsed.versions.find(version => version.state === "active")?.steps.map(step => step.id))
  const model = FlowCardSchema.parse({ ...parsed, versions: parsed.versions.map(version => ({ ...version,
    steps: version.steps.map(step => "wait" in step ? step : { ...step, added: version.state !== "active" && !active.has(step.id) }) })) })
  const definitions: CardActionDefinition[] = []
  for (const [tag, label] of [["flow.source", "Source"], ["flow.plan", "Plan"], ["flow.run", "Run"], ["flow.edit", "Edit"]] as const) {
    if (allowed.has(tag) && (!system || tag === "flow.plan")) definitions.push({ tag, label, command_input: { name: model.name } })
  }
  const bindings = cardActions(dispatch, definitions)
  return <View model={model} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView} />
}
