import { noticeDismissDelay, WORK_NOTICE_DELAY_MS, workNoticeVisible } from "@smthrs/ui/notification-policy"
/**
 * The toast stack: one notice (`setStatus`), plus a row for each piece of
 * background work that has run long enough to mention and has not been
 * settled long; a person's own flow run is a chat card instead, so it shows
 * here only while its form waits. A notice clears itself after 4 s; a failure stays until
 * another notice replaces it or the next submit. A worker's row says what its
 * subagent card says (`SubagentCard.toast`) and carries the card's Stop and Steer.
 */
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import { useCallback, useEffect, useState } from "react"
import { type Run, running as flowRunning } from "./flows.ts"
import type { TextSearch } from "./picker.ts"
import { flowGlyph, tabTitle } from "./surfaces.ts"
import * as Tabs from "./tabs.ts"
import type { Tab } from "./workspace.ts"

export interface Toast {
  readonly text: string
  readonly tone: "info" | "warning" | "danger"
}

/** The card actions a worker's toast offers, while its status allows them. */
const offered: ReadonlyArray<Tabs.ActionId> = ["stop", "steer", "raise"]

export interface Row extends Toast {
  readonly id: string
  /** A worker's row: the tab its buttons act on, and those buttons. */
  readonly worker?: { readonly tab: Tab; readonly actions: ReadonlyArray<Tabs.Action> }
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
  readonly tabs: ReadonlyArray<Tab>
  readonly runs: ReadonlyArray<Run>
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
    ...input.tabs.filter((tab) => workNoticeVisible(tab, now))
      .map((tab) => ({
        id: tab.id,
        text: SubagentCard.toast({ ...tab, title: tabTitle(tab) }, now).line,
        tone: tab.status === "failed" ? "danger" as const : "info" as const,
        worker: { tab, actions: Tabs.actions(tab).filter((action) => offered.includes(action.id)) }
      })),
    // A person's run reports in chat; its input notice appears while the form is closed.
    ...input.runs.filter((run) =>
      input.carded?.has(run.id) !== true &&
      (run.status === "input" || (run.by === "agent" && workNoticeVisible(run, now)))
    ).map((run) => ({
      id: `flow:${run.id}`,
      text: `${flowRunning(run) ? `${tick} ` : flowGlyph(run.status)}${run.flow} · ${run.status}`,
      tone: run.status === "failed" ? "danger" as const : "info" as const
    })),
    ...(search?.status === "running" && now - search.startedAt >= WORK_NOTICE_DELAY_MS
      ? [{ id: "search", text: `${tick} text: ${search.query}`, tone: "info" as const }]
      : []),
    ...(undoing !== undefined && now - undoing >= WORK_NOTICE_DELAY_MS
      ? [{ id: "undo", text: `${tick} Undoing`, tone: "info" as const }]
      : []),
    ...(toast === undefined ? [] : [{ id: "notice", ...toast }])
  ]
}
