import { randomUuid } from "../../runtime/RandomUuid"
import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalSentence } from "@smthrs/rpc/RefusalCopy"
import type { CommandResult } from "../../flows/entries/Declare"
import { activeRepositoryId } from "../RepoContext"
import type { Session } from "../AppState"
import type { SeamContext } from "./SeamContext"

class BranchControlFailure extends Error {}

export type BranchControl = "sleep" | "wake" | "rebase"
export interface BranchControlOptions {
  readonly ready: (operation: BranchControl) => boolean
}
export interface BranchControls {
  readonly dispose: () => void
  readonly available: (operation: BranchControl) => boolean
  readonly request: (operation: BranchControl, branch: string, input?: { conflict_change?: string; onto_revision?: string }) => Promise<CommandResult>
}

/** Branch controls share the install dispatcher and its durable execution receipts. */
export function createBranchControlsSeam(ctx: SeamContext, options: BranchControlOptions): BranchControls {
  type Request = NonNullable<Session["branchControlRequests"]>[number]
  let disposed = false, tail = Promise.resolve()
  const active = new Map<string, { abort: AbortController; epoch: number | undefined }>()
  const identity = () => ctx.store.collections.identitySessions.get("identity")
  const rows = () => ctx.store.session().branchControlRequests ?? []
  const repository = () => activeRepositoryId(ctx.store) ?? ctx.store.session().repositoryEntry?.repo
  const available = (operation: BranchControl) => !disposed && !ctx.isDisposed?.() && options.ready(operation)
  const save = (request: Request, actor: "user" | "smithers" | "system" = "system") => ctx.dispatch({
    type: "branch.control.requests.changed", actor, requests: [...rows().filter(old => old.key !== request.key), request]
  }).isPersisted.promise
  const send = (initial: Request) => {
    const principal = identity()
    if (!available(initial.operation) || initial.origin !== ctx.baseUrl || principal?.state !== "signed-in"
      || principal.login !== initial.owner || active.has(initial.key) || ["completed", "failed"].includes(initial.state)) return
    const abort = new AbortController(), epoch = principal.ownerRevision ?? principal.revision
    active.set(initial.key, { abort, epoch })
    const current = () => !disposed && !ctx.isDisposed?.() && !abort.signal.aborted
      && active.get(initial.key)?.abort === abort && identity()?.state === "signed-in"
      && identity()?.login === initial.owner && (identity()?.ownerRevision ?? identity()?.revision) === epoch
    const title = initial.operation === "sleep" ? "Sleep" : initial.operation === "wake" ? "Wake" : "Rebase"
    const work = async (): Promise<void | string> => {
      let request = initial
      try {
        if (request.state === "requested") {
          let branch = request.branch
          if (/^T[1-9][0-9]*$/.test(branch)) {
            const response = await ctx.http(`${ctx.baseUrl}/api/todos/${branch.slice(1)}`, { credentials: "same-origin", signal: abort.signal })
            const body = await response.json() as { branch?: { name?: unknown } }
            if (!current()) return
            if (!response.ok || typeof body.branch?.name !== "string") throw new BranchControlFailure("Branch unavailable")
            branch = body.branch.name
          }
          if (!available(request.operation)) throw new BranchControlFailure("Branch unavailable")
          const response = await ctx.http(`${ctx.baseUrl}/api/branches/${encodeURIComponent(branch)}`, {
            method: "POST", credentials: "same-origin", signal: abort.signal,
            headers: { "Content-Type": "application/json", "Idempotency-Key": request.key }, body: JSON.stringify(request.operation === "rebase" ? request.input?.conflict_change === undefined ? { rebase: true } : request.input : { op: request.operation })
          })
          const body = await response.json() as { operationId?: unknown; requestId?: unknown; state?: unknown; n?: number; onto?: string; message?: string }
          if (!current()) return
          if (!response.ok) throw new BranchControlFailure(refusalSentence(refusalOf({ body, status: response.status, message: body.message ?? "Branch unavailable" })))
          if (request.operation === "rebase") {
            if (response.status !== 202 || body.state !== "accepted" || !Number.isSafeInteger(body.n) || body.n! < 1 || typeof body.onto !== "string" || !body.onto) throw new BranchControlFailure("Rebase admission was not confirmed")
            request = { ...request, state: "accepted", number: body.n, onto: body.onto }
          } else {
            if (response.status !== 202 || body.state !== "accepted" || typeof body.operationId !== "string" || !body.operationId
              || typeof body.requestId !== "string" || !body.requestId.endsWith(`:${request.key}`)) throw new BranchControlFailure("Branch admission was not confirmed")
            const workspace = body.requestId.slice(0, -request.key.length - 1)
            if (!workspace) throw new BranchControlFailure("Branch admission was not confirmed")
            request = { ...request, state: "accepted", operationId: body.operationId, workspace }
          }
          await save(request)
        }
        const repo = request.repo ?? repository()
        if (request.operation !== "rebase" && (!repo || !request.workspace || !request.operationId)) throw new BranchControlFailure("Branch receipt unavailable")
        while (current()) {
          const response = await ctx.http(request.operation === "rebase" ? `${ctx.baseUrl}/api/todos/${request.number}?rebase_request=${encodeURIComponent(request.key)}` : `${ctx.baseUrl}/api/repos/${repo!.split("/").map(encodeURIComponent).join("/")}/workspaces/${encodeURIComponent(request.workspace!)}/command-runs/${encodeURIComponent(request.operationId!)}`, { credentials: "same-origin", signal: abort.signal })
          const body = await response.json() as { operationId?: unknown; state?: unknown; n?: number; rebase_execution?: { onto: string; state: string }; error?: string }
          if (!current()) return
          if (!response.ok) throw new BranchControlFailure(refusalSentence(refusalOf({ body, status: response.status, message: body.error ?? "Branch receipt unavailable" })))
          if (request.operation === "rebase") {
            if (body.n !== request.number || !body.rebase_execution) throw new BranchControlFailure("Rebase receipt unavailable")
            if (body.rebase_execution.onto !== request.onto) { request = { ...request, settled: true }; throw new BranchControlFailure("Rebase target changed") }
            if (body.rebase_execution.state === "completed") { await save({ ...request, state: "completed" }); return }
            if (body.rebase_execution.state === "failed") { request = { ...request, settled: true }; throw new BranchControlFailure("Rebase failed") }
            if (body.rebase_execution.state !== "running") throw new BranchControlFailure("Rebase receipt unavailable")
          } else {
            if (body.operationId !== request.operationId) throw new BranchControlFailure("Branch receipt changed")
            if (body.state === "completed") { await save({ ...request, state: "completed" }); return }
            if (["failed", "cancelled", "uncertain"].includes(String(body.state))) { request = { ...request, settled: body.state !== "uncertain" }; throw new BranchControlFailure(body.error ?? "Branch request failed") }
            if (!["accepted", "dispatching", "running", "waiting"].includes(String(body.state))) throw new BranchControlFailure("Branch receipt unavailable")
          }
          await new Promise<void>(resolve => {
            const timer = setTimeout(done, 1000)
            function done() { clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve() }
            abort.signal.addEventListener("abort", done, { once: true })
          })
        }
      } catch (error) {
        if (!current()) return
        const message = error instanceof BranchControlFailure ? error.message : "Branch unavailable"
        await save({ ...request, state: "failed", error: message })
        return message
      }
    }
    void (ctx.withToast ? ctx.withToast(`branch.request.${initial.key}`, title, title, work, false, current) : work())
      .catch(error => ctx.report?.("branch.request", error)).finally(() => {
        if (active.get(initial.key)?.abort === abort) { active.delete(initial.key); resume() }
      })
  }
  const resume = () => {
    for (const [key, { abort, epoch }] of active) {
      const request = rows().find(row => row.key === key)
      if (identity()?.state !== "signed-in" || request?.owner !== identity()?.login || epoch !== (identity()?.ownerRevision ?? identity()?.revision)) {
        abort.abort(); active.delete(key)
      }
    }
    for (const request of rows()) send(request)
  }
  const subscription = ctx.store.collections.identitySessions.subscribeChanges(resume)
  queueMicrotask(resume)
  return { available, dispose: () => {
    disposed = true; subscription.unsubscribe()
    for (const { abort } of active.values()) abort.abort()
    active.clear()
  }, request: (operation, branch, input = {}) => {
    if (!available(operation)) return Promise.resolve("Branch unavailable")
    if ((input.conflict_change === undefined) !== (input.onto_revision === undefined)) return Promise.resolve("Branch unavailable")
    if (!branch.trim() || /[\u0000\\]/.test(branch)) return Promise.resolve("Choose a branch")
    const result = tail.then(async (): Promise<CommandResult> => {
      if (!available(operation)) return "Branch unavailable"
      const owner = identity()?.login
      if (!owner || identity()?.state !== "signed-in") return "Sign in"
      const previous = [...rows()].reverse().find(request => request.owner === owner && request.origin === ctx.baseUrl && request.branch === branch && request.operation === operation && request.input?.conflict_change === input.conflict_change && request.input?.onto_revision === input.onto_revision)
      if (previous && !["failed", "completed"].includes(previous.state)) return { value: "Requested" }
      const request: Request = previous?.state === "failed" && !previous.settled ? { ...previous, state: (previous.operationId || previous.number) ? "accepted" : "requested", error: undefined } : { key: randomUuid(), owner, origin: ctx.baseUrl, branch, operation, state: "requested", ...(operation === "rebase" ? { input } : {}), ...(repository() ? { repo: repository()! } : {}) }
      await save(request, ctx.actor()); send(request)
      return { value: "Requested" }
    })
    tail = result.then(() => undefined, () => undefined)
    return result
  } }
}
