import { refuseCloudSignIn } from "./CloudSignIn"
/*
 * The changes seam (lane change, ADR 0003 — the change is the unit; lane L1
 * — the live plue routes), behind the `/api/cloud/*` proxy:
 *
 *   GET  /api/repos/{o}/{r}/changes/{id}                 — the change DTO: revisions[], reviews[], conflicts[], stack, turn, owners, landed, current_seq
 *   GET  /api/repos/{o}/{r}/changes/{id}/diff[?from=&to=&path=] — change vs its recorded parent; from=parent|N, to=N is a jj INTERDIFF (#451)
 *   GET  /api/repos/{o}/{r}/changes/{id}/conflicts        — per-file conflicts (read only when the DTO carries no conflicts[])
 *   GET  /api/repos/{o}/{r}/changes/{id}/findings[?rev=N] — findings per revision with analyzer runs (#454)
 *   GET  /api/repos/{o}/{r}/changes/{id}/walkthrough[?rev=N] — the walkthrough artifact; 404 = none (#465)
 *   POST /api/repos/{o}/{r}/changes/{id}/conflicts/resolve { path } — dispatches an agent session (#455)
 *   POST /api/repos/{o}/{r}/changes/{id}/findings/{fid}/feedback { useful } — records feedback (#487)
 *   POST /api/repos/{o}/{r}/changes/{id}/findings/{fid}/dispatch — 202, the agent session it started (#487)
 *   POST /api/repos/{o}/{r}/changes/{id}/split { paths } — 200 { original, split } (#489)
 *   POST /api/repos/{o}/{r}/landings/{n}/review-requests { reviewer | agent } — 201 (#488)
 *   DELETE /api/repos/{o}/{r}/landings/{n}/review-requests/{id} — 204 (#488)
 *   GET  /api/repos/{o}/{r}/landings?limit=100            — the landing requests: change_ids, landable_prefix, blocked_by, turn (#452, #460)
 *   GET  /api/repos/{o}/{r}/landings/{n}/comments         — threads with lifecycle timestamps and the anchor state (#461)
 *   POST /api/repos/{o}/{r}/landings/{n}/threads/{id}/done|ack|reopen (#461)
 *   GET  /api/repos/{o}/{r}/commits/{ref}/statuses?limit=100 — the checks at one revision's commit, with their work (#452)
 *   PUT  /api/repos/{o}/{r}/landings/{n}/land { commit_id } — lands the request's WHOLE stack; QUEUED, never "merged"
 *   POST /api/repos/{o}/{r}/workspaces { snapshot_id }    — forks a revision's snapshot into a computer
 *   GET  /api/orgs/{org}/changesets                        — the live changeset DTO (ADR 0003)
 *   POST /api/orgs/{org}/changesets/{id}/land              — synchronous; 409 carries failure_reason
 *
 * What still has NO route and is never faked: splitting a CHANGESET's ready
 * members (plue#489 splits one change by path, which is a different act) and
 * a revert's own change. Each refuses with the reason. A field a route omits
 * stays absent — the card renders nothing in its place.
 *
 * Reads need only the legacy token's read:repository, so a degraded sign-in
 * reads freely; dispatching an agent or opening a computer refuses it with
 * the enable wording.
 */
import type {
  ChangeAnalyzerRun,
  ChangeCheck,
  ChangeFacet,
  ChangeFinding,
  ChangeLanded,
  ChangeOwners,
  ChangeReviewRequest,
  ChangeRevision,
  ChangeThread,
  ChangeTurn,
  ChangeVerdict,
  ChangeWalkthrough,
  ChangesetState,
  DiffFile,
  LandingBlock
} from "@smthrs/rpc/Changes"
import { changeRowId } from "../AppState"
import type { Card, ChangeInput } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { createCloudClient } from "./CloudClient"
import { captureCloudOwner, type SeamContext } from "./SeamContext"
import { SIGN_OUT_REFUSAL } from "./CloudSignIn"

export const DEGRADED_CHANGE_REFUSAL =
  "This Smithers Cloud sign-in can't dispatch agents — sign in again to enable them."


/** The honest refusals for the acts that have no route (lane L1 REPORT names each). */
export const NO_SPLIT_REFUSAL =
  "Splitting a changeset's ready members has no route on Smithers Cloud — nothing was split. /change.split moves ONE change's named paths into a new change."
export const NO_REVERT_REFUSAL =
  "Smithers doesn't create a revert change yet — Smithers Cloud's revert route exists, but this app has not built the act, so nothing was reverted."

/** Past this many patch lines a file's hunk rides by reference (ADR 0003 step 1), never inline. */
const INLINE_PATCH_LINE_CAP = 400

type Outcome = Promise<string | void | { readonly value: string }>

export interface ChangeSeam {
  /** `change.view <changeId> [rev]`: read the change and its auxiliaries, render the card; `rev` pins the Diff facet `parent → rev`. */
  readonly viewChange: (changeId: string, rev?: number, repo?: string) => Outcome
  /** `change.diff <changeId> [from] [to] [path]`: render the diff card at the two pins. */
  readonly diffChange: (changeId: string, from?: string, to?: string, path?: string, repo?: string) => Outcome
  /** `change.pins <changeId> <from> <to>`: the Diff facet's two pickers. */
  readonly setPins: (changeId: string, from: string, to: string, repo?: string) => Outcome
  /** `review.since-mine <changeId>`: pin the diff `rev <my last review> → current`. */
  readonly sinceMyReview: (changeId: string, repo?: string) => Outcome
  /** `change.checks <changeId> <seq>`: the Checks facet's revision picker. */
  readonly checksAt: (changeId: string, seq: number, repo?: string) => Outcome
  /** `change.land <changeId>`: land the carrying landing request (queued) or the changeset (synchronous). */
  readonly landChange: (changeId: string, repo?: string) => Outcome
  /** `change.split-ready <changeId>`: a changeset's ready members still have no route; refuses honestly. */
  readonly splitReady: (changeId: string, repo?: string) => Outcome
  /** `change.split <changeId> <path…>`: move the named paths into a new change (plue#489). */
  readonly splitChange: (changeId: string, paths: ReadonlyArray<string>, repo?: string) => Outcome
  /** `change.resolve <changeId> <path>`: dispatch an agent session on the conflict; a degraded sign-in can't. */
  readonly resolveConflict: (changeId: string, path: string, repo?: string) => Outcome
  /** `change.revert <changeId>`: only on a landed change; refuses honestly. */
  readonly revertChange: (changeId: string, repo?: string) => Outcome
  /** The card's body tab; hidden, card-button scoped. */
  readonly setFacet: (changeId: string, facet: ChangeFacet, repo?: string) => Promise<string | void>
  /** `review.done <changeId> <threadId>`: the author addressed the thread at the current revision. */
  readonly threadDone: (changeId: string, threadId: number, repo?: string) => Outcome
  /** `review.ack <changeId> <threadId>`: the reviewer accepts the author's Done. */
  readonly threadAck: (changeId: string, threadId: number, repo?: string) => Outcome
  /** `review.reopen <changeId> <threadId>`: either party reopens. */
  readonly threadReopen: (changeId: string, threadId: number, repo?: string) => Outcome
  /** `findings.please-fix <changeId> <findingId>`: dispatch the agent on one finding (plue#487). */
  readonly pleaseFix: (changeId: string, findingId: number, repo?: string) => Outcome
  /** `findings.not-useful <changeId> <findingId>`: record `useful: false` on one finding (plue#487). */
  readonly notUseful: (changeId: string, findingId: number, repo?: string) => Outcome
  /** `review.request <changeId> <login>`: ask a human (or `agent:<name>`) to review (plue#488). */
  readonly requestReview: (changeId: string, reviewer: string, repo?: string) => Outcome
  /** `review.unrequest <changeId> <requestId>`: dismiss one review request (plue#488). */
  readonly unrequestReview: (changeId: string, requestId: number, repo?: string) => Outcome
}

/** What the controller lends the seam: the workspace card's renderer for a forked computer. */
export interface ChangeSeamDeps {
  readonly viewWorkspace?: (workspaceId: string) => Outcome
}

interface RepoStat {
  readonly repo: string
  readonly additions: number
  readonly deletions: number
}

interface ConflictRow {
  readonly path: string
  readonly state: string
}

type ChangePayload = Extract<Card, { readonly kind: "change" }>["payload"]
type StackRow = NonNullable<ChangePayload["stack"]>
/** Why an auxiliary is null, keyed by the auxiliary (Cards.ts `unread`). */
type ChangeUnread = NonNullable<ChangePayload["unread"]>

/**
 * A read's answer: the value, or why it was not read, in the platform's own
 * words. An unread answer is never a fact — the card says "not read (why)",
 * never "none".
 */
type Read<T> = { readonly value: T } | { readonly unread: string }

/** The auxiliaries a change card renders beside the DTO row. */
interface ChangeAux {
  readonly repos: ReadonlyArray<RepoStat>
  readonly diff: ChangePayload["diff"]
  readonly checks: ReadonlyArray<ChangeCheck> | null
  readonly checksAt: number | null
  readonly findings: ReadonlyArray<ChangeFinding> | null
  readonly analyzers: ReadonlyArray<ChangeAnalyzerRun> | null
  readonly reviews: ReadonlyArray<ChangeVerdict> | null
  readonly threads: ReadonlyArray<ChangeThread> | null
  readonly reviewRequests: ReadonlyArray<ChangeReviewRequest> | null
  readonly conflicts: ReadonlyArray<ConflictRow> | null
  readonly stack: StackRow | null
  readonly turn: ChangeTurn | null
  readonly owners: ChangeOwners | null
  readonly landed: ChangeLanded | null
  readonly walkthrough: ChangeWalkthrough | null
  readonly changeset: ChangesetState | null
  readonly unread: ChangeUnread
  readonly facet?: ChangeFacet | undefined
  readonly error?: string | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null

const seqOrNull = (value: unknown): number | null => {
  const seq = intOrNull(value)
  return seq === null || seq <= 0 ? null : seq
}

const strings = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "") : []

/** A required list: a bare array or one under its named key; malformed is not empty. */
const arrayOrNull = (body: unknown, key: string): ReadonlyArray<unknown> | null => {
  if (Array.isArray(body)) return body
  if (isRecord(body) && Array.isArray(body[key])) return body[key]
  return null
}

/** Optional nested lists retain their existing empty fallback and tolerant row parsing. */
const arrayOf = (body: unknown, key: string): ReadonlyArray<unknown> => arrayOrNull(body, key) ?? []

/* ---- the change DTO (plue#450 / #459 / #460 / #464 / #467) ---- */

/** What the change GET states beyond the row: every field the route omits stays null. */
interface ChangeDetail {
  readonly revisions: ReadonlyArray<ChangeRevision>
  readonly reviews: ReadonlyArray<ChangeVerdict> | null
  /** null when the DTO carries no `conflicts[]` — the conflicts route answers then. */
  readonly conflicts: ReadonlyArray<ConflictRow> | null
  /** plue's server-computed stack position; null when the DTO carries no `stack`. */
  readonly stack:
    | { readonly position: number; readonly size: number; readonly landingRequestNumber: number | null }
    | null
  readonly turn: ChangeTurn | null
  readonly owners: ChangeOwners | null
  readonly landed: ChangeLanded | null
}

const parseRevision = (value: unknown): ChangeRevision | null => {
  if (!isRecord(value)) return null
  const seq = seqOrNull(value.seq)
  const commitId = str(value.commit_id)
  if (seq === null || commitId === null) return null
  const agentSessionId = str(value.agent_session_id)
  const workspaceSnapshotId = str(value.workspace_snapshot_id)
  const source = str(value.source)
  const createdAt = str(value.created_at)
  return {
    seq,
    commitId,
    parentCommitId: str(value.parent_commit_id),
    ...(source === null ? {} : { source }),
    ...(agentSessionId === null ? {} : { agentSessionId }),
    ...(workspaceSnapshotId === null ? {} : { workspaceSnapshotId }),
    operationIds: strings(value.operation_ids),
    ...(createdAt === null ? {} : { createdAt })
  }
}

/** A verdict off the change GET's `reviews[]`: plue's verdict word and the confidence WORD, never a number. */
const parseReview = (value: unknown): ChangeVerdict | null => {
  if (!isRecord(value)) return null
  const verdict = str(value.verdict)
  if (verdict === null) return null
  return {
    reviewer: str(value.reviewer),
    /*
     * plue#500: the login, or an agent session's display title. plue writes
     * the field without omitempty, so an empty string is a lookup that
     * missed and reads as absent — the row then falls back to `reviewer`.
     */
    reviewerLogin: str(value.reviewer_login),
    reviewerKind: str(value.reviewer_kind),
    verdict,
    /* plue#484: the review's own type word beside the agent's verdict. */
    type: str(value.type),
    confidence: str(value.confidence_bucket),
    summary: typeof value.summary === "string" ? value.summary : "",
    commitId: str(value.commit_id),
    seq: seqOrNull(value.seq),
    lastReviewedSeq: seqOrNull(value.last_reviewed_seq)
  }
}

/*
 * Whose turn it is (plue#460, and #484's `actor_login`). The login is the
 * user's username or the agent session's display title; the id stays on the
 * row but the card never renders it, so a wire that names no login leaves
 * the line reading the party alone.
 */
const parseTurn = (value: unknown): ChangeTurn | null => {
  if (!isRecord(value)) return null
  const party = str(value.party)
  if (party === null) return null
  return {
    party,
    actorId: str(value.actor_id),
    actorLogin: str(value.actor_login),
    since: str(value.since),
    reason: str(value.reason)
  }
}

/** An owner principal renders by name only: a login or a team, never expanded. */
const principalName = (value: unknown): string | null => {
  if (!isRecord(value)) return null
  return str(value.login) ?? str(value.team)
}

const parseOwners = (value: unknown): ChangeOwners | null => {
  if (!isRecord(value)) return null
  return {
    touchedPaths: arrayOf(value.touched_paths, "touched_paths").flatMap((entry) => {
      if (!isRecord(entry)) return []
      const path = str(entry.path)
      if (path === null) return []
      const satisfied = isRecord(entry.satisfied_by) ? str(entry.satisfied_by.login) : null
      return [{
        path,
        owners: arrayOf(entry.owners, "owners").flatMap((owner) => {
          const name = principalName(owner)
          return name === null ? [] : [name]
        }),
        agentPolicy: str(entry.agent_policy) ?? "",
        satisfiedBy: satisfied === null
          ? null
          : { login: satisfied, seq: isRecord(entry.satisfied_by) ? seqOrNull(entry.satisfied_by.seq) : null }
      }]
    }),
    requiredApprovers: strings(value.required_approvers),
    suggestedReviewers: strings(value.suggested_reviewers),
    missingApprovals: arrayOf(value.missing_approvals, "missing_approvals").flatMap((entry) => {
      if (!isRecord(entry)) return []
      const path = str(entry.path)
      return path === null ? [] : [{ path, candidates: strings(entry.candidates) }]
    })
  }
}

const parseLanded = (value: unknown): ChangeLanded | null => {
  if (!isRecord(value)) return null
  return {
    at: str(value.at),
    by: str(value.by),
    /* plue#485: the landing request's NUMBER, which is what addresses it in routes. */
    landingRequestNumber: seqOrNull(value.landing_request_number),
    approvedBy: arrayOf(value.approved_by, "approved_by").flatMap((entry) => {
      if (!isRecord(entry)) return []
      const login = str(entry.login)
      return login === null ? [] : [{ login, seq: seqOrNull(entry.seq) }]
    })
  }
}

/** One conflict row off the DTO (`path`, `state`) or the conflicts route (`file_path`, `resolution_status`). */
const parseConflict = (value: unknown): ConflictRow | null => {
  if (!isRecord(value)) return null
  const path = str(value.path) ?? str(value.file_path)
  if (path === null) return null
  return { path, state: str(value.state) ?? str(value.resolution_status) ?? "unresolved" }
}

/**
 * The change row plus what the DTO states beyond it. `currentSeq` is plue's
 * `current_seq` when it names a recorded revision, else the revision whose
 * commit is the change's — a lookup, never an inference from time.
 */
const parseChangeWire = (value: unknown, repoId: string): { readonly input: ChangeInput; readonly detail: ChangeDetail } | null => {
  if (!isRecord(value)) return null
  const changeId = str(value.change_id)
  if (changeId === null) return null
  const commitId = str(value.commit_id)
  const revisions = Array.isArray(value.revisions)
    ? value.revisions.flatMap((entry) => {
      const parsed = parseRevision(entry)
      return parsed === null ? [] : [parsed]
    })
    : null
  const currentSeq = seqOrNull(value.current_seq)
    ?? revisions?.find((revision) => revision.commitId === commitId)?.seq
    ?? null
  const stack = isRecord(value.stack) ? value.stack : null
  const position = stack === null ? null : seqOrNull(stack.position)
  const size = stack === null ? null : seqOrNull(stack.size)
  return {
    input: {
      id: changeRowId(repoId, changeId),
      repoId,
      changeId,
      commitId,
      description: typeof value.description === "string" ? value.description : "",
      authorName: str(value.author_name),
      timestamp: str(value.timestamp),
      hasConflict: value.has_conflict === true,
      parentChangeIds: strings(value.parent_change_ids),
      currentSeq,
      revisionCount: revisions === null ? null : revisions.length
    },
    detail: {
      revisions: revisions ?? [],
      reviews: Array.isArray(value.reviews)
        ? value.reviews.flatMap((entry) => {
          const parsed = parseReview(entry)
          return parsed === null ? [] : [parsed]
        })
        : null,
      conflicts: Array.isArray(value.conflicts)
        ? value.conflicts.flatMap((entry) => {
          const parsed = parseConflict(entry)
          return parsed === null ? [] : [parsed]
        })
        : null,
      stack: position === null || size === null
        ? null
        : { position, size, landingRequestNumber: stack === null ? null : seqOrNull(stack.landing_request_number) },
      turn: parseTurn(value.turn),
      owners: parseOwners(value.owners),
      landed: parseLanded(value.landed)
    }
  }
}

/* ---- the auxiliaries' wire shapes ---- */

/** One file of the diff route's answer; the hunk inlines only under the cap. */
const parseDiffFile = (value: unknown, includePatch: boolean): DiffFile | null => {
  if (!isRecord(value)) return null
  const path = str(value.path)
  if (path === null) return null
  const patch = str(value.patch)
  const patchLines = patch === null ? 0 : patch.split("\n").length
  const inline = patch !== null && (includePatch || patchLines <= INLINE_PATCH_LINE_CAP)
  return {
    path,
    ...(str(value.old_path) === null ? {} : { oldPath: str(value.old_path) as string }),
    changeType: str(value.change_type) ?? "modified",
    isBinary: value.is_binary === true,
    additions: intOrNull(value.additions) ?? 0,
    deletions: intOrNull(value.deletions) ?? 0,
    ...(inline ? { patch: patch as string } : patch === null ? {} : { patchLines })
  }
}

/** One unsatisfied requirement, in the gate's own fields (plue#452 `blocked_by`). */
const parseBlock = (value: unknown): LandingBlock | null => {
  if (!isRecord(value)) return null
  const kind = str(value.kind)
  if (kind === null) return null
  return {
    kind,
    name: str(value.name),
    repo: str(value.repo),
    missing: str(value.missing),
    count: intOrNull(value.count),
    path: str(value.path),
    candidates: strings(value.candidates)
  }
}

/*
 * One `review_requests[]` row on the landing DTO (plue#488). A request names
 * EITHER a human reviewer or an agent, never both, so both fields are read
 * and whichever the wire filled is the one the picker shows. `id` is what
 * the DELETE addresses; `state` is plue's own word.
 */
const parseReviewRequest = (value: unknown): ChangeReviewRequest | null => {
  if (!isRecord(value)) return null
  const id = intOrNull(value.id)
  const state = str(value.state)
  if (id === null || state === null) return null
  const reviewer = isRecord(value.reviewer) ? str(value.reviewer.login) : null
  const agent = str(value.agent)
  if (reviewer === null && agent === null) return null
  return {
    id,
    reviewer,
    agent,
    requestedBy: isRecord(value.requested_by) ? str(value.requested_by.login) : null,
    state,
    createdAt: str(value.created_at)
  }
}

interface LandingWire {
  readonly number: number
  readonly state: string
  readonly changeIds: ReadonlyArray<string>
  readonly targetBookmark: string
  readonly conflictStatus: string
  /** null when the list did not state it. */
  readonly landablePrefix: number | null
  /** The gate's blocks keyed by change id; null when the list did not state it. */
  readonly blockedBy: Readonly<Record<string, ReadonlyArray<LandingBlock>>> | null
  readonly turn: ChangeTurn | null
  /** plue#488 `review_requests[]`; null when the row did not carry the key at all. */
  readonly reviewRequests: ReadonlyArray<ChangeReviewRequest> | null
}

/** One landing request row off the list (change_ids, stack_size, landable_prefix, blocked_by, turn). */
const parseLanding = (value: unknown): LandingWire | null => {
  if (!isRecord(value)) return null
  const number = intOrNull(value.number)
  if (number === null) return null
  const landablePrefix = intOrNull(value.landable_prefix)
  const blockedBy = isRecord(value.blocked_by)
    ? Object.fromEntries(
      Object.entries(value.blocked_by).map(([changeId, blocks]) => [
        changeId,
        arrayOf(blocks, "blocked_by").flatMap((entry) => {
          const parsed = parseBlock(entry)
          return parsed === null ? [] : [parsed]
        })
      ])
    )
    : null
  return {
    number,
    state: str(value.state) ?? "unknown",
    changeIds: strings(value.change_ids),
    targetBookmark: str(value.target_bookmark) ?? "main",
    conflictStatus: str(value.conflict_status) ?? "unknown",
    landablePrefix: landablePrefix === null || landablePrefix < 0 ? null : landablePrefix,
    blockedBy,
    turn: parseTurn(value.turn),
    reviewRequests: Array.isArray(value.review_requests)
      ? value.review_requests.flatMap((entry) => {
        const parsed = parseReviewRequest(entry)
        return parsed === null ? [] : [parsed]
      })
      : null
  }
}

/**
 * A comment thread. plue#486 separated the two states the response used to
 * collide: `state` is the THREAD LIFECYCLE (`open` / `done` / `resolved`)
 * and `anchor_state` is the anchor's position at the current revision
 * (`current` / `stale` / `moved`). Both are read as named.
 *
 * The pre-#486 derivation stays as a FALLBACK and only that: a row that
 * spells no lifecycle in `state` falls back to the timestamps (Done sets
 * `done_at`, Ack sets `resolved_at`, Reopen clears both), and a row that
 * spells no `anchor_state` falls back to an anchor word sitting in `state`.
 * A row that states neither leaves both null — the card then renders no
 * glyph and offers no transition.
 *
 * plue#484 `user_login` names the comment's author; a row without one has no
 * author and the card renders none.
 */
const parseComment = (value: unknown): ChangeThread | null => {
  if (!isRecord(value)) return null
  const rawState = str(value.state)
  const rawAnchor = str(value.anchor_state)
  const anchorWord = (word: string | null): ChangeThread["anchor"] =>
    word === "current" || word === "stale" || word === "moved" ? word : null
  const anchor = anchorWord(rawAnchor) ?? anchorWord(rawState)
  const lifecycleFromState = rawState === "open" || rawState === "done" || rawState === "resolved" ? rawState : null
  const hasTimestamps = "done_at" in value && "resolved_at" in value
  const state: ChangeThread["state"] = lifecycleFromState ?? (hasTimestamps
    ? (str(value.resolved_at) !== null ? "resolved" : str(value.done_at) !== null ? "done" : "open")
    : null)
  const resolvedIn = isRecord(value.resolved_in_revision) ? value.resolved_in_revision : null
  return {
    id: intOrNull(value.id),
    path: str(value.path),
    line: seqOrNull(value.line),
    currentLine: seqOrNull(value.current_line),
    body: typeof value.body === "string" ? value.body : "",
    author: str(value.user_login),
    createdAt: str(value.created_at),
    state,
    anchor,
    commitId: str(value.commit_id),
    resolvedInRevision: resolvedIn === null ? null : { commitId: str(resolvedIn.commit_id), seq: seqOrNull(resolvedIn.seq) }
  }
}

/** One check row off the statuses route, with the work it states (#452). */
const parseCheck = (value: unknown): (ChangeCheck & { readonly createdAt: string }) | null => {
  if (!isRecord(value)) return null
  const context = str(value.context)
  const state = str(value.status)
  if (context === null || state === null) return null
  const affected = intOrNull(value.targets_affected)
  const ran = intOrNull(value.targets_ran)
  const cached = intOrNull(value.targets_cached)
  const duration = intOrNull(value.duration_ms)
  return {
    context,
    state,
    ...(affected === null || affected < 0 ? {} : { targetsAffected: affected }),
    ...(ran === null || ran < 0 ? {} : { targetsRan: ran }),
    ...(cached === null || cached < 0 ? {} : { targetsCached: cached }),
    ...(duration === null || duration < 0 ? {} : { durationMs: duration }),
    ...("workspace_id" in value ? { workspaceId: str(value.workspace_id) } : {}),
    createdAt: str(value.created_at) ?? ""
  }
}

/*
 * Status rows repeat contexts across re-runs and arrive created_at DESC, so
 * the NEWEST row per context wins, decided by created_at — a naive
 * last-write-wins keeps the OLDEST row and shows "pending" forever after a
 * green re-run.
 */
const newestPerContext = (rows: ReadonlyArray<ChangeCheck & { readonly createdAt: string }>): Array<ChangeCheck> => {
  const byContext = new Map<string, ChangeCheck & { readonly createdAt: string }>()
  for (const row of rows) {
    const existing = byContext.get(row.context)
    if (existing === undefined || row.createdAt > existing.createdAt) byContext.set(row.context, row)
  }
  return [...byContext.values()].map(({ createdAt: _createdAt, ...check }) => check)
}

/** One finding off the findings route: the server's `state` (current / stale) and `feedback` ride verbatim. */
/**
 * The recorded feedback on a finding, as ONE word for the row.
 *
 * plue answers `feedback` as an object (`services.FindingFeedbackResponse`
 * = `{ useful, note?, by_user_id }`), so the word is the boolean's: `useful`
 * or `not useful`. A server that spells the word directly is taken at its
 * word; anything else is no recorded feedback and the row does not dim.
 */
const parseFindingFeedback = (value: unknown): string | null => {
  if (isRecord(value)) {
    if (typeof value.useful !== "boolean") return null
    return value.useful ? "useful" : "not useful"
  }
  return str(value)
}

const parseFinding = (value: unknown): ChangeFinding | null => {
  if (!isRecord(value)) return null
  const analyzer = str(value.analyzer)
  const path = str(value.path)
  if (analyzer === null || path === null) return null
  const source = str(value.source)
  return {
    id: intOrNull(value.id),
    analyzer,
    ...(source === null ? {} : { source }),
    severity: str(value.severity) ?? "",
    path,
    line: seqOrNull(value.line),
    summary: typeof value.text === "string" ? value.text : "",
    suggestion: str(value.suggestion),
    raisedAtSeq: seqOrNull(value.seq),
    commitId: str(value.commit_id),
    state: str(value.state),
    feedback: parseFindingFeedback(value.feedback)
  }
}

const parseAnalyzer = (value: unknown): ChangeAnalyzerRun | null => {
  if (!isRecord(value)) return null
  const name = str(value.name)
  if (name === null) return null
  return {
    name,
    state: str(value.state) ?? "",
    seq: seqOrNull(value.seq),
    startedAt: str(value.started_at),
    finishedAt: str(value.finished_at),
    pausedBy: str(value.paused_by),
    pausedReason: str(value.paused_reason),
    failureReason: str(value.failure_reason)
  }
}

const parseWalkthrough = (value: unknown, seq: number | null): ChangeWalkthrough | null => {
  if (!isRecord(value) || !Array.isArray(value.sections) || !Array.isArray(value.quiz)) return null
  return {
    seq,
    sections: value.sections.flatMap((entry) => {
      if (!isRecord(entry)) return []
      const title = str(entry.title)
      if (title === null) return []
      return [{ title, markdown: typeof entry.markdown === "string" ? entry.markdown : "", diagram: str(entry.diagram) }]
    }),
    quiz: value.quiz
  }
}

/** The forked workspace off POST /workspaces, in the row's shape (WorkspaceSeam owns the full parser). */
/** One changeset row off the live DTO (ADR 0003); malformed rows drop. */
const parseChangeset = (value: unknown): ChangesetState | null => {
  if (!isRecord(value)) return null
  const id = intOrNull(value.id)
  const organization = str(value.organization)
  const state = str(value.state)
  if (id === null || organization === null || state === null) return null
  if (state !== "pending" && state !== "landing" && state !== "landed" && state !== "failed") return null
  return {
    id,
    organization,
    superproject: str(value.superproject) ?? "",
    changeId: str(value.change_id) ?? "",
    state,
    failureReason: str(value.failure_reason),
    targetBookmark: str(value.target_bookmark) ?? "main",
    members: arrayOf(value.members, "members").flatMap((member) => {
      if (!isRecord(member)) return []
      const repository = str(member.repository)
      const path = str(member.path)
      const changeId = str(member.change_id)
      const commitId = str(member.commit_id)
      if (repository === null || path === null || changeId === null || commitId === null) return []
      return [{
        repository,
        path,
        changeId,
        commitId,
        targetBookmark: str(member.target_bookmark) ?? "main",
        previousCommitId: str(member.previous_commit_id),
        landedCommitId: str(member.landed_commit_id)
      }]
    })
  }
}

/*
 * The changeset this change belongs to, scoped by REPOSITORY: a jj change id
 * is per-repo and nothing stops two repos from holding the same id, so a
 * bare id match could attach — and land — another repo's changeset. A match
 * is `superproject · change_id` or `member.repository · member.change_id`;
 * plue spells both `org/name` (changeset.go), which is the app's repo id.
 */
const changesetFor = (
  changesets: ReadonlyArray<ChangesetState>,
  repoId: string,
  changeId: string
): ChangesetState | null =>
  changesets.find((changeset) =>
    (changeset.superproject === repoId && changeset.changeId === changeId)
    || changeset.members.some((member) => member.repository === repoId && member.changeId === changeId)
  ) ?? null

const cardIdOf = (repoId: string, changeId: string): string => `change-${repoId}-${changeId}`
const diffCardIdOf = (repoId: string, changeId: string): string => `diff-${repoId}-${changeId}`

/* ---- pins ---- */

/** The Diff facet's two pins resolved against the recorded revisions. */
interface Pins {
  /** `parent` or a revision seq as a string. */
  readonly from: string
  /** `current` or a revision seq as a string. */
  readonly to: string
  /** The revision the `to` side names; null when no revision is recorded (the bare route). */
  readonly toRevision: ChangeRevision | null
  /** The route's query string; null for the bare change-vs-parent read. */
  readonly query: string | null
}

const DEFAULT_PINS = { from: "parent", to: "current" } as const

/**
 * Resolve `from`/`to` tokens: `parent` and `current` are the defaults; a
 * number names a recorded revision. `parent → current` reads the bare route
 * (plue compares the change against its recorded parent); every other pair
 * is a revision diff with jj interdiff semantics (#451). A token naming no
 * recorded revision refuses by name — nothing is guessed.
 */
const resolvePins = (
  revisions: ReadonlyArray<ChangeRevision>,
  currentSeq: number | null,
  from: string,
  to: string,
  changeId: string
): Pins | { readonly error: string } => {
  const current = currentSeq === null ? null : revisions.find((revision) => revision.seq === currentSeq) ?? null
  const bySeq = (token: string, side: "from" | "to"): ChangeRevision | { readonly error: string } => {
    const seq = Number(token)
    if (!Number.isInteger(seq) || seq <= 0) {
      return { error: `change.diff's ${side} pin is "parent"${side === "to" ? ", \"current\"," : ""} or a revision number — not "${token}"` }
    }
    const revision = revisions.find((candidate) => candidate.seq === seq)
    if (revision === undefined) {
      return {
        error: revisions.length === 0
          ? `No revisions are recorded for ${changeId}, so rev ${seq} can't be pinned — the diff offers parent → current.`
          : `${changeId} has no rev ${seq} — its revisions are 1 → ${revisions[revisions.length - 1]?.seq ?? revisions.length}.`
      }
    }
    return revision
  }
  if (from === "parent" && to === "current") return { from, to, toRevision: current, query: null }
  const toRevision = to === "current" ? current : bySeq(to, "to")
  if (toRevision !== null && "error" in toRevision) return toRevision
  if (toRevision === null) {
    return { error: `No revision is recorded as current for ${changeId}, so the diff can't pin to it — the diff offers parent → current.` }
  }
  let fromToken = from
  if (from !== "parent") {
    const fromRevision = bySeq(from, "from")
    if ("error" in fromRevision) return fromRevision
    fromToken = String(fromRevision.seq)
  }
  return { from: fromToken, to, toRevision, query: `from=${encodeURIComponent(fromToken)}&to=${toRevision.seq}` }
}

/** The label a pin wears in a card line: `parent`, `current`, or `rev N`. */
const pinLabel = (token: string): string => (token === "parent" || token === "current" ? token : `rev ${token}`)

/**
 * The card's `unread` lines with ONE auxiliary's answer folded in: the
 * reason when that read failed, no line at all when it succeeded. Every
 * other auxiliary keeps the line its own last read left, which is what a
 * one-panel read (a picker) means.
 */
const foldUnread = (prior: ChangeUnread | undefined, key: keyof ChangeUnread, read: Read<unknown>): ChangeUnread => {
  const next: ChangeUnread = { ...prior }
  if ("unread" in read) next[key] = read.unread
  else delete next[key]
  return next
}

export const createChangeSeam = (ctx: SeamContext, deps: ChangeSeamDeps = {}): ChangeSeam => {
  const { get: getJson, send: sendJson } = createCloudClient(ctx)
  const repoPath = (repoId: string, rest: string): string => {
    const [owner = "", name = ""] = repoId.split("/")
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${rest}`
  }
  const changePath = (repoId: string, changeId: string, rest = ""): string =>
    repoPath(repoId, `/changes/${encodeURIComponent(changeId)}${rest}`)

  /* Reads need only the legacy token's read:repository — a definitive signed-in answer is the gate. */
  const gate = (): string | void => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return refuseCloudSignIn(ctx)
  }
  const degraded = (): boolean => ctx.store.collections.cloudSessions.get("cloud")?.scopes === "degraded"
  const username = (): string | null => ctx.store.collections.cloudSessions.get("cloud")?.username ?? null

  /*
   * The repository a change act routes through: the explicit one, else the
   * changes collection's record of this change, else the app's target repo
   * (the active selection, or the single loaded repository). Never a guess.
   */
  const resolveRepo = (
    changeId: string,
    repo?: string
  ): { readonly repo: string } | { readonly error: string } => {
    if (repo !== undefined && repo !== "") {
      const target = resolveTargetRepo(ctx.store, repo)
      return "error" in target ? target : { repo: target.repo }
    }
    const repositories = new Set<string>()
    for (const row of ctx.store.collections.changes.values()) {
      if (row.changeId === changeId) repositories.add(row.repoId)
    }
    const matches = [...repositories].sort()
    if (matches.length > 1) {
      return { error: `Change ${changeId} is loaded in several repositories (${matches.join(", ")}) — name one as owner/repo` }
    }
    if (matches.length === 1) return { repo: matches[0]! }
    const target = resolveTargetRepo(ctx.store, undefined)
    return "error" in target ? target : { repo: target.repo }
  }

  /* ---- the reads: absent answers, never inventions ---- */

  /** The change DTO; the row is dispatched into the changes collection. */
  const loadChange = async (
    repoId: string,
    changeId: string,
    current = captureCloudOwner(ctx)
  ): Promise<{ readonly change: ChangeInput; readonly detail: ChangeDetail } | { readonly error: string }> => {
    const answer = await getJson(changePath(repoId, changeId))
    if (!current()) return { error: SIGN_OUT_REFUSAL }
    if ("error" in answer) return { error: answer.error }
    const parsed = parseChangeWire(answer.body, repoId)
    if (parsed === null) return { error: `Smithers Cloud's answer for change ${changeId} was malformed.` }
    ctx.dispatch({ type: "change.loaded", actor: "system", change: parsed.input })
    return { change: parsed.input, detail: parsed.detail }
  }

  /** The per-file conflicts off their own route (when the DTO carries none). */
  const loadConflicts = async (repoId: string, changeId: string): Promise<Read<ReadonlyArray<ConflictRow>>> => {
    const answer = await getJson(changePath(repoId, changeId, "/conflicts"))
    if ("error" in answer) return { unread: answer.error }
    const rows = arrayOrNull(answer.body, "conflicts")
    if (rows === null) return { unread: `Smithers Cloud's answer for the conflicts of ${changeId} was malformed` }
    return {
      value: rows.flatMap((entry) => {
        const parsed = parseConflict(entry)
        return parsed === null ? [] : [parsed]
      })
    }
  }

  interface DiffRead {
    readonly files: Array<DiffFile>
    readonly stat: RepoStat
  }

  /** The diff at the pins (the bare route for parent → current). `path` cuts to one file, its hunk inline regardless of size. */
  const loadDiff = async (repoId: string, changeId: string, pins: Pins, path?: string): Promise<Read<DiffRead>> => {
    const params = [
      ...(pins.query === null ? [] : [pins.query]),
      ...(path === undefined ? [] : [`path=${encodeURIComponent(path)}`])
    ]
    const answer = await getJson(changePath(repoId, changeId, `/diff${params.length === 0 ? "" : `?${params.join("&")}`}`))
    if ("error" in answer) return { unread: answer.error }
    const rows = isRecord(answer.body) ? arrayOrNull(answer.body, "file_diffs") : null
    if (rows === null) return { unread: `Smithers Cloud's answer for the diff of ${changeId} was malformed` }
    const files = rows.flatMap((entry) => {
      const parsed = parseDiffFile(entry, path !== undefined)
      return parsed === null || (path !== undefined && parsed.path !== path) ? [] : [parsed]
    })
    let additions = 0
    let deletions = 0
    for (const file of files) {
      additions += file.additions
      deletions += file.deletions
    }
    return { value: { files, stat: { repo: repoId, additions, deletions } } }
  }

  interface LandingHit {
    readonly landing: LandingWire
    /** The change's 1-based index in `change_ids` — request order, the inference the DTO's `stack.position` replaces when read. */
    readonly position: number
  }

  /** The landing request whose stack carries this change; a read `null` means no request does. */
  const loadLanding = async (repoId: string, changeId: string): Promise<Read<LandingHit | null>> => {
    const answer = await getJson(repoPath(repoId, "/landings?limit=100"))
    if ("error" in answer) return { unread: answer.error }
    const rows = arrayOrNull(answer.body, "items")
    if (rows === null) return { unread: `Smithers Cloud's answer for the landing requests of ${repoId} was malformed` }
    for (const entry of rows) {
      const landing = parseLanding(entry)
      if (landing === null) continue
      const index = landing.changeIds.indexOf(changeId)
      if (index !== -1) return { value: { landing, position: index + 1 } }
    }
    return { value: null }
  }

  /** Threads on the landing. */
  const loadComments = async (repoId: string, landingNumber: number): Promise<Read<ReadonlyArray<ChangeThread>>> => {
    const answer = await getJson(repoPath(repoId, `/landings/${landingNumber}/comments?limit=100`))
    if ("error" in answer) return { unread: answer.error }
    const rows = arrayOrNull(answer.body, "comments")
    if (rows === null) return { unread: `Smithers Cloud's answer for the comments of landing request #${landingNumber} was malformed` }
    return {
      value: rows.flatMap((entry) => {
        const parsed = parseComment(entry)
        return parsed === null ? [] : [parsed]
      })
    }
  }

  /** The checks at one commit, newest per context. */
  const loadChecks = async (repoId: string, commitId: string | null): Promise<Read<ReadonlyArray<ChangeCheck>>> => {
    if (commitId === null) return { unread: "the change carries no commit id to read statuses at" }
    const answer = await getJson(repoPath(repoId, `/commits/${encodeURIComponent(commitId)}/statuses?limit=100`))
    if ("error" in answer) return { unread: answer.error }
    const rows = arrayOrNull(answer.body, "statuses")
    if (rows === null) return { unread: `Smithers Cloud's answer for the statuses of ${commitId} was malformed` }
    return {
      value: newestPerContext(
        rows.flatMap((entry) => {
          const parsed = parseCheck(entry)
          return parsed === null ? [] : [parsed]
        })
      )
    }
  }

  interface FindingsRead {
    readonly findings: ReadonlyArray<ChangeFinding>
    readonly analyzers: ReadonlyArray<ChangeAnalyzerRun>
  }

  /** Findings per revision (every revision, so stale findings stay visible) with the analyzer runs. */
  const loadFindings = async (repoId: string, changeId: string): Promise<Read<FindingsRead>> => {
    const answer = await getJson(changePath(repoId, changeId, "/findings"))
    if ("error" in answer) return { unread: answer.error }
    const findings = isRecord(answer.body) ? arrayOrNull(answer.body, "findings") : null
    const analyzers = isRecord(answer.body) ? arrayOrNull(answer.body, "analyzers") : null
    if (findings === null || analyzers === null) return { unread: `Smithers Cloud's answer for the findings of ${changeId} was malformed` }
    return {
      value: {
        findings: findings.flatMap((entry) => {
          const parsed = parseFinding(entry)
          return parsed === null ? [] : [parsed]
        }),
        analyzers: analyzers.flatMap((entry) => {
          const parsed = parseAnalyzer(entry)
          return parsed === null ? [] : [parsed]
        })
      }
    }
  }

  /** The walkthrough artifact at the revision; a 404 is "none" (the facet is then absent), not an unread. */
  const loadWalkthrough = async (repoId: string, changeId: string, seq: number | null): Promise<Read<ChangeWalkthrough | null>> => {
    const answer = await getJson(changePath(repoId, changeId, `/walkthrough${seq === null ? "" : `?rev=${seq}`}`))
    if ("error" in answer) return answer.status === 404 ? { value: null } : { unread: answer.error }
    const walkthrough = parseWalkthrough(answer.body, seq)
    return walkthrough === null
      ? { unread: `Smithers Cloud's answer for the walkthrough of ${changeId} was malformed` }
      : { value: walkthrough }
  }

  /** The org's changesets, when the repository's owner IS an org; a read `null` means none carries this change here. */
  const loadChangeset = async (repoId: string, changeId: string): Promise<Read<ChangesetState | null>> => {
    const repository = ctx.store.collections.repositories.get(repoId)
    if (repository?.ownerKind !== "org") return { value: null }
    const answer = await getJson(`/orgs/${encodeURIComponent(repository.org)}/changesets`)
    if ("error" in answer) return { unread: answer.error }
    const rows = arrayOrNull(answer.body, "changesets")
    if (rows === null) return { unread: `Smithers Cloud's answer for the changesets of ${repository.org} was malformed` }
    return {
      value: changesetFor(
        rows.flatMap((entry) => {
          const parsed = parseChangeset(entry)
          return parsed === null ? [] : [parsed]
        }),
        repoId,
        changeId
      )
    }
  }

  /* ---- the card ---- */

  /*
   * Render one change's card: the DTO row plus the auxiliaries. An override
   * wins; otherwise the existing card's value stands, so a facet switch
   * never blanks what the view loaded.
   */
  const renderChange = (change: ChangeInput, revisions: ReadonlyArray<ChangeRevision> | undefined, overrides: Partial<ChangeAux> = {}): void => {
    const id = cardIdOf(change.repoId, change.changeId)
    const existing = ctx.store.collections.cards.get(id)
    const prior = existing?.kind === "change" ? existing.payload : undefined
    const pick = <K extends keyof ChangeAux & keyof ChangePayload>(key: K): ChangePayload[K] | undefined => {
      if (overrides[key] !== undefined) return overrides[key] as ChangePayload[K]
      return prior?.[key]
    }
    const listOrNull = <T>(value: ReadonlyArray<T> | null | undefined): Array<T> | null | undefined =>
      value === undefined ? undefined : value === null ? null : [...value]
    const payload: ChangePayload = {
      repo: change.repoId,
      changeId: change.changeId,
      description: change.description,
      commitId: change.commitId,
      currentSeq: change.currentSeq,
      revisionCount: change.revisionCount,
      revisions: revisions !== undefined ? [...revisions] : prior?.revisions ?? [],
      authorName: change.authorName,
      timestamp: change.timestamp,
      repos: overrides.repos !== undefined ? [...overrides.repos] : prior?.repos ?? [],
      diff: pick("diff") ?? null,
      checks: listOrNull(pick("checks")) ?? null,
      checksAt: pick("checksAt") ?? null,
      findings: listOrNull(pick("findings")) ?? null,
      analyzers: listOrNull(pick("analyzers")) ?? null,
      reviews: listOrNull(pick("reviews")) ?? null,
      threads: listOrNull(pick("threads")) ?? null,
      reviewRequests: listOrNull(pick("reviewRequests")) ?? null,
      conflicts: listOrNull(pick("conflicts")) ?? null,
      stack: pick("stack") ?? null,
      turn: pick("turn") ?? null,
      owners: pick("owners") ?? null,
      landed: pick("landed") ?? null,
      walkthrough: pick("walkthrough") ?? null,
      changeset: pick("changeset") ?? null,
      ...(overrides.unread !== undefined
        ? (Object.keys(overrides.unread).length === 0 ? {} : { unread: overrides.unread })
        : prior?.unread !== undefined ? { unread: prior.unread } : {}),
      ...(overrides.facet !== undefined
        ? { facet: overrides.facet }
        : prior?.facet !== undefined ? { facet: prior.facet } : {}),
      ...(overrides.error !== undefined ? { error: overrides.error } : {})
    }
    const firstLine = change.description.split("\n")[0] ?? change.changeId
    const card: Card = {
      id,
      kind: "change",
      title: `${change.changeId} · ${firstLine === "" ? change.repoId : firstLine}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  /** What one view asks for beyond the defaults. */
  interface ViewOptions {
    readonly pins?: { readonly from: string; readonly to: string }
    /** The pins came from `review.since-mine`; the facet's first line names it. */
    readonly sinceReview?: { readonly reviewer: string; readonly seq: number }
    /** The revision the Checks facet reads at; the current commit when absent. */
    readonly checksSeq?: number
    readonly facet?: ChangeFacet
    readonly overrides?: Partial<ChangeAux>
  }

  /* The whole read: the change, then its auxiliaries in parallel, then the card. */
  const surfaceChange = async (repoId: string, changeId: string, options: ViewOptions = {}, current = captureCloudOwner(ctx)): Promise<string | void> => {
    if (!current()) return SIGN_OUT_REFUSAL
    const loaded = await loadChange(repoId, changeId, current)
    if ("error" in loaded) return loaded.error
    const { change, detail } = loaded
    const pins = resolvePins(
      detail.revisions,
      change.currentSeq,
      options.pins?.from ?? DEFAULT_PINS.from,
      options.pins?.to ?? DEFAULT_PINS.to,
      changeId
    )
    if ("error" in pins) return pins.error
    const checksRevision = options.checksSeq === undefined
      ? null
      : detail.revisions.find((revision) => revision.seq === options.checksSeq) ?? null
    if (options.checksSeq !== undefined && checksRevision === null) {
      return `${changeId} has no rev ${options.checksSeq} to read checks at.`
    }
    /*
     * ONE retention rule for every auxiliary of the FULL read: it writes
     * each of them from its own answer — the value when the route answered,
     * null plus the reason in `unread` when it did not — and nothing from
     * an earlier read survives it. A transient failure can therefore never
     * leave a stale "Conflicted" line or Land scope standing, nor a blank
     * that reads as "no checks". A no-read act (change.facet) and a
     * one-panel picker (surfacePins, surfaceChecksAt) keep the prior
     * payload of what they do not read, through renderChange's fallback.
     */
    const [conflicts, diff, landing, changeset, findings, walkthrough, checks] = await Promise.all([
      detail.conflicts === null ? loadConflicts(repoId, changeId) : Promise.resolve({ value: detail.conflicts }),
      loadDiff(repoId, changeId, pins),
      loadLanding(repoId, changeId),
      loadChangeset(repoId, changeId),
      loadFindings(repoId, changeId),
      loadWalkthrough(repoId, changeId, change.currentSeq),
      loadChecks(repoId, checksRevision === null ? change.commitId : checksRevision.commitId)
    ])
    if (!current()) return SIGN_OUT_REFUSAL
    /* Threads live on the landing request: unread when its list was, [] when no request carries the change. */
    const hit = "unread" in landing ? null : landing.value
    const threads: Read<ReadonlyArray<ChangeThread>> = "unread" in landing
      ? { unread: `the landing list wasn't read: ${landing.unread}` }
      : hit === null
      ? { value: [] }
      : await loadComments(repoId, hit.landing.number)
    if (!current()) return SIGN_OUT_REFUSAL
    const stack: StackRow | null = hit === null ? null : {
      /* plue#485: the change GET's own `landing_request_number` when it states one; the list's number otherwise. */
      landingNumber: detail.stack?.landingRequestNumber ?? hit.landing.number,
      state: hit.landing.state,
      /* plue's own stack position when the change GET states it; the request-order index otherwise. */
      position: detail.stack?.position ?? hit.position,
      size: detail.stack?.size ?? Math.max(hit.landing.changeIds.length, 1),
      changeIds: [...hit.landing.changeIds],
      targetBookmark: hit.landing.targetBookmark,
      conflictStatus: hit.landing.conflictStatus,
      landablePrefix: hit.landing.landablePrefix,
      ...(hit.landing.blockedBy === null ? {} : { blockedBy: [...(hit.landing.blockedBy[changeId] ?? [])] }),
      positionFrom: detail.stack === null ? "request-order" : "server"
    }
    renderChange(change, detail.revisions, {
      conflicts: "unread" in conflicts ? null : conflicts.value,
      repos: "unread" in diff ? [] : [diff.value.stat],
      diff: "unread" in diff ? null : {
        from: pins.from,
        to: pins.to,
        files: diff.value.files,
        sinceReview: options.sinceReview ?? null
      },
      checks: "unread" in checks ? null : checks.value,
      checksAt: checksRevision === null ? change.currentSeq : checksRevision.seq,
      findings: "unread" in findings ? null : findings.value.findings,
      analyzers: "unread" in findings ? null : findings.value.analyzers,
      reviews: detail.reviews,
      threads: "unread" in threads ? null : threads.value,
      /* plue#488: who has been asked; the landing DTO is the only place it lives. */
      reviewRequests: "unread" in landing ? null : hit === null ? [] : hit.landing.reviewRequests,
      stack,
      turn: detail.turn ?? hit?.landing.turn ?? null,
      owners: detail.owners,
      landed: detail.landed,
      walkthrough: "unread" in walkthrough ? null : walkthrough.value,
      changeset: "unread" in changeset ? null : changeset.value,
      unread: {
        ...("unread" in diff ? { diff: diff.unread } : {}),
        ...("unread" in conflicts ? { conflicts: conflicts.unread } : {}),
        ...("unread" in checks ? { checks: checks.unread } : {}),
        ...("unread" in findings ? { findings: findings.unread } : {}),
        ...(detail.reviews === null ? { reviews: "the change DTO carried no reviews[]" } : {}),
        ...("unread" in threads ? { threads: threads.unread } : {}),
        ...("unread" in landing
          ? { reviewRequests: `the landing list wasn't read: ${landing.unread}` }
          : hit !== null && hit.landing.reviewRequests === null
          ? { reviewRequests: "the landing request carried no review_requests[]" }
          : {}),
        ...("unread" in landing ? { stack: landing.unread } : {}),
        ...("unread" in changeset ? { changeset: changeset.unread } : {}),
        ...("unread" in walkthrough ? { walkthrough: walkthrough.unread } : {})
      },
      ...(options.facet === undefined ? {} : { facet: options.facet }),
      ...options.overrides
    })
    return
  }

  /**
   * The change row and revisions a loaded card already carries: a picker's
   * metadata, with no read of its own. null when no card is loaded.
   */
  const loadedChange = (
    repoId: string,
    changeId: string
  ): { readonly change: ChangeInput; readonly payload: ChangePayload } | null => {
    const card = ctx.store.collections.cards.get(cardIdOf(repoId, changeId))
    if (card?.kind !== "change") return null
    const change = ctx.store.collections.changes.get(changeRowId(repoId, changeId))
    return change === undefined ? null : { change, payload: card.payload }
  }

  /*
   * A picker's read: the ONE panel it names. `change.view` refreshes the
   * whole card; a picker only moves the Diff facet's pins, so it reads the
   * diff route alone and leaves every other panel — and every other
   * `unread` line — at the freshness its own last read gave it. The loaded
   * card's revisions resolve the pins; anything they cannot resolve (a
   * revision pushed since the card was read, or no card at all) falls back
   * to the full read, which rereads the change DTO and refuses by name when
   * the revision truly does not exist.
   */
  const surfacePins = async (
    repoId: string,
    changeId: string,
    pinned: { readonly from: string; readonly to: string },
    current = captureCloudOwner(ctx)
  ): Promise<string | void> => {
    if (!current()) return SIGN_OUT_REFUSAL
    const full: ViewOptions = { pins: pinned, facet: "diff" }
    const loaded = loadedChange(repoId, changeId)
    if (loaded === null) return surfaceChange(repoId, changeId, full, current)
    const pins = resolvePins(loaded.payload.revisions, loaded.payload.currentSeq, pinned.from, pinned.to, changeId)
    if ("error" in pins) return surfaceChange(repoId, changeId, full, current)
    const diff = await loadDiff(repoId, changeId, pins)
    if (!current()) return SIGN_OUT_REFUSAL
    renderChange(loaded.change, loaded.payload.revisions, {
      repos: "unread" in diff ? [] : [diff.value.stat],
      diff: "unread" in diff ? null : {
        from: pins.from,
        to: pins.to,
        files: diff.value.files,
        /* `review.since-mine` names the reviewer; a bare pin never does. */
        sinceReview: null
      },
      unread: foldUnread(loaded.payload.unread, "diff", diff),
      facet: "diff"
    })
    return
  }

  /** The Checks facet's picker, on the same one-panel rule as `surfacePins`. */
  const surfaceChecksAt = async (repoId: string, changeId: string, seq: number, current = captureCloudOwner(ctx)): Promise<string | void> => {
    if (!current()) return SIGN_OUT_REFUSAL
    const loaded = loadedChange(repoId, changeId)
    const revision = loaded?.payload.revisions.find((candidate) => candidate.seq === seq)
    if (loaded === null || revision === undefined) {
      return surfaceChange(repoId, changeId, { checksSeq: seq, facet: "checks" }, current)
    }
    const checks = await loadChecks(repoId, revision.commitId)
    if (!current()) return SIGN_OUT_REFUSAL
    renderChange(loaded.change, loaded.payload.revisions, {
      checks: "unread" in checks ? null : checks.value,
      checksAt: revision.seq,
      unread: foldUnread(loaded.payload.unread, "checks", checks),
      facet: "checks"
    })
    return
  }

  /** A committed mutation stays successful even when its cards cannot be refreshed. */
  const mutationResult = async (
    repoId: string,
    changeIds: string | ReadonlyArray<string>,
    value: string,
    options: ViewOptions = {},
    workspaceId: string | null = null,
    current = captureCloudOwner(ctx)
  ): Promise<{ readonly value: string }> => {
    if (!current()) return { value }
    const warnings: Array<string> = []
    const refresh = async (label: string, read: () => Promise<unknown>): Promise<void> => {
      try {
        const error = await read()
        if (typeof error === "string") warnings.push(`${label}: ${error}`)
      } catch (error) {
        /* The refresh threw rather than refused: its text is for diagnostics, the warning says what did not refresh. */
        ctx.report?.(`change.refresh ${label}`, error)
        warnings.push(`${label}: the refresh failed`)
      }
    }
    for (const changeId of typeof changeIds === "string" ? [changeIds] : changeIds) {
      if (!current()) break
      await refresh(`change ${changeId} on ${repoId}`, () => surfaceChange(repoId, changeId, options, current))
    }
    const viewWorkspace = deps.viewWorkspace
    if (current() && workspaceId !== null && viewWorkspace !== undefined) {
      await refresh(`computer ${workspaceId}`, () => viewWorkspace(workspaceId))
    }
    return { value: warnings.length === 0 ? value : `${value} Refresh warning: ${warnings.map(warning => warning.replace(/[.!?]$/u, "")).join("; ")}. Refresh the cards to reconcile the result; the mutation already succeeded.` }
  }

  /**
   * The landing number carrying the change: the card's stack when read, then
   * the change GET's own `stack.landing_request_number` (plue#485 — the
   * NUMBER routes address, beside the DB id they always carried), and only
   * then the 100-row landings list.
   */
  const landingNumberOf = async (repoId: string, changeId: string, current = captureCloudOwner(ctx)): Promise<{ readonly number: number } | { readonly error: string }> => {
    if (!current()) return { error: SIGN_OUT_REFUSAL }
    const card = ctx.store.collections.cards.get(cardIdOf(repoId, changeId))
    if (card?.kind === "change" && card.payload.stack !== null) return { number: card.payload.stack.landingNumber }
    const loaded = await loadChange(repoId, changeId, current)
    if (!current()) return { error: SIGN_OUT_REFUSAL }
    if (!("error" in loaded)) {
      const stated = loaded.detail.stack?.landingRequestNumber ?? null
      if (stated !== null) return { number: stated }
    }
    const landing = await loadLanding(repoId, changeId)
    if (!current()) return { error: SIGN_OUT_REFUSAL }
    if ("unread" in landing) return { error: `The landing requests of ${repoId} weren't read (${landing.unread}).` }
    if (landing.value === null) return { error: `No landing request carries ${changeId} on ${repoId} — its review comments live on one.` }
    return { number: landing.value.landing.number }
  }

  /* ---- the acts ---- */

  const viewChange: ChangeSeam["viewChange"] = async (changeId, rev, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = captureCloudOwner(ctx)
    if (changeId.trim() === "") return "change.view needs a change id: /change.view <changeId>"
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const error = await surfaceChange(
      resolved.repo,
      changeId,
      rev === undefined ? {} : { pins: { from: "parent", to: String(rev) }, facet: "diff" },
      current
    )
    if (error !== undefined) return error
    return {
      value: rev === undefined
        ? `Change ${changeId} on ${resolved.repo} — the card tracks it.`
        : `Change ${changeId} on ${resolved.repo} at rev ${rev} — the card's diff is pinned parent → rev ${rev}.`
    }
  }

  const setPins: ChangeSeam["setPins"] = async (changeId, from, to, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = captureCloudOwner(ctx)
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const error = await surfacePins(resolved.repo, changeId, { from, to }, current)
    if (error !== undefined) return error
    return { value: `Diff of ${changeId} pinned ${pinLabel(from)} → ${pinLabel(to)}.` }
  }

  const sinceMyReview: ChangeSeam["sinceMyReview"] = async (changeId, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = captureCloudOwner(ctx)
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const me = username()
    if (me === null) return refuseCloudSignIn(ctx, "The signed-in Smithers Cloud user isn't known. Sign in again to continue.")
    const loaded = await loadChange(resolved.repo, changeId, current)
    if ("error" in loaded) return loaded.error
    const mine = (loaded.detail.reviews ?? []).find((review) => review.reviewer === me && review.reviewerKind !== "agent")
    if (mine === undefined || mine.lastReviewedSeq === null) {
      return `No review by ${me} is recorded on ${changeId} — /prs.review posts one; the diff stays parent → current.`
    }
    if (loaded.change.currentSeq !== null && mine.lastReviewedSeq >= loaded.change.currentSeq) {
      return `Your last review of ${changeId} is at the current revision (rev ${mine.lastReviewedSeq}) — nothing changed since.`
    }
    const error = await surfaceChange(resolved.repo, changeId, {
      pins: { from: String(mine.lastReviewedSeq), to: "current" },
      sinceReview: { reviewer: me, seq: mine.lastReviewedSeq },
      facet: "diff"
    }, current)
    if (error !== undefined) return error
    return { value: `Diff of ${changeId} since your review at rev ${mine.lastReviewedSeq} → current.` }
  }

  const checksAt: ChangeSeam["checksAt"] = async (changeId, seq, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = captureCloudOwner(ctx)
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const error = await surfaceChecksAt(resolved.repo, changeId, seq, current)
    if (error !== undefined) return error
    return { value: `Checks of ${changeId} at rev ${seq}.` }
  }

  const diffChange: ChangeSeam["diffChange"] = async (changeId, from, to, path, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = captureCloudOwner(ctx)
    if (changeId.trim() === "") return "change.diff needs a change id: /change.diff <changeId>"
    const fromPin = from === undefined || from === "" ? DEFAULT_PINS.from : from
    const toPin = to === undefined || to === "" ? DEFAULT_PINS.to : to
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const loaded = await loadChange(resolved.repo, changeId, current)
    if ("error" in loaded) return loaded.error
    const { change, detail } = loaded
    const pins = resolvePins(detail.revisions, change.currentSeq, fromPin, toPin, changeId)
    if ("error" in pins) return pins.error
    const [conflicts, diff] = await Promise.all([
      detail.conflicts === null ? loadConflicts(resolved.repo, changeId) : Promise.resolve({ value: detail.conflicts }),
      loadDiff(resolved.repo, changeId, pins, path === undefined || path === "" ? undefined : path)
    ])
    if (!current()) return SIGN_OUT_REFUSAL
    if ("unread" in diff) return `The diff of change ${changeId} on ${resolved.repo} couldn't be read right now (${diff.unread}).`
    /* Unread conflicts mark no file; the change card is where an unread conflicts list is reported. */
    const conflicted = new Set(("unread" in conflicts ? [] : conflicts.value).map((conflict) => conflict.path))
    const files = [...diff.value.files]
      .map((file) => (conflicted.has(file.path) ? { ...file, conflicted: true } : file))
      .sort((left, right) => Number(right.conflicted === true) - Number(left.conflicted === true))
    const id = diffCardIdOf(resolved.repo, changeId)
    const existing = ctx.store.collections.cards.get(id)
    const card: Card = {
      id,
      kind: "diff",
      title: `${changeId} · ${pinLabel(pins.from)} → ${pinLabel(pins.to)}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload: {
        repo: resolved.repo,
        changeId,
        from: pins.from,
        to: pins.to,
        /* The `to` side's pin: the revision it names, else the change's current commit with plue's current_seq. */
        pin: {
          changeId,
          seq: pins.toRevision?.seq ?? change.currentSeq,
          commitId: pins.toRevision?.commitId ?? change.commitId
        },
        files,
        ...(path === undefined || path === "" ? {} : { path })
      }
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
    return {
      value: `Diff of ${changeId} (${pinLabel(pins.from)} → ${pinLabel(pins.to)}) — ${files.length} file${files.length === 1 ? "" : "s"}.`
    }
  }

  /*
   * Walk run 3, C3-N8: the land door read the repository's landing requests,
   * sent no land, and left nothing on screen. Its refusal WAS written — to a
   * toast that leaves after four seconds — so a door that acted on nothing
   * looked like a door that did nothing, and the next session could not read
   * back what it had said. A land that lands or queues renders its own card;
   * a land that refuses states the reason where the person is still looking.
   */
  const landChange: ChangeSeam["landChange"] = async (changeId, repo) => {
    const current = captureCloudOwner(ctx, false)
    const answer = await land(changeId, repo)
    if (typeof answer === "string" && current()) ctx.dispatch({ type: "message.appended", actor: "system", text: answer })
    return answer
  }

  const land: ChangeSeam["landChange"] = async (changeId, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = captureCloudOwner(ctx)
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const repoId = resolved.repo
    /* A changeset lands atomically through its own route — never partially; an unread list can't clear the change of one. */
    const changesetRead = await loadChangeset(repoId, changeId)
    if (!current()) return SIGN_OUT_REFUSAL
    if ("unread" in changesetRead) {
      return `The changesets ${changeId} might belong to weren't read (${changesetRead.unread}) — nothing was landed.`
    }
    const changeset = changesetRead.value
    if (changeset !== null) {
      if (changeset.state === "landing") {
        return `Changeset ${changeset.id} is landing — the card tracks it.`
      }
      if (changeset.state === "landed") {
        return `Changeset ${changeset.id} already landed.`
      }
      const landed = await sendJson("POST", `/orgs/${encodeURIComponent(changeset.organization)}/changesets/${changeset.id}/land`)
      if (!current() && "error" in landed) return SIGN_OUT_REFUSAL
      if ("error" in landed) {
        /* A 409 restores every member bookmark; the row's failure_reason is the honest line. */
        await surfaceChange(repoId, changeId, {}, current)
        return landed.error
      }
      const refreshed = parseChangeset(landed.body)
      return mutationResult(
        repoId, changeId,
        `Changeset ${changeset.id} landed — every member bookmark moved together.`,
        refreshed === null ? {} : { overrides: { changeset: refreshed } }, null, current
      )
    }
    const landingRead = await loadLanding(repoId, changeId)
    if (!current()) return SIGN_OUT_REFUSAL
    if ("unread" in landingRead) {
      return `The landing requests of ${repoId} weren't read (${landingRead.unread}) — nothing was landed.`
    }
    if (landingRead.value === null) {
      return `No landing request carries ${changeId} on ${repoId}.`
    }
    const { landing, position } = landingRead.value
    const size = landing.changeIds.length
    const top = landing.changeIds[size - 1] ?? changeId
    /*
     * PUT /landings/{n}/land lands the request's WHOLE stack. A prefix land
     * from a mid-stack change ("lands 1 → 2") has no route even with
     * landable_prefix read (#452 states the count, not a partial land), so a
     * mid-stack change refuses and names the blast radius, and the top
     * change's land states the full scope in its own line — never a silent
     * over-land.
     */
    if (position < size) {
      return `Land all ${size} changes from ${top}.`
    }
    /* plue lands a request only while it is open or failed (landing.go LandLandingRequest). */
    if (landing.state !== "open" && landing.state !== "failed") {
      return `Landing request #${landing.number} is ${landing.state}. Only open or failed requests can land.`
    }
    /*
     * The land names the commit it lands (ADR 0003: the server refuses a land
     * whose commit no longer matches), so the change is re-read for its
     * current commit right before the PUT — never a commit from an older card.
     */
    const loaded = await loadChange(repoId, changeId, current)
    if ("error" in loaded) return `${changeId} couldn't be re-read before landing (${loaded.error}) — nothing was landed.`
    if (!current()) return SIGN_OUT_REFUSAL
    if (loaded.change.commitId === null) return `${changeId} carries no commit id to land at — nothing was landed.`
    const queued = await sendJson("PUT", repoPath(repoId, `/landings/${landing.number}/land`), { commit_id: loaded.change.commitId })
    if (!current() && "error" in queued) return SIGN_OUT_REFUSAL
    if ("error" in queued) return queued.error
    /*
     * 202/200: the land is QUEUED, never a terminal claim the platform hasn't
     * made. The re-read renders the state the platform answers; the line
     * names the scope the PUT covered.
     */
    const scope = size <= 1 ? `${changeId} alone` : `1 → ${size} together (${landing.changeIds.join(", ")})`
    return mutationResult(repoId, changeId, `Landing request #${landing.number} is queued — it lands ${scope}; the card tracks it.`, {}, null, current)
  }

  const splitReady: ChangeSeam["splitReady"] = async (changeId, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const changesetRead = await loadChangeset(resolved.repo, changeId)
    if ("unread" in changesetRead) {
      return `The changesets ${changeId} might belong to weren't read (${changesetRead.unread}).`
    }
    if (changesetRead.value === null) {
      return `Split ready members applies to a changeset — ${changeId} on ${resolved.repo} belongs to none.`
    }
    return NO_SPLIT_REFUSAL
  }

  /*
   * plue#489 `POST …/changes/{id}/split { paths }` (200): the listed paths'
   * diff moves into a NEW change and the original keeps every unselected
   * path. plue refuses an empty `paths` (400 "paths must not be empty"), so
   * the act names the paths it moves and never sends an empty list.
   *
   * The answer is `{ original, split }` — two `repohost.Change` rows. Both
   * are surfaced as change cards, because both are the returned changes and
   * the split one is the reviewable object the act produced.
   */
  const splitChange: ChangeSeam["splitChange"] = async (changeId, paths, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = captureCloudOwner(ctx)
    const wanted = paths.map((path) => path.trim()).filter((path) => path !== "")
    if (wanted.length === 0) {
      return "change.split needs at least one path to move: /change.split <changeId> <path> [path…]"
    }
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const split = await sendJson("POST", changePath(resolved.repo, changeId, "/split"), { paths: wanted })
    if (!current() && "error" in split) return SIGN_OUT_REFUSAL
    if ("error" in split) return split.error
    const body = isRecord(split.body) ? split.body : null
    const original = body !== null && isRecord(body.original) ? str(body.original.change_id) : null
    const created = body !== null && isRecord(body.split) ? str(body.split.change_id) : null
    if (original === null || created === null) {
      return `Smithers Cloud's answer for the split of ${changeId} named no changes.`
    }
    return mutationResult(
      resolved.repo, [original, created],
      `${wanted.join(", ")} moved out of ${original} into the new change ${created} — both cards track them.`,
      { facet: "diff" }, null, current
    )
  }

  const resolveConflict: ChangeSeam["resolveConflict"] = async (changeId, path, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = captureCloudOwner(ctx)
    if (degraded()) return refuseCloudSignIn(ctx, DEGRADED_CHANGE_REFUSAL)
    if (path.trim() === "") return "change.resolve needs the conflicted file's path: /change.resolve <changeId> <path>"
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const dispatched = await sendJson("POST", changePath(resolved.repo, changeId, "/conflicts/resolve"), { path })
    if (!current() && "error" in dispatched) return SIGN_OUT_REFUSAL
    if ("error" in dispatched) return dispatched.error
    const sessionId = isRecord(dispatched.body) ? str(dispatched.body.agent_session_id) : null
    return mutationResult(
      resolved.repo, changeId,
      `Dispatched an agent${sessionId === null ? "" : ` (session ${sessionId})`} to resolve ${path} in ${changeId} — the next revision carries the resolution.`,
      {}, null, current
    )
  }

  const revertChange: ChangeSeam["revertChange"] = async (changeId, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    /* Revert is offered only on a landed change: the carrying landing's terminal state, or the changeset's. */
    const changesetRead = await loadChangeset(resolved.repo, changeId)
    if ("unread" in changesetRead) {
      return `The changesets ${changeId} might belong to weren't read (${changesetRead.unread}).`
    }
    const changeset = changesetRead.value
    if (changeset !== null) {
      if (changeset.state !== "landed") {
        return `Revert is offered on a landed change — changeset ${changeset.id} is ${changeset.state}.`
      }
      return NO_REVERT_REFUSAL
    }
    const landingRead = await loadLanding(resolved.repo, changeId)
    if ("unread" in landingRead) {
      return `The landing requests of ${resolved.repo} weren't read (${landingRead.unread}).`
    }
    const landing = landingRead.value
    if (landing === null || landing.landing.state !== "merged") {
      return `Revert is offered on a landed change — ${changeId} has not landed${
        landing === null ? "" : ` (the landing request is ${landing.landing.state})`
      }.`
    }
    return NO_REVERT_REFUSAL
  }

  const setFacet: ChangeSeam["setFacet"] = async (changeId, facet, repo) => {
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const row = ctx.store.collections.changes.get(changeRowId(resolved.repo, changeId))
    if (row === undefined) return `Change ${changeId} is not loaded — /change.view ${changeId} reads it first`
    renderChange(row, undefined, { facet })
    return
  }

  /** One thread transition: POST, then the re-read renders the state the platform answers. */
  const transitionThread = (
    verb: "done" | "ack" | "reopen"
  ): ChangeSeam["threadDone"] =>
  async (changeId, threadId, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = captureCloudOwner(ctx)
    if (!Number.isInteger(threadId) || threadId <= 0) return `review.${verb} needs a comment id: /review.${verb} <changeId> <commentId>`
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const landing = await landingNumberOf(resolved.repo, changeId, current)
    if ("error" in landing) return landing.error
    const answer = await sendJson("POST", repoPath(resolved.repo, `/landings/${landing.number}/threads/${threadId}/${verb}`))
    if (!current() && "error" in answer) return SIGN_OUT_REFUSAL
    if ("error" in answer) return answer.error
    const thread = parseComment(answer.body)
    const state = thread?.state ?? null
    return mutationResult(
      resolved.repo, changeId,
      `Comment ${threadId} on ${changeId}${state === null ? "" : ` is ${state}`} — the card tracks it.`,
      { facet: "review" }, null, current
    )
  }

  /*
   * plue#487 `POST …/findings/{id}/dispatch` (202): plue creates the agent
   * session with the finding's text as its durable task and dispatches the
   * run in the background. The answer is the SESSION
   * (`services.AgentSessionResponse`), and — RFD-004 — it names the
   * `workspace_id` the run executes in when one exists, which is an existing
   * card kind in this app: the workspace card. When it names one the card is
   * rendered through the workspace seam the controller lends; when it does
   * not, the line names the session and nothing is invented for it.
   */
  const pleaseFix: ChangeSeam["pleaseFix"] = async (changeId, findingId, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = captureCloudOwner(ctx)
    if (degraded()) return refuseCloudSignIn(ctx, DEGRADED_CHANGE_REFUSAL)
    if (!Number.isInteger(findingId) || findingId <= 0) {
      return "findings.please-fix needs a finding id: /findings.please-fix <changeId> <findingId>"
    }
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const dispatched = await sendJson("POST", changePath(resolved.repo, changeId, `/findings/${findingId}/dispatch`))
    if (!current() && "error" in dispatched) return SIGN_OUT_REFUSAL
    if ("error" in dispatched) return dispatched.error
    const body = isRecord(dispatched.body) ? dispatched.body : null
    const sessionId = body === null ? null : str(body.id)
    const workspaceId = body === null ? null : str(body.workspace_id)
    return mutationResult(
      resolved.repo, changeId,
      `The agent is on finding ${findingId} of ${changeId}${sessionId === null ? "" : ` (session ${sessionId})`}${
        workspaceId === null ? "" : ` — the computer ${workspaceId} card tracks the run`
      }.`,
      { facet: "findings" }, workspaceId, current
    )
  }

  /*
   * plue#487 `POST …/findings/{id}/feedback { useful }` (200): the feedback
   * row, echoed. `Not useful` sends `useful: false` and nothing else — no
   * note is invented for the human — and the re-read dims the row and reads
   * plue's own recorded word.
   */
  const notUseful: ChangeSeam["notUseful"] = async (changeId, findingId, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = captureCloudOwner(ctx)
    if (!Number.isInteger(findingId) || findingId <= 0) {
      return "findings.not-useful needs a finding id: /findings.not-useful <changeId> <findingId>"
    }
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const recorded = await sendJson(
      "POST",
      changePath(resolved.repo, changeId, `/findings/${findingId}/feedback`),
      { useful: false }
    )
    if (!current() && "error" in recorded) return SIGN_OUT_REFUSAL
    if ("error" in recorded) return recorded.error
    return mutationResult(
      resolved.repo, changeId,
      `Finding ${findingId} of ${changeId} is recorded not useful — the card dims it.`,
      { facet: "findings" }, null, current
    )
  }

  /*
   * plue#488 `POST …/landings/{n}/review-requests` (201). The body names
   * EITHER a human `reviewer` or an `agent` — plue refuses a body that names
   * both or neither — so `agent:<name>` is the one spelling that asks a named
   * agent, and every other value is a login.
   */
  const requestReview: ChangeSeam["requestReview"] = async (changeId, reviewer, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = captureCloudOwner(ctx)
    const who = reviewer.trim()
    if (who === "") return "review.request needs a reviewer: /review.request <changeId> <login|agent:name>"
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const landing = await landingNumberOf(resolved.repo, changeId, current)
    if ("error" in landing) return landing.error
    const agent = who.startsWith("agent:") ? who.slice("agent:".length).trim() : null
    if (agent === "") return "review.request's agent needs a name: /review.request <changeId> agent:<name>"
    const asked = await sendJson(
      "POST",
      repoPath(resolved.repo, `/landings/${landing.number}/review-requests`),
      agent === null ? { reviewer: who } : { agent }
    )
    if (!current() && "error" in asked) return SIGN_OUT_REFUSAL
    if ("error" in asked) return asked.error
    return mutationResult(
      resolved.repo, changeId,
      `Review of ${changeId} requested from ${agent === null ? who : `agent ${agent}`} on landing request #${landing.number}.`,
      { facet: "review" }, null, current
    )
  }

  /* plue#488 `DELETE …/landings/{n}/review-requests/{id}` (204): the request is dismissed, never the review. */
  const unrequestReview: ChangeSeam["unrequestReview"] = async (changeId, requestId, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = captureCloudOwner(ctx)
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return "review.unrequest needs a review-request id: /review.unrequest <changeId> <requestId>"
    }
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const landing = await landingNumberOf(resolved.repo, changeId, current)
    if ("error" in landing) return landing.error
    const dismissed = await sendJson(
      "DELETE",
      repoPath(resolved.repo, `/landings/${landing.number}/review-requests/${requestId}`)
    )
    if (!current() && "error" in dismissed) return SIGN_OUT_REFUSAL
    if ("error" in dismissed) return dismissed.error
    return mutationResult(
      resolved.repo, changeId,
      `Review request ${requestId} on landing request #${landing.number} is dismissed.`,
      { facet: "review" }, null, current
    )
  }

  return {
    viewChange,
    diffChange,
    setPins,
    sinceMyReview,
    checksAt,
    landChange,
    splitReady,
    splitChange,
    resolveConflict,
    revertChange,
    setFacet,
    threadDone: transitionThread("done"),
    threadAck: transitionThread("ack"),
    threadReopen: transitionThread("reopen"),
    pleaseFix,
    notUseful,
    requestReview,
    unrequestReview,
  }
}
