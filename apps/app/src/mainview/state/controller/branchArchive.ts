import type { ControllerContext } from "./context"
import type { Session } from "../AppState"
import { randomUuid } from "../../runtime/RandomUuid"
import { TOAST_SUPERSEDED } from "./failures"

type Request = NonNullable<Session["branchArchiveRequests"]>[number]

/** Archive is idempotent at the server: replay preserves the committed time. */
export const createBranchArchive = (ctx: ControllerContext, archive: (branch: string, requestId: string) => Promise<true | string>) => {
  const active = new Map<string, { readonly epoch: number; readonly token: symbol }>()
  const failedPersistence = new Set<string>()
  const persisting = new Map<string, Promise<void>>()
  const requests = () => ctx.store.session().branchArchiveRequests ?? []
  const save = async (request: Request) => {
    await ctx.store.dispatch({ type: "branch.archive.requests.changed", actor: "system", requests: [...requests().filter(each => each.id !== request.id), request] }).isPersisted.promise
  }
  const start = (request: Request) => {
    if (failedPersistence.has(request.id) || active.get(request.id)?.epoch === ctx.accountEpoch || ctx.disposed || ctx.accountOwner() !== request.owner) return
    const epoch = ctx.accountEpoch, token = Symbol(request.id)
    active.set(request.id, { epoch, token })
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === request.owner && requests().some(each => each.id === request.id && each.state === "requested")
    void ctx.withToast(`branch.archive.${request.id}`, "Archiving branch", "Archived", async () => {
      if (!current()) return TOAST_SUPERSEDED
      let result: true | string
      try { result = await archive(request.branch, request.id) } catch { result = "Branch unavailable" }
      if (!current()) return TOAST_SUPERSEDED
      await save({ ...request, state: result === true ? "completed" : "failed", ...(result === true ? {} : { error: result }) })
      return result
    }, false, () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === request.owner).finally(() => { if (active.get(request.id)?.token === token) active.delete(request.id) })
  }
  const request = async (branch: string): Promise<string | { readonly value: string }> => {
    const owner = ctx.accountOwner()
    if (ctx.disposed || owner == null || branch.trim() === "") return "Branch unavailable"
    const key = JSON.stringify([owner, branch])
    const pending = persisting.get(key)
    if (pending) {
      try { await pending } catch { return "Archive request could not be saved" }
      return { value: "Archive requested" }
    }
    const existing = requests().find(each => each.owner === owner && each.branch === branch && each.state !== "failed")
    if (existing) { if (existing.state === "requested") start(existing); return { value: existing.state === "completed" ? "Archived" : "Archive requested" } }
    const next: Request = { id: randomUuid(), owner, branch, state: "requested" }
    const persisted = save(next)
    persisting.set(key, persisted)
    try { await persisted } catch { failedPersistence.add(next.id); return "Archive request could not be saved" } finally { persisting.delete(key) }
    start(next)
    return { value: "Archive requested" }
  }
  const resume = () => {
    for (const request of requests()) if (request.state === "requested") {
      const pending = persisting.get(JSON.stringify([request.owner, request.branch]))
      if (pending) void pending.then(() => start(request)).catch(() => {})
      else start(request)
    }
  }
  return { request, resume }
}
