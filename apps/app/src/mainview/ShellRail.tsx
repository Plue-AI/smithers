/*
 * The activity rail (T-UI-08 mount): one timeline line per conversation
 * entry, live work pinned to the edges, and the notifications docked at its
 * foot. A card file, not a View: it maps the transcript, the toasts and the
 * design world to the Views' props and binds their callbacks to flows.
 */
import type { AppController } from "./state/AppController"
import { browserNotificationAskAvailable } from "./state/controller/failures"
import { accountOwnerOf } from "./state/AccountOwner"
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import type { EntryRowCard } from "@smthrs/rpc/EntryRowCard"
import { actionFor } from "./flows/rowAction"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "./flows/cardActions"
import { todoActionDefinitions, useTodoRole } from "./cards/TodoCard"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import { homeDispatch } from "./cards/HomeContainer"
import type { ShellView, ToastCard } from "@smthrs/rpc/ToastCard"
import type { TimelineLine } from "@smthrs/rpc/TimelineCard"
import { useMessageBand, useMessageScroller } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useState, useSyncExternalStore } from "react"
import { useSharedConversation } from "./state/useSharedConversation"
import type { SharedConversation } from "./state/seams/SharedConversationSeam"
import { useController } from "./ControllerContext"
import { EdgeMap } from "./EdgeMap"
import type { InitMessage } from "./HostOpening"
import type { Card, Message, Toast } from "./state/AppState"
import { diagnosticVisible } from "./state/AppState"
import { useHome, type HomeAnswer } from "./cards/HomeContainer"
import { Timeline } from "./Timeline"
import { ToastStack } from "./ToastStackView"
import { actsLine, type ExternalConversation, type ExternalItem } from "./ExternalEntries"
import { foldedRuns, withTitles, zoomTimeline } from "./TimelineZoom"

export type RailEntry =
  | { readonly kind: "entry"; readonly id: string; readonly entry: EntryRowCard; readonly facts?: Omit<Parameters<typeof actionFor>[0], "state"> }
  | { readonly kind: "message"; readonly message: Message }
  | { readonly kind: "init"; readonly message: InitMessage }
  | { readonly kind: "card"; readonly card: Card }
  | { readonly kind: "external"; readonly item: ExternalItem; readonly conversation?: ExternalConversation | undefined }

const firstLine = (text: string): string => text.split("\n").find(line => line.trim() !== "")?.trim() ?? ""

const toneGlyph = (tone: TimelineLine["tone"]): TimelineLine["glyph"] => ({ state: tone === "failed" ? "failed" : tone === "done" ? "merged" : tone === "live" ? "working" : tone === "attention" ? "needs_you" : "queued" })

const cardTone = (card: Card): TimelineLine["tone"] => card.status === "error" ? "failed" : card.status === "acted" ? "done" : "quiet"

/** One timeline line per transcript entry (spec §14.5.4). The opening read has none. */
export const railLines = (entries: ReadonlyArray<RailEntry>, viewer: Parameters<typeof actionFor>[1] = { role: "member" }): TimelineLine[] => entries.flatMap((entry): TimelineLine[] => {
  // T-APP-07: shared facts are authoritative; never re-derive host tone or title.
  // T-APP-16 can supply this model when its shared-entry provider is mounted.
  if (entry.kind === "entry") {
    const row = entry.entry
    const action = row.tombstone ? undefined : actionFor({ ...entry.facts, state: row.state }, viewer)
    return [{ entry_id: entry.id, kind: row.kind, title: row.title, tone: row.tone, glyph: row.state ? { state: row.state } : { actor: row.author },
      ...(action === undefined ? {} : { action }),
      ...(row.summary === undefined || row.tombstone ? {} : { summary: row.summary }) }]
  }
  if (entry.kind === "init") return []
  if (entry.kind === "card" && entry.card.kind === "todo") {
    const parsed = TodoCardSchema.safeParse((entry.card.payload as { model?: unknown }).model)
    if (parsed.success) {
      const model = parsed.data
      const wait = model.waits[0]
      const candidate = actionFor({ ...model, first_in_order: model.place === 1,
        ...(wait ? { needs_you: { kind: wait.kind } } : {}) }, viewer)
      // A state label alone cannot grant a command: the mounted TODO's provider
      // must offer that command too (retryability, branch and merge readiness).
      const definition = candidate && todoActionDefinitions(model, viewer.role).find(action => action.tag === candidate.tag && !action.disabled)
      const action = definition ? { ...candidate!, args: { ...candidate!.args, ...definition.args, ...(definition.tag === "branch" ? { name: ("name" in definition.command_input ? definition.command_input.name : undefined) } : {}) } } : undefined
      const tone: TimelineLine["tone"] = model.state === "needs_you" ? "attention" : model.state === "failed" ? "failed"
        : model.state === "starting" || model.state === "working" ? "live" : model.state === "merged" || model.state === "dropped" ? "done" : "quiet"
      return [{ entry_id: entry.card.id, kind: "card", title: model.title, tone, glyph: { state: model.state }, ...(action ? { action } : {}) }]
    }
  }
  if (entry.kind === "external") return externalLine(entry.item, entry.conversation)
  if (entry.kind === "card") return [{ entry_id: entry.card.id, kind: "card", title: entry.card.title || entry.card.kind, tone: cardTone(entry.card), glyph: toneGlyph(cardTone(entry.card)) }]
  const { message } = entry
  const text = firstLine(message.text)
  if (text === "") return []
  return [message.role === "user"
    ? { entry_id: message.id, kind: "prompt", title: `“${text}”`, tone: "quiet", glyph: toneGlyph("quiet") }
    : { entry_id: message.id, kind: "answer", title: text, tone: message.status === "failed" ? "failed" : "quiet", glyph: { actor: { kind: "agent", id: "smithers", agent: "smithers", avatar_url: PlaceholderAvatarUrl, color_index: 6 } } }]
})

/** A Codex session's item (M-38): prompts carry their owner, answers the agent; a run of commands and a diff are events. */
const externalLine = (item: ExternalItem, conversation: ExternalConversation | undefined): TimelineLine[] => {
  switch (item.kind) {
    case "message": {
      const text = firstLine(item.text) || (item.reasoning === undefined ? "" : "Reasoning")
      if (text === "" || conversation === undefined) return []
      return [item.role === "user"
        ? { entry_id: item.id, kind: "prompt", title: `“${text}”`, tone: "quiet", glyph: { actor: conversation.owner } }
        : { entry_id: item.id, kind: "answer", title: text, tone: "quiet", glyph: { actor: conversation.agent } }]
    }
    case "acts": return [{ entry_id: item.id, kind: "event", title: actsLine(item).replace(/^ran/, "Ran"), tone: "quiet", glyph: { event: item.failed ? "attention" : "ok" } }]
    case "diff": return [{ entry_id: item.id, kind: "card", title: `Diff · ${item.card.path.split("/").at(-1)}`, tone: "quiet", glyph: { event: "ok" } }]
    case "error": return [{ entry_id: item.id, kind: "event", title: item.text, tone: "failed", glyph: { event: "failed" } }]
  }
}

/** Each entry's time, where it has one: a folded timeline line shows its span (#3728). */
export const railTimes = (entries: ReadonlyArray<RailEntry>): Map<string, number> => new Map(entries.flatMap((entry): Array<[string, number]> =>
  entry.kind === "card" ? [[entry.card.id, entry.card.createdAt]]
    : entry.kind === "external" ? [[entry.item.id, entry.item.at]]
    : entry.kind === "message" ? [[entry.message.id, entry.message.createdAt]]
    : []))
/** Index persisted cursor addresses once per snapshot, including embedded cards. */
const sharedEntrySequences = (conversation: SharedConversation | undefined): ReadonlyMap<string, number> => {
 const positions = new Map<string, number>()
 for (const turn of conversation?.entries ?? []) {
  if ("role" in turn) {
    if ("sequence" in turn && typeof turn.sequence === "number") positions.set(turn.id, turn.sequence * 1_000_000)
    continue
   }
  if (turn.entry_sequences) { for (const [id, position] of Object.entries(turn.entry_sequences)) positions.set(id,position) }
  else if (turn.sequence!==undefined) { positions.set(`${turn.id}:prompt`,turn.sequence*2-1); positions.set(`${turn.id}:answer`,turn.sequence*2) }
 }
 return positions
}
const sharedFresh = (positions: ReadonlyMap<string, number>, id: string, lastSeen: number): boolean => {
 const position=positions.get(id)
 return position!==undefined && position>lastSeen
}

/** Shared history uses exactly the transcript's scroll ids and recorded actors. */
export const sharedRailLines = (conversation: SharedConversation | undefined, viewer: Parameters<typeof actionFor>[1], lastSeen: number = 0): TimelineLine[] => {
 const positions=sharedEntrySequences(conversation)
 return (conversation?.entries ?? []).flatMap(turn => {
  if ("role" in turn) return railLines([{ kind: "message", message: turn }], viewer).map(line => ({ ...line, fresh: sharedFresh(positions, line.entry_id, lastSeen) }))
  const color_index = (turn.author % 6) as 0 | 1 | 2 | 3 | 4 | 5
  const person = { login: turn.authorLogin, name: turn.authorLogin, avatar_url: PlaceholderAvatarUrl }
  const frames = turn.frames.filter(frame => frame.runId === turn.runId)
  const text = frames.flatMap(frame => frame.type === "delta" && frame.kind === "text" ? [frame.text] : []).join("")
  const tone = turn.tone ?? (turn.state === "accepted" || turn.state === "running" ? "live" : turn.state === "failed" ? "failed" : turn.state === "completed" ? "done" : "quiet")
  if (turn.subject) return frames.flatMap(frame => frame.type === "card"
    ? railLines([{ kind: "card", card: frame.card }], viewer).map(row => ({ ...row, title: turn.subject!.title, tone: turn.subject!.tone, glyph: { state: turn.subject!.state }, fresh: sharedFresh(positions, row.entry_id, lastSeen) }))
    : [])
  const rows: TimelineLine[] = [
    { entry_id: `${turn.id}:prompt`, kind: "prompt", fresh: sharedFresh(positions, `${turn.id}:prompt`, lastSeen), title: turn.title ?? firstLine(turn.prompt), tone: "quiet", glyph: { actor: { kind: "person", ...person, color_index } } },
    { entry_id: `${turn.id}:answer`, kind: "answer", ...(turn.summary === undefined ? {} : { summary: turn.summary }), fresh: sharedFresh(positions, `${turn.id}:answer`, lastSeen), title: firstLine(text) || turn.title || firstLine(turn.prompt), tone,
      glyph: { actor: { kind: "agent", id: turn.runId, agent: "smithers", for_member: person, avatar_url: PlaceholderAvatarUrl, color_index } } }
  ]
  for (const frame of frames) {
    if (frame.type !== "card") continue
    rows.push(...railLines([{ kind: "card", card: frame.card }], viewer).map(row => ({ ...row, fresh: sharedFresh(positions, row.entry_id, lastSeen) })))
  }
  return rows
})
}

/** Bind only the current lines' acts; duplicate entries for one TODO share one command input. */
export const timelineActions = (lines: readonly TimelineLine[], dispatch: CardCommandDispatch) => {
  const definitions: CardActionDefinition[] = []
  const seen = new Set<string>()
  for (const { action } of lines) {
    if (action === undefined) continue
    const key = JSON.stringify([action.tag, action.args])
    if (seen.has(key)) continue
    seen.add(key)
    const n = Number(action.args?.n)
    switch (action.tag) {
      case "todo.answer": definitions.push({ ...action, tag: "todo.answer", command_input: { n, answer: "", ...(action.args?.wait ? { wait: action.args.wait } : {}) } }); break
      case "todo.resume": definitions.push({ ...action, tag: "todo.resume", command_input: { n } }); break
      case "todo.retry": definitions.push({ ...action, tag: "todo.retry", command_input: { n } }); break
      case "todo": definitions.push({ ...action, tag: "todo", command_input: { n } }); break
      case "merge": definitions.push({ ...action, tag: "merge", command_input: { n } }); break
      case "branch": definitions.push({ ...action, tag: "branch", command_input: { name: action.args!.name! } }); break
    }
  }
  return cardActions(dispatch, definitions)
}

const LIVE: ReadonlySet<TimelineLine["tone"]> = new Set(["live", "attention", "failed"])
const RANK: Record<TimelineLine["tone"], number> = { attention: 0, failed: 1, live: 2, done: 3, quiet: 4 }

const edgeCard = (line: TimelineLine): ToastCard => ({
  id: line.entry_id, entry_id: line.entry_id, title: line.title, ...(line.summary === undefined ? {} : { detail: line.summary }), tone: line.tone,
  ...(line.fresh ? { fresh: true } : {}),
  kind: line.tone === "attention" ? "needs_you" : line.tone === "failed" ? "failed" : "progress",
  ...(line.action === undefined ? {} : { action: line.action })
})

/** Live lines outside the band, attention first, then failed, then live. */
export const railEdges = (lines: ReadonlyArray<TimelineLine>, band: readonly [string, string] | undefined): { readonly above: ToastCard[]; readonly below: ToastCard[] } => {
  if (band === undefined) return { above: [], below: [] }
  const first = lines.findIndex(line => line.entry_id === band[0])
  const last = lines.findIndex(line => line.entry_id === band[1])
  const live = (slice: ReadonlyArray<TimelineLine>) => slice.filter(line => LIVE.has(line.tone)).sort((left, right) => RANK[left.tone] - RANK[right.tone]).map(edgeCard)
  return { above: first < 0 ? [] : live(lines.slice(0, first)), below: last < 0 ? [] : lines.slice(last + 1).filter(line => LIVE.has(line.tone) || line.fresh).sort((left, right) => (LIVE.has(left.tone) ? RANK[left.tone] : 4) - (LIVE.has(right.tone) ? RANK[right.tone] : 4)).map(edgeCard) }
}

const TOAST_TONE: Record<Toast["status"], ToastCard["tone"]> = { running: "live", ok: "done", failed: "failed", cancelled: "quiet" }

/** Notices: newest first; a running toast with no action is the timeline's job, not a notice. */
export const railNotices = (toasts: ReadonlyArray<Toast>, lines: readonly TimelineLine[] = [], member?: string | null): ToastCard[] => [...toasts]
  .filter(toast => (!toast.audience || toast.audience.member === member) && (toast.action?.flow !== "notifications.allow" || browserNotificationAskAvailable()))
  .sort((left, right) => right.createdAt - left.createdAt)
  .map(toast => {
    const entry = lines.find(line => line.entry_id === toast.sourceCard)
    const entryAction = toast.action?.flow === "notifications.allow" ? undefined : entry?.action
    const todoNotice = toast.action?.flow !== "notifications.allow" && toast.sourceCard?.startsWith("todo:")
    return {
      id: toast.id, title: toast.title, ...(toast.detail === "" ? {} : { detail: toast.detail }), tone: toast.audience ? ["needs_you", "approval", "conflict"].includes(toast.audience.kind) ? "attention" : toast.audience.kind === "failed" ? "failed" : toast.audience.kind === "merged" ? "done" : "quiet" : TOAST_TONE[toast.status],
      entry_id: toast.audience?.entryId ?? toast.sourceCard ?? toast.id,
      kind: toast.action?.flow === "notifications.allow" ? "allow_notifications" : toast.audience?.kind ?? (toast.status === "failed" ? "failed" : toast.status === "running" ? "progress" : "merged"),
      ...(entryAction
        ? { action: entryAction }
        : todoNotice || toast.action === undefined ? {} : { action: { tag: toast.action.flow as CatalogTag, label: toast.action.label, args: { toast: toast.id } } })
    }
  })

/** The home line, pinned first in main's conversation. */
export const HOME_ENTRY_ID = "home"

/** The home line: the repository and "N need you · M working"; a failed read claims no counts. */
export const homeLine = (home: Pick<HomeAnswer, "kind" | "model">): TimelineLine => {
  if (home.kind === "failed") return { entry_id: HOME_ENTRY_ID, kind: "card", title: home.model.repository, tone: "quiet", glyph: { state: "queued" } }
  const { needs_you: needsYou, working, starting } = home.model.counts
  return {
    entry_id: HOME_ENTRY_ID, kind: "card", title: home.model.repository, summary: `${needsYou} need you · ${working + starting} working`,
    tone: needsYou > 0 ? "attention" : working + starting > 0 ? "live" : "quiet",
    glyph: { state: needsYou > 0 ? "needs_you" : working + starting > 0 ? "working" : "queued" }
  }
}

export const toastActions = (controller: AppController, all: readonly Toast[], onEntryAction?: (tag: CatalogTag, args?: Record<string, string>) => void) => (tag: CatalogTag, args?: Record<string, string>): void => {
  if (tag === "notifications.allow") {
    const toast = all.find(each => each.id === args?.toast && each.action?.flow === "notifications.allow")
    if (!toast) return
    void controller.commands.submit({ name: "notifications.allow", payload: {}, actor: "user" }).then(outcome => {
      if (outcome.status === "executed") controller.runCommand("toast.dismiss", toast.id)
    })
    return
  }
  if (args?.toast === undefined) return onEntryAction?.(tag, args)
  const toast = all.find(each => each.id === args?.toast)
  if (toast?.action === undefined) return
  controller.runCommand(toast.action.flow, toast.action.args)
  if (toast.status !== "running") controller.runCommand("toast.dismiss", toast.id)
}

export function ShellRail({ entries, home }: { readonly entries: ReadonlyArray<RailEntry>; readonly home: boolean }) {
  const controller = useController()
  const scroller = useMessageScroller()
  const homeAnswer = useHome(home)
  const role = useTodoRole()
  const shared = useSharedConversation(controller.sharedConversation)
  const { data: identities } = useLiveQuery(controller.store.collections.identitySessions)
  const { data: toasts } = useLiveQuery(controller.store.collections.toasts)
  const { data: privacyNotices } = useLiveQuery(controller.privacyNotices)
  // Transient chrome: whether the rail is wide enough for the timeline (the View reports it).
  const [wide, setWide] = useState(false)
  const positions=sharedEntrySequences(shared.conversation)
  const lines = [...new Map([
    ...(home && homeAnswer !== undefined ? [homeLine(homeAnswer)] : []),
    ...(controller.sharedConversation ? sharedRailLines(shared.conversation, { role }, shared.view?.last_seen_seq ?? 0) : []),
    ...railLines(controller.sharedConversation ? entries.filter(entry => entry.kind === "card" || entry.kind === "entry" || entry.kind === "message" && (entry.message.origin === "external" || entry.message.action !== undefined || diagnosticVisible(entry.message, identities.find(identity => identity.id === "identity")?.login, controller.store.session().branchNavigation?.selected_branch ?? "main"))) : entries, { role })
  ].map(line => [line.entry_id, line] as const)).values()].map(line => positions.get(line.entry_id) === undefined ? line : { ...line, fresh: sharedFresh(positions, line.entry_id, shared.view?.last_seen_seq ?? 0) })
  const timeline = timelineActions(lines, homeDispatch(controller))
  const band = useMessageBand(lines.map(line => line.entry_id), visible => {
    if (!visible || !shared.view) return
    const seen = positions.get(visible[1])
    if (seen === undefined) return
    if (seen > (shared.view.last_seen_seq ?? 0)) void controller.sharedConversation?.saveView({ last_seen_seq: seen })
  })
  const edges = railEdges(lines, band)
  const all = [...toasts, ...privacyNotices]
  const member = accountOwnerOf(identities.find(identity => identity.id === "identity"))
  const notices = controller.sharedConversation && ((!shared.view && !shared.error) || (shared.view?.toasts_hidden || shared.view?.global_toasts_hidden)) ? [] : railNotices(all, lines, member)
  const onView = (patch: ShellView): void => {
    if (patch.toast_hidden !== undefined) controller.runCommand("toast.dismiss", patch.toast_hidden)
    if (patch.jump_to !== undefined) scroller.scrollToMessage(patch.jump_to, { behavior: "smooth" })
    if (patch.timeline_visible !== undefined) { setWide(patch.timeline_visible); controller.sharedConversation?.setTimelineVisible(patch.timeline_visible) }
  }
  const onToastAction = toastActions(controller, all, timeline.onAction)
  const onEdgeAction = timeline.onAction
  const last = lines.at(-1)?.entry_id ?? ""
  // A long conversation zooms out with distance from the band; the band and the edges still read every entry (#3728).
  const folded = zoomTimeline(lines, band, railTimes(entries))
  // While the timeline shows, the fast model retitles folded lines once they hold still; until then, or if it cannot,
  // their own titles stand (#3732).
  const asked = controller.timelineTitles(wide ? foldedRuns(lines, folded) : [])
  const shown = withTitles(folded, useSyncExternalStore(asked.subscribe, asked.get, asked.get))
  return <aside className="rail" aria-label="Activity" data-keyboard-pane="Timeline" data-wide={wide || undefined}>
    <EdgeMap above={edges.above} below={edges.below} narrow={!wide} onAction={onEdgeAction} onView={onView} />
    <Timeline lines={shown} on_screen={band === undefined ? [last, last] : [band[0], band[1]]} onView={onView} onAction={timeline.onAction} />
    <ToastStack toasts={notices} more={Math.max(0, notices.length - 3)} onAction={onToastAction} onView={onView} />
  </aside>
}
