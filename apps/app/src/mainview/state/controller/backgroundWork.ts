import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import { runFailureOf } from "../RunFailure"

// Explicit launch owners also cover the debounce before their toast exists.
const owners = new WeakMap<ControllerContext["store"], Map<string, string>>()
export const claimWorkToast = (store: ControllerContext["store"], cardId: string, key: string): void => {
  let claims = owners.get(store)
  if (!claims) owners.set(store, claims = new Map())
  claims.set(cardId, key)
  const recovered = `toast-worker.${cardId}`
  if (store.collections.toasts.has(recovered)) store.dispatch({ type: "toast.dismissed", actor: "system", id: recovered })
}

const phaseOf = (card: Card): "running" | "ok" | "failed" | "cancelled" | undefined => {
  if (card.kind === "agent") {
    const p = card.payload
    if ("cloud" in p) return p.state === "completed" ? "ok" : p.state === "cancelled" ? "cancelled" : p.state === "failed" ? "failed" : "running"
    return p.phase === "running" ? "running" : p.exitCode === 0 ? "ok" : "failed"
  }
  if (card.kind === "run-trace") {
    return card.payload.phase === "completed" ? "ok"
      : card.payload.phase === "cancelled" ? "cancelled"
      : ["failed", "no-capacity"].includes(card.payload.phase) ? "failed" : "running"
  }
  return undefined
}

/** Recovered workers and externally started runs use the same toast stack as launches. */
export const observeBackgroundWork = (ctx: ControllerContext): void => {
  const { store } = ctx
  for (const toast of store.collections.toasts.values()) {
    if (toast.sourceCard && !toast.key.startsWith("worker.")) claimWorkToast(store, toast.sourceCard, toast.key)
  }
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const seen = new Map<string, string>()
  let scheduled = false
  const reconcile = async () => {
    await store.settled?.()
    if (ctx.disposed) return
    const claims = owners.get(store)
    for (const [id, timer] of pending) if (!store.collections.cards.has(id) || claims?.has(id)) {
      clearTimeout(timer); pending.delete(id)
    }
    for (const card of store.collections.cards.values()) {
      const phase = phaseOf(card)
      if (!phase || claims?.has(card.id)) continue
      // A setup request already owns the job toast through real completion.
      const setup = card.kind === "run-trace" && [...store.collections.cards.values()].find(other => other.kind === "repository-setup"
        && other.payload.repo === card.payload.repo && other.payload.workspaceId === card.payload.workspaceId
        && [other.payload.receipt?.runId, other.payload.receipt?.jobRunId].includes(card.payload.runId) && claims?.has(other.id))
      if (setup) continue
      const key = `worker.${card.id}`, toast = store.collections.toasts.get(`toast-${key}`)
      if (phase === "running") {
        const previous = seen.get(card.id)
        seen.set(card.id, phase)
        if (!pending.has(card.id) && (!toast || previous && previous !== "running")) {
          const timer = setTimeout(() => { void (async () => {
            await store.settled?.()
            pending.delete(card.id)
            const current = store.collections.cards.get(card.id)
            if (ctx.disposed || !current || phaseOf(current) !== "running" || owners.get(store)?.has(card.id)) return
            store.dispatch({ type: "toast.shown", actor: "system", key, title: current.title, sourceCard: card.id })
          })().catch(error => ctx.failures.report("toast.work", error)) }, Math.max(0, ctx.toastDebounceMs - (Date.now() - card.createdAt)))
          pending.set(card.id, timer); ctx.unref(timer)
        }
      } else {
        const timer = pending.get(card.id)
        if (timer) { clearTimeout(timer); pending.delete(card.id) }
        seen.set(card.id, phase)
        const detail = phase === "ok" ? "" : phase === "cancelled" ? "Cancelled" : card.kind === "run-trace"
          ? runFailureOf(card.payload).message
          : card.kind === "agent" && "cloud" in card.payload ? card.payload.error ?? card.payload.state : "Stopped"
        if (toast && (toast.status !== phase || toast.title !== card.title || toast.detail !== detail)) {
          ctx.resolveToast(key, { status: phase, title: card.title, detail })
        }
      }
    }
    for (const toast of store.collections.toasts.values()) if (toast.key.startsWith("worker.") && toast.sourceCard && !store.collections.cards.has(toast.sourceCard)) {
      store.dispatch({ type: "toast.dismissed", actor: "system", id: toast.id })
    }
  }
  const schedule = () => {
    if (scheduled || ctx.disposed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      void reconcile().catch(error => ctx.failures.report("toast.work", error))
    })
  }
  const subscription = store.collections.cards.subscribeChanges(schedule)
  ctx.onDispose(() => { subscription.unsubscribe(); for (const timer of pending.values()) clearTimeout(timer); pending.clear(); owners.delete(store) })
  schedule()
}
