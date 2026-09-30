/**
 * The chat transcript as it shows: its rows with the workers it delegated as
 * host-owned cards between them, its scroll, the card `tab` focuses, and the
 * activity scrubber's selection. Moving the selection aims the scroll at the
 * step it lands on, in the chat or in the worker's own tab.
 */
import type { CliRenderer, ScrollBoxRenderable } from "@opentui/core"
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import type * as Activity from "./activity.ts"
import * as DragScroll from "./drag-scroll.ts"
import type { Run } from "./flows.ts"
import type * as Panels from "./panels.ts"
import * as RunCard from "./run-card.ts"
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
  /** Disclosure chrome belongs to this conversation. */
  readonly conversation: string
  /** The chat's own transcript. */
  readonly transcript: Transcript.Transcript
  readonly tabs: ReadonlyArray<Tab>
  readonly runs?: ReadonlyArray<Run>
  /** A worker's transcript. */
  readonly worker: (id: string) => Transcript.Transcript
  readonly filter: Timeline.Filter
  readonly surface: string
  /** The shown surface's panel; the chat shows none. */
  readonly panel: Panels.Panel | undefined
  readonly setPanelFocus: (focus: boolean) => void
  readonly panelFocus: boolean
  /** The width available to the host cards. */
  readonly width: number
}) => {
  const { renderer, transcript, tabs, worker, filter, surface, panel, setPanelFocus, panelFocus } = options
  /** The chat card `tab` focused, by its key; `enter` opens it. */
  const [cardFocus, setCardFocus] = useState<string | undefined>()
  const [earlierOpened, setEarlierOpened] = useState<ReadonlySet<string>>(() => new Set())
  const earlierContext = (parent?: string) => JSON.stringify([options.conversation, parent ?? null])
  const earlierOpen = (parent?: string) => earlierOpened.has(earlierContext(parent))
  const showEarlier = (parent?: string) => {
    setCardFocus(undefined)
    setEarlierOpened((before) => new Set([...before, earlierContext(parent)]))
  }
  const [inspection, setInspection] = useState<
    { source: string; seq: number; first: Activity.Activity["records"][number] } | undefined
  >()
  const [inspectionInterrupted, setInspectionInterrupted] = useState(false)
  /** The surface inspection owns, including its own jumps between views. */
  const inspectionSurface = useRef<string | undefined>(undefined)
  const previousSurface = useRef(surface)
  const scroll = useRef<ScrollBoxRenderable>(null)
  const workerScroll = useRef<ScrollBoxRenderable | null>(null)
  /** Inspection borrows navigation; closing gives back the exact view it borrowed. */
  const origin = useRef<{ surface: string; panelFocus: boolean; scrollTop: number } | undefined>(undefined)
  const restore = useRef<{ surface: string; scrollTop: number } | undefined>(undefined)
  const viewport = () => surface.startsWith("tab:") ? workerScroll.current : scroll.current
  const [liveEdge, setLiveEdge] = useState(0)
  useLayoutEffect(() => {
    const position = restore.current
    if (position === undefined || position.surface !== surface) return
    const box = viewport()
    if (box === null) return
    box.scrollTop = position.scrollTop
    // Native layout settles after React has mounted a returned tab.
    const timer = setTimeout(() => {
      if (restore.current !== position) return
      restore.current = undefined
      const returned = viewport()
      if (returned !== null) returned.scrollTop = position.scrollTop
    }, 60)
    return () => clearTimeout(timer)
  }, [surface, inspection])
  useLayoutEffect(() => {
    if (liveEdge === 0) return
    const follow = () => {
      const box = viewport()
      if (box === null) return
      box.scrollTop = box.scrollHeight
      // Short panes can fit only the steering label and trailing padding at
      // the bottom. Keep the submitted text itself in the viewport.
      const shown = surface.startsWith("tab:") ? worker(surface.slice(4)) : transcript
      const message = shown.items.findLast((item) => item.kind === "user")
      if (message !== undefined) box.scrollChildIntoView(`${message.id}:text`)
    }
    follow()
    const timer = setTimeout(() => {
      follow()
      setLiveEdge(0)
    }, 60)
    return () => clearTimeout(timer)
  }, [liveEdge, surface])
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
  useLayoutEffect(() => {
    if (previousSurface.current === surface) return
    previousSurface.current = surface
    if (restore.current?.surface !== surface) restore.current = undefined
    if (origin.current !== undefined && inspectionSurface.current !== surface) {
      cancelReveal()
      origin.current = undefined
      inspectionSurface.current = undefined
      setInspection(undefined)
      // The first dismissal closes the interrupted inspection in this view.
      setInspectionInterrupted(true)
    } else if (inspectionSurface.current === undefined) {
      setInspectionInterrupted(false)
    }
  }, [surface, cancelReveal])

  /** A worker's lane color: its card rail, its crumb and its steering accent. */
  const lane = (id: string): string => laneColor(Math.max(0, tabs.findIndex((tab) => tab.id === id)))
  const chatRows = useMemo(() => Timeline.cached(), [])
  const projectedChat = RunCard.chat(transcript)
  const rows = chatRows(projectedChat, filter)
  const lines = Subagents.lines(rows, Subagents.batches(transcript, tabs, undefined, options.runs), earlierOpen())
  const workerTab = surface.startsWith("tab:") ? tabs.find((tab) => `tab:${tab.id}` === surface) : undefined
  const workerEarlier = workerTab === undefined ? undefined : Subagents.lines(
    Timeline.rows(worker(workerTab.id)),
    Subagents.batches(worker(workerTab.id), tabs, workerTab.id),
    earlierOpen(workerTab.id),
    workerTab.id
  ).find((line) => line.kind === "earlier")
  /** Cards in the chat, top to bottom; `tab` on an empty composer walks them. */
  const cardKeys = surface === "chat" && panel === undefined
    ? lines.flatMap((line) =>
      line.kind === "row"
        ? line.row.item.kind === "card" || line.row.item.kind === "run" ? [line.key] : []
        : line.kind === "grid"
        ? [
          ...line.batch.tabs.map((tab) => Subagents.cardKey(tab.id)),
          ...line.batch.runs?.map((run) => `flow:${run.id}`) ?? []
        ]
        : line.kind === "earlier"
        ? [line.key]
        : []
    )
    : panel?.placement !== "main" && workerEarlier !== undefined
    ? [workerEarlier.key]
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
  // A new turn or restored session cannot inherit a cursor from an old turn.
  const pinnedActivity = activitySources.find((source) =>
    source.id === inspection?.source &&
    source.activity.records[0] === inspection.first
  )
  const monitored = surface === "chat" ?
    projectedChat.activity === undefined ? undefined : activitySources.find((source) => source.id === chat)
    : surface.startsWith("tab:") ?
    activitySources.find((source) => source.id === surface.slice(4))
    : undefined
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
    setInspectionInterrupted(false)
    if (monitored === undefined) return
    if (activeInspection === undefined || origin.current === undefined) {
      origin.current = { surface, panelFocus, scrollTop: viewport()?.scrollTop ?? 0 }
    }
    inspectionSurface.current = surface
    setPanelFocus(false)
    const nextInspection = { source: monitored.id, seq, first: monitored.activity.records[0]! }
    setInspection(nextInspection)
    const id = Scrubber.target(transcriptOf(monitored.id), seq)
    if (id === undefined || !jumping) return
    // The current run's transcript handles its own selection; inspection never changes views.
    if (monitored.id !== chat) return
    const key = Timeline.key(id)
    reveal(key)
    // Layout may settle after the inspected row changes; aim again then.
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
    setInspectionInterrupted(false)
    inspectionSurface.current = undefined
    const prior = origin.current
    origin.current = undefined
    if (prior === undefined) return
    restore.current = prior
    setPanelFocus(prior.panelFocus)
  }
  const snapToLive = () => {
    cancelReveal()
    setInspectionInterrupted(false)
    inspectionSurface.current = undefined
    origin.current = undefined
    restore.current = undefined
    setInspection(undefined)
    setLiveEdge((current) => current + 1)
    const box = viewport()
    if (box !== null) box.scrollTop = box.scrollHeight
  }
  const dragScroll = useMemo(() => DragScroll.make(() => renderer.getSelection()?.isDragging === true), [renderer])
  return {
    scroll,
    workerScroll,
    dragScroll,
    lane,
    rows,
    lines,
    cardKeys,
    focusedCard,
    focusedWorker,
    setCardFocus,
    earlierOpen,
    showEarlier,
    /** Expand the focused earlier row in its own parent transcript. */
    openEarlier: () => showEarlier(workerTab?.id),
    /** Moves the focused card and scrolls it into view. */
    moveCard: (direction: Subagents.Direction) => {
      if (focusedCard === undefined) return
      const next = Subagents.move(cardKeys, focusedCard, direction)
      setCardFocus(next)
      reveal(next)
    },
    reveal,
    monitored,
    showActivity,
    activeInspection,
    inspectionInterrupted,
    /** The chat row the scrubber's playhead is on. */
    jumpTarget: jump?.source === chat ? Timeline.key(jump.id) : undefined,
    /** A worker's transcript item the scrubber's playhead is on. */
    workerJump: (id: string) => jump?.source === id ? jump.id : undefined,
    inspectActivity,
    followLive,
    snapToLive,
    /** A new session starts at the live edge. */
    clearInspection: () => {
      cancelReveal()
      setInspection(undefined)
      setInspectionInterrupted(false)
      inspectionSurface.current = undefined
      origin.current = undefined
      restore.current = undefined
      setLiveEdge(0)
    }
  }
}
