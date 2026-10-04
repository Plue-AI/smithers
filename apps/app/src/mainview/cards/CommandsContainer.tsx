import type { ComponentType } from "react"
import { CommandsCardSchema, type CommandsCard, type CommandsViewProps } from "@smthrs/rpc/CommandsCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { cardActions, type CardCommandDispatch } from "../flows/cardActions"
import { modelInvocable } from "../flows/registry"
import { useController } from "../ControllerContext"
import type { CardActions, CardFamily } from "./CardFamily"
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

/* The /help catalog (design Commands.tsx): its grouping and words. A row shows only when its flow is registered here. */
type Row = readonly [tag: CatalogTag, synopsis: string, description: string]
const CATALOG: ReadonlyArray<readonly [label: string, advanced: boolean, rows: ReadonlyArray<Row>]> = [
  ["Ask", false, [["chat.send", "⌘K (no slash)", "Ask or tell Smithers anything"], ["help", "/help", "List these commands"], ["docs", "/docs", "Read the docs in the app"],
    ["stop", "/stop", "Stop the current answer"], ["search", "/search", "Search code, wiki and runs"]]],
  ["TODOs and the stack", false, [["stack", "/stack", "Show the stack and background runs"], ["todo.new", "/todo.new", "Write and place a TODO"],
    ["todo.from-issue", "/todo.from-issue #n", "Draft a TODO from an issue"], ["todo", "/todo T12", "Open a TODO's card"],
    ["todo.answer", "/todo.answer T12", "Answer the agent's question"], ["todo.steer", "/todo.steer T12", "Send the agent a correction"],
    ["todo.amend", "/todo.amend T12", "Change an unmerged TODO's prompt"], ["todo.stop", "/todo.stop T12", "Pause a working TODO"],
    ["todo.resume", "/todo.resume T12", "Resume a paused TODO"], ["todo.retry", "/todo.retry T12", "Retry a failed TODO"],
    ["todo.drop", "/todo.drop T12", "Abandon an unmerged TODO"], ["stack.move", "/stack.move T12 up|down", "Reorder an item"],
    ["merge", "/merge T12", "Review and merge the next item"]]],
  ["Branches and machines", false, [["branches", "/branches", "List branches with presence"], ["branch", "/branch <name|T12>", "Open a branch's card"],
    ["branch.fork", "/branch.fork", "Fork a scratch branch"], ["branch.add-to-stack", "/branch.add-to-stack", "Add a scratch branch as a TODO"],
    ["branch.rebase", "/branch.rebase", "Rebase this branch now"], ["terminal", "/terminal", "Open a terminal on a branch"]]],
  ["Files and code", false, [["file", "/file <path>", "Open and co-edit a file"], ["files", "/files", "Browse a branch's files"], ["diff", "/diff", "Show a branch's changes"]]],
  ["Review", false, [["review", "/review", "Review a change, return findings"], ["pr", "/pr #n", "Open a pull request's card"]]],
  ["Issues", false, [["issues", "/issues", "List the repository's issues"], ["issue", "/issue #n", "Open an issue's card"],
    ["issue.new", "/issue.new", "Open a GitHub issue"], ["issue.comment", "/issue.comment #n", "Comment on an issue"]]],
  ["Wiki", false, [["wiki", "/wiki", "Open the wiki"], ["wiki.page", "/wiki.page <name>", "Open or create a page"], ["wiki.save", "/wiki.save", "Save this answer as a page"]]],
  ["Flows", false, [["flows", "/flows", "List the repository's flows"], ["flow", "/flow <name>", "Show a flow's steps and versions"],
    ["flow.edit", "/flow.edit <name>", "Propose a change to a flow"], ["flow.run", "/flow.run <name>", "Run a flow with typed input"], ["flow.new", "/flow.new", "Create a new flow"]]],
  ["Runs", false, [["runs", "/runs", "Active and attention-needing runs"], ["run", "/run <id>", "Open a run's card"]]],
  ["GitHub", false, [["github", "/github", "Show sync status and retry"]]],
  ["Account and settings", false, [["settings", "/settings", "Model access, machines, GitHub (owner)"], ["secrets", "/secrets", "Set secrets machines can use"],
    ["members", "/members", "Add people and manage roles"], ["ssh", "/ssh <branch>", "Copy the SSH line for a branch"],
    ["sign-in", "/sign-in", "Sign in with GitHub"], ["sign-out", "/sign-out", "Sign out"], ["theme", "/theme", "Switch light or dark"]]],
  ["Advanced", true, [["monitor", "/monitor", "Every run, with its debug view"], ["debug-api", "/debug-api", "Try any call in the open API"],
    ["run.inspect", "/run.inspect <id>", "Open a run's monitor"], ["flow.source", "/flow.source <name>", "Co-edit a flow's source"],
    ["flow.plan", "/flow.plan <name>", "Preview a flow's plan"], ["agents", "/agents", "The factory's agents"], ["agent", "/agent <name>", "Configure an agent"]]]
]

/* The commands card (card-kinds.md L5): the catalog filtered by the live registry, so the same list feeds slash, agent and button. */
const CommandsBody = ({ presentation }: { readonly presentation: CardActions["presentation"] }) => {
  const controller = useController()
  const model: CommandsCard = { groups: CATALOG.map(([label, advanced, rows]) => ({ label, advanced, commands: rows.map(([tag, synopsis, description]) => {
    const entry = controller.commands.find(tag)
    const agent: "run" | "confirm" | "never" = entry === undefined || !modelInvocable(entry) ? "never" : entry.metadata.confirm === undefined ? "run" : "confirm"
    return { tag, synopsis, description, agent }
  }) })) }
  const allowed = new Set(CATALOG.flatMap(([, , rows]) => rows.map(([tag]) => tag)).filter(tag => controller.commands.find(tag) !== undefined))
  return <CommandsContainer model={model} allowed={allowed} view={{ maximized: presentation === "maximized" }} onView={() => {}}
    dispatch={(tag, input) => controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user" })} />
}
export const commandsCardFamily: CardFamily<"commands"> = { commands: { render: (_card, { presentation }) => <CommandsBody presentation={presentation} />, pill: () => "" } }
