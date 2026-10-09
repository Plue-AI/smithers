import { canonicalEventValue } from "../EventValue"
import type { Session } from "../AppState"
import type { SeamContext } from "./SeamContext"
import { randomUuid } from "../../runtime/RandomUuid"
import { Data } from "effect"

type Request = NonNullable<Session["branchRequests"]>[number]

/** The server refused a fork or add-to-stack request, or answered with no usable branch; `sentence` is the request's failure line. */
class BranchRequestFailure extends Data.TaggedError("BranchRequestFailure")<{ readonly sentence: string }> {
  override get message() { return this.sentence }
}

/** Request metadata stays durable while the server writes the branch history. */
export const createBranchMutations = (ctx: SeamContext) => {
  const active = new Map<string, AbortController>()
  const epochs = new Map<string, number | undefined>()
  let disposed = false
  const identity = () => ctx.store.collections.identitySessions.get("identity")
  const rows = () => ctx.store.session().branchRequests ?? []
  const save = async (row: Request) => {
    await ctx.dispatch({ type: "branch.requests.changed", actor: ctx.actor(), requests: [...rows().filter(old => old.id !== row.id), row] }).isPersisted.promise
  }
  const send = (initial: Request) => {
    if (disposed || ctx.isDisposed?.() || active.has(initial.id) || identity()?.state !== "signed-in" || identity()?.login !== initial.owner || ["completed", "failed"].includes(initial.state)) return
    const abort = new AbortController(), epoch = identity()?.ownerRevision ?? identity()?.revision
    active.set(initial.id, abort)
    epochs.set(initial.id, epoch)
    const current = () => !disposed && !ctx.isDisposed?.() && !abort.signal.aborted && identity()?.state === "signed-in" && identity()?.login === initial.owner && (identity()?.ownerRevision ?? identity()?.revision) === epoch
    const title = initial.operation === "fork" ? "Fork" : "Add to stack"
    const work = async (): Promise<void | string> => {
      let row = initial
      try {
        if (row.state === "requested") {
          const { branch, ...add } = row.input
          const path = row.operation === "fork" ? "/api/branches" : `/api/branches/${encodeURIComponent(String(branch))}/add-to-stack`
          const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}${path}`, { method: "POST", credentials: "same-origin", signal: abort.signal,
            headers: { "Content-Type": "application/json", "Idempotency-Key": row.id }, body: JSON.stringify(row.operation === "fork" ? row.input : add) })
          const body = await response.json().catch(() => undefined) as { name?: string; state?: string; n?: number; message?: string } | undefined
          if (!current()) return
          if (!response.ok) throw new BranchRequestFailure({ sentence: body?.message ?? "Branch unavailable" })
          if (row.operation === "add") {
            if (response.status !== 202 || !Number.isInteger(body?.n) || body!.n! < 1) throw new BranchRequestFailure({ sentence: "Branch unavailable" })
            await save({ ...row, state: "completed", n: body!.n }); return
          }
          if (response.status !== 201 || typeof body?.name !== "string") throw new BranchRequestFailure({ sentence: "Branch unavailable" })
          row = { ...row, branch: body.name, state: "provisioning" }
          await save(row)
        }
        while (current()) {
          const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/branches/${encodeURIComponent(row.branch!)}`, { credentials: "same-origin", signal: abort.signal })
          const body = await response.json().catch(() => undefined) as { state?: string; message?: string } | undefined
          if (!current()) return
          if (!response.ok || body?.state === "failed" || body?.state === "closed") throw new BranchRequestFailure({ sentence: body?.message ?? "Branch unavailable" })
          if (body?.state === "awake" || body?.state === "asleep") { await save({ ...row, state: "completed" }); return }
          if (body?.state !== "provisioning" && body?.state !== "waking") throw new BranchRequestFailure({ sentence: "Branch unavailable" })
          await new Promise<void>(resolve => {
            const timer = setTimeout(done, 300)
            function done() { clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve() }
            abort.signal.addEventListener("abort", done, { once: true })
          })
        }
      } catch (error) {
        if (!current()) return
        // A thrown request reads as unavailable; its text goes to the reporter, never the toast.
        if (!(error instanceof BranchRequestFailure)) ctx.report?.("branch.request", error)
        const message = error instanceof BranchRequestFailure ? error.sentence : "Branch unavailable"
        await save({ ...row, state: "failed", error: message })
        ctx.resolveToast?.(row.id, { status: "failed", detail: message, action: { label: "Retry", flow: row.operation === "fork" ? "branch.fork" : "branch.add-to-stack", args: JSON.stringify(row.input) } })
        return message
      }
    }
    void (ctx.withToast ? ctx.withToast(initial.id, title, title, work, false, current) : work())
      .catch(error => ctx.report?.("branch.request", error)).finally(() => { if (active.get(initial.id) === abort) { active.delete(initial.id); epochs.delete(initial.id); const pending = rows().find(row => row.id === initial.id); if (pending?.state === "requested") send(pending) } })
  }
  const request = async (operation: Request["operation"], input: Record<string, unknown>) => {
    const user = identity()
    if (disposed || user?.state !== "signed-in" || !user.login) return "Sign in to reach this repository."
    const prior = rows().find(row => row.owner === user.login && row.operation === operation && JSON.stringify(canonicalEventValue(row.input)) === JSON.stringify(canonicalEventValue(input)))
    const row: Request = prior?.state === "failed" ? { ...prior, state: "requested", error: undefined } : prior ?? { id: randomUuid(), owner: user.login, operation, input, state: "requested" }
    await save(row)
    send(row)
    return { value: "Requested" }
  }
  const resume = () => {
    for (const [id, abort] of active) if (rows().find(row => row.id === id)?.owner !== identity()?.login || identity()?.state !== "signed-in" || epochs.get(id) !== (identity()?.ownerRevision ?? identity()?.revision)) { abort.abort(); active.delete(id) }
    for (const row of rows()) send(row)
  }
  const dispose = () => { disposed = true; for (const abort of active.values()) abort.abort(); active.clear() }
  return { request, resume, dispose }
}
