import { useState, type ComponentType } from "react"
import { HomeCardSchema, type HomeViewProps } from "@smthrs/rpc/HomeCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import { useController } from "../ControllerContext"
import { HomeView } from "./views/HomeView"
import { useDesignHome } from "../state/seams/DesignWorld/home"

export interface HomeContainerProps {
  /** Injectable Home projection, like TodoContainer's seam-populated model. */
  readonly model: unknown
  readonly role: "owner" | "maintainer" | "member"
  readonly allowed: ReadonlySet<CatalogTag>
  readonly dispatch: CardCommandDispatch
  readonly View: ComponentType<HomeViewProps>
  readonly view: HomeViewProps["view"]
  readonly onView: HomeViewProps["onView"]
}
export const HomeContainer = ({ model: source, role, allowed, dispatch, View, view, onView }: HomeContainerProps) => {
  if (source === undefined || source === null) return null
  const parsed = HomeCardSchema.parse(source)
  const definitions: CardActionDefinition[] = []
  const admitted = (definition: CardActionDefinition) => {
    if (!allowed.has(definition.tag) || definition.tag === "main.reset-to-github" && role !== "owner" || definition.tag === "merge" && role === "member") return
    definitions.push(definition)
  }
  admitted({ tag: "todo.new", label: "New TODO", command_input: { text: "" } })
  admitted({ tag: "github", label: "Retry", command_input: undefined })
  const topCount = definitions.length
  const attention = parsed.attention.filter(row => row.kind === "force_push" ? role === "owner" : role !== "member").map(row => {
    const start = definitions.length
    for (const action of row.actions) {
      if (row.kind === "force_push" && action.tag === "main.reset-to-github") admitted({ ...action, tag: "main.reset-to-github", command_input: { revision: parsed.main.sha } })
      if (row.kind === "order" && action.tag === "order.ok" && row.todo) admitted({ ...action, tag: "order.ok", args: { n: String(row.todo) }, command_input: { n: row.todo } })
    }
    return { ...row, start, end: definitions.length }
  })
  const items = parsed.items.map(row => {
    const start = definitions.length
    for (const action of row.actions) {
      const args = { ...action.args, n: String(row.n) }
      if (["merged", "dropped"].includes(row.state) && action.tag !== "branch" && action.tag !== "todo") continue
      switch (action.tag) {
        case "todo": case "todo.retry": case "todo.resume": case "todo.drop":
          admitted({ ...action, tag: action.tag, args, command_input: { n: row.n } }); break
        case "merge":
          if (row.state === "in_review" && row.place === 1 && row.merge.state === "ready" && row.pr && !row.pr.draft)
            admitted({ ...action, tag: "merge", args, command_input: { n: row.n } })
          break
        case "todo.answer":
          admitted({ ...action, tag: "todo.answer", args, command_input: { n: row.n, answer: "" }, resolve_input: input => ({ n: row.n, answer: input.answer ?? "" }) }); break
        case "branch":
          admitted({ ...action, tag: "branch", args, command_input: { name: row.branch.name } }); break
        case "stack.move":
          if (!["merged", "dropped"].includes(row.state) && (action.args?.direction === "up" || action.args?.direction === "down"))
            admitted({ ...action, tag: "stack.move", args, command_input: { n: row.n, direction: action.args.direction } })
          break
      }
    }
    return { ...row, start, end: definitions.length }
  })
  const runs = parsed.background_runs.map(row => {
    const start = definitions.length
    for (const action of row.actions) if (row.state === "failed" && (action.tag === "background.retry" || action.tag === "background.dismiss"))
      admitted({ ...action, tag: action.tag, args: { id: row.id }, command_input: { id: row.id } })
    return { ...row, start, end: definitions.length }
  })
  const bindings = cardActions(dispatch, definitions)
  const bindRows = <T extends { start: number; end: number }>(rows: readonly T[]) => rows.map(row => {
    const rowBindings = cardActions(dispatch, definitions.slice(row.start, row.end))
    return { ...row, actions: rowBindings.actions }
  })
  const model = HomeCardSchema.parse({ ...parsed, attention: bindRows(attention), items: bindRows(items), background_runs: bindRows(runs) })
  const top = cardActions(dispatch, definitions.slice(0, topCount))
  return <View model={model} actions={top.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView} />
}

const HOME_TAGS: ReadonlySet<CatalogTag> = new Set<CatalogTag>([
  "todo", "todo.new", "todo.retry", "todo.resume", "todo.drop", "branch", "merge", "stack.move", "background.retry", "background.dismiss"
])
/** Sync Retry shows only once main's sync is not fresh. */
const HOME_TAGS_SYNC: ReadonlySet<CatalogTag> = new Set<CatalogTag>([...HOME_TAGS, "github"])

/**
 * The Home card of `main`'s conversation and `/stack` (T-APP-01). MOCK SEAM: the model is the seeded
 * design world projected to the `home` topic's shape; the real card reads `useTopic<HomeCard>("home")`.
 */
export const HomeCard = () => {
  const controller = useController()
  const { model, role } = useDesignHome()
  const [view, setView] = useState<HomeViewProps["view"]>({ maximized: false })
  const dispatch: CardCommandDispatch = (tag, input) =>
    controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user" })
  return <HomeContainer model={model} role={role} allowed={model.main.health === "fresh" ? HOME_TAGS : HOME_TAGS_SYNC} dispatch={dispatch}
    View={HomeView} view={view} onView={patch => setView(current => ({ ...current, ...patch }))} />
}
