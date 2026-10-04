import { useMemo, useSyncExternalStore, type ComponentType } from "react"
import { useController } from "../ControllerContext"
import type { CardActions, CardFamily } from "./CardFamily"
import { SettingsView } from "./views/SettingsView"
// MOCK SEAM: the seeded install until GET /api/install answers (InstallSeam.snapshots replaces it).
import { designInstall, designViewerRole } from "../state/seams/DesignWorld/settings"
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
    /* Each control sits on its row (SettingsView rowFor reads args.field) with its own input, so a press changes the value. */
    { tag: "settings.address", label: "Change", args: { field: "address" }, command_input: model.address,
      input: [
        { name: "listen", label: "Listen", kind: "choice", required: true, choices: ["network", "mac"], value: model.address.listen },
        { name: "origins", label: "Address", kind: "text", required: true, value: model.address.origins[0] ?? "" }
      ],
      resolve_input: input => ({ listen: input.listen === "mac" ? "mac" : "network", bind: input.bind ?? model.address.bind,
        origins: input.origins === undefined ? model.address.origins : input.origins.split("\n").filter(Boolean) }) },
    { tag: "settings.capacity", label: "Machines", args: { field: "capacity" }, command_input: { capacity: model.capacity },
      input: [{ name: "value", label: "Machines", kind: "text", required: true, value: String(model.capacity) }],
      resolve_input: input => ({ capacity: Number(input.value ?? input.capacity ?? model.capacity) }) },
    ...(model.parallel === undefined ? [] : [{ tag: "settings.parallel" as const, label: "At once", args: { field: "parallel" }, command_input: { parallel: model.parallel },
      input: [{ name: "value", label: "TODOs at once", kind: "text" as const, required: true, value: String(model.parallel) }],
      resolve_input: (input: Record<string, string>) => ({ parallel: Number(input.value ?? input.parallel ?? model.parallel) }) }]),
    key!.definition
  ] : []
  const bindings = cardActions(key?.dispatch ?? dispatch, definitions)
  if (!owner || !model) return null
  return <View model={settingsCardModel(model, origin)} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView} />
}

/* The settings card (card-kinds.md L5): subject only; the body reads the install and binds through cardActions. */
const SettingsBody = ({ presentation }: { readonly presentation: CardActions["presentation"] }) => {
  const controller = useController()
  const install = useMemo(() => designInstall(controller.design, controller.installSnapshots), [controller])
  return <SettingsContainer View={SettingsView} install={install} owner={designViewerRole(controller.design) === "owner"}
    origin={typeof window === "undefined" ? "http://localhost" : window.location.origin} view={{ maximized: presentation === "maximized" }} onView={() => {}}
    dispatch={(name, payload, gesture) => controller.commands.submit({ name, payload: (payload ?? {}) as Record<string, unknown>, actor: "user", gesture })} />
}
export const settingsCardFamily: CardFamily<"settings"> = { settings: { render: (_card, { presentation }) => <SettingsBody presentation={presentation} />, pill: () => "" } }
