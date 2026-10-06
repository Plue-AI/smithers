import { useState, type ComponentType } from "react"
import type { ContextLineProps } from "@smthrs/rpc/ContextLineCard"
import type { Action } from "@smthrs/rpc/CardAction"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "./flows/cardActions"
import type { StoredAnswer } from "./state/seams/ContextSeam"

// T-UI-07 must supply these props before production activation. No substitute View.
export type ContextViewProps = ContextLineProps & {
  readonly actions: Action[]
  readonly itemBindings: readonly Pick<ReturnType<typeof cardActions>, "actions" | "onAction">[]
  readonly onAction: ReturnType<typeof cardActions>["onAction"]
}
export interface ContextContainerProps {
  readonly answer?: StoredAnswer
  readonly branch: string
  readonly available: boolean
  readonly dispatch: CardCommandDispatch
  // The card-opening provider preserves subject and pinned revision; absent handlers stay dark.
  readonly openItem?: (item: NonNullable<StoredAnswer["context"]>[number]) => CardActionDefinition | undefined
  readonly View?: ComponentType<ContextViewProps>
}
export function ContextContainer({ answer, branch, available, dispatch, openItem, View }: ContextContainerProps) {
  const [expanded, setExpanded] = useState(false)
  if (!available || !View || !openItem || answer?.context === undefined) return null
  const openings = answer.context.map(openItem)
  if (openings.some(action => action === undefined)) return null
  const rows = openings.map((action, index) => ({ ...action!, scope: String(index) }))
  const bindings = cardActions(dispatch, [
    { tag: "context.inspect", label: "Inspect", command_input: { branch, answer: answer.id } },
    ...rows
  ])
  return <View count={answer.context.length} items={answer.context} expanded={expanded}
    onView={patch => setExpanded(patch.expanded)} actions={bindings.actions}
    itemBindings={rows.map((_, index) => bindings.forScope(String(index)))}
    onAction={bindings.onAction} />
}
