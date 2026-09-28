/**
 * Find the approval a run is still waiting on from its control journal.
 * @since 1.0.0
 */

import { ControlFacts } from "@smthrs/control"
import type { JournalEvent } from "@smthrs/journal"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * The run approval one entry names: the request with its question, or the
 * decision that answered a request. A plan decision names no run request, and
 * a fact this version cannot read names nothing.
 */
const approvalOf = (
  entry: JournalEvent.Entry
): { readonly requestId: string; readonly question?: string } | undefined => {
  if (entry.eventType === "control.approval.requested") {
    const fact = Schema.decodeUnknownOption(ControlFacts.ApprovalRequestFact)(entry.payload)
    return Option.isSome(fact) ? { requestId: fact.value.requestId, question: fact.value.question } : undefined
  }
  if (entry.eventType !== "control.approval.approved" && entry.eventType !== "control.approval.denied") {
    return undefined
  }
  const fact = Schema.decodeUnknownOption(ControlFacts.ApprovalDecisionFact)(entry.payload)
  return Option.isSome(fact) && fact.value.approvalTarget._tag === "Node"
    ? { requestId: fact.value.approvalTarget.requestId }
    : undefined
}

/**
 * The latest approval request in `entries` that no decision has answered,
 * with the question it asked.
 *
 * An unrequested round re-parks a run in a host that may never have parked
 * it, after the engine cleared the waiting row to activate the round. The
 * `control.approval.requested` fact is then the only durable record of the
 * wait's token and question, so this is what the re-park declares.
 *
 * @category utilities
 * @since 1.0.0
 */
export const latestPendingApproval = (
  entries: Iterable<JournalEvent.Entry>
): { readonly requestId: string; readonly question: string } | undefined => {
  const pending = new Map<string, string>()
  for (const entry of entries) {
    const approval = approvalOf(entry)
    if (approval === undefined) continue
    // Delete first so a request asked again moves to the end.
    pending.delete(approval.requestId)
    if (approval.question !== undefined) pending.set(approval.requestId, approval.question)
  }
  const latest = [...pending].at(-1)
  return latest === undefined ? undefined : { requestId: latest[0], question: latest[1] }
}
