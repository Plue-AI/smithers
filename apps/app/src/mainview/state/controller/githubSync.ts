import type { ControllerContext } from "./context"
import type { GitHubSyncSeam } from "../seams/GitHubSyncSeam"
import type { Session } from "../AppState"
import { randomUuid } from "../../runtime/RandomUuid"
import { TOAST_SUPERSEDED } from "./failures"

type Request = NonNullable<Session["githubSyncRequest"]>
const sameReset = (a: Request["mainReset"], b: Request["mainReset"]): boolean => a === undefined ? b === undefined : b !== undefined && a.id === b.id && a.old === b.old && a.new === b.new

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
        const admitted = request.mainReset ? await seam.reset(request.mainReset, request.id) : await seam.retry(request.id)
        if (!current()) return TOAST_SUPERSEDED
        if (admitted === undefined) { const error = "GitHub sync is unavailable"; await save({ ...request, phase: "failed", error }); return error }
        if (typeof admitted === "string") { await save({ ...request, phase: "failed", error: admitted }); return admitted }
        // Reset's 200/settled is completion, not Retry's 202 admission.
        // A lost response replays the same stored attention receipt on reload.
        if (request.mainReset) { await save(undefined); return true }
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
    }, false, () => !ctx.disposed && ctx.accountOwner() === request.owner && (ctx.store.session().githubSyncRequest === undefined || ctx.store.session().githubSyncRequest?.id === request.id)).finally(() => { if (active === request.id) active = undefined })
  }
  const requestSync = async (mainReset?: NonNullable<Request["mainReset"]>): ReturnType<GitHubSyncSeam["retry"]> => {
    const acknowledgment = { value: mainReset ? "Reset requested" : "Sync requested" }
    const before = seam.snapshots.get(), owner = ctx.accountOwner()
    if (ctx.disposed || before === undefined || owner == null) return undefined
    if (persisting) { await persisting; return requestSync(mainReset) }
    const existing = ctx.store.session().githubSyncRequest
    if (existing?.owner === owner && existing.phase !== "failed" && !sameReset(existing.mainReset, mainReset)) return "Sync in progress"
    if (existing?.owner === owner && existing.phase !== "failed" && active === existing.id) return acknowledgment
    if (existing?.owner === owner && existing.phase !== "failed") { start(existing); return acknowledgment }
    const request: Request = { id: randomUuid(), owner, lastSuccessAt: before.last_success_at, phase: "requested", ...(mainReset ? { mainReset } : {}) }
    persisting = save(request)
    try { await persisting } finally { persisting = undefined }
    start(request)
    return acknowledgment
  }
  const retry: GitHubSyncSeam["retry"] = () => requestSync()
  const reset: GitHubSyncSeam["reset"] = binding => requestSync(binding)
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
  return { retry, reset, resume }
}
