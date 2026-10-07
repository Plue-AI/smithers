import { useSyncExternalStore } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { CommandsCardSchema, type CommandsCard, type CommandsViewProps } from "@smthrs/rpc/CommandsCard"
import { cardActions, type CardCommandDispatch } from "../flows/cardActions"
import { NAMESPACES, namespace, type CatalogItem } from "../flows/registry"
import { useController } from "../ControllerContext"
import type { CardActions, CardFamily } from "./CardFamily"
import { CommandsView } from "./views/CommandsView"

export interface CommandsContainerProps {
  /** Already viewer-admitted by the shared registry projection. */
  readonly catalog: ReadonlyArray<CatalogItem> | undefined
  readonly dispatch: CardCommandDispatch
  readonly view: CommandsViewProps["view"]
  readonly onView: CommandsViewProps["onView"]
}
export const CommandsContainer = ({ catalog, dispatch, view, onView }: CommandsContainerProps) => {
  if (catalog === undefined) return null
  const groups = new Map<string, CommandsCard["groups"][number]>()
  for (const entry of catalog) {
    // Defense at the metadata boundary; never infer missing policy from invocability.
    if ((entry.visibility !== "core" && entry.visibility !== "advanced") || !entry.group ||
      (entry.agent !== "run" && entry.agent !== "confirm" && entry.agent !== "never")) continue
    const id = entry.visibility === "advanced" ? "advanced" : entry.group
    const group = groups.get(id) ?? { label: id === "advanced" ? "Advanced" : namespace(id).label, advanced: id === "advanced", commands: [] }
    group.commands.push({ tag: entry.name, synopsis: entry.slash === null ? "⌘K (no slash)" : `${entry.slash ?? `/${entry.name}`}${entry.args ? ` ${entry.args}` : ""}`, description: entry.summary, agent: entry.agent })
    groups.set(id, group)
  }
  const rank = (id: string) => { const index = NAMESPACES.findIndex(row => row.id === id); return index < 0 ? NAMESPACES.length : index }
  const model = CommandsCardSchema.parse({ groups: [...groups.entries()].sort(([a], [b]) =>
    a === "advanced" ? 1 : b === "advanced" ? -1 : rank(a) - rank(b)).map(([, group]) => group) })
  const bindings = cardActions(dispatch, catalog.some(entry => entry.name === "debug-api" && entry.visibility === "advanced")
    ? [{ tag: "debug.api", label: "/debug-api", command_input: {} }] : [])
  return <CommandsView model={model} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView} />
}

const CommandsBody = ({ presentation }: { readonly presentation: CardActions["presentation"] }) => {
  const controller = useController()
  const roster = controller.membersRoster
  useSyncExternalStore(roster.subscribe, roster.get, roster.get)
  // The registry derives its catalog and admission from these collections.
  // Keep an already-open card current when identity, target or flows change.
  const { collections } = controller.store
  useLiveQuery(collections.identitySessions)
  useLiveQuery(collections.sessions)
  useLiveQuery(collections.repositories)
  useLiveQuery(collections.repositoryFlows)
  useLiveQuery(collections.connectors)
  return <CommandsContainer catalog={controller.commands.viewerCatalog()} view={{ maximized: presentation === "maximized" }} onView={() => {}}
    dispatch={(tag, input) => controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user" })} />
}
export const commandsCardFamily: CardFamily<"commands"> = { commands: { render: (_card, { presentation }) => <CommandsBody presentation={presentation} />, pill: () => "" } }
