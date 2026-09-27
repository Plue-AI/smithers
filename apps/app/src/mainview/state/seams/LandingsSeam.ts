import { preparedView, type ViewAction, type ViewResult, invalidatePreparedViews } from "../PreparedView"
import { readRepositoryDetail } from "../RepositoryReadReceipts"
import { readRepositoryListError, repositoryListRead, type RepositoryForm } from "./RepositoryListSeam"
import { publishRepoView, repoPaneCard } from "../EmbeddedHistory"
/*
 * The landings seam ("PRs"): /api/repos/{owner}/{repo}/landings* through the
 * product Worker's platform proxy. Landing a PR QUEUES it (202 Accepted) — the
 * card states "queued", never a terminal claim the platform hasn't made yet.
 * Reference: multi src/smithersCloud/landings.ts + landingComments.ts +
 * commitStatuses.ts; the create payload assembly mirrors multi
 * src/landings/landingsStore.ts executeCreate + src/smithersCloud/repoChanges.ts.
 */
import type { Card } from "../AppState"
import type { FieldOption } from "@smthrs/ui/flow-form"

type PrPayload = Extract<Card, { kind: "pr" }>["payload"]
type FileRow = NonNullable<PrPayload["files"]>[number]
/** The most changes a PR card reads (two requests each); a taller stack shows its top. */
const STACK_CAP = 20
import { resolveTargetRepo } from "../RepoContext"
import { fetchAllBookmarks } from "./BookmarksSeam"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage, readResult } from "./SeamContext"

export interface LandingsSeam {
  readonly setTab: (cardId: string, tab: "conversation" | "commits" | "checks" | "files") => Promise<string | void>
  readonly listLandings: ViewAction<[repo?: string]>
  readonly viewLanding: ViewAction<[number: number, repo?: string]>
  readonly createLanding: (
    title: string,
    repo?: string,
    /** The source bookmark (`from:<name>` in /prs.create); required by plue's POST /landings. */
    fromBookmark?: string
  ) => Promise<string | void>
  readonly landLanding: (number: number, repo?: string) => Promise<string | void>
  /**
   * One pull request as the context a review flow reads (the Review a PR
   * app, `prs.triage`): its title, description, state, author, commits and
   * files with the patches the diff read carried. No card; the run card is
   * what follows.
   */
  readonly readLandingContext: (number: number, repo?: string) => Promise<string | LandingContext>
  readonly reviewLanding: (
    number: number,
    type: "approve" | "request_changes" | "comment",
    body: string,
    repo?: string
  ) => Promise<string | void>
}

/** What `readLandingContext` answers: the pull request as data for a review flow. */
export interface LandingContext {
  readonly repo: string
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: string
  readonly author: string | null
  readonly baseBranch?: string
  readonly commits?: PrPayload["commits"]
  readonly files?: PrPayload["files"]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null)

interface LandingRow {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly author: string | null
  readonly updatedAt: string | null
}

interface LandingDetail extends LandingRow {
  readonly body: string
  /** The jj change ids (bottom → top); the tip is the checks status ref. */
  readonly changeIds: readonly string[]
  readonly targetBookmark: string | null
  readonly createdAt: string | null
}

/**
 * One landing row, read defensively (multi parseLanding, loosened): number and
 * title are required, everything else degrades instead of failing the payload.
 */
const parseLandingRow = (value: unknown): LandingRow | null => {
  if (!isRecord(value)) return null
  if (typeof value.number !== "number" || !Number.isInteger(value.number)) return null
  if (typeof value.title !== "string") return null
  return {
    number: value.number,
    title: value.title,
    state: typeof value.state === "string" && value.state !== "" ? value.state : "unknown",
    author: isRecord(value.author) ? stringOrNull(value.author.login) : null,
    updatedAt: stringOrNull(value.updated_at)
  }
}

const parseLandingDetail = (value: unknown): LandingDetail | null => {
  const row = parseLandingRow(value)
  if (row === null || !isRecord(value)) return null
  return {
    ...row,
    body: typeof value.body === "string" ? value.body : "",
    changeIds: Array.isArray(value.change_ids)
      ? value.change_ids.filter((id): id is string => typeof id === "string")
      : [],
    targetBookmark: stringOrNull(value.target_bookmark),
    createdAt: stringOrNull(value.created_at)
  }
}

interface ReviewRow {
  readonly author: string | null
  readonly type: string
  readonly reviewBody: string
}

/**
 * A review verdict row. Plue's current payload exposes only reviewer_id — no
 * login — so author stays null unless a login-shaped field is present.
 */
const parseReviewRow = (value: unknown): ReviewRow | null => {
  if (!isRecord(value)) return null
  if (typeof value.type !== "string") return null
  return {
    author: isRecord(value.author)
      ? stringOrNull(value.author.login)
      : stringOrNull(value.reviewer_login),
    type: value.type,
    reviewBody: typeof value.body === "string" ? value.body : ""
  }
}

interface CheckRow {
  readonly context: string
  readonly state: string
  readonly createdAt: string
}

const parseCheckRow = (value: unknown): CheckRow | null => {
  if (!isRecord(value)) return null
  if (typeof value.context !== "string" || value.context === "") return null
  if (typeof value.status !== "string") return null
  return {
    context: value.context,
    state: value.status,
    createdAt: typeof value.created_at === "string" ? value.created_at : ""
  }
}

/*
 * Commit status rows repeat contexts across re-runs and arrive created_at
 * DESC, so the NEWEST row per context wins, decided by created_at — a naive
 * last-write-wins keeps the OLDEST row and shows "pending" forever after a
 * green re-run (multi commitStatuses.ts).
 */
const newestPerContext = (
  rows: readonly CheckRow[]
): Array<{ context: string; state: string }> => {
  const byContext = new Map<string, CheckRow>()
  for (const row of rows) {
    const existing = byContext.get(row.context)
    if (existing === undefined || row.createdAt > existing.createdAt) byContext.set(row.context, row)
  }
  return [...byContext.values()].map(({ context, state }) => ({ context, state }))
}

const repoApiRoot = (repo: string): string => {
  const [owner = "", name = ""] = repo.split("/")
  return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

/** A pull request a review can still act on: not merged, closed or landed. */
const reviewable = (state: string): boolean => !["merged", "closed", "landed"].includes(state.toLowerCase())

/**
 * A repository's open pull requests as a form's options (the Review a PR
 * app's picker, controller/forms.ts `pull-requests`), one bounded page read
 * exactly as the pull request list reads it. A refusal answers no options
 * and its reason; nothing is invented.
 */
export const readLandingOptions = async (
  ctx: Pick<SeamContext, "http" | "baseUrl">,
  repo: string
): Promise<{ readonly options: ReadonlyArray<FieldOption>; readonly error?: string }> => {
  let response: Response
  try {
    response = await ctx.http(`${ctx.baseUrl}${repoApiRoot(repo)}/landings?limit=100`)
  } catch {
    return { options: [], error: `Pull requests for ${repo} couldn't be listed — the platform didn't answer.` }
  }
  if (!response.ok) return { options: [], error: await readRepositoryListError(response, `Pull requests for ${repo} couldn't be listed.`) }
  const body: unknown = await response.json().catch(() => undefined)
  if (!Array.isArray(body)) return { options: [], error: `Pull requests for ${repo} answered with a payload this app couldn't read.` }
  return { options: body.map(parseLandingRow).filter((row): row is LandingRow => row !== null && reviewable(row.state))
    .map((row) => ({ value: String(row.number), label: `#${row.number} ${row.title}` })) }
}

/** One jj change row: the parent walk is all a landing stack needs. */
interface RepoChangeRow {
  readonly changeId: string
  readonly parentChangeIds: readonly string[]
}

/**
 * The change rows out of the paginated/bare-array shapes plue may answer
 * (multi repoChanges.ts changeArray + parseRepoChange, loosened): change_id is
 * required, a missing parent_change_ids degrades to [], and a malformed row is
 * skipped instead of failing the payload.
 */
const parseRepoChanges = (body: unknown): RepoChangeRow[] => {
  const rows: unknown[] = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.changes)
    ? body.changes
    : isRecord(body) && Array.isArray(body.items)
    ? body.items
    : []
  return rows.flatMap((value): RepoChangeRow[] => {
    if (!isRecord(value)) return []
    if (typeof value.change_id !== "string" || value.change_id === "") return []
    const parents = Array.isArray(value.parent_change_ids)
      ? value.parent_change_ids.filter((id): id is string => typeof id === "string")
      : []
    return [{ changeId: value.change_id, parentChangeIds: parents }]
  })
}

/**
 * Walk the linear chain of parent change ids from the source tip back to the
 * target tip, answering the stack base-first/tip-last — plue lands exactly the
 * stored change_ids in this order (landing_worker.go PositionInStack), so a
 * tip-only id would silently drop ancestor changes. Bails to [] — an honest
 * refusal, never a partial or guessed stack — on tip equality, a parent absent
 * from the fetched list, a merge (ambiguous side), a cycle, or a walk past
 * plue's 50-change stack cap. Ported from multi repoChanges.ts
 * deriveBookmarkStack.
 */
const deriveBookmarkStack = (
  changes: readonly RepoChangeRow[],
  sourceTipChangeId: string,
  targetTipChangeId: string
): string[] => {
  if (sourceTipChangeId === "" || targetTipChangeId === "") return []
  if (sourceTipChangeId === targetTipChangeId) return []
  const byId = new Map(changes.map((change) => [change.changeId, change]))
  const stack: string[] = []
  const seen = new Set<string>()
  const MAX_STACK = 50
  let cursor = sourceTipChangeId
  while (cursor !== targetTipChangeId) {
    if (seen.has(cursor)) return [] // cycle
    if (stack.length >= MAX_STACK) return [] // deeper than plue's stack cap
    seen.add(cursor)
    stack.push(cursor)
    const change = byId.get(cursor)
    if (change === undefined) return [] // parent absent from the fetched list
    if (change.parentChangeIds.length > 1) return [] // merge — ambiguous
    if (change.parentChangeIds.length === 0) return [] // walked off the end
    cursor = change.parentChangeIds[0] as string
  }
  return stack.reverse()
}

export const createLandingsSeam = (ctx: SeamContext, renderRepositoryForm?: RepositoryForm): LandingsSeam => {
  const landingsUrl = (repo: string): string => `${ctx.baseUrl}${repoApiRoot(repo)}/landings`

  /** Reviews for the detail card; a section failure degrades to [] (multi's section() stance). */
  const fetchReviews = async (repo: string, number: number): Promise<ReviewRow[]> => {
    try {
      const response = await ctx.http(`${landingsUrl(repo)}/${number}/reviews?limit=100`)
      if (!response.ok) return []
      const body: unknown = await response.json().catch(() => undefined)
      if (!Array.isArray(body)) return []
      return body.map(parseReviewRow).filter((row): row is ReviewRow => row !== null)
    } catch {
      return []
    }
  }

  /** Checks for the tip change id; no ref or a section failure degrades to []. */
  const fetchChecks = async (
    repo: string,
    ref: string | undefined
  ): Promise<Array<{ context: string; state: string }>> => {
    if (ref === undefined || ref === "") return []
    try {
      const response = await ctx.http(
        `${ctx.baseUrl}${repoApiRoot(repo)}/commits/${encodeURIComponent(ref)}/statuses?limit=100`
      )
      if (!response.ok) return []
      const body: unknown = await response.json().catch(() => undefined)
      if (!Array.isArray(body)) return []
      return newestPerContext(body.map(parseCheckRow).filter((row): row is CheckRow => row !== null))
    } catch {
      return []
    }
  }

  /** The commit at the request's tip change — what a land names; an unreadable tip is an honest refusal, never a guessed commit. */
  const fetchTipCommit = async (
    repo: string,
    number: number
  ): Promise<{ readonly commitId: string } | { readonly error: string }> => {
    let response: Response
    try {
      response = await ctx.http(`${landingsUrl(repo)}/${number}`)
    } catch {
      return { error: `Pull request #${number} couldn't be read — the platform didn't answer.` }
    }
    if (!response.ok) {
      return { error: await readErrorMessage(response, `Pull request #${number} on ${repo} couldn't be read before submitting.`) }
    }
    const landing = parseLandingDetail(await response.json().catch(() => undefined))
    const tip = landing?.changeIds.at(-1)
    if (landing === null || tip === undefined || tip === "") {
      return { error: `Pull request #${number} names no tip change.` }
    }
    let changeResponse: Response
    try {
      changeResponse = await ctx.http(`${ctx.baseUrl}${repoApiRoot(repo)}/changes/${encodeURIComponent(tip)}`)
    } catch {
      return { error: `The tip change ${tip} of #${number} couldn't be read — the platform didn't answer.` }
    }
    if (!changeResponse.ok) {
      return { error: await readErrorMessage(changeResponse, `The tip change ${tip} of #${number} couldn't be read.`) }
    }
    const body: unknown = await changeResponse.json().catch(() => undefined)
    const commitId = isRecord(body) && typeof body.commit_id === "string" && body.commit_id !== "" ? body.commit_id : null
    if (commitId === null) return { error: `The tip change ${tip} of #${number} carries no commit id.` }
    return { commitId }
  }

  /*
   * The landing's retained stack for the PR card's Commits and Files changed
   * tabs: GET …/landings/{number}/changes and its revision-pinned aggregate
   * diff. Files merge by path:
   * counts add up, and the patch rides only when one change touched the file
   * (a later change's patch alone is not the file's diff). A tab's field is
   * set only when every read answered, so a failed read never looks empty.
   */
  const fetchStack = async (repo: string, number: number): Promise<Pick<PrPayload, "commits" | "files" | "readErrors">> => {
    const root = `${ctx.baseUrl}${repoApiRoot(repo)}/landings/${number}`
    const read = async (url: string): Promise<{ readonly body?: unknown; readonly error?: string }> => {
      try {
        const response = await ctx.http(url)
        if (!response.ok) return { error: await readErrorMessage(response, "Read failed.") }
        return { body: await response.json().catch(() => undefined) }
      } catch {
        return { error: "The platform didn't answer." }
      }
    }
    const [changesRead, diffRead] = await Promise.all([read(`${root}/changes?limit=${STACK_CAP}`), read(`${root}/diff`)])
    const changes = Array.isArray(changesRead.body) ? changesRead.body : undefined
    type RetainedChange = Record<string, unknown> & { change_id: string; commit_id: string; description: string; timestamp: string }
    const validChange = (change: unknown): change is RetainedChange => isRecord(change) &&
      typeof change.change_id === "string" && change.change_id !== "" &&
      typeof change.commit_id === "string" && change.commit_id !== "" &&
      typeof change.description === "string" && typeof change.timestamp === "string"
    const commits: NonNullable<PrPayload["commits"]> = (changes ?? []).flatMap((change) => validChange(change) ? [{
      changeId: change.change_id,
      commitId: change.commit_id,
      message: change.description,
      author: stringOrNull(change.author_name),
      timestamp: stringOrNull(change.timestamp)
    }] : [])
    const count = (value: unknown): number => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
    const statusOf = (value: unknown): FileRow["status"] =>
      value === "added" || value === "renamed" ? value : value === "deleted" || value === "removed" ? "removed" : value === "modified" ? "modified" : undefined
    const files = new Map<string, FileRow & { touched: number }>()
    const diffChanges = isRecord(diffRead.body) && Array.isArray(diffRead.body.changes) ? diffRead.body.changes : undefined
    let malformedDiff = false
    for (const diff of diffChanges ?? []) {
      if (!isRecord(diff) || typeof diff.change_id !== "string" || !Array.isArray(diff.file_diffs)) { malformedDiff = true; continue }
      for (const value of diff.file_diffs) {
        if (!isRecord(value) || typeof value.path !== "string" || value.path === "") { malformedDiff = true; continue }
        const prior = files.get(value.path)
        const oldPath = stringOrNull(value.old_path)
        const status = statusOf(value.change_type)
        const patch = stringOrNull(value.patch)
        const touched = (prior?.touched ?? 0) + 1
        files.set(value.path, {
          path: value.path,
          ...(oldPath !== null ? { oldPath } : prior?.oldPath !== undefined ? { oldPath: prior.oldPath } : {}),
          ...(status !== undefined ? { status } : {}),
          additions: (prior?.additions ?? 0) + count(value.additions),
          deletions: (prior?.deletions ?? 0) + count(value.deletions),
          ...(touched === 1 && patch !== null ? { patch } : {}),
          touched
        })
      }
    }
    const commitError = changesRead.error ?? (changes === undefined || !changes.every(validChange) ? "The platform returned an unreadable response." : undefined)
    const diffError = diffRead.error ?? (diffChanges === undefined || malformedDiff ? "The platform returned an unreadable response." : undefined)
    return {
      ...(commitError === undefined ? { commits } : {}),
      ...(diffError === undefined ? { files: [...files.values()].map(({ touched: _touched, ...file }) => file) } : {}),
      ...(commitError !== undefined || diffError !== undefined ? { readErrors: {
        ...(commitError !== undefined ? { commits: `Commits unavailable (${commitError})` } : {}),
        ...(diffError !== undefined ? { files: `Files unavailable (${diffError})` } : {})
      } } : {})
    }
  }

  /*
   * The one detail door: GET the landing, its reviews, and its checks, then
   * upsert the "pr" card. `stateOverride` lets a mutation pin the state the
   * platform just answered (a land pins "queued") over a racing re-read.
   */
  const readLanding = async (
    repo: string,
    number: number,
    stateOverride?: string
  ): Promise<ViewResult> => {
    let response: Response
    try {
      response = await ctx.http(`${landingsUrl(repo)}/${number}`)
    } catch {
      return `Pull request #${number} couldn't be read — the platform didn't answer.`
    }
    if (!response.ok) {
      return readErrorMessage(response, `Pull request #${number} on ${repo} couldn't be read.`)
    }
    const landing = parseLandingDetail(await response.json().catch(() => undefined))
    if (landing === null) {
      return `Pull request #${number} on ${repo} answered with a payload this app couldn't read.`
    }
    const [reviews, checks, stack] = await Promise.all([
      fetchReviews(repo, number),
      fetchChecks(repo, landing.changeIds.at(-1)),
      fetchStack(repo, number)
    ])
    const current = ctx.store.collections.cards.get(`pr-${repo}-${number}`)
    const payload: PrPayload = {
      repo,
      number,
      title: landing.title,
      state: stateOverride ?? landing.state,
      author: landing.author,
      prBody: landing.body,
      reviews,
      checks,
      ...(current?.kind === "pr" && current.payload.tab !== undefined ? { tab: current.payload.tab } : {}),
      ...(landing.targetBookmark !== null ? { baseBranch: landing.targetBookmark } : {}),
      ...(landing.createdAt !== null ? { createdAt: landing.createdAt } : {}),
      ...stack
    }
    const card: Card = {
      id: `pr-${repo}-${number}`,
      kind: "pr",
      title: `#${number} ${landing.title} · ${repo}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload
    }
    return { card, ...readResult([
      `${payload.repo} · #${payload.number} ${payload.title} · ${payload.state}`,
      `Author: ${payload.author ?? "unknown"}`,
      payload.prBody,
      ...payload.reviews.map((review) => `Review by ${review.author ?? "unknown"} · ${review.type}:\n${review.reviewBody}`),
      ...payload.checks.map((check) => `Check: ${check.context} · ${check.state}`),
      ...(payload.commits ?? []).map((commit) => `Commit ${commit.changeId?.slice(0, 8) ?? ""}: ${commit.message.split("\n")[0] ?? ""}`),
      ...(payload.files ?? []).map((file) => `File: ${file.path} +${file.additions ?? 0} −${file.deletions ?? 0}`)
    ].join("\n")) }
  }

  const listView = preparedView(ctx, (repoArg?: string) => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    return { id: `prs-${repo}`, title: `Pull requests · ${repo}`, pane: repo, read: async (): Promise<ViewResult> => {
      let response: Response
      try {
        // One bounded page. Omitting `state` lists every lifecycle state —
        // plue has no "all" filter value and 422s an unknown one.
        response = await ctx.http(`${landingsUrl(repo)}?limit=100`)
      } catch {
        return `Pull requests for ${repo} couldn't be listed — the platform didn't answer.`
      }
      if (!response.ok) {
        return readRepositoryListError(response, `Pull requests for ${repo} couldn't be listed.`)
      }
      const body: unknown = await response.json().catch(() => undefined)
      if (!Array.isArray(body)) {
        return `Pull requests for ${repo} answered with a payload this app couldn't read.`
      }
      const landings = body
        .map(parseLandingRow)
        .filter((row): row is LandingRow => row !== null)
        .map(({ number, title, state, author, updatedAt }) => ({
          number,
          title,
          state,
          author,
          updatedAt
        }))
      const card: Card = {
        id: `prs-${repo}`,
        kind: "pr-list",
        title: `Pull requests · ${repo}`,
        status: "active",
        createdAt: Date.now(),
        ordinal: ctx.nextOrdinal(),
        payload: { repo, landings }
      }
      return { card, ...readResult(landings.length === 0
        ? `No pull requests in ${repo}.`
        : `Pull requests · ${repo}\n${landings.map((landing) => `#${landing.number} ${landing.title} · ${landing.state}`).join("\n")}`) }
    } }
  })
  const landingView = preparedView(ctx, (number: number, repoArg?: string, stateOverride?: string) => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    return { id: `pr-${repo}-${number}`, title: `Pull request #${number} · ${repo}`, pane: repo,
      key: JSON.stringify(["pr", repo, number, stateOverride]), read: () => readLanding(repo, number, stateOverride) }
  })
  const surfaceLanding = (repo: string, number: number, stateOverride?: string) => {
    invalidatePreparedViews(ctx.store)
    return landingView(number, repo, stateOverride)
  }

  const readLandingContext: LandingsSeam["readLandingContext"] = async (number, repoArg) => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    let response: Response
    try {
      response = await ctx.http(`${landingsUrl(repo)}/${number}`)
    } catch {
      return `Pull request #${number} couldn't be read — the platform didn't answer.`
    }
    if (!response.ok) return readErrorMessage(response, `Pull request #${number} on ${repo} couldn't be read.`)
    const landing = parseLandingDetail(await response.json().catch(() => undefined))
    if (landing === null) return `Pull request #${number} on ${repo} answered with a payload this app couldn't read.`
    const stack = await fetchStack(repo, number)
    return {
      repo, number, title: landing.title, body: landing.body, state: landing.state, author: landing.author,
      ...(landing.targetBookmark === null ? {} : { baseBranch: landing.targetBookmark }),
      ...(stack.commits === undefined ? {} : { commits: stack.commits }),
      ...(stack.files === undefined ? {} : { files: stack.files })
    }
  }

  return {
    readLandingContext,
    setTab: async (cardId, tab) => {
      const card = ctx.store.collections.cards.get(cardId)
      if (card?.kind !== "pr") return "That pull request card is no longer available."
      await ctx.dispatch({ type: "card.updated", actor: ctx.actor(), id: cardId, patch: { payload: { tab } } }).isPersisted.promise
    },
    listLandings: Object.assign((repoArg?: string) => repositoryListRead(ctx, "prs", repoArg, "all", renderRepositoryForm, repo => listView(repo)), { preload: listView.preload }),

    viewLanding: Object.assign(async (number: number, repoArg?: string) => {
      const target = resolveTargetRepo(ctx.store, repoArg)
      if ("error" in target) return target.error
      return readRepositoryDetail(ctx, target.repo, "pr", number, () => landingView(number, target.repo))
    }, { preload: landingView.preload }),

    createLanding: async (title, repoArg, fromBookmark) => {
      const target = resolveTargetRepo(ctx.store, repoArg)
      if ("error" in target) return target.error
      const repo = target.repo
      if (fromBookmark === undefined || fromBookmark === "") {
        // The source branch is a genuine user choice — named, never guessed.
        return "prs.create needs a source branch — run /branches.list, then /prs.create <title> from:<bookmark>"
      }
      const trimmedTitle = title.trim()
      if (trimmedTitle === "") return "prs.create needs a title"
      /*
       * Assemble plue's required payload the way multi does (landingsStore
       * executeCreate): the live bookmarks give the source and target tips,
       * the repo's changes give the parent walk, and the FULL target..source
       * stack rides as change_ids. Multi's draft-materialization step
       * (applyDraftsToChange) is workspace-only state this app cannot reach
       * (scratchpad ISSUE-landings-2.md); everything else is the same routes.
       */
      const bookmarks = await fetchAllBookmarks(ctx, repo)
      if ("error" in bookmarks) return bookmarks.error
      const source = bookmarks.rows.find((row) => row.name === fromBookmark)
      if (source === undefined) {
        return `Bookmark "${fromBookmark}" wasn't found in ${repo} — run /branches.list for the choices.`
      }
      // Multi's create defaults the target to "main" (create-pull-request
      // command.ts) and refuses when it is absent, rather than guessing.
      const targetBookmark = "main"
      const targetRow = bookmarks.rows.find((row) => row.name === targetBookmark)
      if (targetRow === undefined) {
        return `Target bookmark "${targetBookmark}" wasn't found in ${repo}.`
      }
      if (source.targetChangeId === targetRow.targetChangeId) {
        return `No changes over ${targetBookmark} — commit to ${fromBookmark} first.`
      }
      let changesResponse: Response
      try {
        changesResponse = await ctx.http(`${ctx.baseUrl}${repoApiRoot(repo)}/changes?limit=100`)
      } catch {
        return `The changes for ${repo} couldn't be read — the platform didn't answer.`
      }
      if (!changesResponse.ok) {
        return readErrorMessage(changesResponse, `The changes for ${repo} couldn't be read.`)
      }
      const changes = parseRepoChanges(await changesResponse.json().catch(() => undefined))
      const stack = deriveBookmarkStack(changes, source.targetChangeId, targetRow.targetChangeId)
      // Landing a partial stack would silently omit changes: a merge, missing
      // parent, cycle, or over-long walk is a hard local refusal (multi's stance).
      if (stack.length === 0) return "Couldn't derive the branch's change stack."
      let response: Response
      try {
        response = await ctx.http(landingsUrl(repo), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: trimmedTitle,
            body: "",
            source_bookmark: fromBookmark,
            target_bookmark: targetBookmark,
            change_ids: stack
          })
        })
      } catch {
        return "The pull request couldn't be opened — the platform didn't answer."
      }
      if (!response.ok) {
        return readErrorMessage(response, "The pull request couldn't be opened.")
      }
      const created = parseLandingRow(await response.json().catch(() => undefined))
      if (created === null) {
        return `The pull request was opened on ${repo}, but the platform's answer couldn't be read — run /prs.list to find it.`
      }
      // The one detail door: the created landing surfaces as the same "pr"
      // card every other read lands on.
      const refreshError = await surfaceLanding(repo, created.number)
      if (typeof refreshError !== "string") return
      return `Pull request #${created.number} was opened, but couldn't be re-read: ${refreshError}`
    },

    landLanding: async (number, repoArg) => {
      const target = resolveTargetRepo(ctx.store, repoArg)
      if ("error" in target) return target.error
      const repo = target.repo
      /*
       * plue's land names the commit it lands (LandLandingRequestInput
       * `commit_id`, required; the server refuses a land whose commit no
       * longer matches — ADR 0003). The request's tip change is read for its
       * current commit right before the PUT; a tip that can't be read lands
       * nothing.
       */
      const tip = await fetchTipCommit(repo, number)
      if ("error" in tip) return tip.error
      let response: Response
      try {
        response = await ctx.http(`${landingsUrl(repo)}/${number}/land`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commit_id: tip.commitId })
        })
      } catch {
        return `Pull request #${number} couldn't be queued to land — the platform didn't answer.`
      }
      if (!response.ok) {
        return readErrorMessage(response, `Pull request #${number} couldn't be queued to land.`)
      }
      // 202/200: the land is QUEUED. The card states the platform-returned
      // post-enqueue state (or "queued"); a re-read fills in the rest.
      const landed = parseLandingDetail(await response.json().catch(() => undefined))
      const state = landed?.state ?? "queued"
      const refreshError = await surfaceLanding(repo, number, state)
      if (typeof refreshError !== "string") return
      // The land itself succeeded, so a failed re-read must not report
      // failure. State the queued truth from the land answer plus whatever
      // the transcript already knows about this PR. The detail may be the
      // repository pane's current location rather than a card of its own.
      const pane = repoPaneCard(ctx, repo)
      const existing = pane !== undefined && pane.kind === "pr" && pane.payload.number === number ? pane : ctx.store.collections.cards.get(`pr-${repo}-${number}`)
      const kept = existing !== undefined && existing.kind === "pr" ? existing.payload : undefined
      const title = landed?.title ?? kept?.title ?? `Pull request #${number}`
      await publishRepoView(ctx, {
        id: `pr-${repo}-${number}`,
        kind: "pr",
        title: `#${number} ${title} · ${repo}`,
        status: "active",
        createdAt: Date.now(),
        ordinal: ctx.nextOrdinal(),
        payload: {
          repo,
          number,
          title,
          state,
          author: landed?.author ?? kept?.author ?? null,
          prBody: landed?.body ?? kept?.prBody ?? "",
          reviews: kept?.reviews ?? [],
          checks: kept?.checks ?? []
        }
      })
    },

    reviewLanding: async (number, type, body, repoArg) => {
      const target = resolveTargetRepo(ctx.store, repoArg)
      if ("error" in target) return target.error
      const repo = target.repo
      const text = body.trim()
      if (type !== "approve" && text === "") {
        // Plue 422s an empty body on these verbs; answer before the wire does.
        const verb = type === "comment" ? "comment" : "request-changes"
        return `A ${verb} review needs text: /prs.review ${number} ${verb} <why>`
      }
      const tip = await fetchTipCommit(repo, number)
      if ("error" in tip) return tip.error
      let response: Response
      try {
        response = await ctx.http(`${landingsUrl(repo)}/${number}/reviews`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type, body: text, commit_id: tip.commitId })
        })
      } catch {
        return `The review on #${number} couldn't be posted — the platform didn't answer.`
      }
      if (!response.ok) {
        return readErrorMessage(response, `The review on #${number} couldn't be posted.`)
      }
      const refreshError = await surfaceLanding(repo, number)
      if (typeof refreshError !== "string") return
      return `The review on #${number} was posted, but the pull request couldn't be re-read: ${refreshError}`
    }
  }
}
