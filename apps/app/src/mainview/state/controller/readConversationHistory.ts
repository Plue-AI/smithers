import type { AgentTurnCursor } from "@smthrs/rpc/AgentTurnJournal"
import { AgentConversationPageSchema, AgentConversationReplaySchema } from "@smthrs/rpc/AgentTurnJournal"
import {
  type ConversationHistory,
  type ConversationHistoryLeg,
  ConversationHistorySchema,
  sameHistoryCursor,
  verifyConversationHistory,
  verifyConversationHistoryPage
} from "../ConversationHistory"
import { HttpTurnIntegrityError } from "../HttpTurn"
import type { AgentPort } from "../../runtime/AgentPort"


/** Verify the private index and every replay boundary before publishing any history. */
export const readConversationHistory = async (history: NonNullable<AgentPort["history"]>, current: () => boolean): Promise<ConversationHistory[] | undefined> => {
  const index = new Map<
    string,
    {
      id: string
      turns: Array<
        {
          runId: string
          legId: string
          acceptedAt: number
          terminal: boolean
          runLinks: ConversationHistoryLeg["runLinks"]
        }
      >
    }
  >()
  const boundaries = new Set<string>(), identities = new Set<string>()
  let after: string | undefined
  do {
    const page = AgentConversationPageSchema.parse(await history.list(after))
    if (!current()) return
    for (const conversation of page.conversations) {
      let saved = index.get(conversation.id)
      if (!saved) {
        saved = { id: conversation.id, turns: [] }
        index.set(conversation.id, saved)
      }
      for (const turn of conversation.turns) {
        const key = JSON.stringify([turn.runId, turn.legId])
        if (identities.has(key)) throw new HttpTurnIntegrityError("Conversation index repeated a leg")
        identities.add(key)
        saved.turns.push(turn)
      }
    }
    if (page.next !== null && boundaries.has(page.next)) {
      throw new HttpTurnIntegrityError(
        "Conversation index did not advance"
      )
    }
    if (page.next !== null) boundaries.add(page.next)
    after = page.next ?? undefined
  } while (after !== undefined)
  const conversations: ConversationHistory[] = []
  for (const saved of index.values()) {
    const legs: ConversationHistoryLeg[] = []
    for (const reference of saved.turns) {
      let cursor: AgentTurnCursor | undefined, collected: ConversationHistoryLeg | undefined
      do {
        const reply = AgentConversationReplaySchema.parse(
          await history.replay({
            runId: reference.runId,
            legId: reference.legId,
            ...(cursor === undefined ? {} : { after: cursor })
          })
        )
        if (!current()) return
        const page = reply.page
        if (
          page.status !== "ok" || reply.conversationId !== saved.id || page.head.runId !== reference.runId ||
          page.head.legId !== reference.legId ||
          (cursor !== undefined && !sameHistoryCursor(page.after, cursor)) ||
          (page.more && sameHistoryCursor(page.after, page.next))
        ) throw new HttpTurnIntegrityError("Saved conversation replay did not advance")
        verifyConversationHistoryPage(reference.runId, reference.legId, page, cursor)
        if (collected === undefined) {
          collected = {
            ...reference,
            userText: reply.userText,
            initial: page.after,
            head: page.head,
            terminal: page.terminal,
            batches: []
          }
        } else if (
          collected.userText !== reply.userText || page.head.batch < collected.head.batch
        ) throw new HttpTurnIntegrityError("Saved conversation changed while loading")
        collected.batches.push(...page.batches)
        collected.head = page.head
        collected.terminal = page.terminal
        cursor = page.next
        if (!page.more) break
      } while (current())
      if (!collected || !current()) return
      legs.push(collected)
    }
    conversations.push(ConversationHistorySchema.parse({ id: saved.id, legs }))
  }
  verifyConversationHistory(conversations)
  return conversations
}
