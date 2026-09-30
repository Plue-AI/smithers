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
 */
import { createCloudClient } from "./CloudClient"
import type { SandboxEgressRow } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "./SeamContext"

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
}

export const createEgressSeam = (ctx: SeamContext): EgressSeam => {
  const gate = (): string | void => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return refuseCloudSignIn(ctx)
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

  return { listSessionEgress }
}
