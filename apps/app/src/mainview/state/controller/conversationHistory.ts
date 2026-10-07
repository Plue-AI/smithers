import { historyHasNewerUserIntent } from "../ConversationHistory"
import { readConversationHistory } from "./readConversationHistory"
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
        const conversations = await readConversationHistory(history, current)
        if (!conversations) return
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
