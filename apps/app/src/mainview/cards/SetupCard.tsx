import { useSyncExternalStore, type ComponentType } from "react"
import type { CardProps } from "@smthrs/rpc/CardAction"
import type { SetupCard as SetupModel } from "@smthrs/rpc/SetupCard"
import { cardActions, type CardActionDefinition } from "../flows/cardActions"
import { installKeyAction, type InstallCardDispatch } from "./installKeyAction"
import { setupCardModel, type InstallModel } from "../state/seams/InstallModel"
import type { InstallAddress, InstallSnapshots } from "../state/seams/InstallSeam"

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

/* The coding model's key providers (MODEL_CREDENTIALS); the fast model is Cerebras and Decisions the AI Gateway (mvp.md §6.5). */
const CODING_PROVIDERS = ["OpenAI", "Anthropic", "OpenRouter"] as const

/**
 * One key control per model role (mvp.md J1 2.4, §6.5), each bound to its role so the View puts it on that role's row.
 * The role id stays in `args`; the only visible names are the role's row and its provider's key.
 */
export const roleKeyActions = (definition: CardActionDefinition<"settings.model-key">, model: InstallModel,
  args: Readonly<Record<string, string>>, chooseModel = true): CardActionDefinition<"settings.model-key">[] => model.models.map(role => ({
  ...definition, label: "Save", args: { ...args, role: role.role }, command_input: { role: role.role, provider: role.provider },
  input: [
    ...(role.role === "coding" ? [{ name: "provider", label: "Provider", kind: "choice" as const, required: true, value: role.provider,
      choices: CODING_PROVIDERS.includes(role.provider as typeof CODING_PROVIDERS[number]) ? [...CODING_PROVIDERS] : [role.provider, ...CODING_PROVIDERS] }, ...(chooseModel ? [{ name: "model", label: "Model", kind: "text" as const, required: true }] : [])] : []),
    { name: "value", label: role.role === "jev" ? "AI Gateway key" : role.role === "coding" ? "API key" : `${role.provider} key`, kind: "secret" as const, required: true }
  ]
}))

/** The port of a bind address; the install serves 4000. */
export const addressPort = (bind: string) => /:(\d+)$/.exec(bind)?.[1] ?? "4000"
/** Origins as typed in their multi-line field: one per line, commas and spaces also separate. */
export const parseOrigins = (text: string) => text.split(/[\s,]+/).filter(Boolean)
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i

/**
 * Setup step 0 (mvp.md J1 2.1, M-28): "This Mac only" binds loopback; "Network" binds the address the owner chose and
 * saves the origins teammates open, so the GitHub App's callback URLs follow them.
 */
export const setupAddressActions = (address: InstallAddress, running: boolean): CardActionDefinition<"settings.setup">[] => {
  const port = addressPort(address.bind)
  const disabled = running ? { reason: "Running" } : undefined
  const bind = address.listen === "network" ? address.bind : `0.0.0.0:${port}`
  const origins = address.origins.filter(origin => !LOOPBACK_ORIGIN.test(origin))
  return [
    { tag: "settings.setup", label: "This Mac only", disabled, args: { step: "address", listen: "mac" },
      command_input: { step: "address", bind: `127.0.0.1:${port}`, origins: [`http://localhost:${port}`] } },
    { tag: "settings.setup", label: "Network", disabled, args: { step: "address", listen: "network" },
      command_input: { step: "address", bind, origins },
      input: [
        { name: "bind", label: "Bind", kind: "text", required: true, value: bind },
        { name: "origins", label: "Origins", kind: "text", multiline: true, required: true, value: origins.join("\n") }
      ],
      resolve_input: input => ({ step: "address", bind: input.bind?.trim() || bind, origins: input.origins === undefined ? origins : parseOrigins(input.origins) }) }
  ]
}

export const SetupCard = ({ View, install, dispatch, allowed, view, onView }: SetupCardProps) => {
  const snapshot = useSyncExternalStore(install.subscribe, install.get, install.get)
  const model = snapshot.model
  const key = model ? installKeyAction(dispatch, model) : undefined
  const definitions: CardActionDefinition[] = []
  const step = model?.steps.find(step => step.state !== "done")
  if (allowed && model && step) {
    if (step.id === "sign_in") definitions.push({ tag: "sign-in", label: "Sign in", args: { step: step.id }, command_input: undefined })
    else if (step.id === "address") definitions.push(...setupAddressActions(model.address, step.state === "running"))
    else if (step.id !== "repository" || model.repositories?.length) definitions.push({ tag: "settings.setup", label: step.state === "failed" || step.state === "blocked" ? "Retry" : labels[step.id],
      // The running App step keeps its control: a press continues to GitHub or starts again (InstallSeam.setupStep).
      disabled: step.state === "running" && step.id !== "app_manifest" ? { reason: "Running" } : undefined,
      args: { step: step.id },
      input: step.id === "app_manifest" ? [{ name: "owner", label: "Owner", kind: "text", required: true, value: model.github.owner }]
        : step.id === "repository" ? [{ name: "repository", label: "Repository", kind: "choice", required: true, choices: model.repositories ?? [] }] : undefined,
      command_input: { step: step.id },
      resolve_input: input => ({ step: step.id, ...(input.owner ? { owner: input.owner } : {}),
        ...(input.repository ? { repository: input.repository } : {}) }) })
    if (step.id === "models" && model.github.signed_in && key) definitions.push(...roleKeyActions(key.definition, model, { step: "models" }, !snapshot.seed))
  }
  const bindings = cardActions(key?.dispatch ?? dispatch, definitions)
  if (!model || !allowed) return null
  return <View model={setupCardModel(model)} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView} />
}
