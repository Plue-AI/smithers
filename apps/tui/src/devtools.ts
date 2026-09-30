/**
 * `/devtools [id]`: a run's node tree with state, timings, inputs, outputs and
 * journal frames, read through the shared projection (`@smthrs/gateway`
 * `RunDevTools`) the app pane and `smthrs runs devtools` read. Without an id
 * it inspects this conversation's own run; with a flow tab's id, that run's
 * journal. Pure: the caller appends the lines to the transcript.
 */
import { lines } from "@smthrs/gateway/RunDevTools"
import { type JournalRecord, traceFromJournal, type TraceModel } from "@smthrs/gateway/RunTrace"
import * as Activity from "./activity.ts"
import type * as Flows from "./flows.ts"

/** The trace status of a flow run's lifecycle word: only a settled run is not running. */
const statusOf = (status: Flows.Run["status"]): string =>
  status === "done" ? "completed" : status === "failed" || status === "cancelled" ? status : "running"

/** The trace of a flow run, folded from its events exactly as the app's run card folds them. */
export const model = (run: Flows.Run, events: ReadonlyArray<JournalRecord>): TraceModel =>
  traceFromJournal({ runId: run.runId ?? run.id, flowId: run.flow, status: statusOf(run.status) }, events)

/**
 * The transcript note for `/devtools [id] [node]`: a flow tab's run by its
 * id, else this conversation's own run, where a lone word may name one of
 * its nodes. An id that names neither is refused in the tab command's words.
 */
export const note = (argument: string, options: {
  readonly activity: Activity.Activity | undefined
  readonly run: (id: string) => Flows.Run | undefined
  readonly journal: (id: string) => ReadonlyArray<JournalRecord>
  readonly width: number
}): string => {
  const [id, node] = argument.trim().split(/\s+/).filter((word) => word !== "")
  const run = id === undefined ? undefined : options.run(id)
  if (run !== undefined) return lines(model(run, options.journal(id!)), node, { width: options.width }).join("\n")
  if (options.activity === undefined) return id === undefined ? "No run yet" : `Unknown tab: ${id}`
  const own = Activity.model(options.activity)
  if (id !== undefined && (node !== undefined || !own.rows.some((row) => row.id === id))) return `Unknown tab: ${id}`
  return lines(own, id, { width: options.width }).join("\n")
}
