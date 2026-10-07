import { useState, type ComponentType } from "react"
import type { ContextLineProps } from "@smthrs/rpc/ContextLineCard"
import { ContextLine } from "./ContextLine"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "./flows/cardActions"
import type { StoredAnswer } from "./state/seams/ContextSeam"

export type ContextViewProps = ContextLineProps
export interface ContextContainerProps {
  readonly answer?: StoredAnswer
  readonly branch: string
  readonly available: boolean
  readonly dispatch: CardCommandDispatch
  // The card-opening provider preserves subject and pinned revision; absent handlers stay dark.
  readonly openItem?: (item: NonNullable<StoredAnswer["context"]>[number]) => CardActionDefinition | undefined
  readonly View?: ComponentType<ContextViewProps>
}
export function ContextContainer({ answer, branch, available, dispatch, openItem, View = ContextLine }: ContextContainerProps) {
  const [expanded, setExpanded] = useState(false)
  if (!available || !openItem || answer?.context === undefined) return null
  const openings = answer.context.map(openItem)
  if (openings.some(action => action === undefined)) return null
  const rows = openings.map((action, index) => ({ ...action!, scope: undefined, args: { ...action!.args, context_item: String(index) } }))
  const inspect = { tag: "run.inspect", label: "Inspect", command_input: { branch, answer: answer.id } } as const
  const lineBindings = cardActions(dispatch, [inspect])
  const bindings = cardActions(dispatch, [inspect, ...rows])
  return <View count={answer.context.length} items={answer.context.map((item, index) => ({ ...item, action: bindings.actions[index + 1] }))} expanded={expanded}
    onView={patch => setExpanded(patch.expanded)} actions={lineBindings.actions}
    onAction={bindings.onAction} />
}
