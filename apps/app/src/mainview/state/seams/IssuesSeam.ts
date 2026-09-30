import { invalidatePreparedViews,preparedView,type ViewAction,type ViewResult } from "../PreparedView"
import { readRepositoryDetail } from "../RepositoryReadReceipts"
import { readRepositoryListError,repositoryListRead,type RepositoryForm } from "./RepositoryListSeam"

import type { Card } from "../AppState"
import { actorSharedState } from "../ActorBindings"
import { TOAST_SUPERSEDED } from "../controller/failures"
import type { FieldOption } from "@smthrs/ui/flow-form"
import { repositoryCiConfigured } from "../RepositoryJobs"
import { resolveTargetRepo, selectedBoxBinding } from "../RepoContext"
import type { SeamContext } from "./SeamContext"
import { captureCloudOwner,refusalWords,readErrorMessage,readResult,unreachableSentence } from "./SeamContext"
import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalLine } from "@smthrs/rpc/RefusalCopy"

import type { PersonaRef } from "@smthrs/rpc/Threads"

/** Which rows a list shows: every issue, only conversations, or only issues (smithers-ui-DESIGN.md §3.1). */
export type IssueKindFilter = "all" | "conversation" | "issue"
/** The backend's issue states; an issue moves open → fixed → verified → closed. */
export type IssueState = "open" | "fixed" | "verified" | "closed"

export interface IssuesSeam {
  /** Intent metadata (smithers-ui-DESIGN.md §3.2): PATCH one field on the issue. */
  readonly setIssueTask: (number: number, field: "owner" | "due" | "priority" | "parent", value: string, repo?: string) => Promise<string | void>
  readonly submitConversation: (text: string, turnId: string, repo: string, owner: string) => Promise<boolean>

  readonly draftIssueComment: (cardId: string, text: string) => Promise<string | void>
  readonly retryIssueComment: (cardId: string, requestId: string) => Promise<string | void>
  readonly reactToIssueComment: (number: number, commentId: number, name: string, active: boolean, repo?: string) => Promise<string | void>

  readonly subscribe: (onDispose: (release: () => void) => void) => void
  readonly resolveIssueSync: (cardId: string, deliveryId: number, action: "sent" | "skip" | "retry", evidence: string, messageId: string) => Promise<string | void>
  readonly mapIssueSync: (number: number, mapping: Omit<NonNullable<IssuePayload["sync"]>, "state" | "error">, repo?: string) => Promise<string | void>
  /** Renders the list card and answers the rows as text (the model reads the value, never the card). */
  readonly listIssues: ViewAction<[filter: "open" | "closed" | "all", repo?: string, kind?: IssueKindFilter, view?: string]>
  readonly viewIssue: ViewAction<[number: number, repo?: string, source?: "smithers-cloud" | "github"]>
  readonly createIssue: (title: string, repo?: string, kind?: "issue" | "chat") => Promise<string | void>
  readonly setIssueState: (
    number: number,
    state: IssueState,
    repo?: string
  ) => Promise<string | void>
  readonly editIssueComment: (number: number, commentId: number, text: string, repo?: string) => Promise<string | void>
  readonly deleteIssueComment: (number: number, commentId: number, repo?: string) => Promise<string | void>
  readonly commentOnIssue: (number: number, text: string, repo?: string, persona?: { username: string; iconEmoji?: string; iconUrl?: string }) => Promise<string | void | { readonly value: string }>
}

const issueMessageWrites = new WeakMap<SeamContext["store"], Set<string>>()

type IssueListPayload = Extract<Card, { kind: "issue-list" }>["payload"]
type IssueListRow = IssueListPayload["issues"][number]
type IssuePayload = Extract<Card, { kind: "issue" }>["payload"]
type IssueCommentRow = IssuePayload["comments"][number]
type ResolutionRequest = NonNullable<NonNullable<IssuePayload["sync"]>["resolution"]>
type ResolutionFlight = {
  readonly repo: string
  readonly number: number
  readonly request: ResolutionRequest
  readonly ownerValid: () => boolean
  admission?: Promise<void>
  admitting: boolean
  started: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const asInt = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) ? value : null

const asIssueState = (value: unknown): IssueState => value === "closed" || value === "fixed" || value === "verified" ? value : "open"
const asText = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined

/** A user summary off the wire (`{ login, avatar_url? }` or a bare login) as a persona. */
const taskPersonOf = (value: unknown): PersonaRef | undefined => {
  if (typeof value === "string") return value === "" ? undefined : { id: value, name: value }
  if (!isRecord(value)) return undefined
  const login = asText(value.login) ?? asText(value.username) ?? asText(value.name)
  if (login === undefined) return undefined
  const avatar = asText(value.avatar_url) ?? asText(value.iconUrl)
  return { id: login, name: login, ...(avatar === undefined ? {} : { iconUrl: avatar }) }
}

/**
 * The PATCH value for one intent field (#2186): owner is a login, due a
 * YYYY-MM-DD date, priority 0-3 and parent an issue number; an empty value
 * clears the field. Undefined when priority or parent is not a number.
 */
export const taskFieldValue = (field: "owner" | "due" | "priority" | "parent", value: string): string | number | null | undefined => {
  const text = value.trim()
  if (text === "") return null
  if (field === "owner" || field === "due") return text
  const digits = field === "priority" ? text.replace(/^p/i, "") : text.replace(/^#/, "")
  if (!/^\d+$/.test(digits)) return undefined
  const number = Number(digits)
  return field === "priority" ? (number <= 3 ? number : undefined) : (number > 0 ? number : undefined)
}

/** Intent metadata the issue carries, when it carries any (owner, due, priority, parent, fixer, verifier). */
const taskOf = (value: Record<string, unknown>): IssueListRow["task"] => {
  const owner = taskPersonOf(value.owner)
  const fixedBy = taskPersonOf(value.fixed_by)
  const verifiedBy = taskPersonOf(value.verified_by)
  const priority = asInt(value.priority)
  const parentNumber = isRecord(value.parent) ? asInt(value.parent.number) : null
  const due = asText(value.due)
  const task = {
    ...(owner === undefined ? {} : { owner }),
    ...(due === undefined ? {} : { due }),
    ...(priority === null || priority < 0 || priority > 3 ? {} : { priority: priority as 0 | 1 | 2 | 3 }),
    ...(parentNumber === null ? {} : { parent: { number: parentNumber, ...(isRecord(value.parent) && asText(value.parent.title) !== undefined ? { title: value.parent.title as string } : {}) } }),
    ...(fixedBy === undefined ? {} : { fixedBy }),
    ...(verifiedBy === undefined ? {} : { verifiedBy })
  }
  return Object.keys(task).length === 0 ? undefined : task
}

/** The author login off Plue's `author: { login }` shape, or null. */
const authorLogin = (value: unknown): string | null =>
  isRecord(value) && typeof value.login === "string" && value.login !== "" ? value.login : null

/** Optional forge facts stay absent when the read did not supply them. */
const forgeFacts = (value: Record<string, unknown>, author: unknown): Pick<IssuePayload, "createdAt" | "assignees" | "labelColors" | "authorAvatar"> => ({
  ...(typeof value.created_at === "string" ? { createdAt: value.created_at } : {}),
  ...(Array.isArray(value.assignees) ? { assignees: value.assignees.flatMap(person =>
    isRecord(person) && typeof person.login === "string" && person.login !== ""
      ? [{ login: person.login, ...(typeof person.avatar_url === "string" ? { avatar: person.avatar_url } : {}) }] : []) } : {}),
  ...(Array.isArray(value.labels) ? { labelColors: Object.fromEntries(value.labels.flatMap(label =>
    isRecord(label) && typeof label.name === "string" && typeof label.color === "string"
      ? [[label.name, label.color]] : [])) } : {}),
  ...(isRecord(author) && typeof author.avatar_url === "string" ? { authorAvatar: author.avatar_url } : {})
})

const commentOrigin = (value: unknown): "app" | "slack" | "telegram" | undefined =>
  value === "app" || value === "slack" || value === "telegram" ? value : undefined

/** The backend's `last_comment` ({commenter, persona, excerpt, origin, created_at}): null when the issue has no comments, absent when malformed. */
const parseLastComment = (value: unknown): IssueListRow["lastComment"] => {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const origin = commentOrigin(value.origin)
  if (typeof value.commenter !== "string" || typeof value.excerpt !== "string" || typeof value.created_at !== "string" || origin === undefined) return undefined
  const persona = isRecord(value.persona) && typeof value.persona.username === "string" && value.persona.username.trim() !== "" ? value.persona.username : undefined
  return { commenter: value.commenter, ...(persona === undefined ? {} : { persona }), excerpt: value.excerpt, origin, createdAt: value.created_at }
}

const lastCommentOf = (value: Record<string, unknown>): Pick<IssueListRow, "lastComment"> => {
  const lastComment = parseLastComment(value.last_comment)
  return lastComment === undefined ? {} : { lastComment }
}

/** One list row; null when the entry carries no usable issue number. */
const parseListRow = (value: unknown): IssueListRow | null => {
  if (!isRecord(value)) return null
  const number = asInt(value.number)
  if (number === null) return null
  const comments = asInt(value.comment_count)
  return {
    number,
    ...(value.kind === "chat" ? { kind: "chat" as const } : {}),
    title: typeof value.title === "string" ? value.title : "",
    state: asIssueState(value.state),
    author: authorLogin(value.author),
    ...forgeFacts(value, value.author),
    labels: parseLabels(value.labels),
    comments: comments !== null && comments >= 0 ? comments : 0,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null,
    ...lastCommentOf(value),
    ...(taskOf(value) === undefined ? {} : { task: taskOf(value) })
  }
}

/*
 * One list row off GitHub's issue shape — the source-only fallback read
 * (`/api/user/github-repos/{o}/{r}/issues`; multi src/smithersCloud/
 * githubIssues.ts parseIssue). GitHub's issues endpoint includes pull
 * requests; presence of `pull_request`, not its shape, is the documented
 * discriminator, so those rows drop. Author sits under `user.login` and the
 * comment count under `comments` — different spellings, same card row.
 */
const parseGithubListRow = (value: unknown): IssueListRow | null => {
  if (!isRecord(value) || "pull_request" in value) return null
  const number = asInt(value.number)
  if (number === null) return null
  const comments = asInt(value.comments)
  return {
    number,
    source: "github",
    ...(typeof value.html_url === "string" ? { htmlUrl: value.html_url } : {}),
    title: typeof value.title === "string" ? value.title : "",
    state: asIssueState(value.state),
    author: authorLogin(value.user),
    ...forgeFacts(value, value.user),
    labels: parseLabels(value.labels),
    comments: comments !== null && comments >= 0 ? comments : 0,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null
  }
}

/** Label names are the stable keys; forgeFacts supplies their optional colors. */
const parseLabels = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((label) => isRecord(label) && typeof label.name === "string" ? [label.name] : [])
    : []

/** One comment off Plue's IssueCommentResponse shape; null when not a record. */
const parseComment = (value: unknown): IssueCommentRow | null => {
  if (!isRecord(value)) return null
  const persona = isRecord(value.persona) && typeof value.persona.username === "string" && value.persona.username.trim() !== "" ? {
    username: value.persona.username,
    ...(typeof value.persona.iconEmoji === "string" ? { iconEmoji: value.persona.iconEmoji } : {}),
    ...(typeof value.persona.iconUrl === "string" ? { iconUrl: value.persona.iconUrl } : {})
  } : undefined
  return {
    ...(asInt(value.id) !== null ? { id: value.id as number } : {}),
    ...(typeof value.idempotency_key === "string" ? { idempotencyKey: value.idempotency_key } : {}),
    ...(persona ? { persona, ...(persona.iconUrl ? { authorAvatar: persona.iconUrl } : {}) } : {}),
    author: typeof value.commenter === "string" && value.commenter !== "" ? value.commenter : null,
    commentBody: typeof value.body === "string" ? value.body : "",
    createdAt: typeof value.created_at === "string" ? value.created_at : null,
    ...(commentOrigin(value.origin) === undefined ? {} : { origin: commentOrigin(value.origin) })
  }
}

/** The detail payload; null only when the body is not a record at all. */
const parseDetail = (
  value: unknown,
  repo: string,
  number: number,
  comments: ReadonlyArray<IssueCommentRow>
): IssuePayload | null => {
  if (!isRecord(value)) return null
  return {
    repo,
    number: asInt(value.number) ?? number,
    ...(value.kind === "chat" ? { kind: "chat" as const } : {}),
    title: typeof value.title === "string" ? value.title : "",
    state: asIssueState(value.state),
    author: authorLogin(value.author),
    ...forgeFacts(value, value.author),
    ...(value.visibility === "private" || value.visibility === "public" ? { visibility: value.visibility } : {}),
    issueBody: typeof value.body === "string" ? value.body : "",
    labels: parseLabels(value.labels),
    comments: [...comments],
    ...lastCommentOf(value),
    ...(taskOf(value) === undefined ? {} : { task: taskOf(value) }),
  }
}

/** One row formatter for imported and GitHub-source issue results. */
const issueRowValue = (issue: IssueListRow, source = issue.source): string =>
  `#${issue.number} ${issue.title} · ${issue.state}${source === "github" ? " · GitHub" : ""}`

/** The imported tracker's issues route for a repository. */
const issuesRoute = (ctx: Pick<SeamContext, "baseUrl">, repo: string): string => {
  const [owner = "", name = ""] = repo.split("/")
  return `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`
}

/** The saved issue views route (the factory's issueViews) for a repository. */
const issueViewsRoute = (ctx: Pick<SeamContext, "baseUrl">, repo: string): string => issuesRoute(ctx, repo).replace(/\/issues$/, "/issue-views")

/** One declared view as the list card offers it. */
const parseIssueView = (value: unknown): { readonly id: string; readonly title: string } | null =>
  isRecord(value) && typeof value.id === "string" && value.id !== "" && typeof value.title === "string" && value.title !== ""
    ? { id: value.id, title: value.title }
    : null

/*
 * IMPORT-READINESS (multi src/smithersCloud/importReadiness.ts): the
 * `/api/repos/{o}/{r}/**` namespace only exists for repositories IMPORTED
 * into Smithers Cloud — for a source-only repo every request there answers
 * 404. The same repo's GitHub-source metadata still lists issues through
 * `GET /api/user/github-repos/{o}/{r}/issues` (GET-only through the
 * Worker), so reads degrade to the source list; mutations never fall back.
 */
const githubIssuesRoute = (ctx: Pick<SeamContext, "baseUrl">, repo: string, filter: "open" | "closed" | "all"): string => {
  const [owner = "", name = ""] = repo.split("/")
  // GitHub accepts state=all (only Plue's imported namespace rejects it).
  return `${ctx.baseUrl}/api/user/github-repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?state=${filter}`
}

/**
 * The open issues of a repository as a form's options (the Fix an issue
 * app's picker, controller/forms.ts `issues`): Smithers Cloud's own tracker,
 * read exactly as the issues list reads it. A source-only repository
 * answers no options and names the import door, since Fix cannot use GitHub
 * source issues.
 */
export const readIssueOptions = async (
  ctx: Pick<SeamContext, "http" | "baseUrl">,
  repo: string
): Promise<{ readonly options: ReadonlyArray<FieldOption>; readonly error?: string }> => {
  const option = (row: IssueListRow): FieldOption => ({ value: String(row.number), label: `#${row.number} ${row.title}` })
  const read = async (url: string): Promise<{ readonly rows?: ReadonlyArray<unknown>; readonly status?: number; readonly error?: string }> => {
    let response: Response
    try {
      response = await ctx.http(url)
    } catch (error) {
      return { error: unreachableSentence(`the backend to list issues for ${repo}`, error) }
    }
    if (!response.ok) return { status: response.status, error: await readRepositoryListError(response, `Listing issues for ${repo} failed (${response.status})`) }
    const body: unknown = await response.json().catch(() => null)
    return Array.isArray(body) ? { rows: body } : { error: `The backend answered issues for ${repo} with an unreadable payload` }
  }
  const native = await read(`${issuesRoute(ctx, repo)}?state=open`)
  if (native.rows !== undefined) {
    return { options: native.rows.flatMap((entry) => {
      const parsed = parseListRow(entry)
      return parsed === null || parsed.kind === "chat" ? [] : [option(parsed)]
    }) }
  }
  if (native.status !== 404) return { options: [], error: native.error }
  return { options: [], error: `Import ${repo} to fix an issue: /repos.import ${repo}` }
}

/*
 * A 404 on an issue route, split on its typed code, never the platform's prose.
 * `not_found`, or no code at all, is the issue or repository missing: the
 * caller's `whenNotFound` (on a mutation, a codeless answer keeps plue's own
 * words when it wrote any). Any other code, `route_not_found` above all, is
 * the address itself missing, which says nothing about the issue: it reads as
 * the act that failed and that code's verdict.
 */
const issue404 = async (response: Response, act: string, whenNotFound: string, codelessWords = true): Promise<string> => {
  const body: unknown = await response.json().catch(() => null)
  const refusal = refusalOf({ body, status: response.status, message: refusalWords(body, whenNotFound, response.status) })
  if (refusal.code === "not_found") return whenNotFound
  if (refusal.rawCode === null) return codelessWords ? refusalLine(refusal, whenNotFound) : whenNotFound
  return refusalLine(refusal, act)
}

/** The native tracker has no such issue; a GitHub issue has its own door. */
const nativeIssueMissing = (repo: string, number: number): string =>
  `Issue #${number} in ${repo} was not found. For a GitHub issue, use /issues.view ${number} ${repo} --source github.`

/**
 * One imported issue's payload without a card: what `issue.implement` hands
 * the coding flow when the person picked the issue on the app home rather
 * than opening it first. Comments stay with the issue card.
 */
export const fetchIssuePayload = async (
  ctx: Pick<SeamContext, "http" | "baseUrl">,
  repo: string,
  number: number
): Promise<IssuePayload | string> => {
  let response: Response
  try {
    response = await ctx.http(`${issuesRoute(ctx, repo)}/${number}`)
  } catch (error) {
    return unreachableSentence(`the backend to load issue #${number} in ${repo}`, error)
  }
  if (!response.ok) {
    return response.status === 404
      ? issue404(response, `Loading issue #${number} in ${repo} failed (404)`, nativeIssueMissing(repo, number), false)
      : readErrorMessage(response, `Loading issue #${number} in ${repo} failed (${response.status})`)
  }
  const payload = parseDetail(await response.json().catch(() => null), repo, number, [])
  return payload ?? `The backend answered issue #${number} in ${repo} with an unreadable payload`
}

export const createIssuesSeam = (ctx: SeamContext, renderRepositoryForm?: RepositoryForm, launchConversationTurn?: (text: string, turnId: string, owner: string) => Promise<boolean> | void): IssuesSeam => {
  const signedInOwner = () => {
    const identity = ctx.store.collections.identitySessions.get("identity")
    const cloud = ctx.store.collections.cloudSessions.get("cloud")
    return identity?.state === "signed-in" ? identity.login : cloud?.state === "signed-in" ? cloud.username : undefined
  }
  const issuesPath = (repo: string): string => issuesRoute(ctx, repo)
  const githubSourceIssuesPath = (repo: string, filter: "open" | "closed" | "all"): string => githubIssuesRoute(ctx, repo, filter)


  const unreachable = (what: string, error: unknown): string => unreachableSentence(`the backend to ${what}`, error)

  /**
   * GitHub's issues for `repo`, through the GitHub-source route, with the
   * read's provenance from plue's X-Metadata-* headers. A refusal answers
   * no rows and the reason; the caller states it beside Smithers Cloud's own list.
   */
  const readGithubIssues = async (
    repo: string,
    filter: "open" | "closed" | "all"
  ): Promise<{
    readonly issues: Array<IssueListRow & { readonly source: "github"; readonly htmlUrl?: string }>
    readonly meta?: { source: string; syncedAt: string | null; stale: boolean; syncError: string | null; refusal: string | null }
  }> => {
    let response: Response
    try {
      response = await ctx.http(githubSourceIssuesPath(repo, filter))
    } catch {
      // The tapped fetch recorded the thrown request; its text is not copy.
      return { issues: [], meta: { source: "unreachable", syncedAt: null, stale: false, syncError: null, refusal: "Could not reach GitHub." } }
    }
    const meta = {
      source: response.headers.get("x-metadata-source") ?? (response.ok ? "github" : "refused"),
      syncedAt: response.headers.get("x-metadata-synced-at"),
      stale: response.headers.get("x-metadata-stale") === "true",
      syncError: response.headers.get("x-metadata-sync-error"),
      refusal: null as string | null
    }
    if (!response.ok) {
      return { issues: [], meta: { ...meta, refusal: await readErrorMessage(response, `GitHub issues answered ${response.status}`) } }
    }
    const body: unknown = await response.json().catch(() => null)
    if (!Array.isArray(body)) return { issues: [], meta: { ...meta, refusal: "GitHub issues answered an unreadable payload" } }
    const issues = body.flatMap((entry) => {
      const parsed = parseGithubListRow(entry)
      if (parsed === null) return []
      const htmlUrl = typeof (entry as { html_url?: unknown }).html_url === "string" ? (entry as { html_url: string }).html_url : undefined
      return [{ ...parsed, source: "github" as const, ...(htmlUrl === undefined ? {} : { htmlUrl }) }]
    })
    return { issues, meta }
  }

  /** The source-only list read; the card carries the degradation note in `body`. */
  const listFromGithubSource = async (
    repo: string,
    filter: "open" | "closed" | "all"
  ): Promise<ViewResult> => {
    let response: Response
    try {
      response = await ctx.http(githubSourceIssuesPath(repo, filter))
    } catch (error) {
      return unreachable(`list issues for ${repo} from its GitHub source`, error)
    }
    // A source 404 too: the repo is nowhere — the plain honest error, no card.
    if (!response.ok) {
      return readRepositoryListError(response, `Listing issues for ${repo} failed (${response.status})`)
    }
    const body: unknown = await response.json().catch(() => null)
    if (!Array.isArray(body)) {
      return `The backend answered issues for ${repo} with an unreadable payload`
    }
    const issues = body.flatMap((entry) => {
      const parsed = parseGithubListRow(entry)
      return parsed === null ? [] : [parsed]
    })
    const card: Card = {
      id: `issues-${repo}`,
      kind: "issue-list",
      title: `Issues · ${repo}`,
      body: `Read from GitHub — import for full features: /repos.import ${repo}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload: { repo, filter, issues, github: {
        source: response.headers.get("x-metadata-source") ?? "github",
        syncedAt: response.headers.get("x-metadata-synced-at"),
        stale: response.headers.get("x-metadata-stale") === "true",
        syncError: response.headers.get("x-metadata-sync-error"),
        refusal: null
      } }
    }
    return { card, ...readResult(issues.length === 0
      ? `No ${filter === "all" ? "" : `${filter} `}issues in ${repo} (read from GitHub).`
      : issues.map((issue) => issueRowValue(issue, "github")).join("\n")) }
  }

  /** GitHub has a separate tracker. Its supported metadata routes expose full issue bodies in the list. */
  const readGithubIssue = async (repo: string, number: number): Promise<ViewResult> => {
    const listPath = githubSourceIssuesPath(repo, "all")
    let issue: Record<string, unknown> | undefined
    for (let page = 1; page <= 50; page += 1) {
      let response: Response
      try { response = await ctx.http(`${listPath}&per_page=100&page=${page}`) }
      catch (error) { return unreachable(`load GitHub issue #${number} in ${repo}`, error) }
      if (!response.ok) return readErrorMessage(response, `Loading GitHub issue #${number} failed (${response.status})`)
      const rows: unknown = await response.json().catch(() => null)
      if (!Array.isArray(rows)) return `GitHub answered issues for ${repo} with an unreadable payload`
      issue = rows.find((row): row is Record<string, unknown> => isRecord(row) && row.number === number && !("pull_request" in row))
      if (issue) break
      // Rebuild our own scoped route; never follow a server-provided host or path.
      if (!/rel="?next"?/.test(response.headers.get("link") ?? "")) break
    }
    if (!issue) return `GitHub issue #${number} in ${repo} was not found. Refresh the issue list and try again.`
    const comments: IssueCommentRow[] = []
    const commentsPath = `${listPath.split("?")[0]}/${number}/comments`
    for (let page = 1; page <= 50; page += 1) {
      let response: Response
      try { response = await ctx.http(`${commentsPath}?per_page=100&page=${page}`) }
      catch (error) { return unreachable(`load comments for GitHub issue #${number} in ${repo}`, error) }
      if (!response.ok) return readErrorMessage(response, `Loading GitHub issue comments failed (${response.status})`)
      const rows: unknown = await response.json().catch(() => null)
      if (!Array.isArray(rows)) return `GitHub answered comments for #${number} with an unreadable payload`
      comments.push(...rows.flatMap(row => isRecord(row) ? [{
        author: authorLogin(row.user),
        ...(isRecord(row.user) && typeof row.user.avatar_url === "string" ? { authorAvatar: row.user.avatar_url } : {}),
        commentBody: typeof row.body === "string" ? row.body : "",
        createdAt: typeof row.created_at === "string" ? row.created_at : null
      }] : []))
      if (!/rel="?next"?/.test(response.headers.get("link") ?? "")) break
      if (page === 50) return `GitHub issue #${number} has more comments than could be loaded. Open it on GitHub to read the full conversation.`
    }
    const payload = parseDetail({ ...issue, author: issue.user }, repo, number, comments)!
    payload.source = "github"
    payload.htmlUrl = `https://github.com/${repo}/issues/${number}`
    const card: Card = {
      id: `issue-github-${repo}-${number}`, kind: "issue", title: `GitHub issue #${number} · ${repo}`,
      status: "active", createdAt: Date.now(), ordinal: ctx.nextOrdinal(), payload
    }
    return { card, ...readResult([
      `${repo} · GitHub #${number} ${payload.title} · ${payload.state}`,
      `Author: ${payload.author ?? "unknown"}`,
      `Labels: ${payload.labels.join(", ") || "none"}`, payload.issueBody,
      ...comments.map(comment => `Comment by ${comment.persona?.username ?? comment.author ?? "unknown"}:\n${comment.commentBody}`)
    ].join("\n")) }
  }

  /** Fetches the issue AND its comments, then upserts the detail card. */
  const readIssue = async (repo: string, number: number): Promise<ViewResult> => {
    let issueResponse: Response
    try {
      issueResponse = await ctx.http(`${issuesPath(repo)}/${number}`)
    } catch (error) {
      return unreachable(`load issue #${number} in ${repo}`, error)
    }
    if (!issueResponse.ok) {
      if (issueResponse.status === 404) {
        return issue404(issueResponse, `Loading issue #${number} in ${repo} failed (404)`, nativeIssueMissing(repo, number), false)
      }
      return readErrorMessage(
        issueResponse,
        `Loading issue #${number} in ${repo} failed (${issueResponse.status})`
      )
    }
    const issueJson: unknown = await issueResponse.json().catch(() => null)

    const comments: IssueCommentRow[] = []
    let cursor = ""
    const seen = new Set<string>()
    for (let page = 1; page <= 50; page++) {
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(repo)}/${number}/comments${cursor === "" ? "" : `?cursor=${encodeURIComponent(cursor)}`}`)
      } catch (error) { return unreachable(`load comments for issue #${number} in ${repo}`, error) }
      if (!response.ok) return readErrorMessage(response, `Loading comments for issue #${number} in ${repo} failed (${response.status})`)
      const rows: unknown = await response.json().catch(() => null)
      if (!Array.isArray(rows)) return `The backend answered comments for #${number} with an unreadable payload`
      comments.push(...rows.flatMap(row => { const parsed = parseComment(row); return parsed ? [parsed] : [] }))
      const next = /<([^>]+)>;\s*rel="?next"?/.exec(response.headers.get("link") ?? "")?.[1]
      if (!next) break
      // Read only the opaque cursor; never follow a returned origin or path.
      cursor = new URL(next, "https://pagination.invalid").searchParams.get("cursor") ?? ""
      if (!cursor || seen.has(cursor)) return `Comments for #${number} did not finish loading.`
      seen.add(cursor)
      if (page === 50) return `Issue #${number} has more comments than could be loaded.`
    }

    const payload = parseDetail(issueJson, repo, number, comments)
    if (payload === null) {
      return `The backend answered issue #${number} in ${repo} with an unreadable payload`
    }
    if (payload.kind === "chat") {
      const mapping = await ctx.http(`${issuesPath(repo)}/${number}/sync`)
      if (mapping.ok) {
        const wire: unknown = await mapping.json().catch(() => null)
        if (isRecord(wire) && (wire.provider === "slack" || wire.provider === "telegram") && typeof wire.connection_id === "string" && typeof wire.scope_id === "string" && typeof wire.conversation_id === "string") {
          payload.sync = { provider: wire.provider, connectionId: wire.connection_id, scopeId: wire.scope_id, conversationId: wire.conversation_id, ...(typeof wire.thread_id === "string" && wire.thread_id ? { threadId: wire.thread_id } : {}), ...(typeof wire.external_user_id === "string" && wire.external_user_id ? { externalUserId: wire.external_user_id } : {}) }
          if (wire.state === "synced" || wire.state === "pending" || wire.state === "dispatching" || wire.state === "outcome_unknown" || wire.state === "failed" || wire.state === "unsupported") payload.sync.state = wire.state
          if (typeof wire.resolution_token === "string") payload.sync.resolutionToken = wire.resolution_token
          if (typeof wire.delivery_id === "number" && wire.delivery_id > 0) payload.sync.deliveryId = wire.delivery_id
          if (typeof wire.error === "string" || wire.error === null) payload.sync.error = wire.error
        }
      } else if (mapping.status !== 404) return readErrorMessage(mapping, `Loading sync settings failed (${mapping.status})`)
      for (const comment of payload.comments) {
        if (comment.id === undefined) continue
        const response = await ctx.http(`${issuesPath(repo)}/${number}/comments/${comment.id}/reactions`)
        if (!response.ok) {
          if (response.status === 404) continue
          return readErrorMessage(response, `Loading reactions failed (${response.status})`)
        }
        const rows: unknown = await response.json().catch(() => null)
        if (!Array.isArray(rows)) return "Reactions returned an unreadable response."
        comment.reactions = rows.flatMap(row => isRecord(row) && typeof row.name === "string" && typeof row.actor === "string" && typeof row.active === "boolean" ? [{ name: row.name, actor: row.actor, active: row.active }] : [])
      }
    }
    const card: Card = {
      id: `issue-${repo}-${number}`,
      kind: "issue",
      title: payload.kind === "chat" ? payload.title : `Issue #${number} · ${repo}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload
    }
    return { card, ...readResult([
      `${payload.repo} · #${payload.number} ${payload.title} · ${payload.state}`,
      `Author: ${payload.author ?? "unknown"}`,
      `Labels: ${payload.labels.join(", ") || "none"}`,

      payload.issueBody,
      ...payload.comments.map((comment) =>
        `Comment by ${comment.persona?.username ?? comment.author ?? "unknown"}${comment.createdAt ? ` · ${comment.createdAt}` : ""}:\n${comment.commentBody}`)
    ].join("\n")) }
  }

  /**
   * The saved issue views the repository's factory declares, or none when
   * the read fails: the chips are a door onto the list, and a view the
   * person selects reports its own failure through the list read.
   */
  const readIssueViews = async (repo: string): Promise<ReadonlyArray<{ readonly id: string; readonly title: string }>> => {
    try {
      const response = await ctx.http(issueViewsRoute(ctx, repo))
      if (!response.ok) return []
      const body: unknown = await response.json().catch(() => null)
      return Array.isArray(body) ? body.flatMap((entry) => { const view = parseIssueView(entry); return view === null ? [] : [view] }) : []
    } catch {
      return []
    }
  }

  const listView = preparedView(ctx, (filter: "open" | "closed" | "all", repoArg?: string, kind: IssueKindFilter = "all", view?: string) => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    // A saved view carries its own state and addresses Smithers' own tracker (the API refuses view with state).
    const named = view === undefined || view === "" ? undefined : view
    return { id: `issues-${repo}`, title: `Issues · ${repo}`, key: JSON.stringify(["issues", repo, filter, kind, named ?? null]), pane: repo, read: async (): Promise<ViewResult> => {
      // Plue 422s unknown states ("all" included) — omit the param to list every state.
      const search = new URLSearchParams()
      if (named !== undefined) search.set("view", named)
      else if (filter !== "all") search.set("state", filter)
      // Conversations are owner-private and excluded from the plain list; ask for them by kind (chat = issues contract; #2111).
      if (kind === "conversation") search.set("kind", "chat")
      const query = search.size === 0 ? "" : `?${search}`
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(repo)}${query}`)
      } catch (error) {
        return unreachable(`list issues for ${repo}`, error)
      }
      if (!response.ok) {
        // The imported namespace 404s ⇔ the repo isn't imported: degrade to
        // the GitHub-source list instead of surfacing a broken 404. A named
        // view 404s when it is not declared: that is the answer, not a fallback.
        if (response.status === 404 && named !== undefined) return readRepositoryListError(response, `Listing the ${named} view of ${repo} failed (${response.status})`)
        if (response.status === 404) return listFromGithubSource(repo, filter)
        if (response.status === 401) ctx.dispatch({ type: "card.removed", actor: ctx.actor(), id: `issues-${repo}` })
        return readRepositoryListError(response, `Listing issues for ${repo} failed (${response.status})`)
      }
      const body: unknown = await response.json().catch(() => null)
      if (!Array.isArray(body)) {
        return `The backend answered issues for ${repo} with an unreadable payload`
      }
      const native = body.flatMap((entry) => {
        const parsed = parseListRow(entry)
        return parsed === null ? [] : [{ ...parsed, source: "smithers-cloud" as const }]
      }).filter((row) => kind === "all" || (kind === "conversation" ? row.kind === "chat" : row.kind !== "chat"))
      /*
       * Smithers Cloud's /issues is the repository's OWN tracker and is correctly
       * empty for a repo mirrored from GitHub; the upstream issues live at
       * the GitHub-source route (synced store or live GitHub, per plue). One
       * list shows both, each row labeled with where it came from, and the
       * GitHub read's provenance rides the card. A GitHub refusal (not
       * linked, not mirrored) is stated, never a silent absence.
       */
      // Read before GitHub: a GitHub 401 re-probes the session, and the view must settle in the scope it started in.
      const views = await readIssueViews(repo)
      // Conversations and saved views live in Smithers' own tracker; GitHub's rows join the unfiltered and issues lists.
      const github = kind === "conversation" || named !== undefined ? { issues: [], meta: undefined } : await readGithubIssues(repo, filter)
      const issues = [...native, ...github.issues]
      const card: Card = {
        id: `issues-${repo}`,
        kind: "issue-list",
        title: kind === "conversation" ? `Conversations · ${repo}` : `Issues · ${repo}`,
        status: "active",
        createdAt: Date.now(),
        ordinal: ctx.nextOrdinal(),
        payload: {
          repo, filter, issues,
          ...(kind === "all" ? {} : { kind }),
          ...(github.meta === undefined ? {} : { github: github.meta }),
          ...(named === undefined ? {} : { view: named }),
          ...(views.length === 0 ? {} : { views: [...views] })
        }
      }
      return { card, ...readResult(issues.length === 0
        ? `No ${filter === "all" ? "" : `${filter} `}${kind === "conversation" ? "conversations" : "issues"} in ${repo}${github.meta?.refusal ? ` (GitHub: ${github.meta.refusal})` : ""}.`
        : issues.map((issue) => issueRowValue(issue)).join("\n")) }
    } }
  })
  const issueView = preparedView(ctx, (number: number, repoArg?: string, source?: "smithers-cloud" | "github") => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const bound = [...ctx.store.collections.cards.values()].find(card => card.kind === "issue" && card.payload.conversation && card.payload.repo === repo && card.payload.number === number && source !== "github")
    return { id: `issue-${source === "github" ? "github-" : ""}${repo}-${number}`, title: `Issue #${number} · ${repo}`, pane: repo, ...(bound ? { target: bound } : {}),
      project: card => {
        if (card.kind !== "issue") return card
        const previous = [...ctx.store.collections.cards.values()].find(row => row.kind === "issue" && row.payload.source !== "github" && row.payload.repo === repo && row.payload.number === number)
        return previous?.kind === "issue" && source !== "github" ? { ...card, payload: { ...card.payload, conversation: previous.payload.conversation, commentDraft: previous.payload.commentDraft, pendingComments: previous.payload.pendingComments } } : card
      },
      read: () => source === "github" ? readGithubIssue(repo, number) : readIssue(repo, number) }
  })
  const showIssue = (repo: string, number: number) => issueView(number, repo)

  /** Re-fetch after a successful mutation; a refresh failure still states the mutation happened. */
  const refreshDetail = async (
    done: string,
    repo: string,
    number: number
  ): Promise<string | void> => {
    invalidatePreparedViews(ctx.store)
    const outcome = await showIssue(repo, number)
    if (typeof outcome === "string") return `${done}, but refreshing the card failed: ${outcome}`
  }

  const showCommentNotice = (
    key: string,
    title: string,
    detail: string,
    action?: { readonly label: string; readonly flow: "issues.view"; readonly args: string }
  ): void => {
    ctx.dispatch({ type: "toast.shown", actor: "system", key, title, action })
    if (ctx.resolveToast) ctx.resolveToast(key, { status: "failed", detail, action })
    else ctx.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", detail, action })
  }

  const refreshCommentDetail = async (repo: string, number: number): Promise<void | { readonly value: string }> => {
    invalidatePreparedViews(ctx.store)
    let failure: string | undefined
    try {
      const outcome = await showIssue(repo, number)
      if (typeof outcome === "string") failure = outcome
    } catch {
      failure = "The issue could not be reloaded."
    }
    if (failure === undefined) return
    const detail = `Refresh failed: ${failure}`
    const key = `issue.comment.refresh:${repo}:${number}`
    const action = { label: "Retry", flow: "issues.view" as const, args: `${number} ${repo}` }
    showCommentNotice(key, "Comment posted", detail, action)
    return { value: `Comment posted. ${detail}` }
  }

  const mutateComment = async (number: number, commentId: number, explicitRepo: string | undefined, method: "PATCH" | "DELETE", body?: { body: string }): Promise<string | void> => {
    const target = resolveTargetRepo(ctx.store, explicitRepo)
    if ("error" in target) return target.error
    const { repo } = target
    // The global comment route does not carry the issue number. Only mutate a
    // comment from the issue card's authoritative read, never an unrelated ID.
    const comment = [...ctx.store.collections.cards.values()].some(card => card.kind === "issue" && card.payload.source !== "github" && card.payload.repo === repo && card.payload.number === number && card.payload.comments.some(row => row.id === commentId))
    if (!comment) return "Open the message before changing it."
    let response: Response
    try {
      response = await ctx.http(`${issuesPath(repo)}/comments/${commentId}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) })
    } catch { return "Message status unknown: nothing answered. Refresh to check." }
    if (!response.ok) return readErrorMessage(response, `Changing the message failed (${response.status})`)
    await response.body?.cancel().catch(() => {})
    return refreshDetail(method === "DELETE" ? "Message deleted" : "Message saved", repo, number)
  }

  const updateLocalIssue = async (cardId: string, update: (payload: IssuePayload) => IssuePayload, actor: "user" | "smithers" | "system" = ctx.actor(), authoritative = false) => {
    const card = ctx.store.collections.cards.get(cardId)
    if (card?.kind !== "issue") return
    await ctx.dispatch({ type: authoritative ? "card.view.loaded" : "card.upsert", actor, card: { ...card, payload: update(card.payload) } }).isPersisted.promise
  }
  const drainComments = (cardId: string): void => {
    if (ctx.isDisposed?.() || !(ctx.store.collections.identitySessions.get("identity")?.state === "signed-in" || ctx.store.collections.cloudSessions.get("cloud")?.state === "signed-in")) return
    let active = issueMessageWrites.get(ctx.store)
    if (!active) issueMessageWrites.set(ctx.store, active = new Set())
    if (active.has(cardId)) return
    const card = ctx.store.collections.cards.get(cardId)
    if (card?.kind !== "issue" || !card.payload.pendingComments?.some(request => request.status === "requested")) return
    const first = card.payload.pendingComments?.find(row => row.status === "requested" && !row.turnId) ?? card.payload.pendingComments?.find(row => row.status === "requested")
    if (first?.turnId && ctx.store.session().phase !== "idle") return
    const ownerValid = captureCloudOwner(ctx, false)
    const requestOwner = first?.owner ?? card.payload.conversation?.owner ?? card.payload.author
    const currentOwner = () => ownerValid() && requestOwner !== undefined && requestOwner !== null && requestOwner === signedInOwner() && (!card.payload.conversation || card.payload.conversation.owner === requestOwner && card.payload.conversation.branchId === ctx.store.session().activeBranchId)
    if (!currentOwner()) return
    active.add(cardId)
    const send = async () => {
      while (currentOwner()) {
        const current = ctx.store.collections.cards.get(cardId)
        if (current?.kind !== "issue") break
        const request = current.payload.pendingComments?.find(row => row.status === "requested" && !row.turnId) ?? current.payload.pendingComments?.find(row => row.status === "requested")
        if (!request || (request.owner ?? current.payload.conversation?.owner ?? current.payload.author) !== signedInOwner() || request.turnId && ctx.store.session().phase !== "idle") break
        const sameThread = () => {
          const live = ctx.store.collections.cards.get(cardId)
          return currentOwner() && live?.kind === "issue" && live.payload.repo === current.payload.repo && (live.payload.number === current.payload.number || current.payload.number === 0 && live.payload.conversation?.creationKey === current.payload.conversation?.creationKey)
        }
        const fail = async (status: "unknown" | "failed", error: string) => {
          if (!sameThread()) return
          await updateLocalIssue(cardId, payload => ({ ...payload, pendingComments: payload.pendingComments?.map(row => row.id === request.id ? { ...row, status, error } : row) }), "system")
          return error
        }
        const work = async () => {
          let number = current.payload.number
          if (number === 0 && current.payload.conversation) {
            let created: Response
            try {
              created = await ctx.http(issuesPath(current.payload.repo), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: current.payload.title, kind: "chat", visibility: "private", idempotency_key: current.payload.conversation.creationKey }) })
            } catch { return fail("unknown", "Chat status unknown: nothing answered. Retry to check.") }
            if (!currentOwner()) return
            if (!created.ok) return fail("failed", await readErrorMessage(created, `Creating chat failed (${created.status})`))
            const body: unknown = await created.json().catch(() => null)
            if (!sameThread()) return
            if (!isRecord(body) || asInt(body.number) === null) return fail("unknown", "Chat returned an unreadable receipt.")
            number = body.number as number
            await updateLocalIssue(cardId, payload => ({ ...payload, number }), "system")
          }
          if (!sameThread()) return
          let response: Response
          const editing = current.payload.comments.find(comment => comment.idempotencyKey === request.id && comment.commentBody !== request.text)
          try {
            response = await ctx.http(editing ? `${issuesPath(current.payload.repo)}/comments/${editing.id}` : `${issuesPath(current.payload.repo)}/${number}/comments`, {
              method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify(editing ? { body: request.text } : { body: request.text, idempotency_key: request.id, ...(request.persona ? { persona: request.persona } : {}) })
            })
          } catch { return fail("unknown", "Message status unknown: nothing answered. Retry to check.") }
          if (!sameThread()) return
          if (!response.ok) return fail("failed", await readErrorMessage(response, `Posting the message failed (${response.status})`))
          const receipt: unknown = await response.json().catch(() => null)
          if (!sameThread()) return
          const commentId = isRecord(receipt) ? asInt(receipt.id) : null
          if (commentId === null) return fail("unknown", "Message posted without a readable receipt. Retry to reconcile.")
          const result = await readIssue(current.payload.repo, number)
          if (!sameThread()) return
          if (typeof result === "string") return fail("unknown", `Message posted. ${result}`)
          if (result.card.kind !== "issue") return
          const loaded = result.card.payload
          const posted = loaded.comments.find(comment => comment.id === commentId)
          if (!posted) return fail("unknown", "Message posted. Refresh is incomplete; retry to reconcile.")
          posted.idempotencyKey ??= request.id
          await updateLocalIssue(cardId, payload => ({ ...loaded, conversation: payload.conversation, commentDraft: payload.commentDraft, pendingComments: payload.pendingComments }), "system", true)
          if (!sameThread()) return
          if (request.turnId && current.payload.conversation && launchConversationTurn) {
            const accepted = await launchConversationTurn(request.text, request.turnId, current.payload.conversation.owner)
            if (accepted === false) return fail("failed", "Message saved. Retry to start the response.")
          }
          if (sameThread()) await updateLocalIssue(cardId, payload => ({ ...payload, pendingComments: payload.pendingComments?.filter(row => row.id !== request.id) }), "system")
        }
        if (ctx.withToast) await ctx.withToast(`issue.message:${request.id}`, "Saving message", "Message saved", work, false, currentOwner, cardId)
        else await work()
      }
    }
    void send().catch(async () => {
      if (!currentOwner()) return
      const current = ctx.store.collections.cards.get(cardId)
      const request = current?.kind === "issue" ? current.payload.pendingComments?.find(row => row.status === "requested") : undefined
      if (request) await updateLocalIssue(cardId, payload => ({ ...payload, pendingComments: payload.pendingComments?.map(row => row.id === request.id ? { ...row, status: "unknown", error: "Message status unknown. Retry to check." } : row) }), "system")
    }).finally(() => { active!.delete(cardId); if (currentOwner()) drainComments(cardId) })
  }

  const resolvingSync = actorSharedState(ctx, "issues.resolutions", () => new Map<string, ResolutionFlight>())
  const ownsResolution = (cardId: string, flight: ResolutionFlight) => resolvingSync.get(cardId) === flight && flight.ownerValid()
  const matchesResolution = (card: Card | undefined, flight: ResolutionFlight): boolean => {
    if (card?.kind !== "issue" || card.payload.repo !== flight.repo || card.payload.number !== flight.number) return false
    const sync = card.payload.sync, request = sync?.resolution, wanted = flight.request
    return sync?.state === "outcome_unknown" && sync.deliveryId === wanted.deliveryId && sync.resolutionToken === wanted.expectedToken &&
      request?.status === "requested" && request.owner === wanted.owner && request.deliveryId === wanted.deliveryId &&
      request.expectedToken === wanted.expectedToken && request.action === wanted.action && request.evidence === wanted.evidence && request.messageId === wanted.messageId
  }
  const resolutionFlight = (card: Extract<Card, { kind: "issue" }>, request: ResolutionRequest, admitting: boolean): ResolutionFlight => ({
    repo: card.payload.repo, number: card.payload.number, request, ownerValid: captureCloudOwner(ctx, false), admitting, started: false
  })
  const drainResolution = (cardId: string) => {
    const card = ctx.store.collections.cards.get(cardId)
    const request = card?.kind === "issue" ? card.payload.sync?.resolution : undefined
    if (ctx.isDisposed?.() || card?.kind !== "issue" || request?.status !== "requested" || request.owner !== signedInOwner()) return
    let flight = resolvingSync.get(cardId)
    if (flight && ownsResolution(cardId, flight) && matchesResolution(card, flight)) {
      if (flight.admitting || flight.started) return
    } else {
      flight = resolutionFlight(card, request, false)
      if (!matchesResolution(card, flight)) return
      resolvingSync.set(cardId, flight)
    }
    const mine = flight
    mine.started = true
    const valid = () => ownsResolution(cardId, mine)
    const current = () => valid() && matchesResolution(ctx.store.collections.cards.get(cardId), mine)
    const work = async () => {
      if (!current()) return TOAST_SUPERSEDED
      let failure: string | undefined
      try {
        const response = await ctx.http(`${issuesPath(card.payload.repo)}/sync/deliveries/${request.deliveryId}`, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ resolution: request.action, expected_token: request.expectedToken, state: { sent: "sent", skip: "unsupported", retry: "pending" }[request.action], error: request.evidence, message_id: request.messageId })
        })
        if (!response.ok) failure = await readErrorMessage(response, `Resolution failed (${response.status})`)
        else await response.body?.cancel().catch(() => {})
      } catch { failure = "Resolution unconfirmed: nothing answered." }
      if (!current()) return TOAST_SUPERSEDED
      await updateLocalIssue(cardId, payload => ({ ...payload, sync: payload.sync && { ...payload.sync, resolution: failure ? { ...request, status: "failed", error: failure } : undefined } }), "system")
      const before = ctx.store.collections.cards.get(cardId)
      if (!valid() || before?.kind !== "issue" || before.payload.repo !== mine.repo || before.payload.number !== mine.number ||
          before.payload.sync?.deliveryId !== request.deliveryId || before.payload.sync.resolutionToken !== request.expectedToken) return TOAST_SUPERSEDED
      if (failure) return failure
      // A successful write still needs an authoritative read. A newer request
      // or card edit owns the projection while this read is outstanding.
      const snapshot = JSON.stringify(before.payload)
      const result = await readIssue(mine.repo, mine.number)
      const latest = ctx.store.collections.cards.get(cardId)
      if (!valid() || latest?.kind !== "issue" || JSON.stringify(latest.payload) !== snapshot) return TOAST_SUPERSEDED
      if (typeof result === "string") return `Delivery resolved, but refreshing the card failed: ${result}`
      if (result.card.kind === "issue") await ctx.dispatch({ type: "card.view.loaded", actor: "system", card: {
        ...latest, title: result.card.title, payload: { ...result.card.payload,
          conversation: latest.payload.conversation, commentDraft: latest.payload.commentDraft, pendingComments: latest.payload.pendingComments }
      } }).isPersisted.promise
      if (!valid()) return TOAST_SUPERSEDED
    }
    void (ctx.withToast ? ctx.withToast(`issue.resolve:${cardId}`, "Resolving delivery", "Delivery resolved", work, false, valid, cardId) : work())
      .finally(() => { if (resolvingSync.get(cardId) === mine) resolvingSync.delete(cardId) })
  }

  // Remote issue comments are authoritative. Restored cards reconnect through
  // the same read path; a poll is only a projection refresh, never a chat store.
  const subscribe: IssuesSeam["subscribe"] = onDispose => {
    const watches = new Map<string, { stop: () => void; address: string }>()
    const deliveryStatuses = new Map<string, string>()
    const deliveryWork = new Map<string, (failure?: string) => void>()
    let disposed = false
    const reconcile = () => {
      if (disposed) return
      const signedIn = ctx.store.collections.identitySessions.get("identity")?.state === "signed-in"
        || ctx.store.collections.cloudSessions.get("cloud")?.state === "signed-in"
      const cards = [...ctx.store.collections.cards.values()].flatMap(card => signedIn && card.kind === "issue" && card.payload.kind === "chat" && card.payload.source !== "github" && !card.loading && (!card.payload.conversation || card.payload.conversation.owner === signedInOwner() && card.payload.conversation.branchId === ctx.store.session().activeBranchId) ? [card] : [])
      const wanted = new Map(cards.map(card => [card.id, `${card.payload.repo}:${card.payload.number}`]))
      for (const [id, watch] of watches) if (wanted.get(id) !== watch.address) { watch.stop(); watches.delete(id) }
      for (const [id, settle] of deliveryWork) if (!wanted.has(id)) { deliveryWork.delete(id); deliveryStatuses.delete(id); settle() }
      for (const card of cards) {
        const delivery = card.payload.sync
        const deliveryKey = JSON.stringify([delivery?.state, delivery?.error])
        if (ctx.withToast && delivery?.state && deliveryStatuses.get(card.id) !== deliveryKey) {
          deliveryStatuses.set(card.id, deliveryKey)
          const pending = delivery?.state === "pending" || delivery?.state === "dispatching"
          const failure = delivery?.state === "outcome_unknown" ? "Delivery unconfirmed. Resolve to continue."
            : delivery?.state === "failed" || delivery?.state === "unsupported" ? delivery.error || "Message delivery failed." : undefined
          if (!pending) {
            const settle = deliveryWork.get(card.id)
            if (settle) { deliveryWork.delete(card.id); settle(failure) }
            else void ctx.withToast(`issue.delivery:${card.id}`, "Message sync", "Messages synced", async () => failure, true, captureCloudOwner(ctx, false), card.id)
          } else if (!deliveryWork.has(card.id)) {
            const settled = new Promise<string | undefined>(resolve => { deliveryWork.set(card.id, resolve) })
            const ownerValid = captureCloudOwner(ctx, false)
            const current = () => {
              const live = ctx.store.collections.cards.get(card.id)
              return ownerValid() && live?.kind === "issue" && !live.loading && live.payload.repo === card.payload.repo && live.payload.number === card.payload.number && (!card.payload.conversation || card.payload.conversation.owner === signedInOwner() && card.payload.conversation.branchId === ctx.store.session().activeBranchId)
            }
            void ctx.withToast(`issue.delivery:${card.id}`, "Syncing messages", "Messages synced", () => settled, false, current, card.id)
          }
        }
        if (card.payload.conversation && card.payload.comments.some(comment => comment.idempotencyKey === `message-${ctx.store.session().turnId}-user`)) {
          const owner = ctx.store.collections.identitySessions.get("identity")?.login ?? ctx.store.collections.cloudSessions.get("cloud")?.username
          if (card.payload.conversation.owner === owner && card.payload.conversation.branchId === ctx.store.session().activeBranchId) {
            // Streamed reply text is compared and posted trimmed: the backend stores strings.TrimSpace(body), so an untrimmed compare would re-post and PATCH the same comment forever.
            const reply = ctx.store.session().phase === "idle" ? [...ctx.store.collections.messages.values()].find(message => message.role === "smithers" && message.id === `message-${ctx.store.session().turnId}-smithers` && !message.issueCardId && message.createdAt >= card.createdAt && message.text.trim() !== "" && !card.payload.pendingComments?.some(row => row.id === message.id) && !card.payload.comments.some(row => row.idempotencyKey === message.id && row.commentBody === message.text.trim())) : undefined
            const steering = [...ctx.store.collections.messages.values()].find(message => message.id.startsWith("message-steer-") && message.ordinal > (ctx.store.collections.messages.get(`message-${ctx.store.session().turnId}-user`)?.ordinal ?? Number.MAX_SAFE_INTEGER) && !message.issueCardId && !card.payload.pendingComments?.some(row => row.id === message.id) && !card.payload.comments.some(row => row.idempotencyKey === message.id))
            if (steering) void updateLocalIssue(card.id, payload => ({ ...payload, pendingComments: [...(payload.pendingComments ?? []), { id: steering.id, text: steering.text, owner, actor: "user", status: "requested" }] }), "user")
            if (reply) {
              void updateLocalIssue(card.id, payload => ({ ...payload, pendingComments: [...(payload.pendingComments ?? []), { id: reply.id, text: reply.text.trim(), owner, actor: "smithers", persona: { username: "Smithers" }, status: "requested" }] }), "smithers")
            }
          }
        }
        drainComments(card.id)
        drainResolution(card.id)
        if (card.payload.number === 0) continue
        if (watches.has(card.id)) continue
        let stopped = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const currentOwner = captureCloudOwner(ctx, false)
        const valid = () => !disposed && !stopped && currentOwner() && ctx.store.collections.cards.get(card.id)?.kind === "issue"
        const stop = () => { stopped = true; clearTimeout(timer) }
        watches.set(card.id, { stop, address: `${card.payload.repo}:${card.payload.number}` })
        const poll = async () => {
          if (!valid()) { stop(); watches.delete(card.id); return }
          const work = async () => {
            const started = ctx.store.collections.cards.get(card.id)
            if (started?.kind !== "issue") return
            const startedPayload = JSON.stringify(started.payload)
            const result = await readIssue(card.payload.repo, card.payload.number)
            if (!valid()) return
            if (typeof result === "string") return result
            const previous = ctx.store.collections.cards.get(card.id)
            if (previous?.kind !== "issue" || result.card.kind !== "issue" || previous.payload.number !== card.payload.number || previous.payload.repo !== card.payload.repo || JSON.stringify(previous.payload) !== startedPayload) return
            const payload = { ...result.card.payload, sync: result.card.payload.sync && { ...result.card.payload.sync, resolution: previous.payload.sync?.resolution }, conversation: previous.payload.conversation, commentDraft: previous.payload.commentDraft, pendingComments: previous.payload.pendingComments }
            if (JSON.stringify(previous.payload) === JSON.stringify(payload)) return
            await ctx.dispatch({ type: "card.view.loaded", actor: "system", card: { ...previous, title: result.card.title, payload } }).isPersisted.promise
          }
          try {
            if (ctx.withToast) await ctx.withToast(`issue.sync:${card.id}`, "Syncing messages", "Messages synced", work, true, valid, card.id)
            else await work()
          } catch { /* The next authoritative read recovers transient transport errors. */ }
          if (valid()) timer = setTimeout(() => { void poll() }, 2_000)
        }
        timer = setTimeout(() => { void poll() }, 2_000)
      }
    }
    const schedule = () => queueMicrotask(reconcile)
    const changes = ctx.store.collections.cards.subscribeChanges(schedule)
    const session = ctx.store.collections.sessions.subscribeChanges(schedule)
    let ownerValid = captureCloudOwner(ctx, false)
    const retire = () => {
      if (!ownerValid()) {
        for (const watch of watches.values()) watch.stop()
        watches.clear()
        for (const settle of deliveryWork.values()) settle()
        deliveryWork.clear(); deliveryStatuses.clear()
        ownerValid = captureCloudOwner(ctx, false)
      }
      schedule()
    }
    const identity = ctx.store.collections.identitySessions.subscribeChanges(retire)
    const cloud = ctx.store.collections.cloudSessions.subscribeChanges(retire)
    reconcile()
    onDispose(() => { disposed = true; changes.unsubscribe(); session.unsubscribe(); identity.unsubscribe(); cloud.unsubscribe(); for (const watch of watches.values()) watch.stop(); watches.clear(); for (const settle of deliveryWork.values()) settle(); deliveryWork.clear() })
  }

  return {
    submitConversation: async (text, turnId, repo, owner) => {
      if (!text.trim() || !owner || signedInOwner() !== owner || ctx.isDisposed?.()) return false
      const branchId = ctx.store.session().activeBranchId ?? "branch-main"
      const existing = [...ctx.store.collections.cards.values()].find(card => card.kind === "issue" && card.payload.conversation?.branchId === branchId && card.payload.conversation.owner === owner && card.payload.repo === repo)
      const cardId = existing?.id ?? `conversation-issue:${crypto.randomUUID()}`
      const request = { id: `message-${turnId}-user`, text, turnId, owner, actor: ctx.actor(), status: "requested" as const }
      if (existing?.kind === "issue") {
        if (existing.payload.pendingComments?.some(row => row.id === request.id || row.text === text && row.status === "requested")) return true
        await updateLocalIssue(cardId, payload => ({ ...payload, pendingComments: [...(payload.pendingComments ?? []), request] }))
      } else {
        await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: {
          id: cardId, kind: "issue", title: "Chat", status: "active", createdAt: Date.now(), ordinal: ctx.nextOrdinal(),
          payload: { repo, number: 0, kind: "chat", visibility: "private", title: "Chat", state: "open", author: owner, issueBody: "", labels: [], comments: [],
            conversation: { branchId, owner, creationKey: cardId }, pendingComments: [request] }
        } }).isPersisted.promise
      }
      await ctx.dispatch({ type: "composer.changed", actor: ctx.actor(), draft: "" }).isPersisted.promise
      drainComments(cardId)
      return true
    },
    subscribe,
    draftIssueComment: async (cardId, text) => { await updateLocalIssue(cardId, payload => ({ ...payload, commentDraft: text })) },
    retryIssueComment: async (cardId, requestId) => {
      await updateLocalIssue(cardId, payload => ({ ...payload, pendingComments: payload.pendingComments?.map(row => row.id === requestId ? { ...row, status: "requested", error: undefined } : row) }))
      drainComments(cardId)
    },
    reactToIssueComment: async (number, commentId, name, active, explicitRepo) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(target.repo)}/${number}/comments/${commentId}/reactions`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, active }) })
      } catch { return "Reaction status unknown: nothing answered. Refresh to check." }
      if (!response.ok) return readErrorMessage(response, `Saving the reaction failed (${response.status})`)
      await response.body?.cancel().catch(() => {})
      return refreshDetail("Reaction saved", target.repo, number)
    },
    resolveIssueSync: async (cardId, deliveryId, action, evidence, messageId) => {
      const card = ctx.store.collections.cards.get(cardId)
      const owner = signedInOwner()
      if (!owner || card?.kind !== "issue" || card.payload.sync?.state !== "outcome_unknown" || card.payload.sync.deliveryId !== deliveryId) return "Delivery is no longer unknown."
      if (!card.payload.sync.resolutionToken) return "Refresh the delivery before resolving."
      const expectedToken = card.payload.sync.resolutionToken
      if (!evidence.trim() || evidence.length > 4096 || (action === "sent" && !messageId.trim())) return "Add evidence and a message ID for sent."
      const existing = card.payload.sync.resolution
      if (existing?.status === "requested" && existing.owner === owner && existing.deliveryId === deliveryId && existing.expectedToken === expectedToken) {
        const flight = resolvingSync.get(cardId)
        if (flight?.admitting && ownsResolution(cardId, flight) && matchesResolution(card, flight)) {
          await flight.admission
          if (!ownsResolution(cardId, flight)) return "Resolution is no longer current."
        }
        drainResolution(cardId)
        return "Resolution requested."
      }
      const request: ResolutionRequest = { deliveryId, expectedToken, action, evidence, messageId, owner, status: "requested" }
      const flight = resolutionFlight(card, request, true)
      const admission = Promise.withResolvers<void>()
      flight.admission = admission.promise
      void admission.promise.catch(() => {})
      // Reserve admission before the optimistic card wakes either actor's
      // subscription. Only its successful persistence receipt permits launch.
      resolvingSync.set(cardId, flight)
      try {
        await updateLocalIssue(cardId, payload => ({ ...payload, sync: payload.sync && { ...payload.sync, resolution: request } }))
      } catch (error) {
        if (resolvingSync.get(cardId) === flight) resolvingSync.delete(cardId)
        admission.reject(error)
        throw error
      }
      if (!ownsResolution(cardId, flight) || !matchesResolution(ctx.store.collections.cards.get(cardId), flight)) {
        if (resolvingSync.get(cardId) === flight) resolvingSync.delete(cardId)
        admission.resolve()
        return "Resolution is no longer current."
      }
      flight.admitting = false
      admission.resolve()
      drainResolution(cardId)
      return "Resolution requested."
    },
    mapIssueSync: async (number, mapping, explicitRepo) => {
      const { provider, connectionId, scopeId, conversationId, threadId, externalUserId } = mapping
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(repo)}/${number}/sync`, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, connection_id: connectionId, scope_id: scopeId, conversation_id: conversationId, ...(threadId ? { thread_id: threadId } : {}), ...(externalUserId ? { external_user_id: externalUserId } : {}) })
        })
      } catch { return "Sync mapping status unknown: nothing answered. Refresh to check." }
      if (!response.ok) return readErrorMessage(response, `Mapping sync failed (${response.status})`)
      await response.body?.cancel().catch(() => {})
      return refreshDetail("Sync mapped", repo, number)
    },
    listIssues: Object.assign((filter: "open" | "closed" | "all", explicitRepo?: string, kind?: IssueKindFilter, view?: string) => repositoryListRead(ctx, "issues", explicitRepo, filter, renderRepositoryForm, (repo) => listView(filter, repo, kind ?? "all", view),
      [filter, kind === undefined || kind === "all" ? undefined : `--kind ${kind}`, view === undefined || view === "" ? undefined : `--view ${view}`].filter((part) => part !== undefined).join(" ")), { preload: listView.preload }),
    setIssueTask: async (number, field, value, explicitRepo) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      const stored = taskFieldValue(field, value)
      if (stored === undefined) return field === "priority" ? "Priority is 0 to 3" : "Parent is an issue number"
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(repo)}/${number}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ [field]: stored }) })
      } catch (error) { return unreachable(`set ${field} on issue #${number} in ${repo}`, error) }
      if (!response.ok) {
        if (response.status === 404) return issue404(response, `Setting ${field} on issue #${number} failed (404)`, `Issue #${number} in ${repo} was not found`)
        return readErrorMessage(response, `Setting ${field} on issue #${number} failed (${response.status})`)
      }
      await response.body?.cancel().catch(() => {})
      return refreshDetail(`Issue #${number} ${field} set`, repo, number)
    },

    viewIssue: Object.assign(async (number: number, explicitRepo?: string, source?: "smithers-cloud" | "github") => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      if (source === "github") return readRepositoryDetail(ctx, target.repo, "issue", number,
        () => issueView(number, target.repo, "github"), "github")
      const shown = await readRepositoryDetail(ctx, target.repo, "issue", number, () => showIssue(target.repo, number))
      return shown
    }, { preload: issueView.preload }),

    createIssue: async (title, explicitRepo, kind) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      const owner = ctx.store.collections.identitySessions.get("identity")?.login ?? null
      let response: Response
      try {
        response = await ctx.http(issuesPath(repo), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, ...(kind === "chat" ? { kind, visibility: "private" } : {}) })
        })
      } catch (error) {
        return unreachable(`create an issue in ${repo}`, error)
      }
      if (!response.ok) {
        // Mutations never fall back — the GitHub-source proxy is GET-only.
        if (response.status === 404) return issue404(response, `Creating the issue in ${repo} failed (404)`, `${repo} was not found`)
        return readErrorMessage(response, `Creating the issue in ${repo} failed (${response.status})`)
      }
      const body: unknown = await response.json().catch(() => null)
      const created = isRecord(body) ? asInt(body.number) : null
      if (created === null) {
        return `The issue was created in ${repo}, but the backend answered with an unreadable payload`
      }
      const key = `setup-ci:${owner}:${repo}`
      const binding = selectedBoxBinding(ctx.store, repo)
      if (kind !== "chat" && owner === (ctx.store.collections.identitySessions.get("identity")?.login ?? null)
        && !(binding !== undefined && "error" in binding)
        && repositoryCiConfigured(ctx.store.collections.repositoryJobObservations.values(), repo, owner, binding !== undefined && "workspaceId" in binding ? binding.workspaceId : null) === false
        && ![...ctx.store.collections.toasts.values()].some(toast => toast.key === key)) {
        const action = { label: "Set up CI", flow: "ci.setup" as const, args: repo }
        ctx.dispatch({ type: "toast.shown", actor: "system", key, title: "Improve issue checks", action })
        if (ctx.resolveToast) ctx.resolveToast(key, { status: "ok", detail: "", action })
        else ctx.dispatch({ type: "toast.resolved", actor: "system", key, status: "ok", detail: "", action })
      }
      return refreshDetail(`Issue #${created} was created in ${repo}`, repo, created)
    },

    setIssueState: async (number, state, explicitRepo) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      const verb = state === "closed" ? "close" : state === "fixed" ? "mark fixed" : state === "verified" ? "verify" : "reopen"
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(repo)}/${number}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state })
        })
      } catch (error) {
        return unreachable(`${verb} issue #${number} in ${repo}`, error)
      }
      if (!response.ok) {
        // Mutations never fall back — the GitHub-source proxy is GET-only.
        if (response.status === 404) return issue404(response, `Could not ${verb} issue #${number} in ${repo} (404)`, `Issue #${number} in ${repo} was not found`)
        return readErrorMessage(
          response,
          `Could not ${verb} issue #${number} in ${repo} (${response.status})`
        )
      }
      // The re-fetch below states the new truth; the PATCH echo is not read.
      await response.body?.cancel()
      return refreshDetail(`Issue #${number} in ${repo} is now ${state}`, repo, number)
    },

    editIssueComment: async (number, commentId, text, explicitRepo) => {
      if (!text.trim()) return "Write a message before saving it."
      return mutateComment(number, commentId, explicitRepo, "PATCH", { body: text })
    },
    deleteIssueComment: async (number, commentId, explicitRepo) => mutateComment(number, commentId, explicitRepo, "DELETE"),

    commentOnIssue: async (number, text, explicitRepo, persona) => {
      if (text.trim() === "") return "Write a comment before posting it."
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      const chat = [...ctx.store.collections.cards.values()].find(card => card.kind === "issue" && card.payload.kind === "chat" && card.payload.source !== "github" && card.payload.repo === repo && card.payload.number === number)
      if (chat?.kind === "issue") {
        if (chat.payload.pendingComments?.some(row => row.text === text && row.status === "requested" && JSON.stringify(row.persona) === JSON.stringify(persona))) return { value: "Requested" }
        const owner = signedInOwner()
        if (!owner) return "Sign in before sending a message."
        const request = { id: crypto.randomUUID(), text, owner, actor: ctx.actor(), status: "requested" as const, ...(persona ? { persona } : {}) }
        await updateLocalIssue(chat.id, payload => ({ ...payload, commentDraft: "", pendingComments: [...(payload.pendingComments ?? []), request] }))
        drainComments(chat.id)
        return { value: "Requested" }
      }
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(repo)}/${number}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: text, ...(persona ? { persona } : {}) })
        })
      } catch {
        const detail = `No response from issue #${number} in ${repo}.`
        showCommentNotice(`issue.comment.unknown:${repo}:${number}`, "Comment status unknown", detail)
        return { value: `Comment status unknown. ${detail}` }
      }
      if (!response.ok) {
        // Mutations never fall back — the GitHub-source proxy is GET-only.
        if (response.status === 404) return issue404(response, `Commenting on issue #${number} in ${repo} failed (404)`, `Issue #${number} in ${repo} was not found`)
        return readErrorMessage(
          response,
          `Commenting on issue #${number} in ${repo} failed (${response.status})`
        )
      }
      // The re-fetch below re-lists the comments; the POST echo is not read.
      await response.body?.cancel().catch(() => {})
      return refreshCommentDetail(repo, number)
    },

  }
}
