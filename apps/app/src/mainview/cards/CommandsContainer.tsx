import type { ComponentType } from "react"
import { CommandsCardSchema, type CommandsViewProps } from "@smthrs/rpc/CommandsCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { cardActions, type CardCommandDispatch } from "../flows/cardActions"
import { CommandsView } from "./views/CommandsView"

export interface CommandsContainerProps {
  /** Viewer-admitted catalog projection; no second command registry. */
  readonly model: unknown
  readonly allowed: ReadonlySet<CatalogTag>
  readonly dispatch: CardCommandDispatch
  readonly View?: ComponentType<CommandsViewProps>
  readonly view: CommandsViewProps["view"]
  readonly onView: CommandsViewProps["onView"]
}
export const CommandsContainer = ({ model: source, allowed, dispatch, View = CommandsView, view, onView }: CommandsContainerProps) => {
  if (source === undefined || source === null) return null
  const parsed = CommandsCardSchema.parse(source)
  const model = CommandsCardSchema.parse({ groups: parsed.groups.map(group => ({ ...group,
    commands: group.commands.filter(command => allowed.has(command.tag)) })).filter(group => group.commands.length > 0) })
  const bindings = cardActions(dispatch, [])
  return <View model={model} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView} />
}
