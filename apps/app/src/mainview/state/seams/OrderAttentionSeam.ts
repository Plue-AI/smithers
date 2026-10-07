import { actorSharedState } from "../ActorBindings"
import { readErrorMessage, unreachableSentence, type SeamContext } from "./SeamContext"

/** Revision-bound OK is persisted before HTTP. Reload retries the same revision;
 * the server keeps a newer appended entry open. */
export const createOrderAttentionSeam = (ctx: SeamContext) => {
  type Request = NonNullable<ReturnType<typeof ctx.store.session>["orderRequests"]>[number]
  const shared = actorSharedState(ctx, "order-attention", () => ({ sending: new Set<string>(), tail: Promise.resolve() }))
  const rows = () => ctx.store.session().orderRequests ?? []
  const identity = () => ctx.store.collections.identitySessions.get("identity")
  const save = (request: Request) => ctx.dispatch({ type: "order.requests.changed", actor: ctx.actor(),
    requests: [...rows().filter(row => row.id !== request.id || row.origin !== request.origin), request] }).isPersisted.promise
  const send = (request: Request) => {
    const principal = identity(), key = JSON.stringify([request.origin, request.id, request.revision, request.owner])
    if (request.origin !== ctx.baseUrl || request.state !== "requested" || principal?.state !== "signed-in" || principal.login !== request.owner || shared.sending.has(key)) return
    const epoch = principal.ownerRevision ?? principal.revision
    const current = () => !ctx.isDisposed?.() && identity()?.state === "signed-in" && identity()?.login === request.owner
      && (identity()?.ownerRevision ?? identity()?.revision) === epoch
      && rows().some(row => row.id === request.id && row.origin === request.origin && row.revision === request.revision && row.owner === request.owner)
    shared.sending.add(key)
    const work = async (): Promise<void | string> => {
      let error: string | undefined
      try {
        const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/stack/attention/${encodeURIComponent(request.id)}`, {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: request.revision })
        })
        if (!current()) return
        if (response.status !== 204) error = await readErrorMessage(response, "Could not settle order attention.")
      } catch (cause) { error = unreachableSentence("order attention", cause) }
      if (!current()) return
      await save({ ...request, state: error ? "failed" : "completed", ...(error ? { error } : {}) })
      return error
    }
    const run = ctx.withToast ? ctx.withToast(`order.ok.${key}`, "OK", "Done", work, false, current) : work()
    void run.catch(cause => ctx.report?.("order.ok", cause)).finally(() => shared.sending.delete(key))
  }
  return {
    orderOK: (id: string, revision: number): Promise<{ readonly value: string } | string> => {
      const request = shared.tail.then(async () => {
        const principal = identity()
        if (ctx.actor() !== "user") return "Only a person can do this"
        if (principal?.state !== "signed-in" || !principal.login) return "Sign in to settle order attention."
        const existing = rows().find(row => row.id === id && row.origin === ctx.baseUrl && row.owner === principal.login)
        if (existing?.revision === revision && existing.state !== "failed") return { value: "Requested" } as const
        const row: Request = { id, revision, origin: ctx.baseUrl, owner: principal.login, state: "requested" }
        await save(row); send(row)
        return { value: "Requested" } as const
      })
      shared.tail = request.then(() => undefined, () => undefined)
      return request
    },
    resumeOrderRequests: () => { for (const row of rows()) send(row) }
  }
}
