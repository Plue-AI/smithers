/**
 * The mythical stack of one repository, as the monitoring UI reads it.
 *
 * A repository's `mythical` bookmark is one linear stack of logical changes.
 * Every open GitHub issue becomes an item: the stack service admits it (or
 * skips it with a reason), a lane (one Plue workspace) plans it against the
 * stack tip and implements it, the service integrates the result onto the
 * current tip, verifies rebased candidates, and proposes it to GitHub as a
 * pull request whose content is exactly a verified stack state. `main` is
 * append-only; merged pull requests are folded back into the stack.
 *
 * `GET /api/repos/{owner}/{repo}/mythical` answers {@link MythicalStackSchema}.
 * `GET …/mythical/events` is a server-sent event stream whose `mythical`
 * events ({@link MythicalEventSchema}) are hints: a client re-reads the
 * snapshot on every event, and the snapshot is authoritative. The write
 * routes acknowledge immediately; the stack worker does the work, so a
 * `202` is "requested", never "done".
 *
 * Wire fields are camelCase and match these schemas exactly. The design is
 * the mythical workstream's design document (epic smithersai/smithers#1745).
 *
 * @since 1.0.0
 */

import { z } from "zod"
import { HttpUrlSchema } from "./WebUrl.ts"

/**
 * The route family this module owns. `{owner}` and `{repo}` are the
 * repository's Smithers owner and name.
 *
 * @since 1.0.0
 * @category constants
 */
export const MYTHICAL_PATH = "/api/repos/{owner}/{repo}/mythical"

/**
 * Every route of the family: the snapshot, its event hints, and the write
 * requests (each acknowledged before the work happens).
 *
 * @since 1.0.0
 * @category constants
 */
export const MYTHICAL_ROUTES = {
  /** `GET`: the {@link MythicalStackSchema} snapshot. */
  stack: "/api/repos/{owner}/{repo}/mythical",
  /** `GET`: `text/event-stream` of `mythical` events. */
  events: "/api/repos/{owner}/{repo}/mythical/events",
  /** `POST`: create the stack from main's history. */
  bootstrap: "/api/repos/{owner}/{repo}/mythical/bootstrap",
  /** `POST`: admit every open GitHub issue now instead of waiting for the sweep. */
  backfill: "/api/repos/{owner}/{repo}/mythical/backfill",
  /** `PUT`: {@link MythicalConfigSchema}. */
  config: "/api/repos/{owner}/{repo}/mythical/config",
  /** `POST`: retry one blocked or rejected item. */
  retry: "/api/repos/{owner}/{repo}/mythical/items/{id}/retry",
  /** `PUT`: a coding host submits a lane result ({@link MythicalLaneSubmissionSchema}). */
  lanes: "/api/repos/{owner}/{repo}/mythical/lanes",
  /** `POST`: refresh the repository wiki now, or retry a failed refresh. */
  wiki: "/api/repos/{owner}/{repo}/mythical/wiki"
} as const

/**
 * One route of the family for a concrete repository (and item, for `retry`).
 *
 * @since 1.0.0
 * @category accessors
 */
export const mythicalRoute = (
  route: keyof typeof MYTHICAL_ROUTES,
  owner: string,
  repo: string,
  id?: string
): string =>
  MYTHICAL_ROUTES[route]
    .replace("{owner}", encodeURIComponent(owner))
    .replace("{repo}", encodeURIComponent(repo))
    .replace("{id}", encodeURIComponent(id ?? ""))

/**
 * The stack as a whole. `absent`: no stack yet (bootstrap creates one).
 * `bootstrapping`: creation requested or running. `active`: items flow.
 * `frozen`: a fold, revert or outside ref move needs a person; `reason` says
 * which, and integration waits.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalStackStateSchema = z.enum(["absent", "bootstrapping", "active", "frozen"])

/**
 * The decoded value accepted by {@link MythicalStackStateSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalStackState = z.infer<typeof MythicalStackStateSchema>

/**
 * Where a stack change came from. `bootstrap`: one of main's commits when the
 * stack was created. `fold`: main moved outside the stack (another merge or a
 * direct push) and the difference was folded in. `item`: an item's work.
 * `revert`: an item whose pull request was closed unmerged, taken back out.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalChangeKindSchema = z.enum(["bootstrap", "fold", "item", "revert"])

/**
 * The decoded value accepted by {@link MythicalChangeKindSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalChangeKind = z.infer<typeof MythicalChangeKindSchema>

/**
 * A GitHub issue an item works on.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: HttpUrlSchema
})

/**
 * The decoded value accepted by {@link MythicalIssueSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalIssue = z.infer<typeof MythicalIssueSchema>

/**
 * One change of the stack. `changeId` is the jj change id; a change the
 * service rewrote carries the id it replaced as `predecessor`. `state` is
 * `landed` when main contains it and `pending` while its pull request is
 * open. `itemId` and `issue` name the item that owns an `item` change.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalChangeSchema = z.object({
  changeId: z.string(),
  commitId: z.string(),
  title: z.string(),
  kind: MythicalChangeKindSchema,
  state: z.enum(["landed", "pending"]),
  itemId: z.string().optional(),
  issue: z.number().int().positive().optional(),
  predecessor: z.string().optional()
})

/**
 * The decoded value accepted by {@link MythicalChangeSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalChange = z.infer<typeof MythicalChangeSchema>

/**
 * Where an item is.
 *
 * - `queued`: admitted, waiting for a free lane.
 * - `skipped`: admission holds it; `reason` says why (a label, the author).
 * - `declined`: the planner declined it; `reason` says why. It stays until
 *   the issue's title or body changes or a person retries it.
 * - `cancelled`: the issue closed before work started.
 * - `running`: its lane is planning and implementing (`coding/request`).
 * - `delivering`: its lane is cleaning and rechecking the result (`coding/vibe`).
 * - `integrating`: the service is putting the result onto the current tip.
 * - `verifying`: a rebased candidate is running the required checks.
 * - `proposing`: the pull request is being opened or updated.
 * - `waiting`: proposal waits for the stack to catch up with main.
 * - `proposed`: its pull request is open. `landed`: main contains it.
 * - `rejected`: its pull request closed unmerged and it was reverted.
 * - `retrying`: a conflict or failed check sent it back to a lane.
 * - `blocked`: out of attempts; a person decides (`retry` route).
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalItemStateSchema = z.enum([
  "queued",
  "skipped",
  "declined",
  "cancelled",
  "running",
  "delivering",
  "integrating",
  "verifying",
  "proposing",
  "waiting",
  "proposed",
  "landed",
  "rejected",
  "retrying",
  "blocked"
])

/**
 * The decoded value accepted by {@link MythicalItemStateSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalItemState = z.infer<typeof MythicalItemStateSchema>

/**
 * What the item's plan does to the stack: the existing changes it amends,
 * the new changes it inserts after an existing one, and how many new changes
 * it appends at the tip.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalPlanSchema = z.object({
  title: z.string(),
  amends: z.array(z.string()),
  inserts: z.array(z.object({ after: z.string(), title: z.string() })),
  appends: z.number().int().nonnegative()
})

/**
 * The decoded value accepted by {@link MythicalPlanSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalPlan = z.infer<typeof MythicalPlanSchema>

/**
 * How the item's result reached the stack. `fast-forward`: the tip had not
 * moved, so the lane's own history became the stack. `rebased`: its new
 * changes were rebased onto a newer tip. `conflict` names what refused.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalIntegrationSchema = z.object({
  kind: z.enum(["fast-forward", "rebased"]).optional(),
  conflict: z.object({ changeId: z.string().optional(), paths: z.array(z.string()) }).optional()
})

/**
 * The decoded value accepted by {@link MythicalIntegrationSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalIntegration = z.infer<typeof MythicalIntegrationSchema>

/**
 * The required checks on the item's rebased candidate. `failed` lists check ids.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalChecksSchema = z.object({
  state: z.enum(["pending", "passed", "failed"]),
  failed: z.array(z.string())
})

/**
 * The decoded value accepted by {@link MythicalChecksSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalChecks = z.infer<typeof MythicalChecksSchema>

/**
 * The GitHub pull request that carries an item.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalPullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: HttpUrlSchema,
  state: z.enum(["open", "closed", "merged"])
})

/**
 * The decoded value accepted by {@link MythicalPullRequestSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalPullRequest = z.infer<typeof MythicalPullRequestSchema>

/**
 * One item: an issue (or a chat request, which has no `issue`) on its way
 * through the stack. `runs` are the flow run ids of its current attempt;
 * `lane` is the lane index it holds. `dependsOn` lists the item ids whose
 * unmerged work its pull request also carries.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalItemSchema = z.object({
  id: z.string(),
  issue: MythicalIssueSchema.optional(),
  state: MythicalItemStateSchema,
  reason: z.string().optional(),
  attempt: z.number().int().nonnegative(),
  lane: z.number().int().nonnegative().optional(),
  runs: z.object({
    request: z.string().optional(),
    vibe: z.string().optional(),
    verify: z.string().optional()
  }),
  plan: MythicalPlanSchema.optional(),
  integration: MythicalIntegrationSchema.optional(),
  checks: MythicalChecksSchema.optional(),
  pullRequest: MythicalPullRequestSchema.optional(),
  dependsOn: z.array(z.string()),
  updatedAt: z.string()
})

/**
 * The decoded value accepted by {@link MythicalItemSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalItem = z.infer<typeof MythicalItemSchema>

/**
 * The pooled provider account that took a lane's latest model call. The
 * pool rotates accounts per call, so `count` is how many accounts served the
 * lane's current attempt. `label` (the account's email, else its name) is
 * present only for the account's owner (for an organization's account, a
 * repository admin). No credential is ever part of it.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalAccountSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  label: z.string().optional(),
  count: z.number().int().positive()
})

/**
 * The decoded value accepted by {@link MythicalAccountSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalAccount = z.infer<typeof MythicalAccountSchema>

/**
 * One lane: a workspace that works one item at a time. A busy lane carries
 * `startedAt`, when it launched its item's current attempt. Once the
 * attempt's model calls went through the account pool, `account` is the
 * account of the latest one and `seat` the seat most of them ran on (its
 * alias, such as `luna`, else the model id). A retrying lane carries none of
 * these until its next attempt starts. A lane that holds an item above
 * `maxParallel` is still listed.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalLaneSchema = z.object({
  index: z.number().int().nonnegative(),
  workspaceId: z.string().optional(),
  itemId: z.string().optional(),
  state: z.enum(["provisioning", "idle", "busy"]),
  startedAt: z.string().datetime({ offset: true }).optional(),
  account: MythicalAccountSchema.optional(),
  seat: z.string().optional()
})

/**
 * The decoded value accepted by {@link MythicalLaneSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalLane = z.infer<typeof MythicalLaneSchema>

/**
 * The repository wiki the stack keeps current. After every fold the stack
 * refreshes the pages its `.smithers/coding-project.json` declares
 * (`coding/wiki` on a wiki workspace), reviews them against the folded
 * source, and publishes the verified pages as `generated-<id>`.
 *
 * - `refreshing`: a refresh of `commit` is running.
 * - `current`: the published pages were reviewed at `landedMain`.
 * - `stale`: main moved past `publishedCommit`; a refresh is due.
 * - `failed`: the refresh of `commit` failed (`error`); it is retried with
 *   backoff, and the `wiki` route retries now.
 *
 * `pages` counts the published pages; `edited` those a person changed since,
 * which a refresh keeps instead of overwriting.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalWikiSchema = z.object({
  state: z.enum(["refreshing", "current", "stale", "failed"]),
  commit: z.string().optional(),
  publishedCommit: z.string().optional(),
  publishedAt: z.string().optional(),
  pages: z.number().int().nonnegative(),
  edited: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  runId: z.string().optional(),
  error: z.string().optional()
})

/**
 * The decoded value accepted by {@link MythicalWikiSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalWiki = z.infer<typeof MythicalWikiSchema>

/**
 * The snapshot `GET …/mythical` answers. `tip` is the bookmark's commit;
 * `landedMain` the last main commit folded into the stack; `mainBehind` is
 * true while main has moved past `landedMain`. `changes` are tip first,
 * bounded to the newest 200. `generation` increases with every change to
 * the stack or an item, so a client can drop an older snapshot.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalStackSchema = z.object({
  repository: z.string(),
  state: MythicalStackStateSchema,
  reason: z.string().optional(),
  generation: z.number().int().nonnegative(),
  tip: z.object({ changeId: z.string(), commitId: z.string() }).optional(),
  landedMain: z.string().optional(),
  mainBehind: z.boolean(),
  changes: z.array(MythicalChangeSchema),
  items: z.array(MythicalItemSchema),
  lanes: z.array(MythicalLaneSchema),
  limits: z.object({ maxParallel: z.number().int().positive() }),
  lastError: z.string().optional(),
  updatedAt: z.string().optional(),
  /** Absent while the repository declares no wiki. */
  wiki: MythicalWikiSchema.optional()
})

/**
 * The decoded value accepted by {@link MythicalStackSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalStack = z.infer<typeof MythicalStackSchema>

/**
 * The data of one `mythical` server-sent event: which generation changed and
 * whether the stack or one item moved. A hint only; re-read the snapshot.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalEventSchema = z.object({
  generation: z.number().int().nonnegative(),
  kind: z.enum(["stack", "item"]),
  itemId: z.string().optional()
})

/**
 * The decoded value accepted by {@link MythicalEventSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalEvent = z.infer<typeof MythicalEventSchema>

/**
 * `PUT …/mythical/config`: how many lanes work at once (1–8).
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalConfigSchema = z.object({
  maxParallel: z.number().int().min(1).max(8)
})

/**
 * The decoded value accepted by {@link MythicalConfigSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalConfig = z.infer<typeof MythicalConfigSchema>

/**
 * `PUT …/mythical/lanes`: a coding host's validated, cleaned result. `base`
 * is the stack tip the request started from; `source` the retained cleaned
 * tip (`refs/smithers/workspaces/<workspaceId>/sources/<source>`);
 * `requestRunId` the completed request it came from. Replaying the same body
 * is idempotent.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MythicalLaneSubmissionSchema = z.object({
  workspaceId: z.string(),
  base: z.string().regex(/^[0-9a-f]{40}$/),
  source: z.string().regex(/^[0-9a-f]{40}$/),
  requestRunId: z.string().min(1),
  summary: z.string().min(1).max(16_384)
})

/**
 * The decoded value accepted by {@link MythicalLaneSubmissionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MythicalLaneSubmission = z.infer<typeof MythicalLaneSubmissionSchema>

/**
 * Whether an item has finished moving: nothing more happens without a person
 * or a new issue event.
 *
 * @since 1.0.0
 * @category accessors
 */
export const isSettledItemState = (state: MythicalItemState): boolean =>
  state === "skipped" || state === "declined" || state === "cancelled" || state === "landed" || state === "rejected" ||
  state === "blocked"
