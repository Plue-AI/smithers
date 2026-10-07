import { emptyAppProjection, projectAppEvent, seedAppProjection } from "../AppProjection"
import type { AppTransition, Branch } from "../AppState"
import type { ConversationHistory } from "../ConversationHistory"
import type { ControllerContext } from "./context"
import { readConversationHistory } from "./readConversationHistory"

/** Decode with the existing historical reducer in an isolated projection.
 * Only branch snapshots leave it: no turn, approval or effect authority does.
 */
export function earlierBranches(owner: string, conversations: readonly ConversationHistory[]): Branch[] {
  let state = seedAppProjection(emptyAppProjection(), { createdAt: 0, theme: "light" })
  const apply = (transition: AppTransition) => {
    state = projectAppEvent(state, { transition, revision: state.sessions[0]!.revision + 1, createdAt: 0, persistenceMode: "memory" })
  }
  apply({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: owner, admin: false, scopesPlain: null })
  apply({ type: "conversation.restored", actor: "system", owner, afterRevision: state.sessions[0]!.revision, conversations })
  const wanted = new Set(conversations.map(row => row.id))
  return state.branches.filter(row => wanted.has(row.id)).map(row => ({ ...row, id: `earlier:journal:${row.id}`, archiveOwner: owner }))
}

export function createEarlierHistoryController(ctx: ControllerContext) {
  let loaded: number | undefined
  const pending = new Set<number>()
  const load = () => {
    const history = ctx.agent.history, owner = ctx.accountOwner(), epoch = ctx.accountEpoch
    if (!history || ctx.disposed || typeof owner !== "string" || ctx.store.collections.identitySessions.get("identity")?.state !== "signed-in" || loaded === epoch || pending.has(epoch)) return
    pending.add(epoch)
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === owner
    void ctx.withToast(`earlier-${epoch}`, "Earlier", "Earlier", async () => {
      const historyRows = await readConversationHistory(history, current)
      if (!historyRows || !current()) return
      const branches = earlierBranches(owner, historyRows)
      await ctx.store.dispatch({ type: "conversation.archives.loaded", actor: "system", owner, branches }).isPersisted.promise
      if (current()) loaded = epoch
    }, true, current).catch(error => { if (current()) ctx.failures.report("seam.failure", error, "earlier") }).finally(() => pending.delete(epoch))
  }
  return { load }
}
