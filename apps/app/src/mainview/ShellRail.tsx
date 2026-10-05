/*
 * The activity rail (T-UI-08 mount): one timeline line per conversation
 * entry, live work pinned to the edges, and the notifications docked at its
 * foot. A card file, not a View: it maps the transcript, the toasts and the
 * design world to the Views' props and binds their callbacks to flows.
 */
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import type { EntryRowCard } from "@smthrs/rpc/EntryRowCard"
import { actionFor, type CatalogTag } from "@smthrs/rpc/CardAction"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "./flows/cardActions"
import { useTodoRole } from "./cards/TodoCard"
import type { ShellView, ToastCard } from "@smthrs/rpc/ToastCard"
import type { TimelineLine } from "@smthrs/rpc/TimelineCard"
import { useMessageBand, useMessageScroller } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useState } from "react"
import { useController } from "./ControllerContext"
import { EdgeMap } from "./EdgeMap"
import type { InitMessage } from "./HostOpening"
import type { Card, Message, Toast } from "./state/AppState"
import { useHome, type HomeAnswer } from "./cards/HomeContainer"
import { Timeline } from "./Timeline"
import { ToastStack } from "./ToastStackView"
import { actsLine, type ExternalConversation, type ExternalItem } from "./ExternalEntries"

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
      case "todo.answer": definitions.push({ ...action, tag: "todo.answer", command_input: { n, answer: "" } }); break
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
  kind: line.tone === "attention" ? "needs_you" : line.tone === "failed" ? "failed" : "progress"
})

/** Live lines outside the band, attention first, then failed, then live. */
export const railEdges = (lines: ReadonlyArray<TimelineLine>, band: readonly [string, string] | undefined): { readonly above: ToastCard[]; readonly below: ToastCard[] } => {
  if (band === undefined) return { above: [], below: [] }
  const first = lines.findIndex(line => line.entry_id === band[0])
  const last = lines.findIndex(line => line.entry_id === band[1])
  const live = (slice: ReadonlyArray<TimelineLine>) => slice.filter(line => LIVE.has(line.tone)).sort((left, right) => RANK[left.tone] - RANK[right.tone]).map(edgeCard)
  return { above: first < 0 ? [] : live(lines.slice(0, first)), below: last < 0 ? [] : live(lines.slice(last + 1)) }
}

const TOAST_TONE: Record<Toast["status"], ToastCard["tone"]> = { running: "live", ok: "done", failed: "failed", cancelled: "quiet" }

/** Notices: newest first; a running toast with no action is the timeline's job, not a notice. */
export const railNotices = (toasts: ReadonlyArray<Toast>): ToastCard[] => [...toasts]
  .sort((left, right) => right.createdAt - left.createdAt)
  .map(toast => ({
    id: toast.id, title: toast.title, ...(toast.detail === "" ? {} : { detail: toast.detail }), tone: TOAST_TONE[toast.status],
    entry_id: toast.sourceCard ?? toast.id,
    kind: toast.status === "failed" ? "failed" : toast.status === "running" ? "progress" : "merged",
    ...(toast.action === undefined ? {} : { action: { tag: toast.action.flow as CatalogTag, label: toast.action.label, args: { toast: toast.id } } })
  }))

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

export function ShellRail({ entries, home }: { readonly entries: ReadonlyArray<RailEntry>; readonly home: boolean }) {
  const controller = useController()
  const scroller = useMessageScroller()
  const homeAnswer = useHome(home)
  const role = useTodoRole()
  const { data: toasts } = useLiveQuery(controller.store.collections.toasts)
  const { data: privacyNotices } = useLiveQuery(controller.privacyNotices)
  // Transient chrome: whether the rail is wide enough for the timeline (the View reports it).
  const [wide, setWide] = useState(false)
  const lines = [
    ...(home && homeAnswer !== undefined ? [homeLine(homeAnswer)] : []),
    ...railLines(entries, { role })
  ]
  const timeline = timelineActions(lines, (tag, input) => controller.commands.submit({ name: tag, payload: input ?? {}, actor: "user" }))
  const band = useMessageBand(lines.map(line => line.entry_id))
  const edges = railEdges(lines, band)
  const all = [...toasts, ...privacyNotices]
  const notices = railNotices(all)
  const onView = (patch: ShellView): void => {
    if (patch.toast_hidden !== undefined) controller.runCommand("toast.dismiss", patch.toast_hidden)
    if (patch.jump_to !== undefined) scroller.scrollToMessage(patch.jump_to, { behavior: "smooth" })
    if (patch.timeline_visible !== undefined) setWide(patch.timeline_visible)
  }
  const onToastAction = (_tag: CatalogTag, args?: Record<string, string>): void => {
    const toast = all.find(each => each.id === args?.toast)
    if (toast?.action === undefined) return
    controller.runCommand(toast.action.flow, toast.action.args)
    if (toast.status !== "running") controller.runCommand("toast.dismiss", toast.id)
  }
  const onEdgeAction = (tag: CatalogTag, args?: Record<string, string>): void => { controller.commands.submit({ name: tag, payload: args ?? {}, actor: "user" }) }
  const last = lines.at(-1)?.entry_id ?? ""
  return <aside className="mvp-rail" aria-label="Activity" data-keyboard-pane="Timeline" data-wide={wide || undefined}>
    <EdgeMap above={edges.above} below={edges.below} narrow={!wide} onAction={onEdgeAction} onView={onView} />
    <Timeline lines={lines} on_screen={band === undefined ? [last, last] : [band[0], band[1]]} onView={onView} onAction={timeline.onAction} />
    <ToastStack toasts={notices} more={Math.max(0, notices.length - 3)} onAction={onToastAction} onView={onView} />
  </aside>
}
