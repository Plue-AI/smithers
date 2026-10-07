import { useTopic } from "../state/useTopic"
import { SecretsCardSchema, type SecretsViewProps } from "@smthrs/rpc/SecretsCard"
import type { Card } from "../state/AppState"
import type { CardFamily } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import { SecretsView } from "./views/SecretsView"
import { useController } from "../ControllerContext"
import { useSyncExternalStore, type ComponentType } from "react"
import { writeOnlyGesture } from "../flows/CommandGesture"

type StoredSecrets = Extract<Card, { kind: "secrets" }>

export const SecretsCardBody = ({ card, dispatch, role = "member", View = SecretsView, confirm = message => window.confirm(message) }: {
  readonly card: StoredSecrets
  readonly dispatch: CardCommandDispatch
  readonly role?: "owner" | "maintainer" | "member"
  readonly View?: ComponentType<SecretsViewProps>
  readonly confirm?: (message: string) => boolean
}) => {
  const definitions: CardActionDefinition[] = []
  if (role !== "member") {
    definitions.push({ tag: "secrets.set", label: "Add", args: { door: "add" }, command_input: { name: "", value: "" },
      input: [{ name: "name", label: "NAME", kind: "text", required: true },
        { name: "value", label: "Value", kind: "secret", required: true },
        { name: "scope", label: "Scope", kind: "choice", choices: ["all_branches", "main_only"], required: true },
        { name: "hosts", label: "Hosts", kind: "text", required: false }],
      resolve_input: input => ({ name: input.name ?? "", value: input.value ?? "", scope: input.scope === "main_only" ? "main_only" : "all_branches", hosts: input.hosts }) })
    for (const secret of card.payload.secrets) {
      definitions.push({ tag: "secrets.set", label: "Replace", args: { name: secret.name }, command_input: { name: secret.name, value: "" },
        input: [{ name: "value", label: "Value", kind: "secret", required: true },
          { name: "hosts", label: "Hosts", kind: "text", required: false }],
        resolve_input: input => ({ name: secret.name, value: input.value ?? "", ...(input.hosts ? { hosts: input.hosts } : {}) }) },
        { tag: "secrets.scope", label: secret.mainOnly ? "all branches" : "main only", args: { name: secret.name },
          command_input: { name: secret.name, scope: secret.mainOnly ? "all_branches" : "main_only" } },
        { tag: "secrets.delete", label: "Delete", args: { name: secret.name }, command_input: { name: secret.name } })
    }
  }
  const bindings = cardActions((tag, input) => {
    if (tag === "secrets.delete" && !confirm(`Delete ${(input as { name: string }).name}?`)) return
    if (tag === "secrets.scope" && (input as { scope: string }).scope === "all_branches" && !confirm("Give to all branches?")) return
    return dispatch(tag, input)
  }, definitions)
  return <View model={{ secrets: card.payload.secrets.map(secret => ({ name: secret.name,
    scope: secret.mainOnly ? "main_only" : "all_branches", hosts: secret.hosts,
    actions: bindings.actions.filter(action => action.args?.name === secret.name) })) }}
    {...bindings} actions={bindings.actions.filter(action => !action.args?.name)} view={{ maximized: false }} onView={() => {}} />
}

const SecretsBody = ({ card }: { card: StoredSecrets }) => {
  const controller = useController()
  useSyncExternalStore(controller.membersRoster.subscribe, controller.membersRoster.get, controller.membersRoster.get)
  const topic = useTopic(controller.flowCatalog !== undefined ? "secrets" : undefined, controller.live)
  const parsed = SecretsCardSchema.safeParse(topic?.data)
  const projected = topic?.error ? { ...card, payload: { ...card.payload, secrets: [] } }
    : parsed.success ? { ...card, payload: { ...card.payload, secrets: parsed.data.secrets.map(secret => ({
      name: secret.name, mainOnly: secret.scope === "main_only", hosts: secret.hosts ?? [], matchHeaders: [], updatedAt: null
    })) } } : card
  return <SecretsCardBody card={projected} role={controller.membersRole()} dispatch={(name, input) => {
    const payload: Record<string, unknown> = { ...(input ?? {}), repo: card.payload.repo || undefined }
    if (name === "secrets.scope") payload.scope = payload.scope === "main_only" ? "main-only" : "all"
    const gesture = name === "secrets.set" ? writeOnlyGesture(name, { value: String(payload.value ?? "") }) : undefined
    if (payload.hosts) payload.headers = "authorization"
    delete payload.value
    return controller.commands.submit({ name, payload, actor: "user", gesture })
  }} />
}

export const secretsCardFamily: CardFamily<"secrets"> = {
  secrets: { render: card => <SecretsBody card={card} />, pill: settledPill }
}
