import type { AgentTurnCursor } from "@smthrs/rpc/AgentTurnJournal"
import { AgentConversationPageSchema, AgentConversationReplaySchema } from "@smthrs/rpc/AgentTurnJournal"
import {
  type ConversationHistory,
  type ConversationHistoryLeg,
  ConversationHistorySchema,
  historyHasNewerUserIntent,
  sameHistoryCursor,
  verifyConversationHistory,
  verifyConversationHistoryPage
} from "../ConversationHistory"
import { HttpTurnIntegrityError } from "../HttpTurn"
import type { ControllerContext } from "./context"

/** Read committed account output; never admit, resume or execute a turn. */
export const createConversationHistoryController = (ctx: ControllerContext) => {
  const history = ctx.agent.history
  const requestedLocation = ctx.services.frameHistory?.current()
  let completedEpoch: number | undefined
  const pending = new Set<number>()
  const empty = (): boolean =>
    ctx.store.session().phase === "idle" && ctx.store.session().draft === "" &&
    (ctx.store.session().queuedPrompts?.length ?? 0) === 0 && ctx.store.collections.httpTurns.size === 0 &&
    ![...ctx.store.collections.messages.values()].some((message) => message.role === "user") &&
    ![...ctx.store.collections.branches.values()].some((branch) =>
      branch.snapshot?.messages.some((message) => message.role === "user")
    )
  const resume = (): void => {
    if (!history || ctx.disposed || ctx.services.bootstrap?.host !== "cloud" || !empty()) return
    const owner = ctx.accountOwner(), epoch = ctx.accountEpoch, afterRevision = ctx.store.session().revision
    if (
      typeof owner !== "string" || ctx.store.collections.identitySessions.get("identity")?.state !== "signed-in" ||
      completedEpoch === epoch || pending.has(epoch)
    ) return
    const current = (): boolean => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === owner
    pending.add(epoch)
    void ctx.withToast(
      `conversation-history-${epoch}`,
      "Conversations",
      "Conversations",
      async () => {
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
        if (
          !current() || !empty() || historyHasNewerUserIntent(ctx.store.collections.transitions.values(), afterRevision)
        ) return
        await ctx.store.dispatch({
          type: "conversation.restored",
          actor: "system",
          owner,
          afterRevision,
          conversations
        }).isPersisted.promise
        if (!current()) return
        completedEpoch = epoch
        const location = requestedLocation
        if (
          location && ctx.store.collections.branches.has(location.branchId) &&
          ctx.store.collections.frames.has(location.frameId)
        ) {
          await ctx.store.dispatch({ type: "frame.navigated", actor: "system", ...location }).isPersisted.promise
        }
        if (current()) {
          const session = ctx.store.session(), branchId = session.activeBranchId
          if (
            branchId !== undefined && session.activeWorkspaceId !== undefined && session.activeFrameId !== undefined
          ) {
            ctx.services.frameHistory?.replace({
              workspaceId: session.activeWorkspaceId,
              branchId,
              frameId: session.activeFrameId
            })
          }
        }
      },
      true,
      current
    ).catch((error) => {
      if (current()) ctx.failures.report("seam.failure", error, "conversation.history")
    }).finally(() => {
      pending.delete(epoch)
    })
  }
  return { resume }
}
