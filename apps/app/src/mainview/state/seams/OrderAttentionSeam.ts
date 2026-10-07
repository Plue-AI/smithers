import { actorSharedState } from "../ActorBindings"
import type { Session } from "../AppState"
import { readErrorMessage, unreachableSentence, type SeamContext } from "./SeamContext"

type Request = NonNullable<Session["orderRequests"]>[number]
/** A press binds the displayed revision. Replays after reload can only settle
 * that revision; an appended event is never silently acknowledged. */
export const createOrderAttentionSeam = (ctx: SeamContext) => {
  const shared = actorSharedState(ctx, "orderAttention", () => ({ sending: new Set<string>(), requesting: new Set<string>() }))
  const rows = () => ctx.store.session().orderRequests ?? []
  const identity = () => ctx.store.collections.identitySessions.get("identity")
  const keyOf = (row: Request) => JSON.stringify([row.owner, row.id, row.revision])
  const save = async (row: Request) => {
    const other = rows().filter(old => keyOf(old) !== keyOf(row))
    await ctx.dispatch({ type: "order.requests.changed", actor: ctx.actor(), requests: [...other, row] }).isPersisted.promise
  }
  const send = (row: Request) => {
    const principal = identity(), key = keyOf(row)
    if (row.state !== "requested" || principal?.state !== "signed-in" || principal.login !== row.owner || shared.sending.has(key)) return
    const epoch = principal.ownerRevision ?? principal.revision
    const current = () => !ctx.isDisposed?.() && identity()?.state === "signed-in" && identity()?.login === row.owner
      && (identity()?.ownerRevision ?? identity()?.revision) === epoch
    shared.sending.add(key)
    const work = async (): Promise<void | string> => {
      let error: string | undefined
      try {
        const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/stack/attention/${encodeURIComponent(row.id)}`, {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json",
            ...(ctx.actor() === "smithers" ? { "Smithers-Via": "smithers" } : {}) }, body: JSON.stringify({ revision: row.revision }) })
        if (!current()) return
        if (response.status !== 204) error = await readErrorMessage(response, "Could not acknowledge the order.")
      } catch (cause) { error = unreachableSentence("order", cause) }
      if (!current()) return
      await save({ ...row, state: error ? "failed" : "completed", ...(error ? { error } : {}) })
      return error
    }
    const run = ctx.withToast ? ctx.withToast(`order.${row.id}.${row.revision}`, "OK", "Acknowledged", work, false, current) : work()
    void run.catch(error => ctx.report?.("order.ok", error)).finally(() => shared.sending.delete(key))
  }
  return {
    orderOK: async (id: string, revision: number): Promise<string | { readonly value: string }> => {
      const owner = identity()?.state === "signed-in" ? identity()?.login : undefined
      if (!owner) return "Sign in to acknowledge the order."
      const row: Request = { id, revision, owner, state: "requested" }, key = keyOf(row)
      if (shared.requesting.has(key)) return { value: "Requested" }
      const prior = rows().find(old => keyOf(old) === key)
      if (prior?.state === "completed") return { value: "Acknowledged" }
      shared.requesting.add(key)
      try { if (prior?.state !== "requested") await save(row); send(row); return { value: "Requested" } }
      finally { shared.requesting.delete(key) }
    },
    resume: () => { for (const row of rows()) send(row) }
  }
}
