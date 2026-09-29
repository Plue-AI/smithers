/*
 * The commits seam: a repository's commit history (commits.list → the
 * "commit-list" card) and one commit (commits.read → the "commit" card).
 * plue has no git log route (no `/git/commits/{sha}`), so both read
 * its jj change routes, the same ones ChangeSeam and LandingsSeam use:
 *
 *   GET /api/repos/{o}/{r}/bookmarks            — the branch's head change (BookmarksSeam.fetchAllBookmarks)
 *   GET /api/repos/{o}/{r}/changes?limit=100    — change rows, cursor-paginated: { items, next_cursor }
 *   GET /api/repos/{o}/{r}/changes/{id}         — one change DTO (a row the listing missed, and commits.read)
 *   GET /api/repos/{o}/{r}/changes/{id}/diff    — { file_diffs[] } against the recorded parent
 *   GET /api/repos/{o}/{r}/commits/{sha}/statuses — status rows, created_at DESC
 *
 * A branch's history is its FIRST-PARENT walk from the bookmark's head,
 * newest first, capped at COMMIT_WALK_CAP. plue names authors by name and
 * email only; a GitHub noreply email is the one place a login and avatar can
 * be read without a guess. Signatures are never reported, so no row claims
 * "verified".
 */
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { fetchAllBookmarks } from "./BookmarksSeam"
import type { BookmarkRow } from "./BookmarksSeam"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage, readResult } from "./SeamContext"

export type CommitListPayload = Extract<Card, { kind: "commit-list" }>["payload"]
export type CommitPayload = Extract<Card, { kind: "commit" }>["payload"]
export type CommitSummary = CommitListPayload["commits"][number]
export type CommitPerson = CommitSummary["author"]

type Answer = string | void | { readonly value: string }

export interface CommitsSeam {
  /** A branch's commits; the default branch when none is named. */
  readonly listCommits: (branch?: string, repo?: string) => Promise<Answer>
  /** One commit by change id (or anything plue's change route resolves). */
  readonly readCommit: (ref: string, repo?: string) => Promise<Answer>
}

/** The most commits one list card walks; the card says when it stopped short. */
export const COMMIT_WALK_CAP = 50
/** Listing pages read before the walk falls back to one GET per missing change. */
const LIST_PAGE_CAP = 3
/** One-by-one reads allowed per walk after the listing, so a sparse listing cannot become 50 requests. */
const MISS_READ_CAP = 10

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)
const int = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0)

/** One change row as plue's ChangeResponse / ChangeDetailResponse carries it. */
export interface ChangeWire {
  readonly changeId: string
  readonly commitId: string
  readonly description: string
  readonly authorName: string | null
  readonly authorEmail: string | null
  readonly timestamp: string | null
  readonly parentChangeIds: ReadonlyArray<string>
}

/** change_id and commit_id are required; a malformed row is skipped, never repaired. */
export const parseChange = (value: unknown): ChangeWire | null => {
  if (!isRecord(value)) return null
  const changeId = str(value.change_id)
  const commitId = str(value.commit_id)
  if (changeId === null || commitId === null) return null
  const parents = Array.isArray(value.parent_change_ids)
    ? value.parent_change_ids.filter((id): id is string => typeof id === "string" && id !== "")
    : str(value.parent_change_id) === null ? [] : [value.parent_change_id as string]
  return {
    changeId,
    commitId,
    description: typeof value.description === "string" ? value.description : "",
    authorName: str(value.author_name),
    authorEmail: str(value.author_email),
    timestamp: str(value.timestamp),
    parentChangeIds: parents
  }
}

/** jj's root commit: every history ends here, and it is nobody's commit. */
const isRoot = (change: ChangeWire): boolean => /^0+$/.test(change.commitId)

const NOREPLY = /^(?:(\d+)\+)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)@users\.noreply\.github\.com$/i

/** Name and email as stated, plus the login and avatar a GitHub noreply address names. */
export const personOf = (name: string | null, email: string | null): CommitPerson => {
  const match = email === null ? null : NOREPLY.exec(email)
  if (match === null) return { name, email }
  const [, id, login] = match
  return {
    name,
    email,
    login: login!,
    ...(id === undefined ? {} : { avatarUrl: `https://avatars.githubusercontent.com/u/${id}?v=4` })
  }
}

/** The first non-blank line of a description; an empty one says so. */
export const titleOf = (description: string): string =>
  description.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "(no description)"

const isoOf = (timestamp: string | null): string | null => {
  if (timestamp === null) return null
  const ms = Date.parse(timestamp)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

export const summaryOf = (change: ChangeWire): CommitSummary => ({
  commitId: change.commitId,
  changeId: change.changeId,
  title: titleOf(change.description),
  author: personOf(change.authorName, change.authorEmail),
  authoredAt: isoOf(change.timestamp)
})

/**
 * The combined status of a commit's rows: the newest row per context
 * (rows repeat across re-runs), then failure over pending over success.
 * No rows is no status, never "success".
 */
export const combinedStatus = (body: unknown): CommitSummary["status"] => {
  if (!Array.isArray(body)) return undefined
  const newest = new Map<string, { readonly state: string; readonly at: string }>()
  for (const row of body) {
    if (!isRecord(row)) continue
    const context = str(row.context) ?? ""
    const state = str(row.status)
    if (state === null) continue
    const at = str(row.created_at) ?? ""
    const seen = newest.get(context)
    if (seen === undefined || at > seen.at) newest.set(context, { state, at })
  }
  const states = [...newest.values()].map((row) => row.state)
  if (states.length === 0) return undefined
  if (states.some((state) => state === "failure" || state === "error")) return "failure"
  if (states.some((state) => state !== "success")) return "pending"
  return "success"
}

/** The branch a bare commits.list walks: main, master, trunk, then the first non-landing bookmark. */
export const defaultBranch = (rows: ReadonlyArray<BookmarkRow>): BookmarkRow | undefined => {
  for (const name of ["main", "master", "trunk"]) {
    const row = rows.find((candidate) => candidate.name === name)
    if (row !== undefined) return row
  }
  return rows.find((row) => !row.name.startsWith("landing/")) ?? rows[0]
}

/** The model's copy of a list: one line per commit, bounded by readResult. */
export const listValue = (repo: string, branch: string | null, commits: ReadonlyArray<CommitSummary>): string =>
  commits.length === 0
    ? `${branch ?? repo} has no commits.`
    : [
      `${commits.length} commits on ${branch ?? "the default branch"} in ${repo}, newest first:`,
      ...commits.map((commit) =>
        `${commit.commitId.slice(0, 7)} ${commit.changeId ?? ""} ${commit.title} — ${commit.author.login ?? commit.author.name ?? "unknown"}${commit.authoredAt === null ? "" : ` ${commit.authoredAt.slice(0, 10)}`}`
      )
    ].join("\n")

export const commitValue = (payload: CommitPayload): string =>
  [
    `${payload.commit.commitId} (change ${payload.commit.changeId ?? "none"}) in ${payload.repo}`,
    `Author: ${payload.commit.author.name ?? "unknown"}${payload.commit.author.email === null ? "" : ` <${payload.commit.author.email}>`}`,
    payload.commit.authoredAt === null ? null : `Date: ${payload.commit.authoredAt}`,
    payload.parents.length === 0 ? null : `Parents: ${payload.parents.map((parent) => parent.commitId ?? parent.changeId).join(", ")}`,
    payload.commit.status === undefined ? null : `Status: ${payload.commit.status}`,
    "",
    payload.message,
    "",
    ...payload.files.map((file) => `${file.changeType} ${file.path} +${file.additions} −${file.deletions}`),
    ...(payload.diffError === undefined ? [] : [`Diff unavailable: ${payload.diffError}`])
  ].filter((line): line is string => line !== null).join("\n")

export const commitListCardId = (repo: string, branch: string | null): string => `commits-${repo}-${branch ?? "default"}`
export const commitCardId = (repo: string, ref: string): string => `commit-${repo}-${ref}`

export const createCommitsSeam = (ctx: SeamContext): CommitsSeam => {
  const root = (repo: string): string => {
    const [owner = "", name = ""] = repo.split("/")
    return `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  }

  const getJson = async (url: string, fallback: string): Promise<{ readonly body: unknown } | { readonly error: string }> => {
    let response: Response
    try {
      response = await ctx.http(url)
    } catch {
      return { error: `${fallback} — the platform didn't answer.` }
    }
    if (!response.ok) return { error: await readErrorMessage(response, `${fallback}.`) }
    return { body: await response.json().catch(() => undefined) }
  }

  const readChange = async (repo: string, id: string): Promise<ChangeWire | { readonly error: string }> => {
    const answer = await getJson(`${root(repo)}/changes/${encodeURIComponent(id)}`, `Commit ${id} in ${repo} couldn't be read`)
    if ("error" in answer) return answer
    return parseChange(answer.body) ?? { error: `Commit ${id} in ${repo} answered with a payload this app couldn't read.` }
  }

  /* Up to LIST_PAGE_CAP pages of change rows, keyed by change id; a failed page ends the prefetch, never the walk. */
  const prefetch = async (repo: string): Promise<Map<string, ChangeWire>> => {
    const known = new Map<string, ChangeWire>()
    let cursor = ""
    for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
      const query = new URLSearchParams({ limit: "100" })
      if (cursor !== "") query.set("cursor", cursor)
      const answer = await getJson(`${root(repo)}/changes?${query.toString()}`, `Commits in ${repo} couldn't be listed`)
      if ("error" in answer || !isRecord(answer.body) || !Array.isArray(answer.body.items)) break
      for (const item of answer.body.items) {
        const change = parseChange(item)
        if (change !== null) known.set(change.changeId, change)
      }
      const next = answer.body.next_cursor
      if (typeof next !== "string" || next === "" || next === cursor) break
      cursor = next
    }
    return known
  }

  /** The first-parent walk from `head`, newest first. */
  const walk = async (
    repo: string,
    head: string
  ): Promise<{ readonly commits: ReadonlyArray<CommitSummary>; readonly truncated: boolean } | { readonly error: string }> => {
    const known = await prefetch(repo)
    const commits: CommitSummary[] = []
    let misses = 0
    let next: string | undefined = head
    while (next !== undefined && commits.length < COMMIT_WALK_CAP) {
      let change = known.get(next)
      if (change === undefined) {
        if (misses >= MISS_READ_CAP) return { commits, truncated: true }
        misses += 1
        const read = await readChange(repo, next)
        if ("error" in read) return commits.length === 0 ? read : { commits, truncated: true }
        change = read
      }
      if (isRoot(change)) return { commits, truncated: false }
      commits.push(summaryOf(change))
      next = change.parentChangeIds[0]
    }
    return { commits, truncated: next !== undefined }
  }

  const upsert = (card: Card): void => {
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  const listCard = (repo: string, branch: string | null, payload: Omit<CommitListPayload, "repo" | "branch">): Card => ({
    id: commitListCardId(repo, branch),
    kind: "commit-list",
    title: `Commits · ${branch === null ? repo : `${branch} · ${repo}`}`,
    status: "active",
    createdAt: Date.now(),
    ordinal: ctx.nextOrdinal(),
    payload: { repo, branch, ...payload }
  })

  const commitCard = (payload: CommitPayload, ref: string): Card => ({
    id: commitCardId(payload.repo, payload.commit.changeId ?? ref),
    kind: "commit",
    title: `Commit ${payload.commit.commitId.slice(0, 7)} · ${payload.commit.title}`,
    status: "active",
    createdAt: Date.now(),
    ordinal: ctx.nextOrdinal(),
    payload
  })

  return {
    listCommits: async (branchArg, repoArg) => {
      const branchName = branchArg?.trim() === "" ? undefined : branchArg?.trim()
      const target = resolveTargetRepo(ctx.store, repoArg)
      if ("error" in target) return target.error
      const repo = target.repo
      const bookmarks = await fetchAllBookmarks(ctx, repo)
      if ("error" in bookmarks) return bookmarks.error
      const bookmark = branchName === undefined
        ? defaultBranch(bookmarks.rows)
        : bookmarks.rows.find((row) => row.name === branchName)
      if (bookmark === undefined) {
        if (branchName !== undefined) return `${repo} has no branch named ${branchName} — /branches.list shows them.`
        upsert(listCard(repo, null, { commits: [] }))
        return readResult(listValue(repo, null, []))
      }
      const result = await walk(repo, bookmark.targetChangeId)
      if ("error" in result) return result.error
      upsert(listCard(repo, bookmark.name, { commits: [...result.commits], ...(result.truncated ? { truncated: true } : {}) }))
      return readResult(listValue(repo, bookmark.name, result.commits))
    },

    readCommit: async (refArg, repoArg) => {
      const ref = refArg.trim()
      if (ref === "") return "commits.read needs a change id or commit id."
      const target = resolveTargetRepo(ctx.store, repoArg)
      if ("error" in target) return target.error
      const repo = target.repo
      const change = await readChange(repo, ref)
      if ("error" in change) return change.error
      const [diff, statuses, parents] = await Promise.all([
        getJson(`${root(repo)}/changes/${encodeURIComponent(change.changeId)}/diff`, `The diff of ${change.changeId} couldn't be read`),
        getJson(`${root(repo)}/commits/${encodeURIComponent(change.commitId)}/statuses?limit=100`, "statuses"),
        Promise.all(change.parentChangeIds.slice(0, 4).map(async (id) => {
          const parent = await readChange(repo, id)
          return { changeId: id, commitId: "error" in parent || isRoot(parent) ? null : parent.commitId }
        }))
      ])
      const fileRows = "error" in diff || !isRecord(diff.body) || !Array.isArray(diff.body.file_diffs) ? null : diff.body.file_diffs
      const files = (fileRows ?? []).flatMap((value): CommitPayload["files"] => {
        if (!isRecord(value)) return []
        const path = str(value.path)
        if (path === null) return []
        const oldPath = str(value.old_path)
        const patch = str(value.patch)
        return [{
          path,
          ...(oldPath === null ? {} : { oldPath }),
          changeType: str(value.change_type) ?? "modified",
          isBinary: value.is_binary === true,
          additions: int(value.additions),
          deletions: int(value.deletions),
          ...(patch === null ? {} : { patch })
        }]
      })
      const status = "error" in statuses ? undefined : combinedStatus(statuses.body)
      const summary = summaryOf(change)
      const payload: CommitPayload = {
        repo,
        commit: status === undefined ? summary : { ...summary, status },
        message: change.description.trim() === "" ? "(no description)" : change.description.replace(/\s+$/, ""),
        parents: parents.filter((parent) => parent.commitId !== null),
        files,
        ...("error" in diff
          ? { diffError: diff.error }
          : fileRows === null
          ? { diffError: `The diff of ${change.changeId} answered with a payload this app couldn't read.` }
          : {})
      }
      upsert(commitCard(payload, ref))
      return readResult(commitValue(payload))
    }
  }
}
