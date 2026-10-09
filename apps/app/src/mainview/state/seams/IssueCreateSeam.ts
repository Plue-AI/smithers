import type { Session } from "../AppState"
import { actorSharedState } from "../ActorBindings"
import { randomUuid } from "../../runtime/RandomUuid"
import { readErrorMessage, readResult, type SeamContext } from "./SeamContext"
import { TOAST_SUPERSEDED } from "../controller/failures"

type Request = NonNullable<Session["issueCreateRequests"]>[number]

/** The install's issue.new door persists intent before launch and observes delivery. */
export const createIssueCreateSeam = (ctx: SeamContext, open: (number: number) => Promise<unknown>, pollMs = 1000) => {
  const shared = actorSharedState(ctx, "issue-create", () => ({ pending: new Set<string>(), retry: new Set<string>() }))
  const identity = () => ctx.store.collections.identitySessions.get("identity")
  const current = (row: Request) => !ctx.isDisposed?.() && identity()?.state === "signed-in" && identity()?.login === row.owner && ctx.baseUrl === row.origin
  const save = (row: Request) => ctx.dispatch({ type: "issue.create.requests.changed", actor: ctx.actor(), requests: [...(ctx.store.session().issueCreateRequests ?? []).filter(each => each.id !== row.id), row] }).isPersisted.promise
  const run = (requested: Request) => {
    if (shared.pending.has(requested.id)) return
    shared.pending.add(requested.id)
    const work = async (): Promise<string | void | typeof TOAST_SUPERSEDED> => {
      let row = requested
      try {
        if (!row.operationId) {
          const response = await ctx.http(`${ctx.baseUrl}/api/issues`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": row.id }, body: JSON.stringify({ title: row.title, body: row.body }) })
          if (!current(row)) return TOAST_SUPERSEDED
          if (!response.ok) { await save({ ...row, state: "failed", terminal: response.status < 500 }); return readErrorMessage(response, "Issue unavailable") }
          const receipt: unknown = await response.json()
          if (!receipt || typeof receipt !== "object" || !("operationId" in receipt) || typeof receipt.operationId !== "string") throw Error("Invalid issue receipt")
          row = { ...row, state: "running", operationId: receipt.operationId }
          await save(row)
        }
        while (current(row)) {
          const response = await ctx.http(`${ctx.baseUrl}/api/issues/requests/${encodeURIComponent(row.operationId!)}`)
          if (!current(row)) return TOAST_SUPERSEDED
          if (!response.ok) { await save({ ...row, state: "failed", terminal: response.status < 500 }); return readErrorMessage(response, "Issue unavailable") }
          const result: unknown = await response.json()
          if (!result || typeof result !== "object" || !("state" in result)) throw Error("Invalid issue state")
          if (result.state === "completed") {
            if (!("number" in result) || typeof result.number !== "number" || !Number.isSafeInteger(result.number) || result.number <= 0) throw Error("Invalid issue number")
            await open(result.number)
            if (!current(row)) return TOAST_SUPERSEDED
            await save({ ...row, state: "completed", terminal: true }); return
          }
          if (["failed", "cancelled", "uncertain"].includes(String(result.state))) { await save({ ...row, state: "failed", terminal: true }); return "Issue failed" }
          if (!["accepted", "dispatching", "running", "waiting"].includes(String(result.state))) throw Error("Invalid issue state")
          await new Promise<void>(resolve => setTimeout(resolve, pollMs))
        }
        return TOAST_SUPERSEDED
      } catch (error) {
        if (!current(row)) return TOAST_SUPERSEDED
        await save({ ...row, state: "failed" }); ctx.report?.("issue.create", error); return "Issue unavailable"
      }
    }
    const result = ctx.withToast ? ctx.withToast(`issue.create.${requested.id}`, requested.title, requested.title, work, false, () => current(requested)) : work()
    void result.finally(() => {
      shared.pending.delete(requested.id)
      if (shared.retry.delete(requested.id)) { const row = ctx.store.session().issueCreateRequests?.find(each => each.id === requested.id); if (row && current(row) && !row.terminal) run(row) }
    }).catch(error => ctx.report?.("issue.create", error))
  }
  for (const row of ctx.store.session().issueCreateRequests ?? []) if (current(row) && ["requested", "running"].includes(row.state)) run(row)
  return { request: async (title: string, body: string) => {
    if (ctx.actor() !== "user" || identity()?.state !== "signed-in" || !identity()?.login) return "Sign in"
    const existing = ctx.store.session().issueCreateRequests?.find(row => current(row) && row.title === title && row.body === body && ["requested", "running", "failed"].includes(row.state))
    if (existing) {
      if (existing.terminal) return "Issue failed"
      if (existing.state === "failed" && shared.pending.has(existing.id)) shared.retry.add(existing.id)
      else run(existing)
      return readResult("Requested")
    }
    const row: Request = { id: randomUuid(), owner: identity()!.login!, origin: ctx.baseUrl, title, body, state: "requested" }
    await save(row); run(row); return readResult("Requested")
  } }
}
