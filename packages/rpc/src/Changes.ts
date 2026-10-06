/**
 * Change-list and diff cards shared by native and browser clients.
 *
 * @since 1.0.0
 */

import { z } from "zod"

/*
 * Lane change (ADR 0003 — the change is the unit): the change-domain schemas
 * the card payloads in Cards.ts build from.
 *
 * A change is a document with revisions. The change id is the document; each
 * revision is a commit; everything else (checks, findings, comments,
 * verdicts) is pinned to a revision and goes stale by revision, never by
 * time. plue's change GET carries `revisions[]`, `reviews[]`, `conflicts[]`,
 * `stack`, `turn`, `owners` and `landed` (plue #450, #459, #460, #464, #467);
 * every field below is what the route states, in the route's own words —
 * nothing is inferred from timestamps, and a field the route omits stays
 * absent.
 */

/**
 * One revision of a change (plue#450: `revisions[]` on the change GET).
 * `source` is plue's word verbatim (`push`, `agent`, `revert`, …);
 * `parentCommitId` is the parent the revision itself recorded, which is what
 * `from=parent` diffs against — never the parent change's current commit.
 * Lane L1 note: the brief named a `provenance` field; plue carries the
 * provenance as `source` + `agent_session_id` + `workspace_snapshot_id`.
 * @since 1.0.0
 * @category schemas
 */
export const ChangeRevisionSchema = z.object({
  seq: z.number().int().positive(),
  commitId: z.string(),
  parentCommitId: z.string().nullable().optional(),
  /** What produced the revision: plue's `source` verbatim. */
  source: z.string().optional(),
  agentSessionId: z.string().optional(),
  workspaceSnapshotId: z.string().optional(),
  operationIds: z.array(z.string()).optional(),
  createdAt: z.string().optional()
})
/**
 * The decoded value accepted by {@link ChangeRevisionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeRevision = z.infer<typeof ChangeRevisionSchema>

/**
 * The one pin everywhere (ADR 0003 §3): `changeId#seq (commitId)`. `seq` is
 * null when the server recorded no revision for the pinned commit — a card
 * read from a local working copy pins by commit id, never by a server seq.
 * @since 1.0.0
 * @category schemas
 */
export const RevisionPinSchema = z.object({
  changeId: z.string(),
  seq: z.number().int().positive().nullable(),
  commitId: z.string().nullable()
})
/**
 * The decoded value accepted by {@link RevisionPinSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RevisionPin = z.infer<typeof RevisionPinSchema>

/**
 * The change card's body tabs (ADR 0003 §1, ADR 0004). `walkthrough` renders
 * only when a walkthrough artifact exists for the current revision (#465);
 * `owners` only when the change GET carries `owners` (#467).
 * @since 1.0.0
 * @category constants
 */
export const CHANGE_FACETS = ["walkthrough", "diff", "findings", "checks", "review", "history", "owners"] as const
/**
 * Validates change facet values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ChangeFacetSchema = z.enum(CHANGE_FACETS)
/**
 * The decoded value accepted by {@link ChangeFacetSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeFacet = z.infer<typeof ChangeFacetSchema>

/** A per-file conflict (the change GET's `conflicts[]`, or the conflicts route).
 * @since 1.0.0
 * @category schemas
 */
export const ChangeConflictSchema = z.object({
  path: z.string(),
  /** plue's resolution_status; "unresolved" while it stands. */
  state: z.string()
})
/**
 * The decoded value accepted by {@link ChangeConflictSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeConflict = z.infer<typeof ChangeConflictSchema>

/**
 * One check row at a revision's commit (the commit-statuses route, #452):
 * `targets_affected · targets_ran · targets_cached · duration_ms` state the
 * work, so a fast green is legible as cache; `workspaceId` names where it
 * ran. The work fields are optional so rows persisted before #452 parse.
 * @since 1.0.0
 * @category schemas
 */
export const ChangeCheckSchema = z.object({
  context: z.string(),
  state: z.string(),
  targetsAffected: z.number().int().nonnegative().optional(),
  targetsRan: z.number().int().nonnegative().optional(),
  targetsCached: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  workspaceId: z.string().nullable().optional()
})
/**
 * The decoded value accepted by {@link ChangeCheckSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeCheck = z.infer<typeof ChangeCheckSchema>

/**
 * A review verdict pinned to a revision (plue#459: `reviews[]` on the change
 * GET). `verdict` is plue's word (`approve`, `request_changes`, `comment`,
 * or an agent's `lgtm` / `concerns`); `confidence` is the agent's bucket
 * WORD (`low` / `medium` / `high`) and null for a human — never a number
 * (DESIGN.md forbids user-facing scores). `lastReviewedSeq` is the server's
 * per-reviewer field the "since my review" diff pins to.
 * @since 1.0.0
 * @category schemas
 */
export const ChangeVerdictSchema = z.object({
  reviewer: z.string().nullable(),
  /**
   * plue#500 `reviewer_login`: the human's login, or the agent session's
   * display title. `reviewer` keeps plue's stable value — an agent session's
   * id — so the row renders this and never the id. plue writes the field
   * without omitempty and leaves it EMPTY when the lookup misses, which the
   * seam reads as absent; the row then falls back to `reviewer`.
   */
  reviewerLogin: z.string().nullable().optional(),
  reviewerKind: z.string().nullable(),
  verdict: z.string(),
  /**
   * plue#484: the review's own `type` (`approve`, `request_changes`,
   * `comment`) beside the agent's `verdict` (`lgtm` / `concerns`). Absent on
   * a row a server answered before #484; the card reads the agent's verdict
   * for an agent row and the type for a human one, never a renamed word.
   */
  type: z.string().nullable().optional(),
  confidence: z.string().nullable(),
  summary: z.string(),
  commitId: z.string().nullable(),
  seq: z.number().int().positive().nullable(),
  lastReviewedSeq: z.number().int().positive().nullable()
})
/**
 * The decoded value accepted by {@link ChangeVerdictSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeVerdict = z.infer<typeof ChangeVerdictSchema>

/**
 * A comment thread on the change's landing request (plue#461). `state` is
 * the lifecycle (`open` → `done` by the author → `resolved` by the reviewer's
 * Ack; Reopen returns to `open`); `anchor` is the server-computed position of
 * the thread at the current revision (`current`, `stale`, `moved` — plue
 * serialises it under the JSON key `state`, see the L1 REPORT). Either is
 * null when the row did not state it. The author is null: plue's comment row
 * carries `user_id`, never a login.
 * @since 1.0.0
 * @category schemas
 */
export const ChangeThreadSchema = z.object({
  id: z.number().int().nullable().optional(),
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  /** Where a `moved` thread's hunk now sits. */
  currentLine: z.number().int().nullable().optional(),
  body: z.string(),
  author: z.string().nullable(),
  createdAt: z.string().nullable(),
  state: z.enum(["open", "done", "resolved"]).nullable().optional(),
  anchor: z.enum(["current", "stale", "moved"]).nullable().optional(),
  commitId: z.string().nullable().optional(),
  /** Recorded by Done: the revision the author addressed the thread in. */
  resolvedInRevision: z.object({ commitId: z.string().nullable(), seq: z.number().int().nullable() }).nullable()
    .optional()
})
/**
 * The decoded value accepted by {@link ChangeThreadSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeThread = z.infer<typeof ChangeThreadSchema>

/**
 * A finding raised by an analyzer at a revision (plue#454: the findings route).
 * `state` is the server's `current` / `stale` against the live head; a stale
 * finding stays visible. `feedback` is the recorded feedback word when any.
 * @since 1.0.0
 * @category schemas
 */
export const ChangeFindingSchema = z.object({
  id: z.number().int().nullable().optional(),
  analyzer: z.string(),
  source: z.string().optional(),
  severity: z.string(),
  path: z.string(),
  line: z.number().int().nullable(),
  summary: z.string(),
  suggestion: z.string().nullable().optional(),
  /** The revision the finding was raised at; older than current reads `rev N · stale`. */
  raisedAtSeq: z.number().int().positive().nullable(),
  commitId: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  feedback: z.string().nullable().optional()
})
/**
 * The decoded value accepted by {@link ChangeFindingSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeFinding = z.infer<typeof ChangeFindingSchema>

/** One analyzer run at a revision (plue#454 `analyzers[]`): paused and failed runs carry their reason.
 * @since 1.0.0
 * @category schemas
 */
export const ChangeAnalyzerRunSchema = z.object({
  name: z.string(),
  state: z.string(),
  seq: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  pausedBy: z.string().nullable(),
  pausedReason: z.string().nullable(),
  failureReason: z.string().nullable()
})
/**
 * The decoded value accepted by {@link ChangeAnalyzerRunSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeAnalyzerRun = z.infer<typeof ChangeAnalyzerRunSchema>

/** One file in a diff. Past 400 patch lines the hunk rides by reference, never inline.
 * @since 1.0.0
 * @category schemas
 */
export const DiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  /** plue's change_type (added, modified, deleted, renamed, copied). */
  changeType: z.string(),
  isBinary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** The unified patch, present only at or under the inline cap. */
  patch: z.string().optional(),
  /** Over the cap: the hunk count, and the card re-reads this one file explicitly. */
  patchLines: z.number().int().nonnegative().optional(),
  /** A conflicted file leads the list with an ember marker (the change's conflicts[]). */
  conflicted: z.boolean().optional()
})
/**
 * The decoded value accepted by {@link DiffFileSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type DiffFile = z.infer<typeof DiffFileSchema>

/**
 * The diff the change card's Diff facet and the `diff` card both render
 * (ADR 0003 §1): `from → to` in the picker's own tokens (`parent`, `current`,
 * or a revision seq as a string) and the files. `from=N → to=M` is a jj
 * INTERDIFF (plue#451). `sinceReview` is set when the pins came from
 * `review.since-mine`: the facet's first line names it.
 * @since 1.0.0
 * @category schemas
 */
export const ChangeDiffSchema = z.object({
  from: z.string(),
  to: z.string(),
  files: z.array(DiffFileSchema),
  sinceReview: z.object({ reviewer: z.string(), seq: z.number().int().positive() }).nullable().optional()
})
/**
 * The decoded value accepted by {@link ChangeDiffSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeDiff = z.infer<typeof ChangeDiffSchema>

/**
 * Path ownership on the change GET (plue#467 `owners`). Owners are names only
 * — a login or a team name, never expanded. `agentPolicy` is plue's word
 * (`auto-land`, `human-approve`, `deny`).
 * @since 1.0.0
 * @category schemas
 */
export const ChangeOwnersSchema = z.object({
  touchedPaths: z.array(
    z.object({
      path: z.string(),
      owners: z.array(z.string()),
      agentPolicy: z.string(),
      satisfiedBy: z.object({ login: z.string(), seq: z.number().int().nullable() }).nullable()
    })
  ),
  requiredApprovers: z.array(z.string()),
  suggestedReviewers: z.array(z.string()),
  missingApprovals: z.array(z.object({ path: z.string(), candidates: z.array(z.string()) }))
})
/**
 * The decoded value accepted by {@link ChangeOwnersSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeOwners = z.infer<typeof ChangeOwnersSchema>

/** Whose turn it is on the landing request (plue#460 `turn`): the party and the event that handed it over.
 * @since 1.0.0
 * @category schemas
 */
export const ChangeTurnSchema = z.object({
  party: z.string(),
  actorId: z.string().nullable(),
  /**
   * plue#484 `actor_login`: the user's login, or the agent session's display
   * title. The header reads it in place of the id; null when the wire named
   * none and the line falls back to the party alone.
   */
  actorLogin: z.string().nullable().optional(),
  since: z.string().nullable(),
  reason: z.string().nullable()
})
/**
 * The decoded value accepted by {@link ChangeTurnSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeTurn = z.infer<typeof ChangeTurnSchema>

/**
 * One review request on the change's landing request (plue#488
 * `review_requests[]` on the landing DTO). A request names EITHER a human
 * reviewer or an agent by name, never both, and its `state` is plue's own
 * word (`requested`, `fulfilled`, `dismissed`). `id` is what
 * `DELETE …/landings/{n}/review-requests/{id}` addresses.
 * @since 1.0.0
 * @category schemas
 */
export const ChangeReviewRequestSchema = z.object({
  id: z.number().int(),
  /** The human reviewer's login; null when the request names an agent. */
  reviewer: z.string().nullable(),
  /** The named agent; null when the request names a human. */
  agent: z.string().nullable(),
  requestedBy: z.string().nullable(),
  state: z.string(),
  createdAt: z.string().nullable()
})
/**
 * The decoded value accepted by {@link ChangeReviewRequestSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeReviewRequest = z.infer<typeof ChangeReviewRequestSchema>

/** A landed change's provenance (plue#464 `landed`): the History facet's last row.
 * @since 1.0.0
 * @category schemas
 */
export const ChangeLandedSchema = z.object({
  at: z.string().nullable(),
  by: z.string().nullable(),
  /** plue#485 `landing_request_number`: the number that addresses the request in routes. */
  landingRequestNumber: z.number().int().positive().nullable().optional(),
  approvedBy: z.array(z.object({ login: z.string(), seq: z.number().int().nullable() }))
})
/**
 * The decoded value accepted by {@link ChangeLandedSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeLanded = z.infer<typeof ChangeLandedSchema>

/** The walkthrough artifact for one revision (plue#465): sections with optional Mermaid.
 * @since 1.0.0
 * @category schemas
 */
export const ChangeWalkthroughSchema = z.object({
  seq: z.number().int().positive().nullable(),
  sections: z.array(z.object({ title: z.string(), markdown: z.string(), diagram: z.string().nullable() }))
})
/**
 * The decoded value accepted by {@link ChangeWalkthroughSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeWalkthrough = z.infer<typeof ChangeWalkthroughSchema>

/** One unsatisfied requirement the landing gate states (plue#452 `blocked_by`), in its own fields.
 * @since 1.0.0
 * @category schemas
 */
export const LandingBlockSchema = z.object({
  kind: z.string(),
  name: z.string().nullable(),
  repo: z.string().nullable(),
  missing: z.string().nullable(),
  count: z.number().int().nullable(),
  path: z.string().nullable(),
  candidates: z.array(z.string())
})
/**
 * The decoded value accepted by {@link LandingBlockSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LandingBlock = z.infer<typeof LandingBlockSchema>

/** A changeset member (ADR 0003's live DTO): `repository · path`, the mount under /workspace/<org>/<repo>.
 * @since 1.0.0
 * @category schemas
 */
export const ChangesetMemberSchema = z.object({
  repository: z.string(),
  path: z.string(),
  changeId: z.string(),
  commitId: z.string(),
  targetBookmark: z.string(),
  previousCommitId: z.string().nullable(),
  landedCommitId: z.string().nullable()
})
/**
 * The decoded value accepted by {@link ChangesetMemberSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangesetMember = z.infer<typeof ChangesetMemberSchema>

/** The changeset a change renders from its own state (ADR 0003's live DTO).
 * @since 1.0.0
 * @category schemas
 */
export const ChangesetStateSchema = z.object({
  id: z.number().int(),
  organization: z.string(),
  /** The superproject repository, `org/name` like a repo id; a change matches the changeset's own `changeId` only there. */
  superproject: z.string(),
  /** The superproject change the changeset itself is. */
  changeId: z.string(),
  state: z.enum(["pending", "landing", "landed", "failed"]),
  /** Rendered verbatim under the header on `failed`, with a Retry land (confirm). */
  failureReason: z.string().nullable(),
  targetBookmark: z.string(),
  members: z.array(ChangesetMemberSchema)
})
/**
 * The decoded value accepted by {@link ChangesetStateSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangesetState = z.infer<typeof ChangesetStateSchema>
