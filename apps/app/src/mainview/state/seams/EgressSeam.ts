import { refuseCloudSignIn } from "./CloudSignIn"
/*
 * The sandbox egress audit (lane L3): what a cloud computer called, and with
 * which secret NAMES the per-sandbox egress proxy swapped in. Two routes, one
 * shape — plue serves both from `serveSandboxEgressAudit`
 * (internal/routes/sandbox_egress_audit.go):
 *
 *   GET /api/repos/{o}/{r}/workspaces/{id}/egress?limit=&cursor=
 *   GET /api/repos/{o}/{r}/agent-sessions/{id}/egress?limit=&cursor=
 *
 * The body is a bare JSON array of
 * `{ occurred_at, host, method, path, status, allowed, swapped_secret_names[] }`
 * (services.SandboxEgressAuditEntry) and the next page is the `rel="next"`
 * link's opaque `cursor` — a base64 keyset position, never an offset. plue
 * caps `limit` at 100 and defaults it to 30.
 *
 * A secret VALUE is never on the wire and never rendered: the audit names
 * which binding was substituted, which is the whole point of the boundary.
 *
 * A blocked call's host can be allowed (#2653): the repository owner's
 * `PATCH /api/repos/{o}/{r}/egress-policy` allowlist, which every running
 * sandbox of the repository reloads without a restart.
 */
import type { Actor, SandboxEgressRow, Session } from "../AppState"
import { browserWriteRefusal, LOST_ACT_COPY } from "../BrowserWriteFailure"
import type { FailureController } from "../controller/failures"
import { TOAST_SUPERSEDED } from "../controller/failures"
import { resolveTargetRepo } from "../RepoContext"
import { createCloudClient } from "./CloudClient"
import type { SeamContext } from "./SeamContext"
import { captureCloudOwner } from "./SeamContext"

export const DEGRADED_EGRESS_REFUSAL =
  "This Smithers Cloud sign-in can't read the egress audit — sign in again to enable it."

/** plue's own default page size for the audit (routes/pagination.go parsePagination). */
export const EGRESS_PAGE_LIMIT = 30

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** One audit row off the wire; a row missing a fact it would have to state drops. */
export const parseEgressRow = (value: unknown): SandboxEgressRow | null => {
  if (!isRecord(value)) return null
  const { occurred_at: occurredAt, host, method, path, status, allowed } = value
  if (typeof occurredAt !== "string" || occurredAt === "") return null
  if (typeof host !== "string" || host === "") return null
  if (typeof method !== "string" || method === "") return null
  if (typeof path !== "string") return null
  if (typeof status !== "number" || !Number.isInteger(status)) return null
  if (typeof allowed !== "boolean") return null
  const names = value.swapped_secret_names
  return {
    occurredAt,
    host,
    method,
    path,
    status,
    allowed,
    /*
     * plue writes `[]` when the proxy swapped nothing; a null or a missing
     * field says the same thing — no binding was substituted. A non-string
     * entry is dropped rather than stringified.
     */
    swappedSecretNames: Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : []
  }
}

/**
 * The opaque cursor of a Link header's `rel="next"`, or null on the last page.
 * plue writes the full upstream URL (`/api/…`), so a link that leaves the
 * route it paginates is refused rather than followed.
 */
export const nextEgressCursor = (link: string | null, path: string): string | null => {
  if (link === null) return null
  // The seam's paths omit the `/api` the local proxy adds; plue's links carry it.
  const upstreamPath = `/api${path}`
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim())
    if (match === null || match[1] === undefined) continue
    let next: URL
    try {
      next = new URL(match[1], "https://cloud.invalid")
    } catch {
      return null
    }
    if (next.pathname !== upstreamPath) return null
    const cursor = next.searchParams.get("cursor")
    return cursor === null || cursor === "" ? null : cursor
  }
  return null
}

export interface EgressPage {
  readonly rows: ReadonlyArray<SandboxEgressRow>
  /** plue's next keyset position, or null when the audit is exhausted. */
  readonly nextCursor: string | null
}

/**
 * One page of an egress audit route. `path` is the seam path without `/api`
 * (`/repos/o/r/workspaces/ws-1/egress`); `cursor` continues an earlier page.
 * An error is the server's own message, verbatim.
 */
export const loadEgressPage = async (
  ctx: SeamContext,
  path: string,
  cursor?: string | null
): Promise<EgressPage | { readonly error: string }> => {
  const query = `?limit=${EGRESS_PAGE_LIMIT}${
    cursor === undefined || cursor === null || cursor === "" ? "" : `&cursor=${encodeURIComponent(cursor)}`
  }`
  const answer = await createCloudClient(ctx).get(`${path}${query}`, "the egress audit")
  if ("error" in answer) return { error: answer.error }
  const { body, response } = answer
  if (!Array.isArray(body)) {
    return { error: "Smithers Cloud answered an egress audit payload in a shape Smithers can't read." }
  }
  const raw = body
  const rows = raw.flatMap((entry) => {
    const parsed = parseEgressRow(entry)
    return parsed === null ? [] : [parsed]
  })
  /*
   * Rows Smithers could not read are not an empty audit: saying "nothing
   * called out" about a page that DID carry calls is the one lie this facet
   * must never tell.
   */
  if (raw.length > 0 && rows.length === 0) {
    return {
      error: `Smithers Cloud answered ${raw.length} egress row${
        raw.length === 1 ? "" : "s"
      } in a shape Smithers can't read.`
    }
  }
  return { rows, nextCursor: nextEgressCursor(response.headers.get("link"), path) }
}

/** The seam path of one workspace's audit. */
export const workspaceEgressPath = (repoId: string, workspaceId: string): string => {
  const [owner = "", name = ""] = repoId.split("/")
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/workspaces/${
    encodeURIComponent(workspaceId)
  }/egress`
}

/** The seam path of one agent session's audit. */
export const agentSessionEgressPath = (repoId: string, sessionId: string): string => {
  const [owner = "", name = ""] = repoId.split("/")
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/agent-sessions/${
    encodeURIComponent(sessionId)
  }/egress`
}

/** The seam path of a repository's egress allowlist. */
export const egressPolicyPath = (repoId: string): string => {
  const [owner = "", name = ""] = repoId.split("/")
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/egress-policy`
}

/** A host as plue stores it: trimmed, lower-case, without a trailing dot. */
export const egressHost = (value: string): string => value.trim().toLowerCase().replace(/\.$/, "")

/** The allowlist off the wire, or null when the answer is not one. */
export const parseAllowDomains = (body: unknown): ReadonlyArray<string> | null => {
  if (!isRecord(body) || !Array.isArray(body.allow_domains)) return null
  const domains = body.allow_domains
  return domains.every((domain): domain is string => typeof domain === "string") ? domains : null
}

/** How many running sandboxes a written allowlist did not reach; an answer without reloads reached none that ran. */
export const staleReloads = (body: unknown): number =>
  isRecord(body) && Array.isArray(body.reloads)
    ? body.reloads.filter((reload) => !isRecord(reload) || reload.reloaded !== true).length
    : 0

export const UNREADABLE_ALLOWLIST = "Smithers Cloud answered an egress allowlist in a shape Smithers can't read."

/** One audit row as a transcript line: the call, and the secret names, never a value. */
export const egressLine = (row: SandboxEgressRow): string =>
  `${row.occurredAt} · ${row.method} ${row.host}${row.path} · ${row.status} · ${row.allowed ? "allowed" : "blocked"}${
    row.swappedSecretNames.length === 0 ? "" : ` · secrets ${row.swappedSecretNames.join(", ")}`
  }`

export interface EgressSeam {
  /**
   * `egress.session <sessionId> [owner/repo]`: one agent session's audit as a
   * transcript listing. The app has no agent-session card to hang a facet on
   * (see docs/workbench-lanes/L3-workspace-card.REPORT.md), so the route
   * answers where every other list act answers.
   */
  readonly listSessionEgress: (
    sessionId: string,
    repo?: string,
    cursor?: string
  ) => Promise<string | void | { readonly value: string }>
  /**
   * `egress.allow <host> [owner/repo]`: add a host to the repository's egress
   * allowlist. Acknowledged at once; the write runs in the background under
   * the shared toast, which settles with the write.
   */
  readonly allowEgressHost: (host: string, repo?: string) => Promise<string | { readonly value: string }>
  /** Reconnect only durable requests belonging to the currently authorized Cloud account. */
  readonly resumeEgressRequests: () => void
}

type EgressRequest = NonNullable<Session["egressRequests"]>[number]
type Flight = { readonly current: () => boolean; readonly admitted: Promise<true | string> }
/** User and agent seams over one store share admission and background work. */
const shared = new WeakMap<
  object,
  {
    readonly flights: Map<string, Flight>
    readonly queues: Map<string, { readonly current: () => boolean; readonly done: Promise<unknown> }>
    readonly restoring: Set<string>
  }
>()
const sharedFor = (store: object) => {
  let state = shared.get(store)
  if (state === undefined) shared.set(store, state = { flights: new Map(), queues: new Map(), restoring: new Set() })
  return state
}

export const createEgressSeam = (ctx: SeamContext, withToast: FailureController["withToast"]): EgressSeam => {
  const gate = (): string | void => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in" || !session.username) return refuseCloudSignIn(ctx)
    if (session.scopes === "degraded") return DEGRADED_EGRESS_REFUSAL
  }

  const listSessionEgress: EgressSeam["listSessionEgress"] = async (sessionId, repo, cursor) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    const page = await loadEgressPage(ctx, agentSessionEgressPath(target.repo, sessionId), cursor)
    if ("error" in page) return page.error
    const listing = page.rows.length === 0
      ? `Agent session ${sessionId} made no recorded calls.`
      : [
        ...page.rows.map((row) => egressLine(row)),
        ...(page.nextCursor === null
          ? []
          : [`Older calls remain — /egress.session ${sessionId} ${target.repo} ${page.nextCursor}`])
      ].join("\n")
    ctx.dispatch({ type: "message.appended", actor: "system", text: listing })
    return { value: listing }
  }

  const { flights, queues, restoring } = sharedFor(ctx.store)
  const requests = (): EgressRequest[] => ctx.store.session().egressRequests ?? []
  const save = async (row: EgressRequest, current: () => boolean, actor: Actor = "system"): Promise<boolean> => {
    if (!current()) return false
    const others = requests().filter((item) => item.id !== row.id)
    // Bound receipts, never work that has not settled yet.
    const terminal = new Set(
      others.filter((item) => item.state !== "requested").slice(row.state === "requested" ? -64 : -63).map((item) =>
        item.id
      )
    )
    await ctx.dispatch({
      type: "egress.requests.changed",
      actor,
      requests: [...others.filter((item) => item.state === "requested" || terminal.has(item.id)), row]
    }).isPersisted.promise
    return current()
  }
  const flightAt = (id: string): Flight | undefined => {
    const flight = flights.get(id)
    return flight?.current() ? flight : undefined
  }
  const release = (id: string, flight: Flight): void => {
    if (flights.get(id) === flight) flights.delete(id)
  }

  /*
   * Atomic additions preserve another writer's removals. Adding a listed host
   * again also reloads running sandboxes, so a failed reload remains retryable.
   * Work whose account has changed stops before it writes.
   */
  const allow = async (
    repo: string,
    host: string,
    current: () => boolean
  ): Promise<true | string | typeof TOAST_SUPERSEDED> => {
    if (!current()) return TOAST_SUPERSEDED
    const client = createCloudClient(ctx)
    const path = egressPolicyPath(repo)
    const write = await client.send("PATCH", path, { add: [host] }, "the egress allowlist")
    if (!current()) return TOAST_SUPERSEDED
    if ("error" in write) return write.error
    const domains = parseAllowDomains(write.body)
    if (domains === null || !domains.includes(host)) return UNREADABLE_ALLOWLIST
    const stale = staleReloads(write.body)
    return stale === 0
      ? true
      : `${host} allowed; ${stale} running ${stale === 1 ? "box gets" : "boxes get"} it on restart.`
  }

  const run = (row: EgressRequest, flight: Flight): void => {
    const queue = `${row.owner}:${row.repo}`
    const previous = queues.get(queue)
    const queued = (previous?.current() ? previous.done : Promise.resolve()).catch(() => undefined).then(async () => {
      if (await flight.admitted !== true || !flight.current()) return TOAST_SUPERSEDED
      try {
        const refusal = gate()
        const outcome = refusal ?? await allow(row.repo, row.host, flight.current)
        if (outcome === TOAST_SUPERSEDED) return outcome
        if (
          !await save({
            ...row,
            state: typeof outcome === "string" ? "failed" : "completed",
            ...(typeof outcome === "string" ? { error: outcome } : {})
          }, flight.current)
        ) return TOAST_SUPERSEDED
        return outcome
      } catch (error) {
        if (!flight.current()) return TOAST_SUPERSEDED
        ctx.report?.("egress.request", error)
        const detail = browserWriteRefusal(error)
        await save({ ...row, state: "failed", error: detail }, flight.current).catch(() => false)
        return detail
      }
    })
    const slot = { current: flight.current, done: queued }
    queues.set(queue, slot)
    // The notice spans the queue as well as the HTTP write, without delaying acknowledgment.
    void flight.admitted.then(async (admitted) => {
      if (admitted !== true) return
      await withToast(row.id, `Allowing ${row.host}…`, `${row.host} allowed`, () => queued, false, flight.current)
    }).finally(() => {
      release(row.id, flight)
      if (queues.get(queue) === slot) queues.delete(queue)
    }).catch((error) => ctx.report?.("egress.request", error))
  }
  const acknowledge = async (flight: Flight, value: string): Promise<string | { readonly value: string }> => {
    const admitted = await flight.admitted
    return admitted !== true ? admitted : flight.current() ? { value } : LOST_ACT_COPY.cancelled.sentence
  }
  const allowEgressHost: EgressSeam["allowEgressHost"] = async (raw, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    const host = egressHost(raw)
    if (host === "") return "Name a host to allow."
    const owner = ctx.store.collections.cloudSessions.get("cloud")!.username!
    const id = `egress-allow:${owner}:${target.repo}:${host}`
    const value = `Allowing ${host} for ${target.repo}.`
    const existing = flightAt(id)
    if (existing !== undefined) return acknowledge(existing, value)
    const current = captureCloudOwner(ctx)
    const saved = requests().find((row) => row.id === id && row.state === "requested")
    const row: EgressRequest = saved ?? { id, owner, repo: target.repo, host, state: "requested" }
    const actor = ctx.actor()
    const flight: Flight = {
      current,
      admitted: saved !== undefined ?
        Promise.resolve(true)
        : save(row, current, actor).then((ok) => ok ? true as const : LOST_ACT_COPY.cancelled.sentence).catch(
          browserWriteRefusal
        )
    }
    flights.set(id, flight)
    run(row, flight)
    return acknowledge(flight, value)
  }
  const resumeEgressRequests: EgressSeam["resumeEgressRequests"] = () => {
    const cloud = ctx.store.collections.cloudSessions.get("cloud")
    if (cloud?.state !== "signed-in" || !cloud.username || ctx.isDisposed?.()) return
    for (const row of requests().filter((item) => item.owner === cloud.username && !flightAt(item.id))) {
      const current = captureCloudOwner(ctx)
      const flight: Flight = { current, admitted: Promise.resolve(true) }
      if (row.state === "requested") {
        flights.set(row.id, flight)
        run(row, flight)
      } else {
        const notice = [...ctx.store.collections.toasts.values()].find((toast) => toast.key === row.id)
        if (
          !restoring.has(row.id) && (notice?.status === "running" || (row.state === "failed" && notice === undefined))
        ) {
          restoring.add(row.id)
          void withToast(
            row.id,
            `Allowing ${row.host}…`,
            `${row.host} allowed`,
            async () => row.state === "failed" ? row.error ?? UNREADABLE_ALLOWLIST : true,
            false,
            current
          )
            .finally(() => restoring.delete(row.id)).catch((error) => ctx.report?.("egress.request", error))
        }
      }
    }
  }

  return { listSessionEgress, allowEgressHost, resumeEgressRequests }
}
