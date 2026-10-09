import { z } from "zod"
import type { ControllerContext } from "./context"
import { randomUuid } from "../../runtime/RandomUuid"
import type { Session } from "../AppState"
import { actorSharedState } from "../ActorBindings"
import { TerminalUnavailable } from "../CloudTerminalClient"

type Request = NonNullable<Session["terminalRequests"]>[number]

/*
 * The durable receipt of `POST /api/terminals` (docs/api/openapi/terminals.yaml).
 * An owner terminal has no workspace session row: the same request, sent again
 * with its Idempotency-Key, answers with the receipt's current status.
 */
const Receipt = z.object({ id: z.string().min(1), workspace_id: z.string().min(1), status: z.enum(["pending", "running", "failed", "closed"]) })
/* Status reads share the server's terminal-open budget (20 per minute) with socket upgrades. */
const MAX_STATUS_MS = 15_000

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
  const sleep = (signal: AbortSignal, ms = ctx.workflowPollMs) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new TerminalUnavailable({ sentence: "Terminal request ended" })); return }
    const end = () => { clearTimeout(timer); reject(new TerminalUnavailable({ sentence: "Terminal request ended" })) }
    const timer = setTimeout(() => { signal.removeEventListener("abort", end); resolve() }, ms)
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
        let wait = ctx.workflowPollMs
        while (current()) {
          const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/terminals`, {
            method: "POST", credentials: "same-origin", signal: requestLifetime.signal,
            headers: { "Content-Type": "application/json", "Idempotency-Key": request.id },
            body: JSON.stringify({ branch: request.branch })
          })
          if (!response.ok) {
            acknowledged ||= response.status >= 400 && response.status < 500
            throw new TerminalUnavailable({ sentence: await ctx.errorMessageOf(response, "Terminal unavailable") })
          }
          const receipt = Receipt.safeParse(await response.json())
          if (!receipt.success) throw new TerminalUnavailable({ sentence: "Terminal unavailable" })
          acknowledged = true
          // A receipt for another session means the server lost this request: retrying it can never settle.
          if (request.session !== undefined && receipt.data.id !== request.session) { terminalFailed = true; throw new TerminalUnavailable({ sentence: "Terminal unavailable" }) }
          if (!current()) return
          if (request.session === undefined) {
            request = { ...request, session: receipt.data.id, branchId: receipt.data.workspace_id, state: "running" }
            await save(request)
          }
          if (receipt.data.status === "running") break
          if (receipt.data.status === "failed" || receipt.data.status === "closed") { terminalFailed = true; throw new TerminalUnavailable({ sentence: "Terminal unavailable" }) }
          await sleep(requestLifetime.signal, wait)
          wait = Math.min(wait * 2, MAX_STATUS_MS)
        }
        if (!current()) return
        options.observe(request.branchId!)
        const metadataDeadline = Date.now() + 30_000
        while (current() && options.available && !options.available(request.session!)) {
          if (Date.now() >= metadataDeadline) throw new TerminalUnavailable({ sentence: "Terminal unavailable" })
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
        // A thrown request (offline, a reset) reads as unavailable; its text goes to the reporter, never the card.
        if (!(error instanceof TerminalUnavailable)) ctx.failures.report("seam.failure", error, "terminal.open")
        const message = error instanceof TerminalUnavailable ? error.sentence : "Terminal unavailable"
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
