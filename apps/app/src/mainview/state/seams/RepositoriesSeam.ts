/*
 * The repositories seam (lane piper step 2, ADR 0001 "Settled with the
 * backend"): the Smithers Cloud inventory behind the `/api/cloud/*` proxy.
 *
 *   GET /api/user/repos                  — owner (bare login), name, full_name,
 *                                          default_bookmark, NO head
 *   GET /api/user/orgs                   — once, to classify owners
 *   GET /api/repos/{owner}/{repo}/bookmarks — per repo, the default bookmark's
 *                                          { target_change_id, target_commit_id }
 *                                          out of the { items, next_cursor }
 *                                          envelope (fixtures/BookmarkWire.ts),
 *                                          following the cursor until the
 *                                          bookmark is found
 *   GET /api/user/workspaces             — the cloud working copies: plue's
 *                                          UserWorkspaceRow (fixtures/
 *                                          UserWorkspaceRow.ts); a 403 degraded
 *                                          token answers empty, honestly
 *
 * plue#445 adds `owner_type` and `default_bookmark_head { change_id,
 * commit_id }` to the repo row; the row is read so those fields REPLACE the
 * per-repo bookmarks call the moment they land. While a server predates it,
 * the per-repo calls run through a small worker pool (HEAD_LOOKUP_CONCURRENCY)
 * so a member of a few-hundred-repo org never opens a few hundred concurrent
 * requests through the proxy on every sign-in. Nothing is invented: a repo
 * whose head could not be read carries `head: null`, and a failed bookmarks
 * call is an absent answer, not a fact.
 */
import { Data } from "effect"
import { createCloudClient } from "./CloudClient"
import { captureCloudOwner } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

export interface RepositoriesSeam {
  /** Refresh the repositories collection and the cloud working copies. */
  readonly loadRepositories: () => Promise<string | void>
  readonly createRepository: (name: string) => Promise<{ readonly fullName: string } | string>
}

interface RepoWire {
  readonly id: string
  readonly org: string
  readonly name: string
  readonly ownerType: "user" | "org" | undefined
  readonly defaultBookmark: string | null
  readonly wireHead: { readonly changeId: string | null; readonly commitId: string | null } | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** How many per-repo bookmarks reads run at once while a server predates plue#445. */
const HEAD_LOOKUP_CONCURRENCY = 6
/** The page size asked of the bookmarks route (its default is 30, sorted `landing/…` before `main`). */
const BOOKMARK_PAGE_LIMIT = 100
/** The defensive bound against a cursor that never closes (BookmarksSeam's fetchAllBookmarks uses the same). */
const MAX_BOOKMARK_PAGES = 100
const MAX_INVENTORY_PAGES = 100

const str = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null

/** User lists use arrays; bookmarks use a cursor envelope. Accept legacy named lists too. */
export const arrayOf = (body: unknown, key: string): ReadonlyArray<unknown> => {
  if (Array.isArray(body)) return body
  if (isRecord(body) && Array.isArray(body[key])) return body[key]
  if (isRecord(body) && Array.isArray(body.items)) return body.items
  return []
}

const ownerLogin = (value: unknown): string | null => {
  if (typeof value === "string" && value !== "") return value
  if (isRecord(value) && typeof value.login === "string" && value.login !== "") return value.login
  return null
}

/** Organization inventories use name; older identity proxies used login. */
export const parseOrg = (value: unknown): string | null =>
  isRecord(value) ? str(value.name) ?? ownerLogin(value) : ownerLogin(value)

/** One repo row off the wire; malformed rows drop. */
export const parseRepo = (value: unknown): RepoWire | null => {
  if (!isRecord(value)) return null
  const fullName = typeof value.full_name === "string" ? value.full_name : null
  const org = ownerLogin(value.owner) ?? fullName?.split("/")[0] ?? null
  const name = typeof value.name === "string" && value.name !== "" ? value.name : fullName?.split("/")[1] ?? null
  if (org === null || name === null) return null
  const ownerType = value.owner_type === "Organization" || value.owner_type === "org"
    ? "org" as const
    : value.owner_type === "User" || value.owner_type === "user"
    ? "user" as const
    : undefined
  const wireHead = isRecord(value.default_bookmark_head)
    ? {
      changeId: typeof value.default_bookmark_head.change_id === "string" ? value.default_bookmark_head.change_id : null,
      commitId: typeof value.default_bookmark_head.commit_id === "string" ? value.default_bookmark_head.commit_id : null
    }
    : undefined
  return {
    id: fullName ?? `${org}/${name}`,
    org,
    name,
    ownerType,
    defaultBookmark: typeof value.default_bookmark === "string" && value.default_bookmark !== "" ? value.default_bookmark : null,
    wireHead
  }
}

/**
 * One page of the bookmarks route: plue's `{ items, next_cursor }` envelope
 * (an empty cursor closes the list), or the bare list an older proxy answered.
 */
export const bookmarkPage = (body: unknown): { readonly rows: ReadonlyArray<unknown>; readonly next: string | null } => {
  if (Array.isArray(body)) return { rows: body, next: null }
  if (!isRecord(body)) return { rows: [], next: null }
  const rows = Array.isArray(body.items) ? body.items : Array.isArray(body.bookmarks) ? body.bookmarks : []
  return { rows, next: str(body.next_cursor) }
}

/** One bookmark row off the wire; malformed rows drop. */
export const parseBookmark = (value: unknown): { readonly name: string; readonly changeId: string | null; readonly commitId: string | null } | null => {
  if (!isRecord(value) || typeof value.name !== "string" || value.name === "") return null
  return {
    name: value.name,
    changeId: typeof value.target_change_id === "string" ? value.target_change_id : null,
    commitId: typeof value.target_commit_id === "string" ? value.target_commit_id : null
  }
}

/**
 * One workspace row off the wire; malformed rows drop. GET /api/user/workspaces
 * answers plue's UserWorkspaceRow (workspace_id, repository_owner,
 * repository_name, workspace_title, state — the shape WorkspaceSeam reads);
 * ADR 0002's per-repo DTO (id, repo_full_name, name, status) is still read
 * for a proxy that answered it.
 */
export const parseWorkspace = (value: unknown): { readonly id: string; readonly repoId: string; readonly label: string; readonly state: string | null } | null => {
  if (!isRecord(value)) return null
  const switcherId = str(value.workspace_id)
  const owner = str(value.repository_owner)
  const repoName = str(value.repository_name)
  const title = str(value.workspace_title)
  if (switcherId !== null && owner !== null && repoName !== null && title !== null) {
    return { id: switcherId, repoId: `${owner}/${repoName}`, label: title, state: str(value.state) }
  }
  const id = str(value.id)
  const repoId = str(value.repo_full_name)
  const label = str(value.name) ?? (typeof value.slug === "string" ? value.slug : null)
  if (id === null || repoId === null || label === null) return null
  return { id, repoId, label, state: typeof value.status === "string" ? value.status : null }
}

/** `f` over every item with at most `limit` in flight, answers in item order. */
const mapBounded = async <A, B>(items: ReadonlyArray<A>, limit: number, f: (item: A) => Promise<B>): Promise<ReadonlyArray<B>> => {
  const answers = new Array<B>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      answers[index] = await f(items[index] as A)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return answers
}

type NextPage =
  | { readonly kind: "none" }
  | { readonly kind: "next"; readonly path: string }
  | { readonly kind: "invalid" }

/** Go emits relative `/api/...` Link targets. Absolute or off-prefix targets never receive credentials. */
const nextPage = (response: Response): NextPage => {
  const header = response.headers.get("link")
  if (header === null || header.trim() === "") return { kind: "none" }
  for (const entry of header.split(",")) {
    const relation = /(?:^|;)\s*rel\s*=\s*"?([^";]+)"?/i.exec(entry)?.[1]?.trim().split(/\s+/) ?? []
    if (!relation.includes("next")) continue
    const target = /^\s*<([^>]+)>/.exec(entry)?.[1]
    if (target === undefined || !target.startsWith("/api/")) return { kind: "invalid" }
    let parsed: URL
    try {
      parsed = new URL(target, "https://pagination.invalid")
    } catch {
      return { kind: "invalid" }
    }
    if (parsed.origin !== "https://pagination.invalid" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
      return { kind: "invalid" }
    }
    return { kind: "next", path: `${parsed.pathname.slice(4)}${parsed.search}` }
  }
  return { kind: "none" }
}

export const createRepositoriesSeam = (ctx: SeamContext): RepositoriesSeam => {
  const { get: getJson, send } = createCloudClient(ctx)

  const readAllPages = async (
    first: string,
    key: string
  ): Promise<{ readonly rows: ReadonlyArray<unknown> } | { readonly error: string; readonly status: number | null }> => {
    const rows: unknown[] = []
    const seen = new Set<string>()
    let path = first
    for (let page = 0; page < MAX_INVENTORY_PAGES; page += 1) {
      if (seen.has(path)) return { error: "Inventory pagination repeated a page.", status: null }
      seen.add(path)
      const answer = await getJson(path)
      if ("error" in answer) return { error: answer.error, status: answer.status }
      rows.push(...arrayOf(answer.body, key))
      const next = nextPage(answer.response)
      if (next.kind === "none") return { rows }
      if (next.kind === "invalid") return { error: "Inventory pagination returned an invalid next page.", status: null }
      path = next.path
    }
    return { error: "Inventory pagination limit reached.", status: null }
  }

  type Head = { readonly bookmark: string; readonly changeId: string | null; readonly commitId: string | null }

  /**
   * The default bookmark's head off the per-repo bookmarks route, page by
   * page until the bookmark is found or the cursor closes. A failed read is
   * an absent answer (null); a list that closed without the bookmark states
   * the name and no ids.
   */
  const lookUpHead = async (repo: RepoWire, bookmarkName: string): Promise<Head | null> => {
    const base = `/repos/${encodeURIComponent(repo.org)}/${encodeURIComponent(repo.name)}/bookmarks`
    let cursor: string | null = null
    for (let page = 0; page < MAX_BOOKMARK_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(BOOKMARK_PAGE_LIMIT) })
      if (cursor !== null) query.set("cursor", cursor)
      const answer = await getJson(`${base}?${query.toString()}`)
      if ("error" in answer) return null
      const { rows, next } = bookmarkPage(answer.body)
      const bookmark = rows
        .flatMap((entry) => {
          const parsed = parseBookmark(entry)
          return parsed === null ? [] : [parsed]
        })
        .find((entry) => entry.name === bookmarkName)
      if (bookmark !== undefined) return { bookmark: bookmark.name, changeId: bookmark.changeId, commitId: bookmark.commitId }
      if (next === null) return { bookmark: bookmarkName, changeId: null, commitId: null }
      if (next === cursor) return null
      cursor = next
    }
    return null
  }

  /**
   * The default bookmark's head for one repo: the wire field when plue#445
   * lands it, else the per-repo call. When the wire answered the head for
   * most rows the server has #445, and a row it left headless is not read
   * again: the absent answer stands (the collection keeps what it knew).
   */
  const headOf = async (repo: RepoWire, wireAnswersHeads: boolean): Promise<Head | null> => {
    if (repo.defaultBookmark === null) return null
    if (repo.wireHead !== undefined) {
      return { bookmark: repo.defaultBookmark, changeId: repo.wireHead.changeId, commitId: repo.wireHead.commitId }
    }
    if (wireAnswersHeads) return null
    return lookUpHead(repo, repo.defaultBookmark)
  }

  return {
    loadRepositories: async () => {
      const [reposAnswer, orgsAnswer] = await Promise.all([
        readAllPages("/user/repos?limit=100", "repos"),
        readAllPages("/user/orgs?limit=100", "orgs")
      ])
      if ("error" in reposAnswer) return reposAnswer.error
      const repos = reposAnswer.rows.flatMap((entry) => {
        const parsed = parseRepo(entry)
        return parsed === null ? [] : [parsed]
      })
      const orgLogins = new Set(
        "error" in orgsAnswer
          ? []
          : orgsAnswer.rows.flatMap((entry) => {
            const login = parseOrg(entry)
            return login === null ? [] : [login]
          })
      )
      const headed = repos.filter((repo) => repo.defaultBookmark !== null)
      const wireHeaded = headed.filter((repo) => repo.wireHead !== undefined).length
      const wireAnswersHeads = wireHeaded * 2 > headed.length
      const heads = await mapBounded(repos, HEAD_LOOKUP_CONCURRENCY, (repo) => headOf(repo, wireAnswersHeads))
      ctx.dispatch({
        type: "repositories.loaded",
        actor: "system",
        repositories: repos.map((repo, index) => ({
          id: repo.id,
          org: repo.org,
          ownerKind: repo.ownerType ?? (orgLogins.has(repo.org) ? "org" : "user"),
          name: repo.name,
          head: heads[index] ?? null
        }))
      })

      /*
       * The cloud working copies. A degraded token (the legacy scope set,
       * ADR 0001) answers 403 here — that IS the probe the Bun side ran —
       * and the honest answer is no workspace rows. Other failures leave the
       * rows alone: a transient error is not a fact about the inventory.
       */
      const workspaces = await readAllPages("/user/workspaces?limit=100", "workspaces")
      if (!("error" in workspaces) || workspaces.status === 403) {
        const rows = "error" in workspaces ? [] : workspaces.rows
        ctx.dispatch({
          type: "workingcopies.workspaces.loaded",
          actor: "system",
          copies: rows.flatMap((entry) => {
            const parsed = parseWorkspace(entry)
            return parsed === null
              ? []
              : [{
                id: `workspace:${parsed.id}`,
                repoId: parsed.repoId,
                kind: "workspace" as const,
                label: parsed.label,
                workspaceId: parsed.id,
                ...(parsed.state === null ? {} : { state: parsed.state })
              }]
          })
        })
      }
    },
    createRepository: async (name) => {
      const currentOwner = captureCloudOwner(ctx, false)
      const answer = await send("POST", "/user/repos", { name, private: true, auto_init: true }, "repository creation")
      if (!currentOwner()) return "The account or tutorial changed; create the repository again."
      if ("error" in answer) return answer.error
      const repo = parseRepo(answer.body)
      if (repo === null) return "The backend returned an unreadable repository."
      const existing = [...ctx.store.collections.repositories.values()].filter((row) => row.id !== repo.id)
      await ctx.dispatch({
        type: "repositories.loaded",
        actor: "system",
        repositories: [
          ...existing,
          {
            id: repo.id,
            org: repo.org,
            ownerKind: repo.ownerType ?? "user",
            name: repo.name,
            head: repo.defaultBookmark === null
              ? null
              : { bookmark: repo.defaultBookmark, changeId: null, commitId: null }
          }
        ]
      }).isPersisted.promise
      return { fullName: repo.id }
    }
  }
}

export interface RankedRepository {
  readonly fullName: string
  readonly count: number | null
  readonly latest: string | null
  readonly coverage: "default-branch" | "unknown"
  readonly error: string | null
}
export interface RepositoryRanking {
  readonly cutoff: string
  readonly repositories: ReadonlyArray<RankedRepository>
  readonly partial: boolean
  readonly error: string | null
}

/** A ranking read this module refused in its own words; any other throw is not copy. */
class RankingRefused extends Data.TaggedError("RankingRefused")<{ readonly message: string }> {
  constructor(message: string) { super({ message }) }
}

/** Pages stay on the supplied same-origin route; untrusted Link URLs never receive credentials. */
async function githubPages(http: (url: string) => Promise<Response>, path: string): Promise<unknown[]> {
  const rows: unknown[] = []
  for (let page = 1; page <= 100; page++) {
    const response = await http(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)
    if (!response.ok) throw new RankingRefused(`GitHub read unavailable (${response.status}).`)
    if (response.headers.get("x-repos-sync-error") || response.headers.get("x-metadata-stale") === "true") throw new RankingRefused("GitHub inventory is stale; retry to rank contributions.")
    const body: unknown = await response.json()
    if (!Array.isArray(body)) throw new RankingRefused("GitHub returned an unreadable list.")
    rows.push(...body)
    if (!response.headers.get("link")?.includes('rel="next"') && body.length < 100) return rows
  }
  throw new RankingRefused("GitHub pagination limit reached; contribution counts are unknown.")
}

/**
 * Ranked by the inventory's pushed_at, most recent first. plue serves no
 * per-repository commits route, so authored counts are never known: count stays
 * null and coverage "unknown" (the durable card schema keeps both fields).
 */
export async function rankTutorialRepositories(
  http: (url: string) => Promise<Response>, baseUrl: string, now = Date.now()
): Promise<RepositoryRanking> {
  const cutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString()
  let inventory: unknown[]
  try { inventory = await githubPages(http, `${baseUrl}/api/user/github-repos?sort=pushed&direction=desc`) }
  catch (error) {
    // A dropped request or an unreadable body is recorded by the fetch tap; only authored refusals are copy.
    return { cutoff, repositories: [], partial: true, error: error instanceof RankingRefused ? error.message : "Could not read your GitHub repositories." }
  }
  const seen = new Set<string>()
  const repositories: RankedRepository[] = []
  for (const row of inventory) {
    if (!isRecord(row) || typeof row.full_name !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(row.full_name) || seen.has(row.full_name)) continue
    seen.add(row.full_name)
    const pushed = typeof row.pushed_at === "string" && !Number.isNaN(Date.parse(row.pushed_at)) ? new Date(row.pushed_at).toISOString() : null
    repositories.push({ fullName: row.full_name, count: null, latest: pushed, coverage: "unknown", error: null })
  }
  repositories.sort((a, b) => (b.latest ?? "").localeCompare(a.latest ?? "") || a.fullName.localeCompare(b.fullName))
  return { cutoff, repositories, partial: true, error: null }
}
