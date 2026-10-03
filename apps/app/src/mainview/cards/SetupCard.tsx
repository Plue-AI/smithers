import { useSyncExternalStore, type ComponentType } from "react"
import type { CardProps } from "@smthrs/rpc/CardAction"
import type { SetupCard as SetupModel } from "@smthrs/rpc/SetupCard"
import { cardActions, type CardActionDefinition } from "../flows/cardActions"
import { installKeyAction, type InstallCardDispatch } from "./installKeyAction"
import { setupCardModel } from "../state/seams/InstallModel"
import type { InstallSnapshots } from "../state/seams/InstallSeam"

export interface SetupCardProps {
  readonly View: ComponentType<CardProps<SetupModel>>
  readonly install: InstallSnapshots
  readonly dispatch: InstallCardDispatch
  readonly allowed: boolean // setup-session or owner admission, supplied by the host
  readonly view: CardProps<SetupModel>["view"]
  readonly onView: CardProps<SetupModel>["onView"]
}
const labels = { address: "Address", app_manifest: "Create GitHub App", sign_in: "Sign in", repository: "Repository",
  models: "Model access", source: "Mirror", machine: "Build image" } as const

export const SetupCard = ({ View, install, dispatch, allowed, view, onView }: SetupCardProps) => {
  const snapshot = useSyncExternalStore(install.subscribe, install.get, install.get)
  const model = snapshot.model
  const key = model ? installKeyAction(dispatch, model) : undefined
  const definitions: CardActionDefinition[] = []
  const step = model?.steps.find(step => step.state !== "done")
  if (allowed && model && step) {
    definitions.push({ tag: "settings.setup", label: step.state === "failed" || step.state === "blocked" ? "Retry" : labels[step.id],
      disabled: step.state === "running" ? { reason: "Running" } : undefined,
      args: { step: step.id },
      input: step.id === "address" ? [
        { name: "bind", label: "Bind", kind: "text", required: true, value: model.address.bind },
        { name: "origins", label: "Origins", kind: "text", required: true, value: model.address.origins.join("\n") }
      ] : step.id === "app_manifest" ? [{ name: "owner", label: "Owner", kind: "text", required: true, value: model.github.owner }]
        : step.id === "repository" ? [{ name: "repository", label: "Repository", kind: "choice", required: true, choices: model.repositories ?? [] }] : undefined,
      command_input: { step: step.id },
      resolve_input: input => ({ step: step.id, ...(input.owner ? { owner: input.owner } : {}),
        ...(input.repository ? { repository: input.repository } : {}), ...(input.bind ? { bind: input.bind } : {}),
        ...(input.origins ? { origins: input.origins.split("\n").filter(Boolean) } : {}) }) })
    if (step.id === "models" && model.github.signed_in && key) definitions.push({ ...key.definition, input: [
      { name: "role", label: "Role", kind: "choice", required: true, choices: ["coding", "fast", "jev"] },
      { name: "provider", label: "Provider", kind: "text", required: true },
      { name: "value", label: "Key", kind: "secret", required: true }
    ] })
  }
  const bindings = cardActions(key?.dispatch ?? dispatch, definitions)
  if (!model || !allowed) return null
  return <View model={setupCardModel(model)} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView} />
}
