import type { ControllerContext } from "./context"
import type { GitHubSyncSeam } from "../seams/GitHubSyncSeam"
import type { Session } from "../AppState"
import { randomUuid } from "../../runtime/RandomUuid"
import { TOAST_SUPERSEDED } from "./failures"

type Request = NonNullable<Session["githubSyncRequest"]>

/** Persist admission before launch; reconnect the same request after reload. */
export const createGitHubSyncRetry = (ctx: ControllerContext, seam: GitHubSyncSeam) => {
  let active: string | undefined
  let persisting: Promise<void> | undefined
  const save = async (request: Session["githubSyncRequest"]) => {
    await ctx.store.dispatch({ type: "github.sync.request.changed", actor: "system", request }).isPersisted.promise
  }
  const start = (request: Request) => {
    if (active === request.id || ctx.disposed || ctx.accountOwner() !== request.owner) return
    active = request.id
    const current = () => !ctx.disposed && ctx.accountOwner() === request.owner && ctx.store.session().githubSyncRequest?.id === request.id
    void ctx.withToast("github.sync", "Syncing GitHub", "Synced", async () => {
      // An interrupted admission repeats its original key; a settled admission only observes.
      if (request.phase === "requested") {
        const admitted = await seam.retry(request.id)
        if (!current()) return TOAST_SUPERSEDED
        if (admitted === undefined) { const error = "GitHub sync is unavailable"; await save({ ...request, phase: "failed", error }); return error }
        if (typeof admitted === "string") { await save({ ...request, phase: "failed", error: admitted }); return admitted }
        await save({ ...request, phase: "running" })
      }
      const result = await new Promise<true | string | typeof TOAST_SUPERSEDED>(resolve => {
        let stop: (() => void) | undefined
        const finish = (result: true | string | typeof TOAST_SUPERSEDED) => { stop?.(); resolve(result) }
        const observe = () => {
          const health = seam.snapshots.get()
          if (!current()) finish(TOAST_SUPERSEDED)
          else if (health?.state === "refused") finish(health.cause === "not_installed" ? "GitHub App not installed" : "GitHub App permission missing")
          else if (health?.state === "fresh" && health.last_success_at !== request.lastSuccessAt) finish(true)
        }
        stop = seam.snapshots.subscribe(observe)
        ctx.onDispose(() => finish(TOAST_SUPERSEDED))
        observe()
      })
      if (current() && result !== TOAST_SUPERSEDED) await save(typeof result === "string" ? { ...request, phase: "failed", error: result } : undefined)
      return result
    }, false, () => !ctx.disposed && ctx.accountOwner() === request.owner).finally(() => { if (active === request.id) active = undefined })
  }
  const retry: GitHubSyncSeam["retry"] = async () => {
    const before = seam.snapshots.get(), owner = ctx.accountOwner()
    if (ctx.disposed || before === undefined || owner == null) return undefined
    if (persisting) { await persisting; return { value: "Sync requested" } }
    const existing = ctx.store.session().githubSyncRequest
    if (existing?.owner === owner && active === existing.id) return { value: "Sync requested" }
    if (existing?.owner === owner && existing.phase !== "failed") { start(existing); return { value: "Sync requested" } }
    const request: Request = { id: randomUuid(), owner, lastSuccessAt: before.last_success_at, phase: "requested" }
    persisting = save(request)
    try { await persisting } finally { persisting = undefined }
    start(request)
    return { value: "Sync requested" }
  }
  const resume = () => {
    const request = ctx.store.session().githubSyncRequest
    if (request && request.phase !== "failed" && ctx.accountOwner() === request.owner) {
      // The first recovered health read supplies the admission seam before relaunch.
      let stop: (() => void) | undefined
      const observe = () => { if (seam.snapshots.get() !== undefined) { stop?.(); start(request) } }
      stop = seam.snapshots.subscribe(observe)
      ctx.onDispose(() => stop?.())
      observe()
    }
  }
  return { retry, resume }
}
