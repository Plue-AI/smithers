import { designProposalCard } from "../state/seams/DesignWorld/proposal"
import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { useDesignWorld } from "../state/seams/DesignWorld/hooks"
import type { CardFamily, CardOf } from "./CardFamily"
import type { ComponentType, ReactNode } from "react"
import { ProposalCardSchema, type ProposalViewProps } from "@smthrs/rpc/ProposalCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import { useTopic, type LiveTopics } from "../state/useTopic"
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
  readonly channel?: LiveTopics
}) => {
  const snapshot = useTopic<ReadonlyArray<unknown>>("proposals", channel)
  const rows = Array.isArray(snapshot?.data) ? snapshot.data : []
  const model = rows.find(row => ProposalCardSchema.safeParse(row).success && (row as { id: string }).id === id)
  return model === undefined ? fallback : <ProposalContainer allowed={props.allowed} dispatch={props.dispatch} View={props.View} view={props.view} onView={props.onView} model={model} />
}

/** The durable card subject reads the shared proposals source. Seeded previews
 * remain available where the install has not published this note. */
const ProposalBody = ({ card, maximized }: { readonly card: CardOf<"proposal">; readonly maximized: boolean }) => {
  const controller = useController()
  const world = useDesignWorld()
  const identity = useLiveQuery(controller.store.collections.identitySessions).data[0]
  const seed = world.proposals.find(row => row.id === card.payload.id)
  const model = card.payload.model ?? (seed ? designProposalCard(world, seed) : undefined)
  const allowed = new Set<CatalogTag>(["todo"])
  if ((controller.design.enabled || identity?.state === "signed-in") && (!card.payload.request || card.payload.request.state === "failed")) {
    for (const tag of ["learning.accept", "learning.dismiss"] as const)
      if (controller.commands.find(tag)) allowed.add(tag)
  }
  const props = { allowed, dispatch: ((tag, input) => controller.commands.submit({ name: tag,
    payload: (input ?? {}) as Record<string, unknown>, actor: "user", originCardId: card.id })) as CardCommandDispatch,
    view: { maximized }, onView: () => {} }
  return <LiveProposalContainer id={card.payload.id} channel={controller.live}
    fallback={<ProposalContainer model={model} {...props} />} {...props} />
}
export const proposalCardFamily: CardFamily<"proposal"> = {
  proposal: { render: (card, actions) => <ProposalBody card={card} maximized={actions.presentation === "maximized"} />, pill: () => "" }
}
