/**
 * The chat transcript as it shows: every source merged into one timeline,
 * its scroll, the card `tab` focuses, and the activity scrubber's selection.
 * Moving the selection aims the scroll at the step it lands on.
 */
import type { CliRenderer, ScrollBoxRenderable } from "@opentui/core"
import { useEffect, useMemo, useRef, useState } from "react"
import type * as Activity from "./activity.ts"
import * as DragScroll from "./drag-scroll.ts"
import type * as Panels from "./panels.ts"
import * as Scrubber from "./scrubber.ts"
import { tabTitle } from "./surfaces.ts"
import { lane } from "./theme.ts"
import * as Timeline from "./timeline.ts"
import type * as Transcript from "./transcript.ts"
import type { Tab } from "./workspace.ts"

interface Source {
  readonly id: string
  readonly title: string
  readonly activity: Activity.Activity
}

export const useTranscriptView = (options: {
  readonly renderer: CliRenderer
  /** The chat's own transcript. */
  readonly transcript: Transcript.Transcript
  readonly tabs: ReadonlyArray<Tab>
  /** A worker's transcript. */
  readonly worker: (id: string) => Transcript.Transcript
  readonly filter: Timeline.Filter
  readonly surface: string
  readonly setSurface: (surface: string) => void
  /** The shown surface's panel; the chat shows none. */
  readonly panel: Panels.Panel | undefined
  readonly setPanelFocus: (focus: boolean) => void
}) => {
  const { renderer, transcript, tabs, worker, filter, surface, setSurface, panel, setPanelFocus } = options
  /** The chat card `tab` focused, by timeline row key; `enter` opens it. */
  const [cardFocus, setCardFocus] = useState<string | undefined>()
  /** A worker whose chat lane the next render scrolls to. */
  const revealWorker = useRef<string | undefined>(undefined)
  const [inspection, setInspection] = useState<
    { source: string; seq: number; first: Activity.Activity["records"][number] } | undefined
  >()
  const scroll = useRef<ScrollBoxRenderable>(null)

  const lanes = new Map(tabs.map((tab, index) => [tab.id, { title: tabTitle(tab), tone: lane(index) }]))
  const mergeTimeline = useMemo(() => Timeline.cached(), [])
  const timeline = mergeTimeline(
    [
      { id: Timeline.chat, transcript },
      ...tabs.map((tab) => ({ id: tab.id, transcript: worker(tab.id) }))
    ],
    filter
  )
  /** Cards in the chat, oldest first; `tab` on an empty composer walks them. */
  const cardKeys = surface === "chat" && panel === undefined
    ? timeline.filter((row) => row.item.kind === "card").map((row) => row.key)
    : []
  const focusedCard = cardFocus !== undefined && cardKeys.includes(cardFocus) ? cardFocus : undefined

  const activitySources = [
    { id: "chat", title: "Chat", activity: transcript.activity },
    ...tabs.map((tab) => ({ id: tab.id, title: tabTitle(tab), activity: worker(tab.id).activity }))
  ].filter((source): source is Source => source.activity !== undefined && source.activity.records.length > 0)
  const latestActivity = [...activitySources].sort((a, b) =>
    (b.activity.records.at(-1)?.occurredAt ?? 0) - (a.activity.records.at(-1)?.occurredAt ?? 0)
  )
  // A new turn or restored session cannot inherit a cursor from an old turn.
  const pinnedActivity = activitySources.find((source) =>
    source.id === inspection?.source &&
    source.activity.records[0] === inspection.first
  )
  const monitored =
    (surface.startsWith("tab:") ? activitySources.find((source) => source.id === surface.slice(4)) : pinnedActivity)
      ?? latestActivity.find((source) => source.activity.status === "running") ?? latestActivity[0]
  const showActivity = monitored !== undefined && (panel === undefined || surface.startsWith("tab:"))
  const activeInspection = showActivity && pinnedActivity === monitored ? inspection : undefined
  const transcriptOf = (source: string) => source === Timeline.chat ? transcript : worker(source)
  /** The chat row a scrubber position lands on. */
  const jumpTarget = activeInspection === undefined ? undefined : (() => {
    const id = Scrubber.target(transcriptOf(activeInspection.source), activeInspection.seq)
    return id === undefined ? undefined : `${activeInspection.source}:${id}`
  })()
  const reveal = (key: string) => {
    const box = scroll.current
    const child = box?.content.findDescendantById(key)
    if (box === null || box === undefined || child === undefined) return
    box.scrollTop = Math.max(0, box.scrollTop + child.y - box.viewport.y - 1)
  }
  const inspectActivity = (seq: number, jump = true) => {
    if (monitored === undefined) return
    setPanelFocus(false)
    setInspection({ source: monitored.id, seq, first: monitored.activity.records[0]! })
    const id = Scrubber.target(transcriptOf(monitored.id), seq)
    if (id === undefined || !jump) return
    if (surface !== "chat") setSurface("chat")
    const key = `${monitored.id}:${id}`
    reveal(key)
    // A surface switch mounts the chat first; lay it out, then aim again.
    setTimeout(() => reveal(key), 60)
  }
  const followLive = () => {
    setInspection(undefined)
    const box = scroll.current
    if (box !== null) box.scrollTop = box.scrollHeight
  }
  const dragScroll = useMemo(() => DragScroll.make(() => renderer.getSelection()?.isDragging === true), [renderer])
  useEffect(() => {
    const id = revealWorker.current
    if (id === undefined || surface !== "chat") return
    revealWorker.current = undefined
    const row = timeline.findLast((each) => each.source === id)
    if (row === undefined) return
    reveal(row.key)
    // The chat mounts on this render; lay it out, then aim again.
    setTimeout(() => reveal(row.key), 60)
  })
  return {
    scroll,
    dragScroll,
    lanes,
    timeline,
    cardKeys,
    focusedCard,
    setCardFocus,
    reveal,
    /** Scrolls the chat to a worker's newest row once the chat shows. */
    revealLane: (id: string) => {
      revealWorker.current = id
    },
    monitored,
    showActivity,
    activeInspection,
    jumpTarget,
    transcriptOf,
    inspectActivity,
    followLive,
    /** A new session starts at the live edge. */
    clearInspection: () => setInspection(undefined)
  }
}
