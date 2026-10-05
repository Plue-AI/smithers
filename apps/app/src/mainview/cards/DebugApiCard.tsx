import { useSyncExternalStore, type ComponentType } from "react"
import type { DebugApiViewProps } from "@smthrs/rpc/DebugApiCard"
import { useController } from "../ControllerContext"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import type { DebugApiSeam } from "../state/seams/DebugApiSeam"
import type { CardFamily } from "./CardFamily"
import { DebugApiView } from "./views/DebugApiView"

export const DebugApiCard = ({ seam, View, dispatch, maximized = false }: {
  seam: DebugApiSeam; View: ComponentType<DebugApiViewProps>; dispatch: CardCommandDispatch; maximized?: boolean
}) => {
  const snapshot = useSyncExternalStore(seam.subscribe, seam.get, seam.get)
  const definitions: CardActionDefinition<"debug.api">[] = seam.available() && snapshot.model.selected ? [{
    tag: "debug.api", label: snapshot.model.pending ? `Confirm ${snapshot.model.pending.method} ${snapshot.model.pending.path}` : "Send",
    ...(snapshot.busy ? { disabled: { reason: "Sending" } } : {}),
    command_input: { operationId: snapshot.model.selected, intent: snapshot.model.pending ? "confirm" : "send", ...(snapshot.confirmation ? { confirmation: snapshot.confirmation } : {}) },
    input: snapshot.fields,
    resolve_input: values => ({ operationId: snapshot.model.selected, intent: snapshot.model.pending ? "confirm" : "send", ...(snapshot.confirmation ? { confirmation: snapshot.confirmation } : {}), values })
  }] : []
  const bindings = cardActions(dispatch, definitions)
  if (!seam.available()) return null
  // Keyed by account epoch and selection: a new account remounts the form, so
  // no draft typed for the previous account can show or re-submit.
  return <View key={`${snapshot.epoch ?? 0}:${snapshot.model.selected ?? ""}`} model={snapshot.model} {...bindings} view={{ maximized, selected: snapshot.model.selected }}
    onView={patch => { if (patch.selected) seam.select(patch.selected) }} />
}
const DebugApiBody = ({ maximized }: { maximized: boolean }) => {
  const controller = useController()
  return <DebugApiCard seam={controller.debugApi} View={DebugApiView} maximized={maximized}
    dispatch={(name, payload) => controller.commands.submit({ name, payload: payload ?? {}, actor: "user" })} />
}
export const debugApiCardFamily: CardFamily<"debug-api"> = {
  "debug-api": { render: (_card, actions) => <DebugApiBody maximized={actions.presentation === "maximized"} />, pill: () => "" }
}
