import { noticeDismissDelay, WORK_NOTICE_DELAY_MS } from "@smthrs/ui/notification-policy"
/** Off-screen settles, command feedback, search and undo notices. */
import { useCallback, useEffect, useState } from "react"
import type { Run } from "./flows.ts"
import type { TextSearch } from "./picker.ts"
import { flowGlyph, tabTitle } from "./surfaces.ts"
import * as Tabs from "./tabs.ts"
import * as Lifecycle from "./lifecycle.ts"
import type { Tab } from "./workspace.ts"

export interface Toast {
  readonly text: string
  readonly tone: "info" | "warning" | "danger"
}

export interface Row extends Toast {
  readonly id: string
  /** Opening this settle notice dismisses it. */
  readonly surface?: string
}

/** Ephemeral settlement notices. Seeding observes restored work without announcing it. */
export class Settlements {
  private observed = new Map<string, string>()
  private notices = new Map<string, Row>()
  constructor(tabs: ReadonlyArray<Tab> = [], runs: ReadonlyArray<Run> = []) {
    for (const work of this.work(tabs, runs)) this.observed.set(work.surface, work.stamp)
  }
  private work(tabs: ReadonlyArray<Tab>, runs: ReadonlyArray<Run>) {
    return [
      ...tabs.map((tab) => ({
        surface: `tab:${tab.id}`, title: tabTitle(tab), status: tab.status,
        startedAt: tab.startedAt, endedAt: tab.endedAt,
        stamp: `${tab.startedAt}:${tab.endedAt}:${tab.status}`,
        glyph: Tabs.style(tab.status, tab.endedAt ?? tab.startedAt).glyph
      })),
      ...runs.map((run) => ({
        surface: `flow:${run.id}`, title: run.flow, status: run.status,
        startedAt: run.startedAt, endedAt: run.endedAt,
        stamp: `${run.startedAt}:${run.endedAt}:${run.status}`,
        glyph: flowGlyph(run.status).trim()
      }))
    ]
  }
  update(input: {
    readonly tabs: ReadonlyArray<Tab>
    readonly runs: ReadonlyArray<Run>
    readonly visible: ReadonlySet<string>
    readonly opened: string
    readonly now: number
  }): ReadonlyArray<Row> {
    const work = this.work(input.tabs, input.runs)
    for (const each of work) {
      for (const other of work) {
        if (other.surface.startsWith(each.surface.split(":")[0]! + ":") &&
          other.title === each.title && other.startedAt < each.startedAt) this.notices.delete(other.surface)
      }
      const previous = this.observed.get(each.surface)
      if (previous !== each.stamp) {
        this.notices.delete(each.surface)
        this.observed.set(each.surface, each.stamp)
        if (Lifecycle.settled(each.status) && each.endedAt !== undefined &&
          !input.visible.has(each.surface) && input.opened !== each.surface) {
          const ms = Math.max(0, each.endedAt - each.startedAt)
          const clock = ms < 1000 ? `${ms}ms` : `${Math.floor(ms / 1000)}s`
          this.notices.set(each.surface, {
            id: each.surface, surface: each.surface,
            text: `${each.glyph} ${each.title} · ${clock}`,
            tone: each.status === "failed" ? "danger" : "info"
          })
        }
      }
      if (input.visible.has(each.surface) || input.opened === each.surface || !Lifecycle.settled(each.status)) {
        this.notices.delete(each.surface)
      }
    }
    for (const id of this.notices.keys()) if (!work.some((each) => each.surface === id)) this.notices.delete(id)
    return [...this.notices.values()]
  }
}

export const useToast = () => {
  const [toast, setToast] = useState<Toast | undefined>()
  const setStatus = useCallback((text: string, tone: Toast["tone"] = "info") => setToast({ text, tone }), [])
  /** A submit clears a failure; other notices run out on their own. */
  const clearFailure = useCallback(() => setToast((current) => (current?.tone === "danger" ? undefined : current)), [])
  useEffect(() => {
    if (toast === undefined) return
    const delay = noticeDismissDelay(toast.tone === "danger" ? "failed" : "ok")
    if (delay === undefined) return
    const timer = setTimeout(() => setToast(undefined), delay)
    return () => clearTimeout(timer)
  }, [toast])
  return { toast, setStatus, clearFailure }
}

/** The stack, oldest work first and the notice last. */
export const rows = (input: {
  readonly settlements?: ReadonlyArray<Row>
  readonly search: TextSearch | undefined
  /** When a running undo started. */
  readonly undoing: number | undefined
  readonly toast: Toast | undefined
  readonly now: number
  readonly tick: string
  /** Runs whose chat card is on screen: the card already says what a toast would. */
  readonly carded?: ReadonlySet<string>
}): ReadonlyArray<Row> => {
  const { now, tick, search, undoing, toast } = input
  return [
    ...input.settlements ?? [],
    ...(search?.status === "running" && now - search.startedAt >= WORK_NOTICE_DELAY_MS
      ? [{ id: "search", text: `${tick} text: ${search.query}`, tone: "info" as const }]
      : []),
    ...(undoing !== undefined && now - undoing >= WORK_NOTICE_DELAY_MS
      ? [{ id: "undo", text: `${tick} Undoing`, tone: "info" as const }]
      : []),
    ...(toast === undefined ? [] : [{ id: "notice", ...toast }])
  ]
}
