import { MemberConfirmationSchema, type MemberConfirmation } from "@smthrs/rpc/ConfirmCard"
import type { LiveTopics } from "../useTopic"
import type { SeamContext } from "./SeamContext"

/** Approvals remain server-owned, in the private live collection. No payload enters chat/model history. */
export const createConfirmationSeam = (ctx: SeamContext, options: {
  readonly ready: boolean
  readonly live?: LiveTopics
  readonly observe: (row: MemberConfirmation) => Promise<void>
  readonly debounceMs?: number
}) => {
  const presses = new Map<string, AbortController>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let stop: (() => void) | undefined
  let scope = "", topic: string | undefined, generation = 0, disposed = false
  const identity = () => ctx.store.collections.identitySessions.get("identity")
  const current = (mine: number) => !disposed && !ctx.isDisposed?.() && mine === generation && identity()?.state === "signed-in"
  const rows = (): MemberConfirmation[] => {
    const snapshot = topic ? options.live?.getSnapshot(topic) : undefined
    if (snapshot?.topic !== topic || snapshot?.error || !Array.isArray(snapshot?.data)) return []
    return snapshot.data.flatMap(value => {
      const parsed = MemberConfirmationSchema.safeParse(value)
      return parsed.success ? [parsed.data] : []
    })
  }
  const receive = () => {
    const mine = generation
    void (async () => {
      for (const row of rows()) {
        if (!current(mine)) return
        if (row.state !== "pending") {
          clearTimeout(timers.get(row.id)); timers.delete(row.id)
          const press = presses.get(row.id)
          press?.abort(); presses.delete(row.id)
          const notice = `todo.request.confirmation:${row.id}`
          if (row.state !== "approved" && (press || ctx.store.collections.toasts.get(`toast-${notice}`)?.status === "running")) {
            ctx.resolveToast?.(notice, row.state === "rejected" ? { status: "cancelled", detail: "Cancelled" } : { status: "failed", detail: "Expired" })
          }
        }
        if (row.state === "approved") await options.observe(row)
      }
    })().catch(error => ctx.report?.("confirmations.observe", error))
  }
  const refresh = () => {
    const member = identity()
    const next = options.ready && options.live && member?.state === "signed-in" && member.memberId
      ? `${member.memberId}:${member.ownerRevision ?? member.revision}` : ""
    if (next === scope) return
    ++generation; scope = next; stop?.(); stop = undefined; topic = undefined
    for (const press of presses.values()) press.abort()
    presses.clear()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    if (next) {
      topic = `confirmations:${member!.memberId}`
      stop = options.live!.subscribe(topic, receive)
      receive()
    }
  }
  const identitySubscription = ctx.store.collections.identitySessions.subscribeChanges(refresh)
  refresh()
  const decide = (id: string, decision: "approved" | "denied"): void => {
    refresh()
    const row = rows().find(row => row.id === id)
    if (ctx.actor() !== "user" || !scope || !row || row.state !== "pending" || presses.has(id)) return
    const mine = generation, abort = new AbortController()
    let admitted = false
    presses.set(id, abort)
    // One decision operation per immutable confirmation; retry/reload retains
    // its key. The server additionally binds that key to the browser session.
    const key = `confirmation:${id}:${decision}`
    const notice = `todo.request.confirmation:${id}`
    const timer = setTimeout(() => {
      timers.delete(id)
      if (current(mine) && ctx.store.collections.toasts.get(`toast-${notice}`)?.status !== "running") ctx.dispatch({ type: "toast.shown", actor: "system", key: notice, title: row.payload.card.summary })
    }, options.debounceMs ?? 300)
    timers.set(id, timer)
    const stopTimer = () => { clearTimeout(timer); if (timers.get(id) === timer) timers.delete(id) }
    const fail = (message: string) => {
      stopTimer()
      if (!current(mine)) return
      ctx.dispatch({ type: "toast.shown", actor: "system", key: notice, title: row.payload.card.summary })
      ctx.resolveToast?.(notice, { status: "failed", detail: message,
        action: { label: "Retry", flow: decision === "approved" ? "approval.approve" : "approval.deny", args: `confirmation:${id}` } })
    }
    void (async () => {
      try {
        const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/confirmations/${encodeURIComponent(id)}/${decision === "approved" ? "approve" : "deny"}`, {
          method: "POST", credentials: "same-origin", headers: { "Idempotency-Key": key, "Content-Type": "application/json" }, signal: abort.signal,
          body: JSON.stringify({ subject: row.payload.card.subject, revision: row.revision })
        })
        const body: unknown = await response.json()
        if (!current(mine) || abort.signal.aborted) return
        if (!response.ok) {
          const message = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "Confirmation unavailable"
          fail(message); return
        }
        if (response.status === 202 && body && typeof body === "object" && "id" in body && body.id === id && "state" in body && body.state === "pending") {
          // Admission is neither failure nor completion. Keep this press and
          // its running toast until the private topic observes settlement.
          admitted = true
          receive()
          return
        }
        if (!body || typeof body !== "object" || !("id" in body) || body.id !== id || !("state" in body) || body.state !== (decision === "approved" ? "approved" : "rejected")) {
          fail("Confirmation response unavailable"); return
        }
        admitted = decision === "approved"
        if (decision === "denied") {
          stopTimer()
          ctx.resolveToast?.(notice, { status: "cancelled", detail: "Cancelled" })
        }
        // An approval is admission. The same toast key is handed to the TODO
        // observer by the authoritative live row, including after a reload.
        receive()
      } catch (error) {
        if (current(mine) && !abort.signal.aborted) { ctx.report?.("confirmations.press", error); fail("Confirmation unavailable") }
      } finally {
        if (!admitted && presses.get(id) === abort) presses.delete(id)
      }
    })()
  }
  const dispose = () => {
    disposed = true; ++generation; identitySubscription.unsubscribe(); stop?.()
    for (const press of presses.values()) press.abort()
    for (const timer of timers.values()) clearTimeout(timer)
    presses.clear(); timers.clear()
  }
  return { decide, dispose }
}
