import {
  AgentTurnBatchSchema,
  type AgentTurnCursor,
  AgentTurnCursorSchema,
  type AgentTurnJournalReply
} from "@smthrs/rpc/AgentTurnJournal"
import { z } from "zod"
import { HttpTurnIntegrityError, verifyHttpBatch } from "./HttpTurn"

const Identity = z.string().min(1).max(160)
export const ConversationHistoryLegSchema = z.object({
  runId: Identity,
  legId: Identity,
  userText: z.string(),
  acceptedAt: z.number().finite(),
  initial: AgentTurnCursorSchema,
  head: AgentTurnCursorSchema,
  terminal: z.boolean(),
  batches: z.array(AgentTurnBatchSchema),
  runLinks: z.array(
    z.object({
      repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      runId: Identity,
      workspaceId: Identity.optional()
    }).strict()
  )
}).strict()
export const ConversationHistorySchema = z.object({ id: Identity, legs: z.array(ConversationHistoryLegSchema).min(1) })
  .strict()
export type ConversationHistoryLeg = z.infer<typeof ConversationHistoryLegSchema>
export type ConversationHistory = z.infer<typeof ConversationHistorySchema>
export const sameHistoryCursor = (a: AgentTurnCursor, b: AgentTurnCursor): boolean =>
  a.version === b.version && a.runId === b.runId && a.legId === b.legId && a.batch === b.batch &&
  a.position === b.position && a.hash === b.hash

/** Validate all bytes before projecting any visible fact. No execution authority is restored. */
export const verifyConversationHistory = (conversations: readonly ConversationHistory[]): void => {
  const ids = new Set<string>(), legs = new Set<string>()
  for (const conversation of conversations) {
    if (ids.has(conversation.id)) throw new HttpTurnIntegrityError("Duplicate saved conversation")
    ids.add(conversation.id)
    for (const leg of conversation.legs) {
      const key = JSON.stringify([leg.runId, leg.legId])
      if (
        legs.has(key) || leg.initial.runId !== leg.runId || leg.initial.legId !== leg.legId ||
        leg.initial.batch !== 0 || leg.initial.position !== 0
      ) throw new HttpTurnIntegrityError("Saved conversation leg identity failed")
      legs.add(key)
      let cursor = leg.initial
      for (const batch of leg.batches) {
        const next = verifyHttpBatch({ id: key, turnId: leg.runId, legId: leg.legId, status: "active" }, {
          id: leg.legId,
          attemptId: key,
          status: "streaming",
          cursor
        }, batch)
        if (!next) throw new HttpTurnIntegrityError("Saved conversation repeated a batch")
        cursor = next
      }
      const last = leg.batches.at(-1)?.frames.at(-1)
      if (
        !sameHistoryCursor(cursor, leg.head) || (last?.type === "done") !== leg.terminal ||
        leg.batches.slice(0, -1).some((batch) => batch.frames.at(-1)?.type === "done")
      ) throw new HttpTurnIntegrityError("Saved conversation head failed verification")
    }
  }
}

/** A compacted diagnostic tail cannot prove that no user action intervened. */
export const historyHasNewerUserIntent = (
  records: Iterable<{ readonly revision: number; readonly actor: string }>,
  afterRevision: number
): boolean => {
  const newer = [...records].filter((record) => record.revision > afterRevision)
  return newer.some((record) => record.actor === "user") ||
    (newer.length > 0 && Math.min(...newer.map((record) => record.revision)) > afterRevision + 1)
}

/** Check a page before another network request can extend its claimed boundary. */
export const verifyConversationHistoryPage = (
  runId: string,
  legId: string,
  page: Extract<AgentTurnJournalReply, { status: "ok" }>,
  expected?: AgentTurnCursor
): void => {
  if (
    page.after.runId !== runId || page.after.legId !== legId || page.head.runId !== runId ||
    page.head.legId !== legId ||
    (expected ? !sameHistoryCursor(expected, page.after) : page.after.batch !== 0 || page.after.position !== 0)
  ) throw new HttpTurnIntegrityError("Saved replay page identity failed")
  let cursor = page.after
  for (const [index, batch] of page.batches.entries()) {
    const next = verifyHttpBatch({ id: runId, turnId: runId, legId, status: "active" }, {
      id: legId,
      attemptId: runId,
      status: "streaming",
      cursor
    }, batch)
    if (!next || (batch.frames.at(-1)?.type === "done" && (index !== page.batches.length - 1 || page.more))) {
      throw new HttpTurnIntegrityError("Saved replay page contains an invalid terminal boundary")
    }
    cursor = next
  }
  if (
    !sameHistoryCursor(cursor, page.next) || page.next.batch > page.head.batch ||
    page.next.position > page.head.position ||
    page.more !== (page.next.batch < page.head.batch) || (page.more && page.batches.length === 0) ||
    (!page.more && !sameHistoryCursor(page.next, page.head)) ||
    (!page.more && page.batches.length > 0 && (page.batches.at(-1)?.frames.at(-1)?.type === "done") !== page.terminal)
  ) throw new HttpTurnIntegrityError("Saved replay page cursor failed verification")
}
