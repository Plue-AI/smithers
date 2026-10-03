import { expireStatus } from "../HealthStatus"
import type { ControllerContext } from "./context"

/** One bounded controller clock for all persisted projections, including offline cards. */
export const createHealthStatusController = (ctx: Pick<ControllerContext, "store" | "unref" | "onDispose">): void => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const schedule = (): void => {
    clearTimeout(timer)
    if (disposed) return
    const now = Date.now()
    let deadline = Infinity
    const statuses = [
      ...[...ctx.store.collections.cards.values()].flatMap((card) => card.kind === "run-trace" ? [card.payload.statusRollup] :
        card.kind === "run-list" ? card.payload.runs.map((run) => run.statusRollup) : [])
    ]
    for (const status of statuses) {
      if (status === undefined || status.freshness !== "fresh") continue
      deadline = Math.min(deadline, expireStatus(status, now) === status ? status.provenance!.expiresAt : now)
    }
    if (!Number.isFinite(deadline)) return
    timer = setTimeout(() => {
      if (disposed) return
      ctx.store.dispatch({ type: "status.expired", actor: "system", now: Date.now(), runtime: true })
      schedule()
    }, Math.max(0, Math.min(2_147_483_647, deadline - now)))
    ctx.unref(timer)
  }
  const cards = ctx.store.collections.cards.subscribeChanges(schedule)
  ctx.onDispose(() => { disposed = true; clearTimeout(timer); cards.unsubscribe() })
  schedule()
}
