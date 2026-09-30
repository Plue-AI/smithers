import { publicRepoActivityPath } from "@smthrs/rpc/AgentApiRoutes"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { ServerConfig } from "./Config"
import { EdgeCache } from "./githubApp"
import { discardBody, readJsonOrUndefined, readText, Transport } from "./Http"
import { AVAILABLE_REPOS, cloudRepoFor } from "./publicRepoCatalog"
import { readPublicRepository } from "./publicRepositoryReads"

/*
 * GET /api/public/repos/<owner>/<name>/activity: one sentence about the last
 * seven days of a catalog repository, computed from the Smithers Cloud mirror
 * the anonymous public reads already use. The Worker never calls GitHub and
 * carries no credential; every count comes from the mirror's own feeds, and a
 * feed the mirror cannot answer becomes an honest "not available" clause, never
 * a zero.
 */

export interface PublicRepoActivity {
  readonly sentence: string
  /** A null count is one the mirror could not answer; the sentence says so. */
  readonly counts: {
    readonly commits: number | null
    readonly pullRequests: number | null
    readonly issues: number | null
  }
  /** The window's start, ISO 8601. */
  readonly since: string
}

export const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** The mirror's page ceiling. */
const PAGE_SIZE = 100
/** Bounds upstream traffic on a cache miss; a window that outruns the bound is reported as unavailable. */
const MAX_COMMIT_PAGES = 20
const MAX_LIST_PAGES = 5

/** The cache TTL in seconds: a complete answer, or a short retry when a feed could not be counted. */
const FULL_TTL = 300
const RETRY_TTL = 30

const headers = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "x-content-type-options": "nosniff"
}

/** `owner/name` when the path is the activity route, else undefined. */
export const parsePublicRepoActivityPath = (pathname: string): string | undefined => {
  const match = /^\/api\/public\/repos\/([a-z\d][a-z\d-]{0,38})\/([a-z\d_.-]{1,100})\/activity\/?$/i.exec(pathname)
  if (match === null || match[2] === "." || match[2] === "..") return undefined
  return `${match[1]}/${match[2]}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const parseTime = (value: unknown): number | null => {
  if (typeof value !== "string") return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

/** The cursor of the mirror's `rel="next"` link, or undefined when the feed is exhausted. */
const nextCursor = (response: Response): string | undefined => {
  const link = response.headers.get("link") ?? ""
  const next = /<([^>]+)>\s*;\s*rel="next"/.exec(link)?.[1]
  if (next === undefined) return undefined
  const cursor = new URL(next, "https://cursor.invalid").searchParams.get("cursor")
  return cursor === null || cursor === "" ? undefined : cursor
}

interface Change {
  readonly changeId: string
  readonly commitId: string
  readonly timestamp: number
  readonly parents: ReadonlyArray<string>
}

const parseChange = (value: unknown): Change | null => {
  if (!isRecord(value) || typeof value.change_id !== "string" || typeof value.commit_id !== "string") return null
  const timestamp = parseTime(value.timestamp)
  if (timestamp === null) return null
  const parents = Array.isArray(value.parent_change_ids)
    ? value.parent_change_ids.filter((id): id is string => typeof id === "string")
    : []
  return { changeId: value.change_id, commitId: value.commit_id, timestamp, parents }
}

const pluralize = (count: number, noun: string, verb: { one: string; many: string }): string =>
  count === 0
    ? `no ${noun}s ${verb.many}`
    : count === 1
    ? `1 ${noun} ${verb.one}`
    : `${count} ${noun}s ${verb.many}`

const joinClauses = (clauses: ReadonlyArray<string>): string =>
  clauses.length <= 1
    ? clauses.join("")
    : clauses.length === 2
    ? `${clauses[0]} and ${clauses[1]}`
    : `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`

/**
 * The deterministic sentence for a set of counts. A null count drops out of
 * the main sentence and is named in its own honest sentence after it.
 */
export const activitySentence = (counts: PublicRepoActivity["counts"], bookmark: string | null): string => {
  const clauses: Array<string> = []
  const missing: Array<string> = []
  if (counts.commits === null) missing.push("Commit activity is not available.")
  else clauses.push(pluralize(counts.commits, "commit", { one: `landed on ${bookmark ?? "the default bookmark"}`, many: `landed on ${bookmark ?? "the default bookmark"}` }))
  if (counts.pullRequests === null) missing.push("Pull request activity is not available.")
  else clauses.push(pluralize(counts.pullRequests, "pull request", { one: "was opened", many: "were opened" }))
  if (counts.issues === null) missing.push("Issue activity is not available.")
  else clauses.push(pluralize(counts.issues, "issue", { one: "was filed", many: "were filed" }))
  if (clauses.length === 0) return "Recent activity is not available."
  return [`In the last 7 days, ${joinClauses(clauses)}.`, ...missing].join(" ")
}

interface Document {
  readonly body: unknown
  readonly response: Response
}

/** One mirror document, parsed, or null when the mirror could not answer it. */
const document = (appPath: string, origin: string, base: string): Effect.Effect<Document | null, never, Transport> =>
  Effect.gen(function*() {
    const response = yield* readPublicRepository(new URL(appPath, origin), base)
    if (!response.ok) {
      yield* discardBody(response)
      return null
    }
    const body = yield* readJsonOrUndefined(response)
    return body === undefined ? null : { body, response }
  })

const paged = (appPath: string, cursor: string | undefined): string =>
  `${appPath}?limit=${PAGE_SIZE}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`

/** Counts `created_at` within the window across a keyset-paginated array feed. */
const countCreated = (appPath: string, origin: string, base: string, since: number): Effect.Effect<number | null, never, Transport> =>
  Effect.gen(function*() {
    let count = 0
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const answer = yield* document(paged(appPath, cursor), origin, base)
      if (answer === null || !Array.isArray(answer.body)) return null
      let oldestInWindow = true
      for (const item of answer.body) {
        const created = isRecord(item) ? parseTime(item.created_at) : null
        if (created === null) return null
        if (created >= since) count++
        else oldestInWindow = false
      }
      cursor = nextCursor(answer.response)
      if (cursor === undefined || !oldestInWindow || answer.body.length < PAGE_SIZE) return count
    }
    // The window holds more than the bound reads; a partial count would be a lie.
    return null
  })

interface CommitCount {
  readonly count: number | null
  readonly bookmark: string | null
}

/**
 * The count of changes reachable from `head` made inside the window, or null
 * while that ancestry is not yet fully loaded. A change's timestamp is its
 * author's, which Git ancestry does not order, so no old page proves the
 * rest of the ancestry is old: only a walk that reaches every ancestor (or
 * the end of the feed) is complete.
 */
const ancestryCount = (
  head: Change,
  byChange: ReadonlyMap<string, Change>,
  since: number,
  exhausted: boolean
): number | null => {
  let count = 0
  const seen = new Set<string>()
  const queue: Array<Change> = [head]
  while (queue.length > 0) {
    const change = queue.pop()!
    if (seen.has(change.changeId)) continue
    seen.add(change.changeId)
    if (change.timestamp >= since) count++
    for (const parent of change.parents) {
      const next = byChange.get(parent)
      if (next !== undefined) queue.push(next)
      // An ancestor the feed has not reached yet may be inside the window.
      else if (!exhausted) return null
    }
  }
  return count
}

/**
 * Commits reachable from the default bookmark's head that were made inside
 * the window. The mirror's change feed is every visible change in jj index
 * order (children before parents); pages are read until the bookmark's whole
 * ancestry is loaded or the feed ends. An ancestry the bound cannot load is
 * unavailable, never a partial count.
 */
const countCommits = (repo: string, origin: string, base: string, since: number): Effect.Effect<CommitCount, never, Transport> =>
  Effect.gen(function*() {
    const [root, refs] = yield* Effect.all([
      document(`/api/repos/${repo}`, origin, base),
      document(`/api/repos/${repo}/git/refs`, origin, base)
    ], { concurrency: "unbounded" })
    const bookmark = root !== null && isRecord(root.body) && typeof root.body.default_bookmark === "string" && root.body.default_bookmark !== ""
      ? root.body.default_bookmark
      : null
    if (bookmark === null || refs === null || !Array.isArray(refs.body)) return { count: null, bookmark }
    const ref = refs.body.find((entry) => isRecord(entry) && entry.ref === `refs/heads/${bookmark}`)
    const sha = ref !== undefined && isRecord(ref) && isRecord(ref.object) && typeof ref.object.sha === "string" ? ref.object.sha : null
    if (sha === null) return { count: null, bookmark }

    const byChange = new Map<string, Change>()
    let head: Change | undefined
    let cursor: string | undefined
    for (let page = 0; page < MAX_COMMIT_PAGES; page++) {
      const answer = yield* document(paged(`/api/repos/${repo}/changes`, cursor), origin, base)
      if (answer === null || !isRecord(answer.body) || !Array.isArray(answer.body.items)) return { count: null, bookmark }
      for (const item of answer.body.items) {
        const change = parseChange(item)
        if (change === null) return { count: null, bookmark }
        byChange.set(change.changeId, change)
        if (change.commitId === sha) head = change
      }
      cursor = nextCursor(answer.response)
      const exhausted = cursor === undefined
      // A head the whole feed never lists cannot be counted.
      if (head === undefined) {
        if (exhausted) return { count: null, bookmark }
        continue
      }
      const count = ancestryCount(head, byChange, since, exhausted)
      if (count !== null) return { count, bookmark }
    }
    // The ancestry outruns the bound; a partial count would be a lie.
    return { count: null, bookmark }
  })

/** The three feeds, read concurrently, as one sentence. */
const compute = (repo: string, origin: string, base: string): Effect.Effect<PublicRepoActivity, never, Transport> =>
  Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    const since = now - ACTIVITY_WINDOW_MS
    const [commits, pullRequests, issues] = yield* Effect.all([
      countCommits(repo, origin, base, since),
      countCreated(`/api/repos/${repo}/landings`, origin, base, since),
      countCreated(`/api/repos/${repo}/issues`, origin, base, since)
    ], { concurrency: "unbounded" })
    const counts = { commits: commits.count, pullRequests, issues }
    return { sentence: activitySentence(counts, commits.bookmark), counts, since: new Date(since).toISOString() }
  })

interface Snapshot {
  readonly body: string
  readonly expiresAt: number
}

export type PublicRepoActivityHandler = (
  request: Request
) => Effect.Effect<Response, never, Transport | ServerConfig | EdgeCache>

/**
 * An activity handler with its own completed per-repository snapshots:
 * the isolate's copy. `handlePublicRepoActivity` is the deployed one; a
 * test builds its own to play two isolates over one edge cache. The Cloud
 * origin the mirror is read from is `ServerConfig.cloudApiBaseUrl`.
 */
export const makePublicRepoActivityHandler = (): PublicRepoActivityHandler => {
  const snapshots = Ref.makeUnsafe(new Map<string, Snapshot>())

  const snapshotOf = (repo: string) => Effect.map(Ref.get(snapshots), (all) => all.get(repo))

  const remember = (repo: string, snapshot: Snapshot) =>
    Ref.update(snapshots, (all) => new Map(all).set(repo, snapshot))

  const refresh = (repo: string, cacheKey: string, base: string): Effect.Effect<Snapshot, never, Transport | EdgeCache> =>
    Effect.gen(function*() {
      const edge = yield* EdgeCache
      const cached = yield* edge.match(cacheKey)
      if (cached !== undefined) {
        const now = yield* Clock.currentTimeMillis
        const ttl = Math.max(0, Number(cached.headers.get("x-activity-expires")) - now) / 1000
        if (ttl > 0) {
          const body = yield* readText(cached).pipe(Effect.orElseSucceed(() => undefined))
          if (body !== undefined) {
            const next = { body, expiresAt: now + ttl * 1000 }
            yield* remember(repo, next)
            return next
          }
        }
      }
      const activity = yield* compute(repo, cacheKey, base)
      // A count the mirror could not answer is retried sooner than a complete answer is kept.
      const ttl = Object.values(activity.counts).every((count) => count !== null) ? FULL_TTL : RETRY_TTL
      const now = yield* Clock.currentTimeMillis
      const snapshot: Snapshot = { body: JSON.stringify(activity), expiresAt: now + ttl * 1000 }
      yield* remember(repo, snapshot)
      yield* edge.put(cacheKey, new Response(snapshot.body, {
        headers: { ...headers, "cache-control": `public, max-age=${ttl}`, "x-activity-expires": String(snapshot.expiresAt) }
      }))
      return snapshot
    })

  return (request) =>
    Effect.gen(function*() {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers })
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(JSON.stringify({ status: "error", code: "method_not_allowed", message: "Method not allowed." }), {
          status: 405, headers: { ...headers, allow: "GET, HEAD, OPTIONS" }
        })
      }
      const name = parsePublicRepoActivityPath(new URL(request.url).pathname)
      if (name === undefined || cloudRepoFor(name) === undefined) {
        return new Response(
          JSON.stringify({ status: "error", code: "route_not_found", message: "Repository is not in the public catalog." }),
          { status: 404, headers }
        )
      }
      // The catalog's spelling is the cache key, so a mixed-case request shares the answer.
      const repo = AVAILABLE_REPOS.find((entry) => entry.name.toLowerCase() === name.toLowerCase())!.name
      let current = yield* snapshotOf(repo)
      if (current === undefined || current.expiresAt <= (yield* Clock.currentTimeMillis)) {
        const config = yield* ServerConfig
        // Query strings and visitor headers never change the public cache key.
        const key = new URL(publicRepoActivityPath(repo), request.url).href
        // Only completed snapshots cross requests. Waiting on another request's
        // pending fiber leaves workerd with no owned event and produces a 500.
        current = yield* refresh(repo, key, config.cloudApiBaseUrl)
      }
      const now = yield* Clock.currentTimeMillis
      return new Response(request.method === "HEAD" ? null : current.body, {
        headers: { ...headers, "cache-control": `public, max-age=${Math.max(0, Math.ceil((current.expiresAt - now) / 1000))}` }
      })
    })
}

/** The deployed activity route: one set of snapshots per isolate. */
export const handlePublicRepoActivity: PublicRepoActivityHandler = makePublicRepoActivityHandler()
