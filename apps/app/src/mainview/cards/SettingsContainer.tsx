import { useMemo, useSyncExternalStore, type ComponentType } from "react"
import { useController } from "../ControllerContext"
import type { CardActions, CardFamily } from "./CardFamily"
import { SettingsView } from "./views/SettingsView"
// MOCK SEAM: the seeded install until GET /api/install serves a model (InstallSeam.snapshots replaces it).
import { designInstall, designViewerRole, setSettingsView, settingsViewsOf } from "../state/seams/DesignWorld/settings"
import { useLiveQuery } from "@tanstack/react-db"
import type { CardProps } from "@smthrs/rpc/CardAction"
import type { SettingsCard } from "@smthrs/rpc/SettingsCard"
import { cardActions, type CardActionDefinition } from "../flows/cardActions"
import { installKeyAction, type InstallCardDispatch } from "./installKeyAction"
import { limitFix, settingsCardModel } from "../state/seams/InstallModel"
import type { InstallAddress, InstallSnapshots } from "../state/seams/InstallSeam"
import { addressPort as port, parseOrigins as origins, roleKeyActions } from "./SetupCard"

export interface SettingsContainerProps {
  readonly View: ComponentType<CardProps<SettingsCard>>
  readonly install: InstallSnapshots
  readonly dispatch: InstallCardDispatch
  readonly docsAvailable?: () => boolean
  readonly owner: boolean
  readonly origin: string
  readonly view: CardProps<SettingsCard>["view"]
  readonly onView: CardProps<SettingsCard>["onView"]
}
/**
 * mvp.md J1 2.1 / §6.15 Address: "This Mac only" binds loopback at this Mac's own address; "Network" shows Bind (prefilled
 * with every interface when the install is loopback-bound now) and Origins, the addresses teammates use.
 */
export const addressActions = (address: InstallAddress): CardActionDefinition<"settings.address">[] => {
  const mac = { listen: "mac" as const, bind: `127.0.0.1:${port(address.bind)}`, origins: [`http://localhost:${port(address.bind)}`] }
  const network = { listen: "network" as const, bind: address.listen === "network" ? address.bind : `0.0.0.0:${port(address.bind)}`, origins: address.origins }
  return [
    { tag: "settings.address", label: "Save", args: { field: "address", listen: "mac" }, command_input: mac },
    { tag: "settings.address", label: "Save", args: { field: "address", listen: "network" }, command_input: network,
      input: [
        { name: "bind", label: "Bind", kind: "text", required: true, value: network.bind },
        { name: "origins", label: "Origins", kind: "text", multiline: true, required: true, value: network.origins.join("\n") }
      ],
      resolve_input: input => ({ listen: "network", bind: input.bind?.trim() || network.bind,
        origins: input.origins === undefined ? network.origins : origins(input.origins) }) }
  ]
}

export const SettingsContainer = ({ View, install, dispatch, owner, origin, view, onView, docsAvailable = () => false }: SettingsContainerProps) => {
  const snapshot = useSyncExternalStore(install.subscribe, install.get, install.get)
  const model = snapshot.model
  const needsHttps = model ? settingsCardModel(model, origin).notifications_need_https : false
  const dispatchAvailable: InstallCardDispatch = (tag, input, gesture) => {
    if (tag === "docs" && (!owner || !needsHttps || !docsAvailable())) return
    return dispatch(tag, input, gesture)
  }
  const key = model ? installKeyAction(dispatchAvailable, model) : undefined
  const definitions: CardActionDefinition[] = owner && model ? [
    /* Each control sits on its row (SettingsView rowFor reads args.field) with its own input, so a press changes the value. */
    ...addressActions(model.address),
    ...(needsHttps && docsAvailable() ? [{ tag: "docs" as const, label: "Notifications need HTTPS ↗",
      args: { page: "quickstart#put-https-in-front" }, command_input: { page: "quickstart#put-https-in-front" } }] : []),
    { tag: "settings.capacity", label: "Machines", args: { field: "capacity", min: "0", max: String(model.this_mac.capacity) }, command_input: { capacity: model.capacity },
      input: [{ name: "value", label: "Machines", kind: "text", required: true, value: String(model.capacity) }],
      resolve_input: input => ({ capacity: Number(input.value ?? input.capacity ?? model.capacity) }) },
    ...(model.parallel === undefined ? [] : [{ tag: "settings.parallel" as const, label: "At once", args: { field: "parallel", min: "1", max: "8" }, command_input: { parallel: model.parallel },
      input: [{ name: "value", label: "TODOs at once", kind: "text" as const, required: true, value: String(model.parallel) }],
      resolve_input: (input: Record<string, string>) => ({ parallel: Number(input.value ?? input.parallel ?? model.parallel) }) }]),
    ...(model.wiki_sync === undefined ? [] : [{ tag: "settings.obsidian" as const, label: "Change", args: { field: "obsidian" },
      command_input: { path: model.wiki_sync.obsidian?.path ?? "" },
      input: [{ name: "path", label: "Obsidian folder", kind: "text" as const, required: true, value: model.wiki_sync.obsidian?.path ?? "" }],
      resolve_input: (input: Record<string, string>) => ({ path: input.path ?? model.wiki_sync?.obsidian?.path ?? "" }) }]),
    ...roleKeyActions(key!.definition, model, { field: "key" }, !snapshot.seed)
  ] : []
  /* This Mac's fix renders inside its row (model.this_mac.limit): it binds for onAction but stays out of the listed actions. */
  const fix: CardActionDefinition[] = owner && model?.this_mac.limit ? [{ ...limitFix(model.this_mac.limit.fix), command_input: undefined }] : []
  const listed = cardActions(key?.dispatch ?? dispatchAvailable, definitions)
  const bindings = cardActions(key?.dispatch ?? dispatchAvailable, [...definitions, ...fix])
  if (!owner || !model?.health) return null
  return <View model={settingsCardModel(model, origin)} actions={listed.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView} />
}

/* The settings card (card-kinds.md L5): subject only; the body reads the install and binds through cardActions. */
const SettingsBody = ({ presentation }: { readonly presentation: CardActions["presentation"] }) => {
  const controller = useController()
  const install = useMemo(() => designInstall(controller.design, controller.installSnapshots), [controller])
  // A served /api/install projection is owner-only after claim; until one is served the seeded viewer's role decides.
  const live = useSyncExternalStore(controller.installSnapshots.subscribe, controller.installSnapshots.get, controller.installSnapshots.get).model
  const owner = live === undefined ? designViewerRole(controller.design) === "owner" : live.github.signed_in
  // MOCK SEAM: the seed's per-member view state holds the Address choice until the `view:<member>` topic lands.
  const viewer = controller.design.viewer()
  const listen = useLiveQuery(settingsViewsOf(controller.design)).data.find(row => row.id === viewer)?.listen
  return <SettingsContainer View={SettingsView} install={install} owner={owner} docsAvailable={() => controller.docsTargetAvailable("quickstart#put-https-in-front")}
    origin={typeof window === "undefined" ? "http://localhost" : window.location.origin}
    view={{ maximized: presentation === "maximized", ...(listen === undefined ? {} : { tab: listen }) }} onView={patch => setSettingsView(controller.design, viewer, patch)}
    dispatch={(name, payload, gesture) => controller.commands.submit({ name, payload: (payload ?? {}) as Record<string, unknown>, actor: "user", gesture })} />
}
export const settingsCardFamily: CardFamily<"settings"> = { settings: { render: (_card, { presentation }) => <SettingsBody presentation={presentation} />, pill: () => "" } }
