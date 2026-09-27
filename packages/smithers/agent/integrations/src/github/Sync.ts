/**
 * A repository's issues, pull requests and issue comments as source records.
 *
 * The adapter walks two listings of one repository, in order, on every sync:
 * `GET /repos/{owner}/{repo}/issues?state=all&sort=updated&direction=asc`,
 * which returns issues and pull requests alike, and
 * `GET /repos/{owner}/{repo}/issues/comments?sort=updated&direction=asc`,
 * which returns the conversation comments on both. One `changes` call fetches
 * one page, so the sync driver commits each page with its cursor.
 *
 * **Paging by change time.** A page-numbered walk of a list sorted by update
 * time skips an item whenever an earlier item is edited mid-walk and moves to
 * the end. The cursor therefore records the latest change time a page
 * contained and asks the next page for everything `since` one second before
 * it, so the page boundary's second is read twice (the store drops the
 * duplicates) and an item edited during the walk is met again further on. Only
 * a full page whose items all fall inside that one second advances by page
 * number instead. The cursor is JSON the adapter writes and validates; a
 * corrupt one fails rather than restarting the listing.
 *
 * **Pull requests** come back from the issues listing with a `pull_request`
 * member and are recorded with kind `pull-request`; issues are `issue`, and
 * comments on either are `issue-comment` whose parent and thread are the
 * issue's record. External ids carry the numeric repository id, which survives
 * renames: `repo:<id>:issue:<number>` and `repo:<id>:comment:<id>`.
 *
 * **Access.** A public repository's records are `public`; a private or
 * internal one's are `container`-scoped to the repository id. Either way the
 * thread container is the repository id, which is what a grant names.
 *
 * **Deletions are not visible here.** GitHub's list endpoints omit deleted
 * issues and comments rather than reporting them, so an incremental sync
 * never learns of a deletion. A `fullListing` adapter starts a fresh full walk
 * that reports `reset`, after which the driver tombstones every record of the
 * repository the walk did not contain; run one periodically, or turn the
 * `issues.deleted` and `issue_comment.deleted` webhooks into
 * `SourceRecord.tombstone`s. A transferred issue leaves this repository's
 * listing the same way.
 *
 * Rate limits and transient read failures are retried by `GitHubClient`.
 *
 * @since 1.0.0
 */

import { Effect, Schema } from "effect"
import { IntegrationError } from "../core/IntegrationError.ts"
import type { SourceRecord } from "../core/SourceRecord.ts"
import type { Changes, SyncAdapter } from "../core/Sync.ts"
import { type GitHubClient, MAX_PER_PAGE } from "./GitHubClient.ts"
import { repositoryPath } from "./Repository.ts"

/**
 * The provider name on every record.
 *
 * @category constants
 * @since 1.0.0
 */
export const PROVIDER = "github"

// The overlap each page leaves at its boundary, so neither an inclusive nor an
// exclusive reading of `since` can skip an item stamped in that second.
const OVERLAP_MS = 1000

/**
 * What the adapter needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The connection the records belong to. */
  readonly connectionId: string
  readonly owner: string
  readonly repo: string
  readonly client: GitHubClient
  /** The sync stream name. Defaults to `owner/repo`. */
  readonly stream?: string | undefined
  /** Items per page, 1 to 100. Defaults to 100. */
  readonly perPage?: number | undefined
  /**
   * Start a fresh full listing, reported as `reset`, whenever the stored
   * cursor is not already inside one. Used to discover deletions.
   */
  readonly fullListing?: boolean | undefined
}

const Position = Schema.Struct({
  since: Schema.NullOr(Schema.String),
  page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
})

type Position = typeof Position.Type

const Cursor = Schema.Struct({
  v: Schema.Literal(1),
  phase: Schema.Literals(["issues", "comments"]),
  full: Schema.Boolean,
  issues: Position,
  comments: Position
})

type Cursor = typeof Cursor.Type

const start: Position = { since: null, page: 1 }

const initial = (full: boolean): Cursor => ({ v: 1, phase: "issues", full, issues: start, comments: start })

const User = Schema.NullOr(Schema.Struct({ id: Schema.Number, login: Schema.String }))

const Issue = Schema.Struct({
  id: Schema.Number,
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: User,
  html_url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  pull_request: Schema.optional(Schema.Unknown)
})

const Comment = Schema.Struct({
  id: Schema.Number,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: User,
  html_url: Schema.String,
  issue_url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String
})

const Repository = Schema.Struct({ id: Schema.Number, private: Schema.Boolean })

/**
 * The external id of an issue or pull request.
 *
 * @category constructors
 * @since 1.0.0
 */
export const issueId = (repositoryId: number, issueNumber: number): string =>
  `repo:${repositoryId}:issue:${issueNumber}`

/**
 * The external id of an issue comment.
 *
 * @category constructors
 * @since 1.0.0
 */
export const commentId = (repositoryId: number, id: number): string => `repo:${repositoryId}:comment:${id}`

const ISSUE_NUMBER = /\/issues\/(\d+)$/

/**
 * Builds the sync adapter for one repository.
 *
 * Throws `invalid-config` for an owner or repository name GitHub could not
 * have issued, or a page size outside 1 to 100, before any request is made.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options): SyncAdapter => {
  const path = repositoryPath(options.owner, options.repo)
  const perPage = options.perPage ?? MAX_PER_PAGE
  if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > MAX_PER_PAGE) {
    throw new IntegrationError(
      "invalid-config",
      `GitHub sync perPage must be an integer between 1 and ${MAX_PER_PAGE}.`,
      { perPage, retryable: false }
    )
  }
  const stream = options.stream ?? `${options.owner}/${options.repo}`
  const { client, connectionId } = options
  const scope = { connectionId, stream }

  const decodeFailed = (message: string, extra: Record<string, unknown> = {}, cause?: unknown) =>
    new IntegrationError("decode-failed", message, { ...scope, ...extra }, { cause })

  const readCursor = (cursor: string): Effect.Effect<Cursor, IntegrationError> =>
    Effect.try({ try: () => JSON.parse(cursor) as unknown, catch: (cause) => cause }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Cursor)),
      Effect.filterOrFail(
        (decoded) =>
          [decoded.issues.since, decoded.comments.since].every((since) =>
            since === null || Number.isFinite(Date.parse(since))
          ),
        () => "since is not a timestamp"
      ),
      Effect.mapError((cause) =>
        new IntegrationError(
          "invalid-config",
          `GitHub sync for "${stream}" has a stored cursor it did not write, so syncing would restart the listing.`,
          { ...scope, retryable: false },
          { cause }
        )
      )
    )

  const time = (value: string, field: string, id: number): Effect.Effect<number, IntegrationError> => {
    const ms = Date.parse(value)
    return Number.isFinite(ms)
      ? Effect.succeed(ms)
      : Effect.fail(decodeFailed(`GitHub returned an item whose ${field} is not a timestamp.`, { id, field }))
  }

  const decodeItems = <A>(schema: Schema.Decoder<A>, items: ReadonlyArray<unknown>, what: string) =>
    Effect.forEach(items, (item) =>
      Schema.decodeUnknownEffect(schema)(item).pipe(
        Effect.map((decoded) => ({ decoded, raw: item })),
        Effect.mapError((cause) => decodeFailed(`GitHub returned ${what} this adapter cannot read.`, {}, cause))
      ))

  const advance = (position: Position, latestMs: number | null, more: boolean): Position => {
    // An empty page that still links onward can only move on by page number.
    if (latestMs === null) {
      return more
        ? { since: position.since, page: position.page + 1 }
        : { since: position.since, page: 1 }
    }
    const candidate = latestMs - OVERLAP_MS
    const current = position.since === null ? null : Date.parse(position.since)
    if (current !== null && candidate <= current) {
      // Everything on this page sits inside the overlap second: a full page
      // there can only move on by page number.
      return more ? { since: position.since, page: position.page + 1 } : { since: position.since, page: 1 }
    }
    return { since: new Date(candidate).toISOString(), page: 1 }
  }

  const listingPath = (endpoint: string, position: Position): string => {
    const query = new URLSearchParams({ sort: "updated", direction: "asc" })
    if (endpoint === "issues") query.set("state", "all")
    if (position.since !== null) query.set("since", position.since)
    if (position.page > 1) query.set("page", String(position.page))
    return `/repos/${path}/${endpoint === "issues" ? "issues" : "issues/comments"}?${query.toString()}`
  }

  const changes = (stored: string | null): Effect.Effect<Changes, IntegrationError> =>
    Effect.gen(function*() {
      const decoded = stored === null ? initial(options.fullListing === true) : yield* readCursor(stored)
      const reset = options.fullListing === true && (stored === null || !decoded.full)
      const cursor = reset ? initial(true) : decoded
      const repository = yield* client.request("GET", `/repos/${path}`, undefined, { schema: Repository })
      const retrievedAtMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      const repositoryId = String(repository.id)
      const access: SourceRecord["access"] = repository.private
        ? { scope: "container", containerId: repositoryId }
        : { scope: "public", containerId: null }
      const position = cursor[cursor.phase]
      const page = yield* client.paginate(listingPath(cursor.phase, position), { perPage, maxPages: 1 })
      const records: Array<SourceRecord> = []
      let latestMs: number | null = null
      const base = (id: string, raw: unknown) => ({
        provider: PROVIDER,
        connectionId,
        externalId: id,
        version: null,
        retrievedAtMs,
        access,
        deleted: false,
        payload: raw as SourceRecord["payload"]
      })
      const author = (user: typeof User.Type): SourceRecord["author"] =>
        user === null ? null : { id: String(user.id), label: user.login }
      if (cursor.phase === "issues") {
        for (const { decoded: issue, raw } of yield* decodeItems(Issue, page.items, "an issue")) {
          const createdAtMs = yield* time(issue.created_at, "created_at", issue.id)
          const updatedAtMs = yield* time(issue.updated_at, "updated_at", issue.id)
          latestMs = Math.max(latestMs ?? updatedAtMs, updatedAtMs)
          const id = issueId(repository.id, issue.number)
          const body = issue.body ?? ""
          records.push({
            ...base(id, raw),
            kind: issue.pull_request === undefined ? "issue" : "pull-request",
            url: issue.html_url,
            author: author(issue.user),
            createdAtMs,
            updatedAtMs,
            thread: { containerId: repositoryId, threadId: id, parentId: null },
            text: body.length === 0 ? issue.title : `${issue.title}\n\n${body}`
          })
        }
      } else {
        for (const { decoded: comment, raw } of yield* decodeItems(Comment, page.items, "an issue comment")) {
          const createdAtMs = yield* time(comment.created_at, "created_at", comment.id)
          const updatedAtMs = yield* time(comment.updated_at, "updated_at", comment.id)
          latestMs = Math.max(latestMs ?? updatedAtMs, updatedAtMs)
          const issueNumber = ISSUE_NUMBER.exec(comment.issue_url)?.[1]
          if (issueNumber === undefined) {
            return yield* Effect.fail(
              decodeFailed("GitHub returned an issue comment whose issue_url names no issue.", { id: comment.id })
            )
          }
          const parent = issueId(repository.id, Number(issueNumber))
          records.push({
            ...base(commentId(repository.id, comment.id), raw),
            kind: "issue-comment",
            url: comment.html_url,
            author: author(comment.user),
            createdAtMs,
            updatedAtMs,
            thread: { containerId: repositoryId, threadId: parent, parentId: parent },
            text: comment.body ?? ""
          })
        }
      }
      const more = page.truncated
      const next = advance(position, latestMs, more)
      let following: Cursor
      let done = false
      if (more) following = cursor.phase === "issues" ? { ...cursor, issues: next } : { ...cursor, comments: next }
      else if (cursor.phase === "issues") following = { ...cursor, issues: next, phase: "comments" }
      else {
        following = { ...cursor, comments: next, phase: "issues", full: false }
        done = true
      }
      return { records, cursor: JSON.stringify(following), reset, done }
    }).pipe(Effect.withSpan("GitHub.Sync.changes", { attributes: { "integration.stream": stream } }))

  return { provider: PROVIDER, connectionId, stream, changes }
}
