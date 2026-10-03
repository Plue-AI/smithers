import { useSyncExternalStore, type ComponentType } from "react"
import type { CardProps } from "@smthrs/rpc/CardAction"
import type { SettingsCard } from "@smthrs/rpc/SettingsCard"
import { cardActions, type CardActionDefinition } from "../flows/cardActions"
import { installKeyAction, type InstallCardDispatch } from "./installKeyAction"
import { settingsCardModel } from "../state/seams/InstallModel"
import type { InstallSnapshots } from "../state/seams/InstallSeam"

export interface SettingsContainerProps {
  readonly View: ComponentType<CardProps<SettingsCard>>
  readonly install: InstallSnapshots
  readonly dispatch: InstallCardDispatch
  readonly owner: boolean
  readonly origin: string
  readonly view: CardProps<SettingsCard>["view"]
  readonly onView: CardProps<SettingsCard>["onView"]
}
export const SettingsContainer = ({ View, install, dispatch, owner, origin, view, onView }: SettingsContainerProps) => {
  const snapshot = useSyncExternalStore(install.subscribe, install.get, install.get)
  const model = snapshot.model
  const key = model ? installKeyAction(dispatch, model) : undefined
  const definitions: CardActionDefinition[] = owner && model ? [
    { tag: "settings.address", label: "Address", command_input: model.address,
      resolve_input: input => ({ listen: input.listen === "mac" ? "mac" : "network", bind: input.bind ?? model.address.bind,
        origins: input.origins === undefined ? model.address.origins : input.origins.split("\n").filter(Boolean) }) },
    { tag: "settings.capacity", label: "Machines", command_input: { capacity: model.capacity },
      resolve_input: input => ({ capacity: Number(input.capacity) }) },
    ...(model.parallel === undefined ? [] : [{ tag: "settings.parallel" as const, label: "At once", command_input: { parallel: model.parallel },
      resolve_input: (input: Record<string, string>) => ({ parallel: Number(input.parallel) }) }]),
    key!.definition
  ] : []
  const bindings = cardActions(key?.dispatch ?? dispatch, definitions)
  if (!owner || !model) return null
  return <View model={settingsCardModel(model, origin)} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView} />
}
