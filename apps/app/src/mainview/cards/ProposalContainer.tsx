import type { ComponentType, ReactNode } from "react"
import { ProposalCardSchema, type ProposalViewProps } from "@smthrs/rpc/ProposalCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import type { LiveChannel } from "../runtime/LiveChannel"
import { useTopic } from "../state/useTopic"
import { ProposalView } from "./views/ProposalView"

export interface ProposalContainerProps {
  readonly model: unknown
  /** Only descriptors admitted for this person's repository context. */
  readonly allowed: ReadonlySet<CatalogTag>
  readonly dispatch: CardCommandDispatch
  readonly View?: ComponentType<ProposalViewProps>
  readonly view: ProposalViewProps["view"]
  readonly onView: ProposalViewProps["onView"]
}
/** No proposal renderer existed. This binds the retained design-owned View;
 * unavailable dependencies supply no commands, without inventing proposal data.
 */
export const ProposalContainer = ({ model: source, allowed, dispatch, View = ProposalView, view, onView }: ProposalContainerProps) => {
  if (source === undefined || source === null) return null
  const model = ProposalCardSchema.parse(source)
  const definitions: CardActionDefinition<CatalogTag, "todo">[] = []
  if (model.state === "open") {
    if (allowed.has("learning.accept")) definitions.push({ tag: "learning.accept", label: "Make TODO", command_input: { id: model.id } })
    if (allowed.has("learning.dismiss")) definitions.push({ tag: "learning.dismiss", label: "Dismiss", command_input: { id: model.id } })
  }
  if (model.todo && allowed.has("todo")) definitions.push({ tag: "todo", label: `T${model.todo.n}`, gesture: "todo", command_input: { n: model.todo.n } })
  const bindings = cardActions<"todo">(dispatch, definitions)
  return <View model={model} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView} />
}

/** The live seam stays beside the seed. Its caller retains the seeded renderer
 * until a valid projection for this exact proposal is actually available.
 */
export const LiveProposalContainer = ({ id, fallback, channel, ...props }: Omit<ProposalContainerProps, "model"> & {
  readonly id: string
  readonly fallback: ReactNode
  readonly channel?: LiveChannel
}) => {
  const snapshot = useTopic<ReadonlyArray<unknown>>("proposals", channel)
  const rows = Array.isArray(snapshot?.data) ? snapshot.data : []
  const model = rows.find(row => ProposalCardSchema.safeParse(row).success && (row as { id: string }).id === id)
  return model === undefined ? fallback : <ProposalContainer allowed={props.allowed} dispatch={props.dispatch} View={props.View} view={props.view} onView={props.onView} model={model} />
}
