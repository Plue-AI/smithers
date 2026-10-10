import type { MemberConfirmation } from "@smthrs/rpc/ConfirmCard"
import { CardSchema, conversationTabIdOf } from "../AppState"
import type { Session } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { actorSharedState } from "../ActorBindings"
import { accountOwnerOf } from "../AccountOwner"
import { randomUuid } from "../../runtime/RandomUuid"
import { captureCloudOwner, readErrorMessage, readResult, unreachableSentence, type SeamContext } from "./SeamContext"
import { TOAST_SUPERSEDED } from "../controller/failures"

type Request = NonNullable<Session["reviewRequests"]>[number]

/** The shared slash/button/confirmed-agent door. Only the install runs review. */
export const createReviewSeam = (ctx: SeamContext, pollMs = 1000) => {
  const shared = actorSharedState(ctx, "review", () => ({ pending: new Set<string>() }))
  const identity = () => ctx.store.collections.identitySessions.get("identity")
  const owner = () => identity()?.login ?? ""
  const current = (row: Request) => ctx.isDisposed?.() !== true && identity()?.state === "signed-in" && owner() === row.owner && row.origin === ctx.baseUrl
  const notice = (row: Request) => row.confirmationId ? `todo.request.confirmation:${row.confirmationId}` : `review.${row.id}`
  const save = (row: Request) => ctx.dispatch({ type: "review.requests.changed", actor: ctx.actor(),
    requests: [...(ctx.store.session().reviewRequests ?? []).filter(each => each.id !== row.id), row] }).isPersisted.promise
  const run = (requested: Request) => {
    if (shared.pending.has(requested.id)) return
    shared.pending.add(requested.id)
    const accountCurrent = captureCloudOwner(ctx, false)
    const stillCurrent = (row: Request) => accountCurrent() && current(row)
    const work = async (): Promise<string | void | typeof TOAST_SUPERSEDED> => {
      let row = requested
      try {
        if (!row.operationId) {
          const response = await ctx.http(`${ctx.baseUrl}/api/reviews`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": row.id },
            body: JSON.stringify({ number: row.number, repo: row.repo, conversation: row.conversation }) })
          if (!stillCurrent(row)) return TOAST_SUPERSEDED
          if (!response.ok) {
            const refusal: unknown = await response.clone().json().catch(() => undefined)
            const loading = typeof refusal === "object" && refusal !== null && "error" in refusal && typeof refusal.error === "object" && refusal.error !== null && "code" in refusal.error && refusal.error.code === "active_flow_unavailable"
            const message = loading ? "Review loading. Retry /review." : await readErrorMessage(response, "Review unavailable")
            await save({ ...row, state: "failed", terminal: response.status < 500 }); return message
          }
          const receipt: unknown = await response.json()
          if (typeof receipt !== "object" || receipt === null || !("operationId" in receipt) || typeof receipt.operationId !== "string" || !receipt.operationId) throw Error("Review receipt is invalid")
          row = { ...row, operationId: receipt.operationId, state: "running" }
          await save(row)
        }
        while (stillCurrent(row)) {
          const response = await ctx.http(`${ctx.baseUrl}/api/reviews/${encodeURIComponent(row.operationId!)}`)
          if (!stillCurrent(row)) return TOAST_SUPERSEDED
          if (!response.ok) {
            const message = await readErrorMessage(response, "Review unavailable")
            await save({ ...row, state: "failed", terminal: response.status < 500 }); return message
          }
          const result: unknown = await response.json()
          if (typeof result !== "object" || result === null || !("state" in result)) throw Error("Review observation is invalid")
          if (result.state === "completed") {
            if (!("change" in result)) throw Error("Review findings are missing")
            const card = CardSchema.parse({ id: `review-${row.operationId}`, kind: "change", title: "Review", status: "active", createdAt: Date.now(), ordinal: ctx.nextOrdinal(),
              tabId: row.tabId, payload: result.change })
            if (card.kind === "change" && card.payload.facet === undefined) card.payload.facet = "findings"
            await ctx.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
            await save({ ...row, state: "completed", terminal: true }); return
          }
          if (["failed", "cancelled", "uncertain"].includes(String(result.state))) {
            await save({ ...row, state: "failed", terminal: true }); return "error" in result && typeof result.error === "string" && result.error ? result.error : "Review failed"
          }
          if (!["accepted", "dispatching", "running", "waiting"].includes(String(result.state))) throw Error("Review state is invalid")
          await new Promise<void>(resolve => setTimeout(resolve, pollMs))
        }
        return TOAST_SUPERSEDED
      } catch (error) {
        if (!stillCurrent(row)) return TOAST_SUPERSEDED
        ctx.report?.("review", error)
        await save({ ...row, state: "failed" })
        return unreachableSentence("review", error)
      }
    }
    const pending = ctx.withToast ? ctx.withToast(notice(requested), "Review", "Review", work, false, () => stillCurrent(requested)) : work()
    void pending.then(result => {
      if (typeof result === "string" && !ctx.withToast && stillCurrent(requested)) {
        ctx.dispatch({ type: "toast.shown", actor: "system", key: notice(requested), title: "Review" })
        ctx.dispatch({ type: "toast.resolved", actor: "system", key: notice(requested), status: "failed", detail: result })
      }
    }).finally(() => shared.pending.delete(requested.id)).catch(error => ctx.report?.("review", error))
  }
  for (const row of ctx.store.session().reviewRequests ?? []) if (current(row) && ["requested", "running"].includes(row.state)) run(row)
  return {
    observeConfirmation: async (confirmation: MemberConfirmation): Promise<void> => {
      const operationId = confirmation.payload.effect?.review
      if (ctx.actor() !== "user" || identity()?.state !== "signed-in" || confirmation.command !== "review" || confirmation.state !== "approved" || !operationId) return
      const id = `confirmation:${confirmation.id}`
      const existing = (ctx.store.session().reviewRequests ?? []).find(row => row.id === id && current(row))
      if (existing) { if (!existing.terminal) run(existing); return }
      const input = confirmation.payload.input
      if (typeof input.number !== "number" || !Number.isSafeInteger(input.number) || input.number <= 0 || typeof input.conversation !== "string") return
      const resolved = resolveTargetRepo(ctx.store, typeof input.repo === "string" && input.repo ? input.repo : undefined)
      if ("error" in resolved) return
      const row: Request = { id, confirmationId: confirmation.id, operationId, origin: ctx.baseUrl, owner: owner(), repo: resolved.repo,
        number: input.number, conversation: input.conversation, tabId: conversationTabIdOf(ctx.store.session()), state: "running" }
      await save(row)
      run(row)
    },
    request: async (number: number, explicit?: string) => {
      if (ctx.actor() !== "user") return "Confirm review."
      if (identity()?.state !== "signed-in") return "Sign in"
      const resolved = resolveTargetRepo(ctx.store, explicit)
      if ("error" in resolved) return resolved.error
      if (!Number.isSafeInteger(number) || number <= 0) return "Choose a PR."
      // The install's conversation, as every other door names it; activeBranchId is a local frame id.
      const navigation = ctx.store.session().branchNavigation
      const conversation = navigation?.owner === accountOwnerOf(identity()) ? navigation?.selected_branch ?? "main" : "main"
      const existing = (ctx.store.session().reviewRequests ?? []).find(row => current(row) && row.repo === resolved.repo && row.number === number && row.conversation === conversation && ( ["requested", "running"].includes(row.state) || row.state === "failed" && row.terminal !== true ))
      if (existing) { run(existing); return readResult("Requested") }
      const row: Request = { id: randomUuid(), origin: ctx.baseUrl, owner: owner(), repo: resolved.repo, number, conversation, tabId: conversationTabIdOf(ctx.store.session()), state: "requested" }
      await save(row)
      run(row)
      return readResult("Requested")
    }
  }
}
