/*
 * The bookmarks seam (jj branches): GET /api/repos/{owner}/{repo}/bookmarks
 * supplies the source choices a
 * created landing needs (LandingsSeam.createLanding), so the paginated fetch
 * is exported for that seam to reuse. Reference: multi
 * src/smithersCloud/bookmarks.ts.
 */
import type { SeamContext } from "./SeamContext"
import { readErrorMessage } from "./SeamContext"

/** One parsed bookmark (multi Bookmark): the change id is the landing-stack identity. */
export interface BookmarkRow {
  readonly name: string
  readonly targetChangeId: string
  readonly targetCommitId: string | null
  readonly isTrackingRemote: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * One bookmark row (multi parseBookmark, loosened): name and target_change_id
 * are required; everything else degrades instead of failing the payload —
 * where multi throws a 502, this seam skips the malformed row.
 */
const parseBookmark = (value: unknown): BookmarkRow | null => {
  if (!isRecord(value)) return null
  if (typeof value.name !== "string" || value.name === "") return null
  if (typeof value.target_change_id !== "string" || value.target_change_id === "") return null
  const commit = value.target_commit_id
  return {
    name: value.name,
    targetChangeId: value.target_change_id,
    targetCommitId: typeof commit === "string" && commit !== "" ? commit : null,
    isTrackingRemote: value.is_tracking_remote === true
  }
}

/*
 * Every bookmark on the repo, following plue's cursor pagination to the last
 * page (multi listBookmarks): the list defaults to a 30-item page and sorts
 * `landing/…` names before `main`, so a single-page read can silently lose
 * the base bookmark a landing needs. The hard page cap is multi's defensive
 * bound against a backend that never returns an empty cursor.
 */
export const fetchAllBookmarks = async (
  ctx: SeamContext,
  repo: string
): Promise<{ readonly rows: ReadonlyArray<BookmarkRow> } | { readonly error: string }> => {
  const [owner = "", name = ""] = repo.split("/")
  const base = `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/bookmarks`
  const rows: BookmarkRow[] = []
  let cursor = ""
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: "100" })
    if (cursor !== "") query.set("cursor", cursor)
    let response: Response
    try {
      response = await ctx.http(`${base}?${query.toString()}`)
    } catch {
      return { error: `Branches for ${repo} couldn't be listed — the platform didn't answer.` }
    }
    if (!response.ok) {
      return { error: await readErrorMessage(response, `Branches for ${repo} couldn't be listed.`) }
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!isRecord(body)) {
      return { error: `Branches for ${repo} answered with a payload this app couldn't read.` }
    }
    const items = body.items
    const next = body.next_cursor
    if (!Array.isArray(items) || typeof next !== "string") {
      return { error: `Branches for ${repo} answered with a payload this app couldn't read.` }
    }
    rows.push(...items.map(parseBookmark).filter((row): row is BookmarkRow => row !== null))
    if (next === "") return { rows }
    if (next === cursor) {
      return {
        error: `Branches for ${repo} couldn't be fully listed — the pagination cursor didn't advance.`
      }
    }
    cursor = next
  }
  return {
    error: `Branches for ${repo} couldn't be fully listed — pagination exceeded the supported page limit.`
  }
}
