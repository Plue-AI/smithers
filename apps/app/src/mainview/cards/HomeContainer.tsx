import { useMemo, type ComponentType } from "react"
import { HomeCardSchema, type HomeCard as HomeModel, type HomeViewProps } from "@smthrs/rpc/HomeCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import { useController } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { HomeView } from "./views/HomeView"
import { useClock } from "@smthrs/ui/clock"
import { useTopic } from "../state/useTopic"
import { useDesignHome, useDesignHomeView } from "../state/seams/DesignWorld/home"

export interface HomeContainerProps {
  /** Injectable Home projection, like TodoContainer's seam-populated model. */
  readonly model: unknown
  readonly role: "owner" | "maintainer" | "member"
  readonly allowed: ReadonlySet<CatalogTag>
  readonly dispatch: CardCommandDispatch
  readonly View?: ComponentType<HomeViewProps>
  readonly view: HomeViewProps["view"]
  readonly onView: HomeViewProps["onView"]
}
export const HomeContainer = ({ model: source, role, allowed, dispatch, View = HomeView, view, onView }: HomeContainerProps) => {
  const now = useClock(true, 1000)
  if (source === undefined || source === null) return null
  const parsed = HomeCardSchema.parse(source)
  // The existing View clock ages the caption; the Container must age health and its controls too.
  const health = parsed.main.health === "fresh" || parsed.main.health === "stale"
    ? now - Date.parse(parsed.main.last_success_at) > 120_000 ? "stale" : "fresh"
    : parsed.main.health
  const definitions: CardActionDefinition[] = []
  const admitted = (definition: CardActionDefinition) => {
    if (!allowed.has(definition.tag) || definition.tag === "main.reset-to-github" && role !== "owner"
      || (definition.tag === "merge" || definition.tag === "order.ok") && role === "member") return
    definitions.push(definition)
  }
  admitted({ tag: "todo.new", label: "New TODO", command_input: { text: "" } })
  /* Sync Retry shows only once main's sync is stale; limited retries on its own, refused needs a fix. */
  if (health === "stale") admitted({ tag: "github", label: "Retry", command_input: undefined })
  const topCount = definitions.length
  const attention = parsed.attention.filter(row => row.kind === "force_push" ? role === "owner" : role !== "member").map(row => {
    const start = definitions.length
    for (const action of row.actions) {
      if (row.kind === "force_push" && action.tag === "main.reset-to-github") admitted({ ...action, tag: "main.reset-to-github", command_input: { revision: parsed.main.sha } })
      if (row.kind === "order" && action.tag === "order.ok" && row.todo) admitted({ ...action, tag: "order.ok", args: { n: String(row.todo) }, command_input: { n: row.todo } })
    }
    return { ...row, start, end: definitions.length }
  })
  const first = parsed.items.find(row => !["merged", "dropped"].includes(row.state))
  let mergeOffered = false
  const items = parsed.items.map(row => {
    const start = definitions.length
    for (const action of row.actions) {
      const args = { ...action.args, n: String(row.n) }
      if (["merged", "dropped"].includes(row.state) && action.tag !== "branch" && action.tag !== "todo") continue
      switch (action.tag) {
        case "todo": case "todo.retry": case "todo.resume": case "todo.drop":
          admitted({ ...action, tag: action.tag, args, command_input: { n: row.n } }); break
        case "merge":
          if (!mergeOffered && row === first && row.state === "in_review" && row.place === 1 && row.merge.state === "ready" && row.pr && !row.pr.draft) {
            admitted({ ...action, tag: "merge", args, command_input: { n: row.n } })
            mergeOffered = true
          }
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
  const model = HomeCardSchema.parse({ ...parsed, main: { ...parsed.main, health }, attention: bindRows(attention), items: bindRows(items), background_runs: bindRows(runs) })
  const top = cardActions(dispatch, definitions.slice(0, topCount))
  return <View model={model} actions={top.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={view} onView={onView} />
}

/** Every control the Home card can render; role and the row's state narrow it further above. */
export const HOME_TAGS: ReadonlySet<CatalogTag> = new Set<CatalogTag>([
  "todo", "todo.new", "todo.answer", "todo.retry", "todo.resume", "todo.drop", "branch", "merge", "stack.move",
  "order.ok", "main.reset-to-github", "background.retry", "background.dismiss", "github"
])
/** A failed `home` provider offers no row or sync control: nothing it shows is a live TODO. */
const FAILED_TAGS: ReadonlySet<CatalogTag> = new Set<CatalogTag>(["todo.new"])

/** `/api/live` refusal codes meaning this host serves no `home` topic (the live channel's 404): the seed stands in. */
const NO_PROVIDER = new Set(["unknown_topic", "unsupported"])

/** The Home model a FAILED provider shows: main's row in its refused or limited state, and no rows at all. */
export const homeFailureModel = (repository: string, code: string): HomeModel => ({
  repository,
  main: code === "forbidden"
    ? { sha: "", title: "main", last_success_at: new Date(0).toISOString(), health: "refused", cause: "Stack access refused" }
    : { sha: "", title: "main", last_success_at: new Date(0).toISOString(), health: "limited", cause: "Stack unavailable" },
  attention: [], items: [],
  counts: { queued: 0, starting: 0, working: 0, needs_you: 0, paused: 0, failed: 0, in_review: 0, merged: 0, dropped: 0 },
  merged_since_last_look: [], machines: { in_use: 0, capacity: 0, slots: [] }, background_runs: []
})

/** The `home` topic as the card reads it: served data, a failed provider, or no provider on this host. */
export const homeSource = (snapshot: { readonly data?: unknown; readonly error?: string } | undefined):
  { readonly kind: "seed" } | { readonly kind: "served"; readonly model: HomeModel } | { readonly kind: "failed"; readonly code: string } => {
  if (snapshot?.error !== undefined) return NO_PROVIDER.has(snapshot.error) ? { kind: "seed" } : { kind: "failed", code: snapshot.error }
  if (snapshot?.data === undefined) return { kind: "seed" }
  const parsed = HomeCardSchema.safeParse(snapshot.data)
  return parsed.success ? { kind: "served", model: parsed.data } : { kind: "failed", code: "invalid" }
}

/**
 * The card's one dispatch: every press runs as the person through the command registry. Answer pressed
 * without an answer is the question's door (design Home.tsx): it opens the TODO card, where the answer is typed.
 */
export const homeDispatch = (controller: Pick<AppController, "commands">): CardCommandDispatch => (tag, input) => {
  const payload = (input ?? {}) as Record<string, unknown>
  if (tag === "todo.answer" && !payload.answer) return controller.commands.submit({ name: "todo", payload: { n: payload.n }, actor: "user" })
  return controller.commands.submit({ name: tag, payload, actor: "user" })
}

/**
 * The Home card of `main`'s conversation and `/stack` (T-APP-01), composed from the controller: the viewer's
 * role, the Home admission, the registry dispatch and the member's view state. It subscribes to the `home`
 * topic through the controller's live channel. Served data replaces the seed; a provider that fails shows main's refused or limited row and
 * no rows; only a host with no `home` provider (or no answer yet) keeps the seeded design world (MOCK SEAM),
 * so the mounted card never goes dark. `production` overrides any part of that composition.
 */
export const HomeCard = ({ production }: {
  readonly production?: Partial<Omit<HomeContainerProps, "model" | "View">>
} = {}) => {
  const controller = useController()
  const seeded = useDesignHome()
  const member = useDesignHomeView()
  const dispatch = useMemo(() => homeDispatch(controller), [controller])
  const source = homeSource(useTopic(controller.live ? "home" : undefined, controller.live))
  const model = source.kind === "served" ? source.model : source.kind === "failed" ? homeFailureModel(seeded.model.repository, source.code) : seeded.model
  return <HomeContainer model={model} role={production?.role ?? seeded.role}
    allowed={source.kind === "failed" ? FAILED_TAGS : production?.allowed ?? HOME_TAGS} dispatch={production?.dispatch ?? dispatch}
    view={production?.view ?? member.view} onView={production?.onView ?? member.onView} />
}
