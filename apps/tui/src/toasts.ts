/**
 * The toast stack: one notice (`setStatus`), plus a row for each piece of
 * background work that has run long enough to mention and has not been
 * settled long. A notice clears itself after 3 s; a failure stays until
 * another notice replaces it or the next submit.
 */
import { useCallback, useEffect, useState } from "react"
import type * as Approvals from "./approvals.ts"
import { type Run, running as flowRunning } from "./flows.ts"
import type { TextSearch } from "./picker.ts"
import { flowGlyph, tabTitle } from "./surfaces.ts"
import * as Tabs from "./tabs.ts"
import { type Tab, tabToast } from "./workspace.ts"

export interface Toast {
  readonly text: string
  readonly tone: "info" | "warning" | "danger"
}

export const useToast = () => {
  const [toast, setToast] = useState<Toast | undefined>()
  const setStatus = useCallback((text: string, tone: Toast["tone"] = "info") => setToast({ text, tone }), [])
  /** A submit clears a failure; other notices run out on their own. */
  const clearFailure = useCallback(() => setToast((current) => (current?.tone === "danger" ? undefined : current)), [])
  useEffect(() => {
    if (toast === undefined || toast.tone === "danger") return
    const timer = setTimeout(() => setToast(undefined), 3000)
    return () => clearTimeout(timer)
  }, [toast])
  return { toast, setStatus, clearFailure }
}

/** The stack, oldest work first and the notice last. */
export const rows = (input: {
  readonly tabs: ReadonlyArray<Tab>
  readonly runs: ReadonlyArray<Run>
  readonly approvals: ReadonlyArray<Approvals.Pending>
  readonly search: TextSearch | undefined
  /** When a running undo started. */
  readonly undoing: number | undefined
  readonly toast: Toast | undefined
  readonly now: number
  readonly tick: string
}): ReadonlyArray<{ readonly id: string } & Toast> => {
  const { now, tick, search, undoing, toast } = input
  return [
    ...input.tabs.filter((tab) => now - tab.startedAt >= 300 && (tab.endedAt === undefined || now - tab.endedAt < 3000))
      .map((tab) => ({
        id: tab.id,
        text: `${Tabs.style(tab.status, tick).glyph} ${
          input.approvals.some((request) => request.source === tab.id) ? `${tabTitle(tab)} · approval` : tabToast(tab)
        }`,
        tone: tab.status === "failed" ? "danger" as const : "info" as const
      })),
    ...input.runs.filter((run) =>
      run.status === "input" || now - run.startedAt >= 300 && (run.endedAt === undefined || now - run.endedAt < 3000)
    ).map((run) => ({
      id: `flow:${run.id}`,
      text: `${flowRunning(run) ? `${tick} ` : flowGlyph(run.status)}${run.flow} · ${run.status}`,
      tone: run.status === "failed" ? "danger" as const : "info" as const
    })),
    ...(search?.status === "running" && now - search.startedAt >= 300
      ? [{ id: "search", text: `${tick} text: ${search.query}`, tone: "info" as const }]
      : []),
    ...(undoing !== undefined && now - undoing >= 300
      ? [{ id: "undo", text: `${tick} Undoing`, tone: "info" as const }]
      : []),
    ...(toast === undefined ? [] : [{ id: "notice", ...toast }])
  ]
}
