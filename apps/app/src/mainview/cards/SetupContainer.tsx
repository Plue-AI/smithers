import { useSyncExternalStore, type ComponentType } from "react"
import type { CardProps } from "@smthrs/rpc/CardAction"
import type { SetupCard } from "@smthrs/rpc/SetupCard"
import { cardActions, type CardActionDefinition } from "../flows/cardActions"
import { installKeyAction, type InstallCardDispatch } from "../flows/cardActions"
import { setupCardModel } from "../state/seams/InstallModel"
import type { InstallSnapshots } from "../state/seams/InstallSeam"

export interface SetupContainerProps {
  readonly View: ComponentType<CardProps<SetupCard>>
  readonly install: InstallSnapshots
  readonly dispatch: InstallCardDispatch
  readonly allowed: boolean // setup-session or owner admission, supplied by the host
  readonly view: CardProps<SetupCard>["view"]
  readonly onView: CardProps<SetupCard>["onView"]
}
const labels = { address: "Address", app: "Create GitHub App", sign_in: "Sign in", repository: "Repository",
  models: "Model access", source: "Mirror", machine: "Build image" } as const

export const SetupContainer = ({ View, install, dispatch, allowed, view, onView }: SetupContainerProps) => {
  const snapshot = useSyncExternalStore(install.subscribe, install.get, install.get)
  const model = snapshot.model
  const key = model ? installKeyAction(dispatch, model) : undefined
  const definitions: CardActionDefinition[] = []
  const step = model?.steps.find(step => step.state !== "done")
  if (allowed && model && step) {
    definitions.push({ tag: "settings.setup", label: step.state === "failed" || step.state === "blocked" ? "Retry" : labels[step.id],
      disabled: step.state === "running" ? { reason: "Running" } : undefined,
      command_input: { step: step.id },
      resolve_input: input => ({ step: step.id, ...(input.owner ? { owner: input.owner } : {}),
        ...(input.repository ? { repository: input.repository } : {}), ...(input.bind ? { bind: input.bind } : {}),
        ...(input.origins ? { origins: input.origins.split("\n").filter(Boolean) } : {}) }) })
    if (step.id === "models" && model.github.signed_in && key) definitions.push(key.definition)
  }
  const bindings = cardActions(key?.dispatch ?? dispatch, definitions)
  if (!model || !allowed) return null
  return <View model={setupCardModel(model)} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView} />
}
