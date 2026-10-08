import { ProposalCardSchema } from "./ProposalCard.ts"
import {
  GraphDrawerSchema,
  LegacyRunTracePayloadSchema,
  PlanCardGraphSchema,
  PlanCardNodeSchema,
  RunViewStateSchema
} from "./RunCard.ts"
import { LegacySecretMetadataSchema, SecretsCardSchema } from "./SecretsCard.ts"
/**
 * Cards rendered from agent, code-intelligence, and repository events.
 *
 * @since 1.0.0
 */

import { z } from "zod"
import { ConfiguredModelSchema } from "./ConfiguredModel.ts"
import { AGENT_ROLES, AgentRoleModelSchema } from "./AgentRoles.ts"
import { BillingPlanSchema, SandboxEntitlementSchema } from "./BillingPlans.ts"
import {
  ChangeAnalyzerRunSchema,
  ChangeCheckSchema,
  ChangeDiffSchema,
  ChangeFacetSchema,
  ChangeFindingSchema,
  ChangeLandedSchema,
  ChangeOwnersSchema,
  ChangeReviewRequestSchema,
  ChangeRevisionSchema,
  ChangesetStateSchema,
  ChangeThreadSchema,
  ChangeTurnSchema,
  ChangeVerdictSchema,
  ChangeWalkthroughSchema,
  LandingBlockSchema,
  RevisionPinSchema
} from "./Changes.ts"
import { DiffCardSchema } from "./DiffCard.ts"
import { type DraftCard, DraftCardSchema } from "./DraftCard.ts"
import { FactoryRuleSchema } from "./FactoryProjection.ts"
import { FileCardSchema } from "./FileCard.ts"
import { GatewayWorkspaceIdSchema } from "./GatewayWorkspace.ts"
import { StatusRollupSchema } from "./Health.ts"
import { HARNESS_IDS } from "./LocalApp.ts"
import { LSP_DIAGNOSTICS_CAP, LspDiagnosticSchema, LspHoverSchema } from "./LocalLsp.ts"
import { PLUE_FAULTS } from "./PlueFailureCodes.ts"
import { REFUSAL_ORIGINS } from "./Refusal.ts"
import { RepositoryHomeSchema } from "./RepositoryHome.ts"
import { GraphNodeSchema } from "./TargetGraph.ts"
import { TaskMetaSchema } from "./Threads.ts"
import { type TodoCard, TodoCardSchema } from "./TodoCard.ts"
import { HttpUrlSchema, RelativeUrlPathSchema } from "./WebUrl.ts"

/*
 * The targets card's table state (apps/app cards/TargetsTable.ts): the filter
 * the user set, the row they selected, and what the card has read about
 * individual targets. All optional: cards persisted before the table parse.
 */
/**
 * Shared target run states used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const TARGET_RUN_STATES = ["never", "passed", "failed", "running"] as const
/**
 * Validates target run state values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TargetRunStateSchema = z.enum(TARGET_RUN_STATES)
/**
 * The decoded value accepted by {@link TargetRunStateSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type TargetRunState = z.infer<typeof TargetRunStateSchema>

/** The table's views: the repository's essentials, everything, or what ran most recently.
 * @since 1.0.0
 * @category constants
 */
export const TARGETS_VIEW_MODES = ["featured", "all", "recent"] as const
/**
 * Validates targets view mode values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TargetsViewModeSchema = z.enum(TARGETS_VIEW_MODES)
/**
 * The decoded value accepted by {@link TargetsViewModeSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type TargetsViewMode = z.infer<typeof TargetsViewModeSchema>

/**
 * Validates targets view values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TargetsViewSchema = z.object({
  /** Featured / All / Recent; absent = Featured when the repo has featured or starred targets, else All. */
  mode: TargetsViewModeSchema.optional(),
  /** Substring match on the label or the workspace. */
  query: z.string().optional(),
  /** Kind chips that are ON; absent or empty = every kind. */
  kinds: z.array(z.string()).optional(),
  /** Last-run state chips that are ON; absent or empty = every state. */
  states: z.array(TargetRunStateSchema).optional(),
  /** One workspace, or absent for all. */
  workspace: z.string().optional(),
  /** The row whose detail drawer is open. */
  selected: z.string().optional(),
  /** Grouped rows (same name across packages, `//...:name`) the user expanded, by group label. */
  expanded: z.array(z.string()).optional(),
  /** Per group label, the member labels picked to run; absent = every member. */
  picked: z.record(z.string(), z.array(z.string())).optional()
})
/**
 * The decoded value accepted by {@link TargetsViewSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type TargetsView = z.infer<typeof TargetsViewSchema>

/** What the card has read about one target through `graph <label> --plan`.
 * @since 1.0.0
 * @category schemas
 */
export const TargetDetailSchema = z.object({
  status: z.enum(["pending", "done", "failed"]),
  node: GraphNodeSchema.optional(),
  deps: z.array(z.string()).optional(),
  rdeps: z.array(z.string()).optional(),
  error: z.string().optional()
})
/**
 * The decoded value accepted by {@link TargetDetailSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type TargetDetail = z.infer<typeof TargetDetailSchema>

/*
 * The card wire model, shared by the server boundary (which validates frames off
 * the upstream stream), the web agent, and the client store. A card is how the
 * agent surfaces structured state — a plan, an approval request, a status — into
 * the transcript; the client renders it with zero UI changes per DESIGN.md §5.
 */

/**
 * Validates card plan item values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const CardPlanItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "active", "done"])
})
/**
 * The decoded value accepted by {@link CardPlanItemSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CardPlanItem = z.infer<typeof CardPlanItemSchema>

/** The seams a form field's select may draw its options from (apps/app flows/FlowForms.ts OPTION_PROVIDERS).
 * @since 1.0.0
 * @category constants
 */
export const FORM_OPTION_PROVIDERS = [
  "cloud-repos",
  "bookmarks",
  "workspaces",
  "plugins",
  /* The selected repository's real files, listed by the tutorial's file lesson. */
  "files",
  /* The configured models; with a seat in the draft, only the ones that seat takes. */
  "models",
  /* The credential NAMES the host listed on the models card. Never a value. */
  "credentials",
  /* The seats the host listed on the models card. */
  "seats",
  /* The target repository's open issues (the Fix an issue app's picker). */
  "issues",
  /* The target repository's open pull requests (the Review a PR app's picker). */
  "pull-requests",
  /* The flows the target repository declares (.smithers/factory.json). */
  "repository-flows"
] as const

const cardBaseShape = {
  /** A prepared view keeps its address while its data is loading. */
  viewKey: z.string().optional(),
  viewRepo: z.string().optional(),
  loading: z.boolean().optional(),
  /** Runtime views join current normalized facts; a revision pins an immutable historical checkpoint. */
  runtimeView: z.object({ version: z.literal(1), revision: z.number().int().nonnegative().optional() }).optional(),
  navigation: z.object({ index: z.number().int().nonnegative(), length: z.number().int().positive() }).optional(),
  id: z.string(),
  title: z.string(),
  body: z.string().optional(),
  status: z.enum(["active", "acted", "error"]),
  createdAt: z.number(),
  ordinal: z.number().int().nonnegative(),
  /**
   * The conversation this card belongs to (LOCAL-APP.md "Tabs"). There is
   * one Smithers, so live cards carry no id; the field stays so cards
   * persisted by a build that had conversation tabs parse unchanged.
   */
  tabId: z.string().optional()
}

/*
 * Lane sync (ADR 0005 "Rate limits"): a GitHub-proxied call's rate-limit
 * facts, carried on the card that made the refused call (or whose status
 * read reports them). `resetAt` is the wire's reset timestamp; null when
 * the wire names none. The line renders only from these fields — a plain
 * 429 with no structured body (plue#472's shape is not deployed) reads as
 * the verbatim error, never an invented reset.
 */
/**
 * Validates GitHub rate-limit values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const GitHubRateLimitSchema = z.object({
  limit: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  resetAt: z.string().nullable()
})
/**
 * The decoded value accepted by {@link GitHubRateLimitSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type GitHubRateLimit = z.infer<typeof GitHubRateLimitSchema>

/*
 * Lane L3 (ADR 0002, plue#446): the workspace DTO's own head — what the guest
 * last reported after jj snapshotted the working copy. Distinct from
 * `bookmarkHead`, which is the TARGET BOOKMARK's head off the bookmarks call.
 * Both ids are empty strings on the wire when the guest has reported none;
 * the parser turns those into null and the card renders nothing.
 */
/**
 * Validates workspace head values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const WorkspaceHeadSchema = z.object({
  changeId: z.string().nullable(),
  commitId: z.string().nullable()
})
/**
 * The decoded value accepted by {@link WorkspaceHeadSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type WorkspaceHead = z.infer<typeof WorkspaceHeadSchema>

/*
 * The NixOS environment a workspace was built from (ADR 0002: no image
 * picker; the repository's `.smithers/environment.nix` is the source).
 * `revision` and `closureHash` are empty on the wire until a build pins them.
 * Lane L3b: `image` is the registry reference a vm or desktop workspace
 * BOOTED — empty for a container, and optional so a card written before this
 * lane still parses. The header renders its TAG only, never the whole path.
 */
/**
 * Validates workspace environment values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const WorkspaceEnvironmentSchema = z.object({
  source: z.string(),
  revision: z.string().nullable(),
  closureHash: z.string().nullable(),
  image: z.string().nullable().optional()
})
/**
 * The decoded value accepted by {@link WorkspaceEnvironmentSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type WorkspaceEnvironment = z.infer<typeof WorkspaceEnvironmentSchema>

/*
 * Lane L3b — the DTO's `desktop` object, present ONLY when `kind` is
 * `desktop`. `streamUrl` is the RELATIVE path plue publishes on the workspace
 * (never credentialed, safe to persist); `session` is the last mint's id and
 * expiry, or null before the first one. The credentialed absolute URL, the
 * session token and the VNC password come from the session POST and live only
 * in the facet's ephemeral holder — they are deliberately absent from this
 * schema, because everything in a card payload is written to disk.
 */
/**
 * Validates workspace desktop values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const WorkspaceDesktopSchema = z.object({
  /**
   * plue#496 `ready`: true only after the guest's `smithers-desktop-start`
   * verified the noVNC endpoint. A desktop workspace stays `starting` until
   * then, and a mint before then is refused 503 `desktop_not_ready`.
   */
  ready: z.boolean().nullable().optional(),
  streamUrl: RelativeUrlPathSchema.nullable(),
  session: z.object({ id: z.string(), expiresAt: z.string().nullable() }).nullable()
})
/**
 * The decoded value accepted by {@link WorkspaceDesktopSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type WorkspaceDesktop = z.infer<typeof WorkspaceDesktopSchema>

/*
 * Lane L3b — one row of `GET /api/repos/{o}/{r}/environment-images`: a built
 * NixOS closure and the image it produced. `platformBase` is plue's
 * `repository_id 0`; `coldPull` is an empty `golden_snapshot_id`, which means
 * the first boot of that closure pays a 20–40 s registry pull.
 */
/**
 * Validates environment image row values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const EnvironmentImageRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  source: z.string(),
  sourceRevision: z.string().nullable(),
  closureHash: z.string().nullable(),
  image: z.string().nullable(),
  status: z.string(),
  platformBase: z.boolean(),
  coldPull: z.boolean()
})
/**
 * The decoded value accepted by {@link EnvironmentImageRowSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type EnvironmentImageRow = z.infer<typeof EnvironmentImageRowSchema>

/**
 * One row of `GET …/workspaces/{id}/files?path=` (plue#449,
 * services.WorkspaceFileEntry). `type` is plue's own word — `file`, `dir`, or
 * `symlink` — kept verbatim; the shared file-list row the card reuses only
 * knows file and dir, so the mapping happens at the render, never here.
 * @since 1.0.0
 * @category schemas
 */
export const WorkspaceFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.string(),
  size: z.number().int().nonnegative().nullable()
})
/**
 * The decoded value accepted by {@link WorkspaceFileEntrySchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntrySchema>

/**
 * One row of `GET …/workspaces/{id}/services` (plue#449, and #483's
 * `port` / `url`, services.WorkspaceManagedService). The port and the url
 * are `omitempty` on the wire, so a service that publishes neither carries
 * neither and the row shows a name and a state alone.
 * @since 1.0.0
 * @category schemas
 */
export const WorkspaceServiceSchema = z.object({
  name: z.string(),
  state: z.string(),
  /** plue#483 `port`; null when the service publishes none. */
  port: z.number().int().nullable().optional(),
  /** plue#483 `url`; null when the service publishes none. */
  url: HttpUrlSchema.nullable().optional()
})
/**
 * The decoded value accepted by {@link WorkspaceServiceSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type WorkspaceService = z.infer<typeof WorkspaceServiceSchema>

/*
 * One row of the sandbox egress audit (`GET …/workspaces/{id}/egress` and
 * `GET …/agent-sessions/{id}/egress`, services.SandboxEgressAuditEntry): what
 * the computer called and which secret NAMES the proxy swapped in. The values
 * are never on the wire and never rendered.
 */
/**
 * Validates sandbox egress row values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const SandboxEgressRowSchema = z.object({
  occurredAt: z.string(),
  host: z.string(),
  method: z.string(),
  path: z.string(),
  status: z.number().int(),
  allowed: z.boolean(),
  swappedSecretNames: z.array(z.string())
})
/**
 * The decoded value accepted by {@link SandboxEgressRowSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type SandboxEgressRow = z.infer<typeof SandboxEgressRowSchema>

/**
 * How a workspace session POST refused (the workspace card's desktop and
 * terminal facets): plue's status beside its own words. The machine-readable
 * `code` survives the 5xx message sanitizer (`writeRouteError` keeps `Code`
 * and replaces the text with the status text); a code like
 * `guest_not_ready` is the one the facet retries on
 * its own, because the server asked it to.
 * @since 1.0.0
 * @category schemas
 */
export const SessionRefusalSchema = z.object({
  plan_key: z.string().nullable().optional(),
  limit_kind: z.string().nullable().optional(),
  upgrade_plan_key: z.string().nullable().optional(),
  status: z.number().int(),
  message: z.string(),
  /** plue's machine-readable code; null when the refusal carried none. */
  code: z.string().nullable().optional(),
  /** The `Retry-After` header's seconds, when the refusal carried one. */
  retryAfterSeconds: z.number().int().nonnegative().nullable().optional(),
  /**
   * Whose fault this was, in plue's own vocabulary — the one fact the status
   * and the sentence together cannot supply, and the one the card's lead line
   * is chosen by. Optional because cards persisted before the failure registry
   * landed carry none; `refusalFromStored` re-derives it from the code.
   */
  fault: z.enum(PLUE_FAULTS).optional(),
  /**
   * Which party refused: plue, the Cloudflare Worker in front of it, the
   * desktop app's own native host, or nothing at all because no answer came
   * back. Read back from the closed set in @smthrs/rpc/Refusal so the schema
   * and the union cannot drift.
   */
  origin: z.enum(REFUSAL_ORIGINS).optional()
})
/**
 * The decoded value accepted by {@link SessionRefusalSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type SessionRefusal = z.infer<typeof SessionRefusalSchema>

/**
 * Lane piper (ADR 0001): the revision a file or file-list card was read at.
 * `commitId` is what "head moved" compares — a change id survives a rebase,
 * a commit id does not. Optional on the card so cards persisted before the
 * fields parse.
 * @since 1.0.0
 * @category schemas
 */
export const ReadAtSchema = z.object({
  changeId: z.string().nullable(),
  commitId: z.string().nullable(),
  /** `head` = read at the repository head (head-moved applies); `working-copy` = read at a checkout's `@` (drift is "N ahead", never "head moved"). */
  source: z.enum(["head", "working-copy"]).optional()
})
/**
 * The decoded value accepted by {@link ReadAtSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ReadAt = z.infer<typeof ReadAtSchema>

/**
 * The kinds a search result can be: the Librarian Door union (RULINGS 6)
 * plus `flow`, the kind `search.flows` answers with (the slash tree as data).
 *
 * @since 1.0.0
 * @category constants
 */
export const SEARCH_ITEM_KINDS = [
  "wiki",
  "note",
  "history",
  "target",
  "file",
  "run",
  "change",
  "issue",
  "box",
  "secret-name",
  "person",
  "flow"
] as const
/**
 * Validates one search result kind.
 *
 * @since 1.0.0
 * @category schemas
 */
export const SearchItemKindSchema = z.enum(SEARCH_ITEM_KINDS)
/**
 * The decoded search result kind.
 *
 * @since 1.0.0
 * @category models
 */
export type SearchItemKind = z.infer<typeof SearchItemKindSchema>

/**
 * One act on a search result: a registered flow and the slash arguments that
 * name the item. `open` runs on Enter, `primary` on Cmd+Enter, and the rest
 * fill the actions panel (palette spec §2).
 *
 * @since 1.0.0
 * @category schemas
 */
export const SearchActionSchema = z.object({
  flow: z.string(),
  args: z.string().optional(),
  label: z.string(),
  role: z.enum(["open", "primary", "other"])
})
/**
 * The decoded search action.
 *
 * @since 1.0.0
 * @category models
 */
export type SearchAction = z.infer<typeof SearchActionSchema>

/**
 * One search result as data (palette spec §6): its kind, the ref its actions
 * name, what a person reads, and every act a registered flow offers on it.
 *
 * @since 1.0.0
 * @category schemas
 */
export const SearchItemSchema = z.object({
  kind: SearchItemKindSchema,
  ref: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  actions: z.array(SearchActionSchema)
})
/**
 * The decoded search result.
 *
 * @since 1.0.0
 * @category models
 */
export type SearchItem = z.infer<typeof SearchItemSchema>

/**
 * Validates card values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
/** Where an issue comment was written: the app, or the chat it was mirrored from. */
const IssueCommentOriginSchema = z.enum(["app", "slack", "telegram"])

const IssueLastCommentSchema = z.object({
  commenter: z.string(),
  persona: z.string().optional(),
  excerpt: z.string(),
  origin: IssueCommentOriginSchema,
  createdAt: z.string()
}).nullable()

/** Durable browser requests remain until their projection receipt arrives. */
const TodoRequestSchema = z.object({
  key: z.string(),
  owner: z.string(),
  operation: z.enum([
    "create",
    "amend",
    "answer",
    "steer",
    "stop",
    "resume",
    "retry",
    "retry-current-flow",
    "drop",
    "merge",
    "move",
    "takeover",
    "keep-moved",
    "return-to-item",
    "discard-foreign",
    "bring-in",
    "preapprove",
    "unapprove"
  ]),
  body: z.record(z.string(), z.unknown()),
  n: z.number().int().positive().optional(),
  state: z.enum(["requested", "accepted", "failed"]),
  error: z.string().optional(),
  /* The attempt an accepted retry starts, from its receipt: the retry settles once that attempt runs. */
  attempt: z.number().int().positive().optional(),
  revision: z.number().int().positive().optional(),
  /* The place an accepted move took, from its receipt: the move settles once the card shows it. */
  place: z.number().int().positive().optional()
})
type TodoRequest = z.infer<typeof TodoRequestSchema>
// Named types keep declaration emit from inlining the whole TODO and Draft
// models into every union that carries a card (TS7056 in AgentTurnFrame).
const TodoModelSchema: z.ZodType<TodoCard> = TodoCardSchema
const DraftPayloadSchema: z.ZodType<
  DraftCard & {
    idempotencyKey: string
    request?: TodoRequest | undefined
    issuePreparation?: { source: { author?: string | null | undefined; number: number; title: string; body: string; url: string; digest?: string | undefined; comments: Array<{ author: string | null; body: string }> }; state: "requested" | "ready" | "failed"; error?: string | undefined } | undefined
    imagePreparation?: {
      name: string
      repo: string
      state: "requested" | "ready" | "failed"
      error?: string | undefined
    } | undefined
    optionsFailure?: string | undefined
    issueDigest?: string | undefined
  }
> = DraftCardSchema.extend({
  idempotencyKey: z.string(),
  request: TodoRequestSchema.optional(),
  issuePreparation: z.object({ source: z.object({ author: z.string().nullable().optional(), number: z.number().int().positive(), title: z.string(), body: z.string(), url: z.string(), digest: z.string().optional(), comments: z.array(z.object({ author: z.string().nullable(), body: z.string() })) }), state: z.enum(["requested", "ready", "failed"]), error: z.string().optional() }).optional(),
  imagePreparation: z.object({
    name: z.string(),
    repo: z.string(),
    state: z.enum(["requested", "ready", "failed"]),
    error: z.string().optional()
  }).optional(),
  optionsFailure: z.string().optional(),
  /* Make TODO: the digest of the issue text the Draft was made from, sent as `issue_digest` on Commit. */
  issueDigest: z.string().regex(/^[0-9a-f]{64}$/).optional()
})

/**
 * Decodes persisted repository import requests and their progress.
 * @since 1.0.0
 * @category schemas
 */
export const RepositoryImportRequestSchema = z.object({
  ...cardBaseShape,
  payload: z.object({
    repo: z.string(),
    jobId: z.string().nullable(),
    phase: z.enum(["starting", "running", "done", "failed"]),
    detail: z.string().nullable(),
    /** The job's raw stage word (`provisioning_workspace`); optional — older answers carry none. */
    stage: z.string().nullable().optional(),
    /** Progress counts (`refs 214 of 214 · objects … · issues …`); absent until plue#471's wire fields. */
    counts: z.object({
      refs: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
      objects: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
      issues: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
    }).optional(),
    /** The job's error verbatim; the failed phase renders it with Retry. */
    error: z.string().nullable().optional(),
    /** The imported repository, when the job's answer names it (the done state links it). */
    repository: z.object({ owner: z.string(), name: z.string() }).nullable().optional(),
    /** The workspace the import created, when it created one (the done state links its card). */
    workspaceId: z.string().nullable().optional(),
    /** A refused GitHub call's rate-limit line (lane sync; GitHubRateLimitSchema above). */
    rateLimit: GitHubRateLimitSchema.optional(),
    /** Persisted launch identity: fences stale answers and reconnects the exact operation after reload. */
    requestId: z.string().optional(),
    requestKind: z.enum(["start", "retry"]).optional(),
    retryMode: z.enum(["reconnect", "restart"]).optional(),
    accountOwner: z.string().nullable().optional(),
    /** A registration's import: its step shows on the registration card, so this card is not shown. */
    registration: z.boolean().optional()
  })
})
/**
 * A persisted repository import request and its progress.
 * @since 1.0.0
 * @category models
 */
export type RepositoryImportRequest = z.infer<typeof RepositoryImportRequestSchema>

const CurrentCardSchema = z.discriminatedUnion("kind", [
  /* The deferred repository chooser and its shared-backend creation receipt. */
  z.object({
    ...cardBaseShape,
    kind: z.literal("repository-choice"),
    payload: z.object({
      cutoff: z.string(),
      partial: z.boolean(),
      error: z.string().nullable(),
      selected: z.string().nullable(),
      created: z.object({ fullName: z.string() }).nullable(),
      repositories: z.array(z.object({
        fullName: z.string(),
        count: z.number().nullable(),
        latest: z.string().nullable(),
        coverage: z.enum(["default-branch", "unknown"]),
        error: z.string().nullable()
      }))
    })
  }),

  z.object({
    ...cardBaseShape,
    kind: z.literal("factory.home"),
    payload: z.object({
      home: z.union([RepositoryHomeSchema, z.object({ kind: z.literal("error"), message: z.string() })]),
      repo: z.string(),
      flows: z.array(
        z.object({ id: z.string(), summary: z.string().nullable(), description: z.string(), featured: z.boolean() })
      )
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("stack"),
    payload: z.object({
      repo: z.string(),
      failure: z.object({
        act: z.enum(["bootstrap", "backfill", "parallel", "retry", "todo"]),
        message: z.string(),
        args: z.string()
      }).nullable(),
      bootstrap: z.object({ requestedAt: z.number() }).optional(),
      todos: z.array(z.object({
        key: z.string(),
        title: z.string(),
        body: z.string(),
        requestedAt: z.number(),
        item: z.string().optional()
      })).optional(),
      /** The issue list (default) or the metrics table; changed through `history.view`. */
      view: z.enum(["issues", "metrics"]).optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("branch"),
    payload: z.object({ id: z.string(), tab: z.enum(["activity", "files", "terminals"]).optional() })
  }),
  z.object({ ...cardBaseShape, kind: z.literal("terminal"), payload: z.object({ id: z.string() }) }),
  /* An agent CLI started from this conversation (M-38): the session the conversation shows read-only. */
  z.object({
    ...cardBaseShape,
    kind: z.literal("agent-session"),
    payload: z.object({ agent: z.enum(["codex", "claude-code"]), session: z.string() })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("todo"),
    payload: z.object({
      n: z.number().int().positive(),
      model: TodoModelSchema.optional(),
      requests: z.array(TodoRequestSchema),
      /** Private confirmation IDs already attached to this browser's durable progress observer. */
      observedConfirmations: z.array(z.string()).optional(),
      answerDraft: z.string().optional(),
      answeredBy: z.string().optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("draft"),
    audience_member_id: z.string().nullable(),
    payload: DraftPayloadSchema
  }),
  /* Confirm (card-kinds.md Confirm, T-APP-04): A✓ or Review & merge, private to the person who presses it; the card file reads its subject. */
  z.object({
    ...cardBaseShape,
    kind: z.literal("confirm"),
    audience_member_id: z.string().nullable(),
    payload: z.object({ id: z.string() })
  }),
  /* L5 subject references: the Run card (T-FLW-07) names its run; the Flow card (T-APP-05) its flow and chosen version. */
  z.object({
    ...cardBaseShape,
    kind: z.literal("proposal"),
    payload: z.object({
      id: z.string(),
      model: ProposalCardSchema.optional(),
      load: z.object({ owner: z.string(), state: z.enum(["pending", "failed"]), error: z.string().optional() })
        .optional(),
      request: z.object({
        action: z.enum(["accept", "dismiss"]),
        owner: z.string(),
        state: z.enum(["pending", "failed"]),
        error: z.string().optional()
      }).optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("run"),
    payload: z.object({
      id: z.string(),
      view: RunViewStateSchema.optional(),
      memberViews: z.record(z.string(), RunViewStateSchema).optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("flow"),
    payload: z.object({
      name: z.string(),
      version: z.string().optional(),
      memberVersions: z.record(z.string(), z.string()).optional(),
      proposal: z.object({ request: z.string(), diff: z.string() }).optional()
    })
  }),
  /* card-kinds.md L5: subject-only kinds; the card file reads its data (T-APP-03, T-APP-06, T-UI-14). */
  z.object({ ...cardBaseShape, kind: z.literal("setup"), payload: z.object({}) }),
  z.object({ ...cardBaseShape, kind: z.literal("settings"), payload: z.object({}) }),
  z.object({ ...cardBaseShape, kind: z.literal("members"), payload: z.object({}) }),
  z.object({ ...cardBaseShape, kind: z.literal("commands"), payload: z.object({}) }),

  // Identity-only tombstones keep historical frames and journals loadable.
  z.object({
    ...cardBaseShape,
    kind: z.literal("retired"),
    payload: z.object({ was: z.string().optional() })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("repo-update"),
    payload: z.object({
      repo: z.string(),
      scope: z.string(),
      checkedAt: z.number(),
      summary: z.string(),
      branch: z.string().optional(),
      openIssues: z.number().int().nonnegative().nullable(),
      openPrs: z.number().int().nonnegative().nullable(),
      problems: z.array(z.string()),
      items: z.array(
        z.object({
          id: z.string(),
          version: z.string(),
          source: z.string().optional(),
          kind: z.enum(["issue", "pr", "notification"]),
          number: z.number().int().optional(),
          title: z.string(),
          state: z.string(),
          tags: z.array(z.string()),
          read: z.boolean()
        })
      )
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("plan"),
    payload: z.object({ items: z.array(CardPlanItemSchema) })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("approval"),
    payload: z.object({
      capability: z.string(),
      detail: z.string().optional(),
      /*
       * The run identity an approval decision round-trips against (the
       * gateway's `Approval.Submit` procedure). Optional so demo cards stay
       * valid; a card without them cannot be decided against a backend.
       */
      runId: z.string().optional(),
      /** The gate's own id, which is what identifies it to the engine. */
      requestId: z.string().optional(),
      /*
       * The submit-ready `ApprovalTarget.Node` envelope the gateway published
       * with the request. A decision hands this back unchanged, so the client
       * never reconstructs the authority it is exercising.
       */
      approval: z.record(z.string(), z.unknown()).optional(),
      /*
       * A gate that asks a QUESTION rather than for a grant: a HumanTask
       * waiting on a person. Approve and Deny answer nothing here, so the card
       * renders the prompt and a box to answer it in. Absent on a capability
       * gate, which is decided and not answered.
       */
      question: z.object({
        kind: z.enum(["ask", "confirm", "select", "json"]),
        prompt: z.string(),
        name: z.string().optional(),
        options: z.array(z.string()).optional(),
        attempt: z.number().int().positive().optional(),
        maxAttempts: z.number().int().positive().optional()
      }).optional(),
      /** Read projection of the human's draft, bound to the exact pending question. */
      answerDraft: z.object({ question: z.string().regex(/^[0-9a-f]{64}$/), text: z.string() }).optional(),
      /** The loaded repository whose per-user gateway the run lives on. */
      repo: z.string().optional(),
      /** Owning gateway; omission keeps legacy cards unbound. */
      workspaceId: GatewayWorkspaceIdSchema.optional(),
      /** Version 1 records an explicit legacy route when workspaceId is absent. */
      gatewayBindingVersion: z.literal(1).optional(),
      decision: z.enum(["approved", "denied"]).optional(),
      decidedAt: z.number().optional(),
      /** A decision is in flight to the backend: the card must not be re-decided. */
      pending: z.boolean().optional(),
      /** The last decision attempt failed; the card stays retryable. */
      error: z.string().optional(),
      /*
       * A chain approval park (DESIGN.md §14): the decision resolves against
       * the in-app chain runtime (runId = the lineage) and resumes it, not
       * against the workflow gateway — so requestId never applies.
       * `background` marks a lineage the runtime resumes itself: the
       * controller freezes the card and starts no turn.
       */
      chain: z.boolean().optional(),
      background: z.boolean().optional(),
      /** The parked call's flow name; with `capability` it reconstructs the ask after a reload. */
      flow: z.string().optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("billing-plans"),
    payload: z.object({
      planKey: z.string().nullable(),
      sandbox: SandboxEntitlementSchema.nullable(),
      plans: z.array(BillingPlanSchema),
      checkout: z.boolean(),
      refusal: SessionRefusalSchema.optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("balance"),
    payload: z.object({
      totalUsd: z.string(),
      state: z.enum(["ok", "low", "empty"]),
      allowedToStartWork: z.boolean(),
      lifetimeChargedUsd: z.string(),
      chargeCount: z.number().int().nonnegative(),
      introUsd: z.string().nullable()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("status"),
    payload: z.object({
      progress: z.number().min(0).max(1).optional(),
      note: z.string().optional()
    })
  }),
  /* The admin plugin's cards (Launch Checklist §E — registered only for admin sessions). */
  /* A world query's embedded answer card (the agent's world form; §2c″). */
  z.object({
    ...cardBaseShape,
    kind: z.literal("world"),
    payload: z.object({
      documents: z.array(
        z.object({
          id: z.string().optional(),
          path: z.string(),
          title: z.string(),
          confidence: z.number(),
          cloud: z.object({
            repo: z.string(),
            slug: z.string(),
            revision: z.number().int().positive(),
            visibility: z.enum(["public", "private"]).optional(),
            accountLogin: z.string().optional()
          }).optional()
        })
      ),
      selectedDocumentId: z.string().optional(),
      view: z.enum(["outline", "read", "document"]).optional(),
      index: z.object({
        repo: z.string(),
        page: z.number().int().positive(),
        hasNext: z.boolean(),
        /* The space the index lists (#1922); absent on cards written before spaces existed, which listed public. */
        space: z.enum(["public", "private"]).optional()
      }).optional()
    })
  }),
  /*
   * A wiki page's history (#1922): every revision of one page in one space,
   * including renames and the deletion, newest first. A row's content is the
   * scoped revision's own bytes (the history content route), so a revision
   * downloads after a rename or a delete.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("wiki-history"),
    payload: z.object({
      /** A pinned read, separate from the live editable document. */
      content: z.object({ revision: z.number().int().positive(), markdown: z.string() }).optional(),
      repo: z.string(),
      space: z.enum(["public", "private"]),
      pageId: z.number().int().positive(),
      /* The page's indexed slug, independent of its path: pagination requests it back. */
      slug: z.string(),
      title: z.string(),
      path: z.string(),
      revisions: z.array(z.object({
        revision: z.number().int().positive(),
        title: z.string(),
        path: z.string(),
        author: z.string(),
        at: z.string(),
        deleted: z.boolean(),
        digest: z.string(),
        attachment: z.object({ digest: z.string(), mediaType: z.string(), size: z.number() }).optional()
      })),
      page: z.number().int().positive(),
      hasNext: z.boolean()
    })
  }),
  /*
   * The browser surface (Wave 10, §2d′): an embedded, maximizable view of a
   * URL. `frameable:false` carries the honest blocked reason (the site
   * refused framing) — never a silent blank.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("browser"),
    /*
     * `url` is what was asked for and may be a refused scheme the card
     * reports; only a frameable card is embedded, so the page it embeds
     * (`finalUrl ?? url`) must be http(s) — an iframe `src` of `javascript:`
     * runs in the app origin.
     */
    payload: z.object({
      url: z.string(),
      finalUrl: HttpUrlSchema.nullable(),
      status: z.number().int().nullable(),
      frameable: z.boolean(),
      blockReason: z.string().nullable(),
      error: z.string().optional(),
      refusal: SessionRefusalSchema.optional()
    }).refine((payload) => !payload.frameable || HttpUrlSchema.safeParse(payload.finalUrl ?? payload.url).success, {
      message: "A frameable browser card embeds only an http(s) URL.",
      path: ["url"]
    })
  }),
  /*
   * The run trace (factory spec 06): one card kind for every run, whatever its
   * kind (implement, prototype, review, ...). The card tracks the run live
   * (phase, `steps` as a short tail of progress words, `result` once it
   * settles) and renders its journal as a trace: a call tree, a waterfall and
   * a span pane, folded on the client from `events` (the `run-events`
   * projection) until the gateway serves a run-trace projection. The pump
   * POLLS the summary and run-events projections from the start on every load
   * — there is no per-run event cursor and nothing reconnects mid-stream.
   * `lastSeq` is a retained legacy field name: it carries the summary
   * projection's `updatedAt`, when the card last heard from the run, never a
   * replay position. Stopping a watch asks the gateway's durable Cancel; the
   * card reads "cancelled" when the workspace accepts and "stopped" (this
   * client stopped watching) when it refuses. The reader's view state
   * (selection, cursor, filter, live tail) lives here too, so the tree, the
   * waterfall and the pane never disagree. The id scheme `flow-run-<runId>`
   * stays so links resolve.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("run-trace"),
    payload: LegacyRunTracePayloadSchema
  }),
  /* The workspace's workflows as an embedded card (flow.list). */
  z.object({
    ...cardBaseShape,
    kind: z.literal("workflow-list"),
    payload: z.object({
      repo: z.string(),
      catalogRequest: z.object({ id: z.string(), owner: z.string(), state: z.enum(["pending", "failed"]) }).optional(),
      /** The gateway that actually answered this executable catalog. */
      workspaceId: GatewayWorkspaceIdSchema.optional(),
      /** Version 1 distinguishes a recorded legacy gateway from missing provenance. */
      gatewayBindingVersion: z.literal(1).optional(),
      issueContext: z.object({ number: z.number(), title: z.string() }).optional(),
      research: z.string().optional(),
      workflows: z.array(
        z.object({
          key: z.string(),
          description: z.string().nullable(),
          prompt: z.string().optional(),
          inputSchema: z.unknown().optional()
        })
      )
    })
  }),
  /*
   * What a flow WOULD run (flow.plan): the keyed nodes the control plane
   * answered with before anything runs, and the labelled edges between them.
   *
   * Only the part a graph draws is kept. A plan node's full key material
   * carries the call's own payload, and everything in a card payload is
   * written to disk by the persistence backend, so the card holds the node's
   * address, its key, its edges, its tier and the action it dispatches, and
   * nothing else. `graph` is present only when the workspace reported the
   * labelled edges; `dependsOn` is the unlabelled edge set every host carries.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("flow-plan"),
    payload: z.object({
      repo: z.string(),
      /** The gateway that answered the plan. */
      workspaceId: GatewayWorkspaceIdSchema.optional(),
      flowId: z.string(),
      /** The input the plan was taken on, so the Run door launches the same thing. */
      input: z.record(z.string(), z.unknown()).optional(),
      /** The declaration read from this plan's own box, retained so Run still asks for typed input after reload. */
      inputSchema: z.unknown().optional(),
      /** Durable client admission; retained on failure so retry uses the same Plan key. */
      planRequest: z.object({ id: z.string(), owner: z.string() }).optional(),
      status: z.enum(["pending", "done", "failed"]),
      /** The workspace's own sentence when the plan was refused. */
      error: z.string().optional(),
      planId: z.string().optional(),
      digest: z.string().optional(),
      nodes: z.array(PlanCardNodeSchema).optional(),
      /** The labelled edges and declaration sites the workspace reported (@see PlanCardGraphSchema). */
      graph: PlanCardGraphSchema.optional(),
      /** The run this plan was asked to be compared against (`flow.plan against=<runId>`). */
      against: z.string().optional(),
      /** The previous engine plan, retained when authoring redraws this same card. */
      previousPlan: z.object({ planId: z.string(), digest: z.string(), nodes: z.array(PlanCardNodeSchema) }).optional(),
      /** Applied source receipt that requested this plan; completion is the card's status. */
      sourceReceipt: z.object({ runCardId: z.string(), receipt: z.string() }).optional(),
      /*
       * The re-key preview: this plan against the plan that run was approved
       * on. Numbers only, and each one is something the engine or the journal
       * stated. There is no predicted cache-hit count: on this host nothing
       * settles `clean` (D-044) and a plan key is not a dispatch key, so the
       * only cache figure is the one the compared run actually recorded.
       */
      rekey: z.object({
        /** Nodes the second run would execute: added plus re-keyed. */
        rerun: z.number().int().nonnegative(),
        /** Nodes in this plan. */
        total: z.number().int().nonnegative(),
        /** The critical path over the work; absent when one node of it was never measured. */
        etaMs: z.number().nonnegative().optional(),
        /** What the compared run really took, its first journal row to its last. */
        wasMs: z.number().nonnegative().optional(),
        /** How many nodes that run settled `clean`; absent where it settled none. */
        cleanSettlements: z.number().int().positive().optional()
      }).optional(),
      /** The graph's own reader state: the node whose drawer is open, and its tab. */
      view: GraphDrawerSchema.optional()
    })
  }),
  /*
   * The dispatchers waiting on a repository (triggers.list). Two sources,
   * never mixed: `declared` is the `on` table of `.smithers/factory.json`
   * read from the public mirror, so every visitor gets it; `triggers` are the
   * repository's schedules registered on Smithers Cloud, present only for a
   * signed-in session, which `live` states. Rows are never invented: no
   * projection means no declared rows, no registration means live is false
   * and `triggers` is empty. Fields older cards carried beyond these are
   * dropped on decode.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("trigger-list"),
    payload: z.object({
      repo: z.string(),
      /** Preparation outbox: the plan receipt is durable before its approval message is published. */
      preparations: z.array(z.object({
        id: z.string(),
        owner: z.string(),
        workspaceId: GatewayWorkspaceIdSchema.optional(),
        phase: z.enum(["requested", "planning", "ready", "prepared", "failed"]),
        draft: z.object({
          flow: z.string(),
          slug: z.string(),
          schedule: z.string(),
          input: z.string(),
          tokens: z.number().optional(),
          minutes: z.number().optional()
        }),
        receipt: z.object({ text: z.string(), args: z.string() }).optional(),
        /* The owner asked to schedule with one press: their approval of the plan is applied once it is prepared (no preview prompt). */
        approve: z.literal("owner").optional(),
        error: z.string().optional()
      })).optional(),
      /** Durable HTTP pause requests; reconnect by observing before offering an explicit retry. */
      pauseRequests: z.array(z.object({
        id: z.string(),
        slug: z.string(),
        owner: z.string(),
        phase: z.enum(["requested", "sending", "completed", "failed"]),
        error: z.string().optional()
      })).optional(),
      /** Optional for cards persisted before the declaration joined the listing. */
      declared: z.array(FactoryRuleSchema).optional(),
      /** True only when Smithers Cloud listed registrations on this show. Optional for older cards. */
      live: z.boolean().optional(),
      triggers: z.array(
        z.object({
          id: z.string(),
          /** The registration's own name, which is what a manual fire addresses; optional for older cards. */
          slug: z.string().optional(),
          flowId: z.string(),
          cron: z.string(),
          timezone: z.string().optional(),
          enabled: z.boolean(),
          /** The next fire Smithers Cloud computed for this registration. */
          nextFireAt: z.number().optional()
        })
      )
    })
  }),

  /*
   * Lane runs §2 — the run inbox: every run on the workspace, one summary row
   * each, with the filters the listing was cut at so the card states what it
   * shows. A row opens its run card; the filters are the flow's arguments,
   * never hidden state.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("run-list"),
    payload: z.object({
      repo: z.string(),
      /** Owning gateway; omission keeps legacy cards unbound. */
      workspaceId: GatewayWorkspaceIdSchema.optional(),
      /** Version 1 records an explicit legacy route when workspaceId is absent. */
      gatewayBindingVersion: z.literal(1).optional(),
      /** Every status the unfiltered workspace carried when listed; the filter chips read it. Optional for older cards. */
      statuses: z.array(z.string()).optional(),
      /** A saved inventory read; only this request may publish into the card. */
      listRequest: z.object({
        id: z.string(),
        owner: z.string(),
        repo: z.string(),
        workspaceId: GatewayWorkspaceIdSchema.optional(),
        status: z.string().optional(),
        flow: z.string().optional(),
        lineage: z.string().optional(),
        state: z.enum(["pending", "complete", "failed"])
      }).optional(),
      status: z.string().optional(),
      flow: z.string().optional(),
      lineage: z.string().optional(),
      /** Pending gates in the attention view; decisions still open the authoritative approval cards. */
      approvals: z.array(z.object({ runId: z.string(), requestId: z.string(), title: z.string() })).optional(),
      observationError: z.string().optional(),
      observedAt: z.number().optional(),
      runs: z.array(
        z.object({
          runId: z.string(),
          flowId: z.string(),
          status: z.string(),
          waiting: z.string().optional(),
          statusRollup: StatusRollupSchema.optional(),
          createdAt: z.number(),
          turns: z.number().int().nonnegative(),
          calls: z.number().int().nonnegative()
        })
      )
    })
  }),
  /*
   * Lane runs §5 — the approvals inbox: every pending gate across the
   * workspace's runs. Each row carries the submit-ready envelope the gateway
   * published, so a decision goes back with it unchanged — the client never
   * reconstructs authority.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("approvals-inbox"),
    payload: z.object({
      repo: z.string(),
      /** Owning gateway; omission keeps legacy cards unbound. */
      workspaceId: GatewayWorkspaceIdSchema.optional(),
      /** Version 1 records an explicit legacy route when workspaceId is absent. */
      gatewayBindingVersion: z.literal(1).optional(),
      approvals: z.array(
        z.object({
          runId: z.string(),
          requestId: z.string(),
          title: z.string(),
          approval: z.record(z.string(), z.unknown()),
          requestedAt: z.number(),
          /*
           * A budget or time guard's park: its class and words. The row reads
           * as the incident, decided as Continue (approve) or Stop (deny).
           */
          incident: z.object({ classification: z.enum(["Runaway", "Stuck"]), message: z.string() }).optional(),
          /*
           * A gate that asks a QUESTION rather than for a grant: a HumanTask
           * waiting on a person. Approve and Deny answer nothing here, so the
           * row carries what the run asked — the kind of answer it wants, the
           * prompt, the choices, and how much of the attempt budget is left —
           * and the card renders a box to answer it in. Absent on an ordinary
           * capability gate, which is decided and not answered.
           */
          question: z.object({
            kind: z.enum(["ask", "confirm", "select", "json"]),
            prompt: z.string(),
            name: z.string().optional(),
            options: z.array(z.string()).optional(),
            attempt: z.number().int().positive().optional(),
            maxAttempts: z.number().int().positive().optional()
          }).optional(),
          /** Read projection of the human's draft, bound to the exact pending question. */
          answerDraft: z.object({ question: z.string().regex(/^[0-9a-f]{64}$/), text: z.string() }).optional(),
          decision: z.enum(["approved", "denied"]).optional(),
          /** When the decision was submitted, never when the gate was raised; absent until one is made, so a row states only the time it knows. */
          decidedAt: z.number().optional(),
          decisionError: z.string().optional(),
          /** A decision is in flight: the buttons hide until the server answers, so a second click cannot send a contradicting decision. */
          pending: z.boolean().optional()
        })
      )
    })
  }),
  /*
   * The multi-parity domain cards (MULTI-ACTIONS-GAP.md Tier 1/2): issues,
   * landings ("PRs" — landing is QUEUED, never "merged"),
   * notifications, the agent environment, and the repo import job. Payloads
   * mirror the platform answers trimmed to what the card states; bodies live
   * in src/mainview/cards/*.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("issue-list"),
    payload: z.object({
      repo: z.string(),
      filter: z.enum(["open", "closed", "all"]),
      /** Which rows the list shows: every issue, only conversations, or only issues (issues.list --kind). */
      kind: z.enum(["all", "conversation", "issue"]).optional(),
      /** The saved issue view the list applies (issues.list --view), when one is selected. */
      view: z.string().optional(),
      /** The saved issue views the repository's factory declares, in declaration order; absent when none. */
      views: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
      issues: z.array(
        z.object({
          number: z.number().int(),
          kind: z.enum(["issue", "chat"]).optional(),
          /** Intent metadata (smithers-ui-DESIGN.md §3.2) when the read carried it. */
          task: TaskMetaSchema.optional(),
          title: z.string(),
          /** The backend's states: an issue moves open → fixed → verified → closed; a conversation opens and closes. */
          state: z.enum(["open", "fixed", "verified", "closed"]),
          author: z.string().nullable(),
          comments: z.number().int().nonnegative(),
          updatedAt: z.string().nullable(),
          /** Where the row came from: Smithers Cloud's own tracker, or GitHub for a mirrored repo. Optional so older cards parse. */
          source: z.enum(["smithers-cloud", "github"]).optional(),
          htmlUrl: HttpUrlSchema.optional(),
          /** The issue's labels when the read carried them; absent renders none. */
          labels: z.array(z.string()).optional(),
          /*
           * GitHub facts the restyled issue cards render when a read carries
           * them (cards/IssueCards.tsx IssueExtras; the onboarding practice
           * repository does). Optional: a field the source did not state
           * renders nothing. Avatars are URLs or data: URIs; label colors
           * are hex, keyed by label name.
           */
          createdAt: z.string().nullable().optional(),
          assignees: z.array(z.object({ login: z.string(), avatar: z.string().optional() })).optional(),
          labelColors: z.record(z.string(), z.string()).optional(),
          authorAvatar: z.string().optional(),
          /** The newest comment (the backend's `last_comment`); absent when the read carried none. */
          lastComment: IssueLastCommentSchema.optional()
        })
      ),
      /**
       * The GitHub read's provenance (X-Metadata-* headers on
       * /api/user/github-repos/{o}/{r}/issues): "synced" with a syncedAt, or
       * "live"; stale=true when the store is behind; a sync error verbatim.
       * Absent when GitHub was not read (not linked, not mirrored, refused).
       */
      github: z.object({
        source: z.string(),
        syncedAt: z.string().nullable(),
        stale: z.boolean(),
        syncError: z.string().nullable(),
        refusal: z.string().nullable()
      }).optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("issue"),
    payload: z.object({
      repo: z.string(),
      number: z.number().int(),
      kind: z.enum(["issue", "chat"]).optional(),
      visibility: z.enum(["public", "private"]).optional(),
      /** Intent metadata (smithers-ui-DESIGN.md §3.2): owner, due, priority, parent, fixer and verifier, when the issue carries them. */
      task: TaskMetaSchema.optional(),
      title: z.string(),
      state: z.enum(["open", "fixed", "verified", "closed"]),
      author: z.string().nullable(),
      issueBody: z.string(),
      issueDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      makeTodoAllowed: z.boolean().optional(),
      todoAuthorizationScope: z.string().optional(),
      source: z.enum(["smithers-cloud", "github"]).optional(),
      htmlUrl: HttpUrlSchema.optional(),
      conversation: z.object({ branchId: z.string(), owner: z.string(), creationKey: z.string() }).optional(),
      commentDraft: z.string().optional(),
      pendingComments: z.array(z.object({
        id: z.string(),
        text: z.string(),
        actor: z.enum(["user", "smithers"]),
        owner: z.string().optional(),
        turnId: z.string().optional(),
        persona: z.object({ username: z.string(), iconEmoji: z.string().optional(), iconUrl: HttpUrlSchema.optional() })
          .optional(),
        status: z.enum(["requested", "failed", "unknown"]),
        error: z.string().optional()
      })).optional(),
      labels: z.array(z.string()),
      comments: z.array(
        z.object({
          author: z.string().nullable(),
          id: z.number().int().optional(),
          idempotencyKey: z.string().optional(),
          reactions: z.array(z.object({ name: z.string(), actor: z.string(), active: z.boolean() })).optional(),
          persona: z.object({
            username: z.string(),
            iconEmoji: z.string().optional(),
            iconUrl: HttpUrlSchema.optional()
          })
            .optional(),
          commentBody: z.string(),
          createdAt: z.string().nullable(),
          authorAvatar: z.string().optional(),
          /** Where the comment was written (the backend's `origin`); absent when the read did not say. */
          origin: IssueCommentOriginSchema.optional()
        })
      ),
      lastComment: IssueLastCommentSchema.optional(),
      /* The restyled issue card's GitHub facts (cards/IssueCards.tsx IssueExtras); see the issue-list row. */
      createdAt: z.string().nullable().optional(),
      assignees: z.array(z.object({ login: z.string(), avatar: z.string().optional() })).optional(),
      labelColors: z.record(z.string(), z.string()).optional(),
      authorAvatar: z.string().optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("pr-list"),
    payload: z.object({
      repo: z.string(),
      landings: z.array(
        z.object({
          number: z.number().int(),
          title: z.string(),
          state: z.string(),
          author: z.string().nullable(),
          updatedAt: z.string().nullable(),
          /** The source branch and the files it touches, when the read carried them; absent renders none. */
          branch: z.string().optional(),
          files: z.array(z.string()).optional(),
          /* The restyled PR row's GitHub facts (cards/LandingCards.tsx LandingRowExtras); optional, absent renders nothing. */
          draft: z.boolean().optional(),
          reviewsRequested: z.number().int().nonnegative().optional(),
          createdAt: z.string().nullable().optional(),
          comments: z.number().int().nonnegative().optional(),
          baseBranch: z.string().optional(),
          labels: z.array(z.string()).optional(),
          labelColors: z.record(z.string(), z.string()).optional(),
          additions: z.number().int().nonnegative().optional(),
          deletions: z.number().int().nonnegative().optional(),
          assignees: z.array(z.object({ login: z.string(), avatar: z.string().optional() })).optional(),
          reviewers: z.array(z.object({ login: z.string(), avatar: z.string().optional() })).optional()
        })
      )
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("pr"),
    payload: z.object({
      tab: z.enum(["conversation", "commits", "checks", "files"]).optional(),
      repo: z.string(),
      sourceRepo: z.string().optional(),
      number: z.number().int(),
      title: z.string(),
      /** Platform landing state; "queued" after a land — never "merged". */
      state: z.string(),
      author: z.string().nullable(),
      prBody: z.string(),
      reviews: z.array(
        z.object({
          author: z.string().nullable(),
          type: z.string(),
          reviewBody: z.string()
        })
      ),
      checks: z.array(z.object({ context: z.string(), state: z.string() })),
      readErrors: z.object({
        commits: z.string().optional(),
        files: z.string().optional()
      }).optional(),
      /*
       * GitHub-like facts and the Commits / Files changed tabs, when the read
       * carried them (see the issue-list row). All optional: an absent field
       * has a matching readErrors entry, never an invented empty stack. Commits run
       * bottom → top (GET …/landings/{number}/changes); files merge the stack's
       * retained diffs (GET …/landings/{number}/diff) by path, with a patch only when one change
       * touched the file.
       */
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      draft: z.boolean().optional(),
      createdAt: z.string().nullable().optional(),
      authorAvatar: z.string().optional(),
      labels: z.array(z.string()).optional(),
      labelColors: z.record(z.string(), z.string()).optional(),
      commits: z.array(z.object({
        changeId: z.string().optional(),
        commitId: z.string().optional(),
        message: z.string(),
        author: z.string().nullable().optional(),
        timestamp: z.string().nullable().optional()
      })).optional(),
      files: z.array(z.object({
        path: z.string(),
        oldPath: z.string().optional(),
        status: z.enum(["added", "modified", "removed", "renamed"]).optional(),
        additions: z.number().int().nonnegative().optional(),
        deletions: z.number().int().nonnegative().optional(),
        patch: z.string().optional()
      })).optional()
    })
  }),

  /*
   * A repository's CI secrets (Secrets L1): METADATA only. plue's workflow
   * secret list has no value field; `mainOnly` limits a secret to trusted runs
   * on the default bookmark, and hosts and match_headers are the egress-proxy
   * binding, empty on both for an unbound secret. `scope` names whose secrets
   * the card lists; personal secrets add a second scope in a later lane.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("secrets"),
    payload: z.object({
      repo: z.string(),
      scope: z.literal("repository"),
      secrets: z.array(LegacySecretMetadataSchema)
    })
  }),
  /*
   * The composer for one configured model (ConfiguredModel.ts): the request a
   * person edits, the typed answer it got, and whether one is out. The
   * request is fields and questions, the answer is numbers and option names
   * or the generated text, and no value exists on this payload.
   */

  /*
   * Lane sync (ADR 0005): the sync-ops card for GitHub mirror syncs. Rows
   * are the durable ops, newest first, a failed row carrying the server's
   * error verbatim with a Retry act
   * (`sync.retry <opId>`); failures are never filtered out. The header's
   * run state and counts stay live while the run is polled.
   *
   * Lane L5 (plue#468/#470 live): the state words are the WIRE's, never a
   * vocabulary of this app's own — a mirror run `queued | running |
   * succeeded | failed`, a mirror ref `pending | succeeded | failed`. They
   * are strings here so the screen never renames the wire's words;
   * `@smthrs/ui`'s status vocabulary already tints every one of them.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("sync-ops"),
    payload: z.object({
      /** The header subject: `Mirror · org/repo`. */
      subject: z.string(),
      source: z.literal("github-mirror"),
      /** `org/repo` (the mirror's repository). */
      repo: z.string().optional(),
      /** The run the trigger answered with (`run_id`), when it named one. */
      runId: z.string().nullable().optional(),
      /** The run's state VERBATIM off the run DTO; null before a run answers. */
      runState: z.string().nullable(),
      /** The header counts from the run DTO; absent with it. */
      counts: z.object({
        total: z.number().int().nonnegative(),
        done: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative()
      }).nullable().optional(),
      /**
       * The repository's `mirror_status` word off the repository DTO
       * (`synced | behind | failed | unconfigured`); absent when the app
       * never read it. Header word for a mirror card only.
       */
      mirrorStatus: z.string().optional(),
      /**
       * plue#491: the repository DTO's `behind_refs` / `failed_refs` beside
       * `mirror_status`, so `behind GitHub · 3 refs` states a count instead
       * of the bare word. Absent when the DTO named none.
       */
      behindRefs: z.number().int().nonnegative().optional(),
      failedRefs: z.number().int().nonnegative().optional(),
      /** The one fact the trigger answered (`sync started`, `already running`, `synced`); null when it said nothing. */
      trigger: z.string().nullable().optional(),
      /** The ops, newest first; empty while a run has produced none. */
      ops: z.array(
        z.object({
          id: z.string(),
          source: z.string(),
          target: z.string(),
          entity: z.string(),
          entityId: z.string().nullable(),
          action: z.string(),
          /** The wire's own status word (see the note above); never remapped. */
          status: z.string(),
          /** The server error verbatim, on its own line. */
          error: z.string().optional(),
          retryable: z.boolean(),
          at: z.string().nullable()
        })
      ),
      /** Why the ops list is empty (the ADR's degraded wording); absent when the feed answered. */
      opsNote: z.string().optional(),
      /** The activity window this card was cut at (`24h`), when it is the activity view. */
      window: z.string().optional(),
      /** `show more` revealed the whole cut; the first N rows show by default. */
      expanded: z.boolean().optional(),
      /** Older ops exist beyond this cut (`load older` pages the feed). */
      hasOlder: z.boolean().optional(),
      /**
       * plue#491: the opaque `rel="next"` cursor of the LAST ops page this
       * card read — the position `load older` continues from. Absent when
       * the feed is exhausted, which is also when `hasOlder` is false.
       */
      opsCursor: z.string().nullable().optional(),
      /** The rate-limit line when a GitHub call behind this card was refused. */
      rateLimit: GitHubRateLimitSchema.optional(),
      /** The last act's honest refusal, kept on the card. */
      error: z.string().optional()
    })
  }),
  /*
   * Lane piper (ADR 0001): file cards carry the GLOBAL path
   * (`/org/repo/path`) and the position they were read at. `readAt.commitId`
   * is what "head moved" compares — a change id survives a rebase, a commit
   * id does not. Optional so cards persisted before the fields parse.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("file-list"),
    payload: z.object({
      repo: z.string(),
      /** Exact local working copy; display names can name several checkouts. */
      localRepoId: z.string().optional(),
      path: z.string(),
      entries: z.array(z.object({ name: z.string(), kind: z.enum(["file", "dir"]) })),
      /** True when the listing was cut (a local directory past its cap); optional so older cards parse. */
      truncated: z.boolean().optional(),
      /** The global path (`/org/repo/path`); absent on cards written before lane piper. */
      address: z.string().optional(),
      readAt: ReadAtSchema.optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("file"),
    payload: z.object({
      repo: z.string(),
      /** Branch file projection; old pinned cards continue decoding without it. */
      file: FileCardSchema.optional(),
      comparison: z.object({ version: z.string(), text: z.string() }).optional(),
      compare: z.boolean().optional(),
      /** Exact local working copy; retained by refresh and code-intelligence actions. */
      localRepoId: z.string().optional(),
      /** The box the bytes were read from (`box.file`); its markdown links open that box's files. */
      workspaceId: z.string().optional(),
      path: z.string(),
      content: z.string(),
      /** True when the read was cut at the card cap; the full file stays upstream. */
      truncated: z.boolean(),
      /*
       * The file's bytes are not text. The card states that instead of
       * printing them: base64 rendered as source is one 42626px line the
       * reader cannot use and cannot reach (§8.27). Optional so cards
       * persisted before the field parse without a schema reset.
       */
      binary: z.boolean().optional(),
      /** The global path (`/org/repo/path`); absent on cards written before lane piper. */
      address: z.string().optional(),
      /*
       * Lane change (ADR 0003 §3): the revision pin `{ changeId, seq,
       * commitId }`. `seq` stays absent until plue#450 records revisions —
       * a card read from a local working copy pins by commit id, never a
       * server seq. Optional so cards persisted before the lane parse.
       */
      readAt: ReadAtSchema.extend({
        seq: z.number().int().positive().nullable().optional()
      }).optional(),
      /*
       * Code intelligence (apps/app/docs/code-intel/PLAN.md §5). Components
       * project these; the seams write them through `card.updated`. All
       * optional so cards persisted before the lane parse and state none.
       */
      /**
       * The revision this file was read AT, when the read asked for one.
       *
       * A read with no ref answers the working tree, which moves; a read
       * with one answers bytes that cannot change. The graph drawer's Code
       * tab only renders a card whose ref is the revision its node's sites
       * were recorded at, so an unbound read of the same path is never
       * shown as the code that ran (D-068).
       */
      ref: z.string().min(1).optional(),
      /** The anchored line and column (`files.read <path>:<line>[:<col>]`), 1-based: scrolled to and marked. */
      line: z.number().int().min(1).optional(),
      column: z.number().int().min(1).optional(),
      /**
       * The digest of the bytes the card shows (SHA-256, hex). A
       * language server answers about the file on disk and names that
       * digest; the seam re-reads a card whose digest differs before it
       * draws the answer. Absent on cloud reads and cards persisted before.
       */
      digest: z.string().optional(),
      /** What the language server published for this file, up to the cap; absent until it answered (an unread file has no count). */
      diagnostics: z.array(LspDiagnosticSchema).max(LSP_DIAGNOSTICS_CAP).optional(),
      /** How many the server published when `diagnostics` is the capped head of them; absent when the list is complete. */
      diagnosticsTotal: z.number().int().nonnegative().optional(),
      /** The last hover answer at a position: null when the server had nothing there; absent when never asked. */
      hover: z.object({
        line: z.number().int().min(1),
        character: z.number().int().min(1),
        /** The hover text, capped exactly as {@link LspHoverSchema} caps it. */
        contents: LspHoverSchema.shape.contents,
        /** True when the host cut the server's text at its cap; the box says so. */
        truncated: z.boolean().optional()
      }).nullable().optional(),
      /** The language server as far as this card knows; absent until a `code.*` flow ran on the file. */
      intel: z.object({
        state: z.enum(["ready", "starting", "missing", "unavailable"]),
        /** What the card prints under the state: the install line on `missing`, the host's message on `unavailable`. */
        note: z.string().optional()
      }).optional()
    })
  }),
  /*
   * Lane change (ADR 0003 — the change is the unit): the change card. One
   * fact per line of the ADR's mockup and nothing else: the header (change
   * id, `rev N of M` once plue#450 records revisions, stack position,
   * landing state), the description, the per-repo stat, checks / findings /
   * review at the current revision, the conflict line, the current
   * revision's provenance, and the facet strip (Diff, Findings, Checks,
   * Review, History), plus Walkthrough when an artifact exists and Owners
   * when the change GET carries `owners` (ADR 0004, lane L1).
   *
   * Every revision-shaped field is what plue's routes state (#450–#467); a
   * field a route omits stays null or absent, and nothing is inferred from
   * timestamps. The lane-L1 fields (`turn`, `owners`, `landed`,
   * `walkthrough`, `analyzers`, `checksAt`, the stack's `blockedBy`) are
   * optional so cards persisted before the lane parse.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("change"),
    payload: z.object({
      /** `org/repo` the change was read from. */
      repo: z.string(),
      changeId: z.string(),
      description: z.string(),
      /** The reviewed GitHub PR, pinned at admission. Absent for ordinary changes. */
      pullRequest: z.object({ number: z.number().int().positive(), url: HttpUrlSchema }).optional(),
      /** The current revision's commit. */
      commitId: z.string().nullable(),
      /** plue's `current_seq` when it names a recorded revision; `revisions.length`. Null when the DTO carries neither. */
      currentSeq: z.number().int().positive().nullable(),
      revisionCount: z.number().int().nonnegative().nullable(),
      revisions: z.array(ChangeRevisionSchema),
      /** The current revision's provenance: the author and timestamp the DTO states. */
      authorName: z.string().nullable(),
      timestamp: z.string().nullable(),
      /** One entry per repo touched, with its stat (one repo is one entry, not a group header). */
      repos: z.array(
        z.object({
          repo: z.string(),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative()
        })
      ),
      /** The diff the Diff facet renders at its pins; null while unread. */
      diff: ChangeDiffSchema.nullable(),
      /** Check rows at `checksAt`'s commit (the statuses route); null while unread. */
      checks: z.array(ChangeCheckSchema).nullable(),
      /** The revision the checks were read at; null when no revision is recorded (the current commit). */
      checksAt: z.number().int().positive().nullable().optional(),
      /** Findings per revision (the findings route); null while unread. */
      findings: z.array(ChangeFindingSchema).nullable(),
      /** The analyzer runs the findings route states beside the findings; null while unread. */
      analyzers: z.array(ChangeAnalyzerRunSchema).nullable().optional(),
      /**
       * Verdicts (the change GET's `reviews[]`) and threads (the landing's
       * comments); null while unread (`unread.reviews` / `unread.threads` name
       * why), [] when read and empty.
       */
      reviews: z.array(ChangeVerdictSchema).nullable(),
      threads: z.array(ChangeThreadSchema).nullable(),
      /**
       * plue#488: the landing request's `review_requests[]` — who has been
       * asked to review. null while unread (`unread.reviewRequests` names
       * why), [] when the landing answered and nobody is asked.
       */
      reviewRequests: z.array(ChangeReviewRequestSchema).nullable().optional(),
      /** The change's per-file conflicts; null while unread (`unread.conflicts` names why). */
      conflicts: z.array(z.object({ path: z.string(), state: z.string() })).nullable(),
      /** The landing request carrying this change: its state, the change's stack position, the target, the gate's blocks. */
      stack: z.object({
        landingNumber: z.number().int(),
        state: z.string(),
        /** 1-based from the bottom, like `jj log`. */
        position: z.number().int().positive(),
        size: z.number().int().positive(),
        /** The request's change ids in request order; the last is the top, whose Land lands 1 → size. */
        changeIds: z.array(z.string()),
        targetBookmark: z.string(),
        conflictStatus: z.string(),
        /** Whether `position` is plue's own (`stack.position` on the change GET) or the request-order index the list implies. */
        positionFrom: z.enum(["server", "request-order"]).optional(),
        /** plue#452: how many changes from the bottom may land now; null when the list did not state it. */
        landablePrefix: z.number().int().nonnegative().nullable().optional(),
        /** plue#452: the gate's blocks for THIS change, in the gate's own fields. */
        blockedBy: z.array(LandingBlockSchema).optional(),
        /**
         * The stack's commits, bottom to top, when the opener knows them (the
         * tutorial's practice Change). `rebased` names a row that moved onto
         * the target: absent means it did not move, and no chip renders.
         */
        rows: z.array(z.object({
          changeId: z.string(),
          commitId: z.string(),
          message: z.string(),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
          rebased: z.object({ from: z.string(), to: z.string() }).optional()
        })).optional()
      }).nullable(),
      /** Whose turn it is on the landing request (plue#460); absent when the DTO carried none. */
      turn: ChangeTurnSchema.nullable().optional(),
      /** Path ownership (plue#467); absent when the DTO carried none. */
      owners: ChangeOwnersSchema.nullable().optional(),
      /** A landed change's provenance (plue#464); null until landed. */
      landed: ChangeLandedSchema.nullable().optional(),
      /** The walkthrough artifact for the current revision (plue#465); null when none exists or it was not read. */
      walkthrough: ChangeWalkthroughSchema.nullable().optional(),
      /** The changeset this change belongs to (live at /api/orgs/{org}/changesets); null when none. */
      changeset: ChangesetStateSchema.nullable(),
      /**
       * Why an auxiliary above is null: the failed read's reason in the
       * platform's words. One rule per read (ChangeSeam): a read writes the
       * auxiliaries it reads from their own answers, a failed one writes
       * null and names it here, and nothing from an earlier read survives in
       * those fields. The full read (`change.view`) covers every auxiliary;
       * a revision picker (`change.pins`, `change.checks`) covers only the
       * panel it moves and leaves the other auxiliaries — and their lines
       * here — as their own last read left them.
       */
      unread: z.object({
        diff: z.string().optional(),
        conflicts: z.string().optional(),
        checks: z.string().optional(),
        findings: z.string().optional(),
        reviews: z.string().optional(),
        threads: z.string().optional(),
        reviewRequests: z.string().optional(),
        stack: z.string().optional(),
        changeset: z.string().optional(),
        walkthrough: z.string().optional()
      }).optional(),
      /** Which body tab the card shows; the diff by default. */
      facet: ChangeFacetSchema.optional(),
      /** The last act's honest refusal, kept on the card. */
      error: z.string().optional()
    })
  }),
  /*
   * Lane change (ADR 0003 §1/§3): the `diff` card — one change's diff at two
   * pinned revisions (`parent ▾ → rev 5 ▾`; degraded: `parent → current`
   * only). The header carries the revision pin; when the change's current
   * revision moves past the pin and BOTH seqs are known, one mono line
   * `rev N exists · view` — never a claim a commit comparison cannot name.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("diff"),
    payload: z.object({
      repo: z.string(),
      changeId: z.string(),
      /** The pickers' tokens: "parent", "current", or "rev N" once revisions exist. */
      from: z.string(),
      to: z.string(),
      /** Where the `to` side pins: seq null until plue#450 records revisions. */
      pin: RevisionPinSchema,
      files: ChangeDiffSchema.shape.files,
      branchFiles: z.array(DiffCardSchema).optional(),
      branchDiffSource: z.string().optional(),
      branchDiffEntry: z.string().optional(),
      branchDiffRequest: z.string().optional(),
      branchDiffPending: z.boolean().optional(),
      /** The one file this card was cut at, when the flow named one. */
      path: z.string().optional(),
      error: z.string().optional()
    })
  }),
  /*
   * Lane L3b: the environment images a repository has built (ADR 0002 — the
   * environment is stated, never chosen). One row per closure: what kind of
   * sandbox it boots, the closure short, the image, its status, and whether
   * its first boot is a cold registry pull.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("environment-images"),
    payload: z.object({
      /** `org/repo` — the repository whose catalogue this is. */
      repo: z.string(),
      images: z.array(EnvironmentImageRowSchema)
    })
  }),
  /*
   * Lane citc: one workspace service's log (WORKBENCH-UX §3.1 Services
   * facet). The routes that would feed it do not exist yet (plue#449), so no
   * flow produces this card today — the schema lands with the workspace card
   * so the contract is one change, and the body renders what it is handed.
   */
  /*
   * The /theme picker: one swatch per palette, painted in that palette's own
   * colors. `selected` is the palette live when the card last synced; the
   * mainview owns the palette list, so the payload carries only the key.
   */
  /*
   * The local app's repository cards (apps/app/docs/LOCAL-APP.md "Cards"):
   * the opened repository, its trusted typed target list, and one streamed
   * target run.
   */
  /*
   * The target-graph cards (@smthrs/rpc/TargetGraph): the typed DAG with
   * plan facts and an optional live run overlay, one run's timeline with its
   * critical path, the run history with replay, the diff-affected set, and
   * the generated CI matrix.
   */
  /* The agents (the built-in roles and the loaded repository's agent flows) or a repository's cloud session inventory. */
  z.object({
    ...cardBaseShape,
    kind: z.literal("agents"),
    payload: z.union([
      z.object({
        /** False on the web host: no local harnesses, so nothing local is listed. */
        native: z.boolean(),
        install: z.boolean().optional(),
        canAssign: z.boolean().optional(),
        roleBindings: z.record(z.string(), z.unknown()).optional(),
        selectedAgent: z.string().optional(),
        selectedModel: z.string().optional(),
        testing: z.array(z.string()).optional(),
        testRequests: z.record(z.string(), z.object({ requestId: z.string(), model: ConfiguredModelSchema })).optional(),
        assignment: z.object({
          id: z.string(),
          role: z.string(),
          model: z.string(),
          state: z.enum(["requested", "failed"])
        }).optional(),
        agents: z.array(
          z.object({
            /** A built-in role id, or the flow id of a repository agent flow (`flows/<id>/flow.mdx` with a model). */
            id: z.string().min(1),
            label: z.string(),
            purpose: z.string(),
            /** The local harness a built-in role launches through; an agent flow runs on Smithers itself and names none. */
            harness: z.enum(HARNESS_IDS).optional(),
            /** The harness's display name from the table; the id when the table lacks it. */
            harnessName: z.string().optional(),
            model: AgentRoleModelSchema,
            source: z.enum(["owner", "repository", "builtin"]).optional(),
            binding: z.object({
              protocol: z.string(),
              modelId: z.string(),
              credential: z.string(),
              baseUrl: z.string().optional(),
              path: z.string().optional()
            }).nullable().optional(),
            instructions: z.string().optional(),
            runs: z.array(z.object({ id: z.string(), model: z.string() })).optional(),
            builtin: z.boolean(),
            /** Profile metadata (smithers-ui-DESIGN.md §3.3): whether it is a core role or a specialist. */
            kind: z.enum(["core", "specialist", "helper"]).optional(),
            available: z.boolean(),
            /** Why it cannot launch here (roleMenuEntries); empty when available. */
            reason: z.string(),
            /** The account the harness reports; empty when none. */
            account: z.string()
          })
        ),
        /** The last act's honest refusal, kept on the card. */
        error: z.string().optional()
      }),
      z.object({
        cloud: z.literal(true),
        repo: z.string(),
        sessions: z.array(z.object({
          id: z.string(),
          title: z.string(),
          status: z.string(),
          messageCount: z.number().int().nonnegative(),
          createdAt: z.string().nullable(),
          workspaceId: z.string().nullable()
        }))
      })
    ])
  }),
  /*
   * THE FORM LAW (apps/app/AGENTS.md;
   * repository flow forms): a flow invoked without its
   * required input renders this card for the missing fields. The fields derive
   * from the flow's input schema; the draft IS the payload (a field commit is
   * a card-payload update, never component state); `given` is what the slash
   * line already carried; an option the human cannot pick carries its reason.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("flow-form"),
    payload: z.object({
      flow: z.string(),
      /** Who invoked the flow the form continues: the submit runs it as that actor, so an agent's ask still confirms. */
      via: z.enum(["user", "agent"]),
      fields: z.array(
        z.object({
          name: z.string(),
          label: z.string(),
          kind: z.enum(["text", "textarea", "number", "boolean", "select", "write-only"]),
          disabledReason: z.string().optional(),
          required: z.boolean(),
          placeholder: z.string().optional(),
          options: z.array(
            z.object({
              value: z.string(),
              label: z.string(),
              disabled: z.boolean().optional(),
              reason: z.string().optional(),
              flow: z.literal("model.credential.new").optional()
            })
          ).optional(),
          optionsFrom: z.enum(FORM_OPTION_PROVIDERS).optional()
        })
      ),
      draft: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      given: z.record(z.string(), z.unknown()),
      /** A Review PR request held while its explicitly opened box becomes selectable. */
      afterBox: z.object({
        kind: z.literal("prs.triage"),
        repo: z.string(),
        number: z.number().int().positive(),
        owner: z.string(),
        workspaceId: z.string().optional(),
        consumed: z.boolean().optional()
      }).optional(),
      /** A submission holds the form until its invocation settles. */
      submitting: z.boolean().optional(),
      submitLabel: z.string().optional(),
      /** A nested input uses the same form editor and submits under this named property. */
      payloadField: z.string().optional(),
      inputSchema: z.unknown().optional(),
      /** The last submit's honest refusal, kept on the card. */
      error: z.string().optional(),
      /**
       * Where `error` came from when it is not the form's own sentence about
       * the input: `read` (a choice list could not be read) or `run` (the
       * flow refused or failed). Such an error is raw detail, never shown as
       * the sentence. Absent: `error` is the form's own sentence.
       */
      errorKind: z.enum(["read", "run"]).optional()
    })
  }).superRefine(({ payload }, context) => {
    const given = payload.payloadField === undefined ? payload.given : payload.given[payload.payloadField]
    for (const field of payload.fields) {
      if (
        field.kind === "write-only" && (field.name in payload.draft ||
          (given !== null && typeof given === "object" && field.name in given))
      ) {
        context.addIssue({ code: "custom", message: "Write-only values cannot be persisted" })
      }
    }
  }),

  /*
   * The anonymous turn ceiling's refusal (factory mock 22): a signed-out
   * visitor's turn the Worker refused with 429 turn_rate_limited. `message`
   * is the server's own sentence (per-address or deployment-wide wording),
   * `retryAt` its ISO reset time or null when the body named none. The card
   * renders only these two fields plus the sign-in door; no count or reset is
   * invented client-side.
   */
  /*
   * The palette's results card (palette spec §3, §6): the rows one `search.*`
   * flow answered, re-runnable from `flow` and `args`, each row carrying the
   * registered flows that act on it. The agent embeds one when it surfaces
   * what it found; a `text:` search embeds one grouped by file.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("search-results"),
    payload: z.object({
      query: z.string(),
      flow: z.string(),
      args: z.string().optional(),
      items: z.array(SearchItemSchema)
    })
  }),
  /*
   * The Wiki's link rail as a card (Librarian L5): who links to one note and
   * where it links out, each row a `wiki.open` door, plus the `[[targets]]`
   * no note answers. Embedded for the agent and the slash alike: a read.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("wiki-links"),
    payload: z.object({
      path: z.string(),
      title: z.string(),
      backlinks: z.array(z.object({ path: z.string(), title: z.string() })),
      linksOut: z.array(z.object({ path: z.string(), title: z.string() })),
      unresolved: z.array(z.string())
    })
  }),
  /*
   * The Wiki's knowledge graph as a card: every note a node, every wikilink
   * an edge, a dangling target a `missing` node. `path` names the note the
   * graph is focused on (one hop around it), or null for the whole Wiki.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("wiki-graph"),
    payload: z.object({
      path: z.string().nullable(),
      notes: z.array(
        z.object({
          path: z.string(),
          title: z.string(),
          linksOut: z.array(z.string()),
          backlinks: z.array(z.string()),
          missing: z.boolean()
        })
      ),
      links: z.array(z.object({ source: z.string(), target: z.string() }))
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("anonymous-ceiling"),
    payload: z.object({
      message: z.string(),
      retryAt: z.string().nullable()
    })
  }),
  z.object({ ...cardBaseShape, kind: z.literal("debug-api"), payload: z.object({}) }),
  /*
   * An in-app docs page (M-35), read only: the page's slug and the Markdown
   * the build shipped for it. The card's title is the page's title. Embedded
   * for the agent and the slash alike; a link to another page runs `docs`.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("docs"),
    payload: z.object({
      page: z.string(),
      markdown: z.string(),
      summary: z.string().optional(),
      toc: z.array(z.object({ slug: z.string(), title: z.string() })).optional(),
      anchor: z.string().optional(),
      not_found: z.string().optional()
    })
  })
])
/** Removed stored kinds consumed by CardSchema and renderer registration coverage.
 * @since 1.0.0
 * @category constants
 */
export const LEGACY_CARD_KINDS = [
  "workspace",
  "commit",
  "commit-list",
  "branches",
  "workflow-repo",
  "provider-accounts",
  "repo-import",
  "connector-setup",
  "env",
  "account",
  "explain",
  "repository-setup",
  "agent",
  "admin-health",
  "notifications",
  "registration",
  "connect",
  "plugin-library",
  "theme-picker",
  "models",
  "model-call",
  "service-log",
  "repo",
  "targets",
  "target-run",
  "graph",
  "run-timeline",
  "run-history",
  "affected",
  "ci-matrix",
  "grant-confirm",
  "factory",
  "repo-onboarding",
  "repo-home",
  "agent-models",
  "agent-form",
  "history",
  "experimental",
  "request-queue"
] as const
const retiredKinds = new Set<string>(LEGACY_CARD_KINDS)

const retiredFlows = new Set<string>([
  "commits.list",
  "commits.read",
  "flow.repo.choose",
  "chat.clear",
  "tab.card",
  "tab.close",
  "tab.select",
  "world",
  "world.delete",
  "world.delete.cancel",
  "world.delete.confirm",
  "world.new-note",
  "world.select",
  "subagents",
  "flows",
  "connect",
  "smithers.who",
  "workspace.rename",
  "workspace.rename.edit",
  "app.first-run.dismiss",
  "notifications.read-update",
  "notifications.tag",
  "search.targets",
  "search.boxes",
  "box.select",
  "files.add",
  "change.request",
  "change.split",
  "change.revert",
  "prs.create",
  "issues",
  "issues.fix",
  "issues.verify",
  "issues.set",
  "issues.comment.react",
  "issues.comment.retry",
  "wiki.ask",
  "runs.takeover",
  "runs.release",
  "runs.handoff",
  "runs.burndown.filter",
  "runs.burndown.select",
  "agent.session.list",
  "agent.session.new",
  "agent.session.say",
  "agent.session.stop",
  "agent.session.view",
  "notifications.list",
  "notifications.read",
  "admin.grant",
  "admin.grant.confirm",
  "admin.grant.cancel",
  "admin.health",
  "repository.register",
  "signup.account",
  "signup.finish",
  "signup.next",
  "signup.repo",
  "signup.set",
  "setup.ask",
  "setup.configure",
  "setup.discard",
  "setup.discard.confirm",
  "setup.guide",
  "setup.retry",
  "setup.run",
  "setup.view",
  "setup.work",
  "issues.setup",
  "review.setup",
  "ci.setup",
  "feature.setup",
  "chores.setup",
  "feature.prototype",
  "system.recommend",
  "issue-sweep",
  "integrations.admit",
  "integrations.list",
  "issues.sync.resolve",
  /* The experimental mocks' switch and prop setter left with the mocks. */
  "app.experimental",
  "experimental.set",
  /* Renamed to box.* (#2147): a form saved under the old name retires rather than naming a flow that no longer exists. */
  "workspace.delete",
  "workspace.desktop",
  "workspace.desktop.open",
  "workspace.desktop.rotate",
  "workspace.desktop.stop",
  "workspace.egress",
  "workspace.facet",
  "workspace.file",
  "workspace.files",
  "workspace.images",
  "workspace.list",
  "workspace.open",
  "workspace.resume",
  "workspace.services",
  "workspace.session.destroy",
  "workspace.sessions",
  "workspace.suspend",
  "workspace.terminal",
  "workspace.view",
  "repo.welcome",
  "repo.explore",
  "repo.contribute",
  "repo.maintain",
  "repo.home",
  "factory.show",
  "workspace.fork",
  "workspace.snapshot",
  "workspace.snapshot.delete",
  "workspace.snapshot.fork",
  "workspace.template",
  "change.open-computer",
  "agent.create",
  "agent.edit",
  "agent.models",
  "agent.new",
  "agent.remove",
  "issues.link-linear",
  "issues.unlink-linear",
  "sync.retry",
  "sync.ops.load-older",
  /* One history view (D-20): the stack flows joined `history.*`; amend and fold were refusal-only. */
  "stack.show",
  "stack.backfill",
  "stack.parallel",
  "stack.retry",
  "history.amend",
  "history.fold",
  /* The closed-alpha gate retired (#2145): signup is public, so its request and allowlist doors are gone. */
  "auth.request-access",
  "admin.allowlist.add",
  "admin.allowlist.remove",
  "admin.requests",
  "admin.queue.approve"
])
/**
 * The kinds {@link CardSchema} decodes, named so a schema that embeds a card can be declared without inlining the union.
 *
 * @since 1.0.0
 * @category models
 */
export type CardSchemaOptions = typeof CurrentCardSchema.options
/**
 * One persisted card, decoded by kind. Explicitly legacy kinds become titled
 * tombstones; unknown kinds and malformed current kinds fail decoding.
 *
 * @since 1.0.0
 * @category schemas
 */
export const CardSchema: z.ZodType<z.infer<typeof CurrentCardSchema>, unknown> & {
  readonly options: CardSchemaOptions
} = Object.assign(
  z.preprocess((value: unknown) => {
    if (typeof value !== "object" || value === null) return value
    const row = value as Record<string, unknown>
    const payload = row.payload as Record<string, unknown> | undefined
    // Shared live Secrets models and old pinned metadata decode through one card kind.
    if (
      row.kind === "secrets" && payload && Array.isArray(payload.secrets) &&
      (payload.scope !== "repository" ||
        payload.secrets.some((secret) => typeof secret === "object" && secret !== null && "scope" in secret))
    ) {
      const live = SecretsCardSchema.safeParse(payload)
      if (live.success) {
        return {
          ...row,
          payload: {
            repo: typeof payload.repo === "string" ? payload.repo : "",
            scope: "repository",
            secrets: live.data.secrets.map((secret) => ({
              name: secret.name,
              mainOnly: secret.scope === "main_only",
              hosts: secret.hosts ?? [],
              matchHeaders: [],
              updatedAt: null
            }))
          }
        }
      }
    }
    if (
      typeof row.kind === "string" && (retiredKinds.has(row.kind) ||
        (row.kind === "agents" && payload?.cloud === true) ||
        ((row.kind === "issue" || row.kind === "issue-list") && (payload?.source === "linear" ||
          (Array.isArray(payload?.issues) &&
            payload.issues.some((issue: unknown) =>
              typeof issue === "object" && issue !== null && (issue as Record<string, unknown>).source === "linear"
            )))) ||
        (row.kind === "flow-form" && typeof payload?.flow === "string" && retiredFlows.has(payload.flow)))
    ) {
      const { body: _body, ...base } = row
      return {
        ...base,
        kind: "retired",
        loading: false,
        status: "acted",
        payload: { was: row.kind }
      }
    }
    if (row.kind === "retired") {
      const { body: _body, ...base } = row
      return base
    }
    if (row.kind === "agents" && Array.isArray(payload?.agents)) {
      return {
        ...row,
        payload: {
          ...payload,
          agents: payload.agents.flatMap((entry: unknown) => {
            if (typeof entry !== "object" || entry === null) return []
            const saved = entry as Record<string, unknown>
            const role = AGENT_ROLES.find((candidate) => candidate.id === saved.id)
            // A built-in row reads its facts from the table; a configured
            // profile the table does not know (smithers-ui-DESIGN.md §3.3)
            // keeps its own, and the schema below still validates it.
            return role === undefined ?
              [saved] :
              [{
                ...saved,
                id: role.id,
                label: role.label,
                purpose: role.purpose,
                harness: role.harness,
                model: role.model,
                builtin: true
              }]
          })
        }
      }
    }

    if (row.kind === "repository-choice" && typeof payload?.created === "object" && payload.created !== null) {
      const created = payload.created as Record<string, unknown>
      if (typeof created.fullName !== "string" && typeof created.name === "string") {
        return { ...row, payload: { ...payload, created: { fullName: created.name } } }
      }
    }
    return value
  }, CurrentCardSchema),
  { options: CurrentCardSchema.options }
)

/**
 * The decoded value accepted by {@link CardSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Card = z.infer<typeof CardSchema>

type ShallowPatch<T> = { [K in keyof T]?: T[K] | undefined }
type PatchFor<C extends Card> = C extends Card
  ? Pick<C, "kind"> & ShallowPatch<Pick<C, "title" | "body" | "status" | "createdAt" | "ordinal">> & {
    payload?: ShallowPatch<C["payload"]> | undefined
  }
  : never

/*
 * A patch field is optional WITHOUT its default. zod's `.partial()` keeps
 * `.default()`, so an omitted field would decode to the default and the
 * consumer's shallow merge would overwrite the stored value with it.
 */
const withoutDefault = (field: z.ZodType): z.ZodType => {
  if (field instanceof z.ZodDefault || field instanceof z.ZodPrefault) {
    return withoutDefault(field.unwrap() as z.ZodType)
  }
  if (field instanceof z.ZodOptional) return withoutDefault(field.unwrap() as z.ZodType)
  return field
}

const patchPayload = (payload: z.ZodType): z.ZodType =>
  payload instanceof z.ZodObject ?
    z.object(
      Object.fromEntries(
        Object.entries(payload.shape as Record<string, z.ZodType>).map(([key, field]) => [
          key,
          withoutDefault(field).optional()
        ])
      )
    ) :
    payload

// Derive each branch from the card itself so enums, caps and redaction cannot drift.
const cardPatchOptions = CurrentCardSchema.options.map((card) => {
  const payload = card.shape.payload
  return z.object({
    kind: card.shape.kind,
    title: cardBaseShape.title.optional(),
    body: cardBaseShape.body,
    status: cardBaseShape.status.optional(),
    createdAt: cardBaseShape.createdAt.optional(),
    ordinal: cardBaseShape.ordinal.optional(),
    payload: patchPayload(payload).optional()
  })
})

/**
 * Validates kind-specific, shallow payload patches at the RPC boundary.
 * Consumers must match the existing kind and validate the merged card.
 *
 * @since 1.0.0
 * @category schemas
 */
export const CardPatchSchema: z.ZodType<PatchFor<Card>> = z.discriminatedUnion(
  "kind",
  cardPatchOptions as [typeof cardPatchOptions[number], ...Array<typeof cardPatchOptions[number]>]
) as z.ZodType<PatchFor<Card>>

/**
 * The decoded value accepted by {@link CardPatchSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CardPatch = z.infer<typeof CardPatchSchema>
