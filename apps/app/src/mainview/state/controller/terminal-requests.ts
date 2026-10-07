import type { ControllerContext } from "./context"
import { randomUuid } from "../../runtime/RandomUuid"
import type { Session } from "../AppState"
import { actorSharedState } from "../ActorBindings"

type Request = NonNullable<Session["terminalRequests"]>[number]

export function createTerminalRequests(ctx: ControllerContext, options: {
  repo: () => string
  observe: (branch: string) => void
  open: (id: string) => Promise<void>
  available?: (id: string) => boolean
  ready: (repo: string, id: string, signal: AbortSignal) => Promise<void>
}) {
  const running = actorSharedState(ctx, "terminalRequests", () => new Set<string>())
  const lifetime = new AbortController()
  ctx.onDispose(() => lifetime.abort())
  const owner = () => {
    const identity = ctx.store.collections.identitySessions.get("identity")
    return identity?.state === "signed-in" ? identity.login : undefined
  }
  const save = (request: Request, actor: "user" | "smithers" | "system" = "system") => ctx.store.dispatch({
    type: "terminal.requests.changed", actor,
    requests: [...(ctx.store.session().terminalRequests ?? []).filter(row => row.id !== request.id), request]
  }).isPersisted.promise
  const sleep = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Terminal request ended")); return }
    const end = () => { clearTimeout(timer); reject(new Error("Terminal request ended")) }
    const timer = setTimeout(() => { signal.removeEventListener("abort", end); resolve() }, ctx.workflowPollMs)
    signal.addEventListener("abort", end, { once: true })
  })
  const send = (initial: Request) => {
    if (running.has(initial.id) || ctx.disposed || owner() !== initial.owner) return
    running.add(initial.id)
    const requestLifetime = new AbortController()
    const abort = () => requestLifetime.abort()
    const accountUnsubscribe = ctx.onAccountChange(abort)
    lifetime.signal.addEventListener("abort", abort, { once: true })
    const epoch = ctx.accountEpoch
    const current = () => !ctx.disposed && epoch === ctx.accountEpoch && owner() === initial.owner
    void ctx.withToast(`terminal.${initial.id}`, "Opening terminal…", "Terminal opened", async () => {
      let request = initial
      let acknowledged = Boolean(initial.session)
      let terminalFailed = false
      try {
        if (!request.session) {
          const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/terminals`, {
            method: "POST", credentials: "same-origin", signal: requestLifetime.signal,
            headers: { "Content-Type": "application/json", "Idempotency-Key": request.id },
            body: JSON.stringify({ branch: request.branch })
          })
          if (!response.ok) {
            acknowledged = response.status >= 400 && response.status < 500
            throw new Error(await ctx.errorMessageOf(response, "Terminal unavailable"))
          }
          const receipt: unknown = await response.json()
          if (!receipt || typeof receipt !== "object" || !("id" in receipt) || typeof receipt.id !== "string"
              || !("workspace_id" in receipt) || typeof receipt.workspace_id !== "string") throw new Error("Terminal unavailable")
          acknowledged = true
          if (!current()) return
          request = { ...request, session: receipt.id, branchId: receipt.workspace_id, state: "running" }
          await save(request)
        }
        while (current()) {
          const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/repos/${request.repo.split("/").map(encodeURIComponent).join("/")}/workspace/sessions/${encodeURIComponent(request.session!)}`, { credentials: "same-origin", signal: requestLifetime.signal })
          if (!response.ok) throw new Error(await ctx.errorMessageOf(response, "Terminal unavailable"))
          const receipt: unknown = await response.json()
          if (!current()) return
          if (!receipt || typeof receipt !== "object" || !("status" in receipt)) throw new Error("Terminal unavailable")
          if (receipt.status === "running") break
          if (receipt.status === "failed" || receipt.status === "closed" || receipt.status === "stopped") { terminalFailed = true; throw new Error("Terminal unavailable") }
          await sleep(requestLifetime.signal)
        }
        if (!current()) return
        options.observe(request.branchId!)
        const metadataDeadline = Date.now() + 30_000
        while (current() && options.available && !options.available(request.session!)) {
          if (Date.now() >= metadataDeadline) throw new Error("Terminal unavailable")
          await sleep(requestLifetime.signal)
        }
        if (!current()) return
        await options.open(request.session!)
        // A WebSocket upgrade follows the real broker spawn, not VM launch.
        await options.ready(request.repo, request.session!, requestLifetime.signal)
        if (!current()) return
        await save({ ...request, state: "completed" })
      } catch (error) {
        if (!current()) return
        const message = error instanceof Error ? error.message : "Terminal unavailable"
        await save({ ...request, state: "failed", error: message, uncertain: !acknowledged || (Boolean(request.session) && !terminalFailed) })
        return message
      }
    }, false, current).catch(error => ctx.failures.report("seam.failure", error, "terminal.open"))
       .finally(() => {
        accountUnsubscribe()
        lifetime.signal.removeEventListener("abort", abort)
        running.delete(initial.id)
        queueMicrotask(resume)
      })
  }
  const resume = () => { void (ctx.store.settled?.() ?? Promise.resolve()).then(() => {
    for (const request of ctx.store.session().terminalRequests ?? []) if (request.state === "requested" || request.state === "running") send(request)
  }).catch(error => ctx.failures.report("seam.failure", error, "terminal.recover")) }
  const identities = ctx.store.collections.identitySessions.subscribeChanges(resume)
  const sessions = ctx.store.collections.sessions.subscribeChanges(resume)
  ctx.onDispose(() => { identities.unsubscribe(); sessions.unsubscribe() })
  queueMicrotask(resume)
  return { openTerminal: async (branch: string) => {
    const login = owner(), repo = options.repo()
    if (!login || !repo || !branch.trim()) return "Terminal unavailable"
    const prior = (ctx.store.session().terminalRequests ?? []).find(row => row.owner === login && row.repo === repo && row.branch === branch.trim() && (row.state === "requested" || row.state === "running" || (row.state === "failed" && row.uncertain)))
    const request: Request = prior ? { ...prior, state: prior.state === "failed" ? "requested" : prior.state, error: undefined, uncertain: undefined } : { id: randomUuid(), owner: login, repo, branch: branch.trim(), state: "requested" }
    await save(request, ctx.commandActor)
    send(request)
    return { value: "Requested" }
  } }
}
