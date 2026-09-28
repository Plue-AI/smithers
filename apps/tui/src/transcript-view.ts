/**
 * The chat transcript as it shows: its rows with the workers it delegated as
 * card grids between them, its scroll, the card `tab` focuses, and the
 * activity scrubber's selection. Moving the selection aims the scroll at the
 * step it lands on, in the chat or in the worker's own tab.
 */
import type { CliRenderer, ScrollBoxRenderable } from "@opentui/core"
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import type * as Activity from "./activity.ts"
import * as DragScroll from "./drag-scroll.ts"
import type * as Panels from "./panels.ts"
import * as Scrubber from "./scrubber.ts"
import * as Subagents from "./subagents.ts"
import { tabTitle } from "./surfaces.ts"
import { lane as laneColor } from "./theme.ts"
import * as Timeline from "./timeline.ts"
import type * as Transcript from "./transcript.ts"
import type { Tab } from "./workspace.ts"

interface Source {
  readonly id: string
  readonly title: string
  readonly activity: Activity.Activity
}

/** The chat's own activity source; a worker's is its tab id. */
const chat = "chat"

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
  /** The chat column's width, which lays out its card grids. */
  readonly width: number
}) => {
  const { renderer, transcript, tabs, worker, filter, surface, setSurface, panel, setPanelFocus } = options
  /** The chat card `tab` focused, by its key; `enter` opens it. */
  const [cardFocus, setCardFocus] = useState<string | undefined>()
  const [inspection, setInspection] = useState<
    { source: string; seq: number; first: Activity.Activity["records"][number] } | undefined
  >()
  const scroll = useRef<ScrollBoxRenderable>(null)
  const pendingReveal = useRef<
    {
      inspection: NonNullable<typeof inspection>
      timer: ReturnType<typeof setTimeout>
    } | undefined
  >(undefined)
  const cancelReveal = useCallback(() => {
    if (pendingReveal.current === undefined) return
    clearTimeout(pendingReveal.current.timer)
    pendingReveal.current = undefined
  }, [])
  useLayoutEffect(() => cancelReveal, [cancelReveal])

  /** A worker's lane color: its card rail, its crumb and its steering accent. */
  const lane = (id: string): string => laneColor(Math.max(0, tabs.findIndex((tab) => tab.id === id)))
  const chatRows = useMemo(() => Timeline.cached(), [])
  const rows = chatRows(transcript, filter)
  const lines = Subagents.lines(rows, Subagents.batches(transcript, tabs))
  const grids = lines.flatMap((line) =>
    line.kind === "grid" ? [line.batch.tabs.map((tab) => Subagents.cardKey(tab.id))] : []
  )
  /** Cards in the chat, top to bottom; `tab` on an empty composer walks them. */
  const cardKeys = surface === "chat" && panel === undefined
    ? lines.flatMap((line) =>
      line.kind === "row"
        ? line.row.item.kind === "card" ? [line.key] : []
        : line.kind === "grid"
        ? line.batch.tabs.map((tab) => Subagents.cardKey(tab.id))
        : []
    )
    : []
  const focusedCard = cardFocus !== undefined && cardKeys.includes(cardFocus) ? cardFocus : undefined
  /** The worker whose card has focus. */
  const focusedWorker = focusedCard === undefined
    ? undefined
    : tabs.find((tab) => Subagents.cardKey(tab.id) === focusedCard)

  const activitySources = [
    { id: chat, title: "Chat", activity: transcript.activity },
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
  useLayoutEffect(() => {
    if (pendingReveal.current?.inspection !== activeInspection) cancelReveal()
  }, [activeInspection, cancelReveal])
  const transcriptOf = (source: string) => source === chat ? transcript : worker(source)
  /** The transcript item a scrubber position lands on, in the chat or a worker's tab. */
  const jump = activeInspection === undefined ? undefined : (() => {
    const id = Scrubber.target(transcriptOf(activeInspection.source), activeInspection.seq)
    return id === undefined ? undefined : { source: activeInspection.source, id }
  })()
  const reveal = (key: string) => {
    const box = scroll.current
    const child = box?.content.findDescendantById(key)
    if (box === null || box === undefined || child === undefined) return
    box.scrollTop = Math.max(0, box.scrollTop + child.y - box.viewport.y - 1)
  }
  const inspectActivity = (seq: number, jumping = true) => {
    cancelReveal()
    if (monitored === undefined) return
    setPanelFocus(false)
    const nextInspection = { source: monitored.id, seq, first: monitored.activity.records[0]! }
    setInspection(nextInspection)
    const id = Scrubber.target(transcriptOf(monitored.id), seq)
    if (id === undefined || !jumping) return
    // A worker's step shows in its own tab, which scrolls to it.
    if (monitored.id !== chat) {
      if (surface !== `tab:${monitored.id}`) setSurface(`tab:${monitored.id}`)
      return
    }
    if (surface !== "chat") setSurface("chat")
    const key = Timeline.key(id)
    reveal(key)
    // A surface switch mounts the chat first; lay it out, then aim again.
    const timer = setTimeout(() => {
      if (pendingReveal.current?.timer !== timer) return
      pendingReveal.current = undefined
      reveal(key)
    }, 60)
    pendingReveal.current = { inspection: nextInspection, timer }
  }
  const followLive = () => {
    cancelReveal()
    setInspection(undefined)
    const box = scroll.current
    if (box !== null) box.scrollTop = box.scrollHeight
  }
  const dragScroll = useMemo(() => DragScroll.make(() => renderer.getSelection()?.isDragging === true), [renderer])
  return {
    scroll,
    dragScroll,
    lane,
    rows,
    lines,
    cardKeys,
    focusedCard,
    focusedWorker,
    setCardFocus,
    /** Moves the focused card and scrolls it into view. */
    moveCard: (direction: Subagents.Direction) => {
      if (focusedCard === undefined) return
      const next = Subagents.move(cardKeys, grids, options.width, focusedCard, direction)
      setCardFocus(next)
      reveal(next)
    },
    reveal,
    monitored,
    showActivity,
    activeInspection,
    /** The chat row the scrubber's playhead is on. */
    jumpTarget: jump?.source === chat ? Timeline.key(jump.id) : undefined,
    /** A worker's transcript item the scrubber's playhead is on. */
    workerJump: (id: string) => jump?.source === id ? jump.id : undefined,
    inspectActivity,
    followLive,
    /** A new session starts at the live edge. */
    clearInspection: () => {
      cancelReveal()
      setInspection(undefined)
    }
  }
}
