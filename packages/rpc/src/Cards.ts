/**
 * Cards rendered from agent, code-intelligence, and repository events.
 *
 * @since 1.0.0
 */
import { z } from "zod"
import { AGENT_ROLES, AgentRoleIdSchema, AgentRoleModelSchema } from "./AgentRoles.ts"
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
import { ModelCallCardPayloadSchema, ModelsCardPayloadSchema } from "./ConfiguredModel.ts"
import { FactoryRuleSchema } from "./FactoryProjection.ts"
import { GatewayWorkspaceIdSchema } from "./GatewayWorkspace.ts"
import { StatusRollupSchema } from "./Health.ts"
import { HARNESS_IDS, RepoSchema, TargetSchema } from "./LocalApp.ts"
import { LSP_DIAGNOSTICS_CAP, LspDiagnosticSchema, LspHoverSchema } from "./LocalLsp.ts"
import { PLUE_FAULTS } from "./PlueFailureCodes.ts"
import { REFUSAL_ORIGINS } from "./Refusal.ts"
import { RepositoryHomeSchema } from "./RepositoryHome.ts"
import { RepositorySetupSchema } from "./RepositorySetup.ts"
import {
  AffectedCardPayloadSchema,
  CiMatrixCardPayloadSchema,
  GraphCardPayloadSchema,
  GraphNodeSchema,
  NodeTimingSchema,
  RunHistoryCardPayloadSchema,
  RunRecordSchema,
  RunSummarySchema,
  RunTimelineCardPayloadSchema
} from "./TargetGraph.ts"
import { IntegrationRowSchema, TaskMetaSchema } from "./Threads.ts"

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
  "open-repos",
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
  streamUrl: z.string().nullable(),
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
  url: z.string().nullable().optional()
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
 * `desktop_not_ready` or `guest_not_ready` is the one the facet retries on
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

/** A commit's author or committer as the source stated them; login and avatar only when derivable. */
const CommitPersonSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  login: z.string().optional(),
  avatarUrl: z.string().optional()
})

/** One commit row: the commits list's row and the commit card's head. */
const CommitSummarySchema = z.object({
  commitId: z.string(),
  /** The jj change id; null when the source is plain git. */
  changeId: z.string().nullable(),
  /** The description's first line. */
  title: z.string(),
  author: CommitPersonSchema,
  /** ISO time the author wrote it; null when the source did not say. */
  authoredAt: z.string().nullable(),
  /** The combined commit status (newest per context) when it was read. */
  status: z.enum(["success", "failure", "pending"]).optional(),
  /** Signature verification, only when the source reported it. */
  verified: z.boolean().optional()
})

/**
 * One plan node as a card carries it: the flow-plan card's row, and the
 * snapshot a launch writes onto the run it started.
 *
 * Only the part a graph draws is kept. A plan node's full key material carries
 * the call's own payload and its JSON schemas, and everything in a card
 * payload is written to disk by the persistence backend, so the card holds the
 * node's address, its key, its edges, its tier and the action it dispatches,
 * and nothing else.
 */
const PlanCardNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(["step", "agent", "merge"]),
  key: z.string(),
  dependsOn: z.array(z.string()),
  /** The key material's own tier: what the node may do to the world. */
  tier: z.enum(["sealed", "compensable", "irreversible"]),
  /** The action or flow the node dispatches; a merge node dispatches neither. */
  action: z.string().optional(),
  status: z.enum(["cached", "run"])
})

/**
 * The graph a plan was built from, as a card carries it: the labelled edges,
 * and where the graph builder saw each node declared.
 *
 * A `PlanCardNode` carries `dependsOn`, which is ONE unlabelled edge set: it
 * cannot tell a value dependency from a `catch` arm or from an ordering edge
 * a write conflict added, and the declaration site is deliberately not part
 * of the key material a node is addressed by. Both are the workspace's own
 * observations, so both ride here, and a host that reported neither leaves
 * this absent rather than making its reader guess them back.
 *
 * The plan door's card and the snapshot a launch writes onto the run it
 * started carry the same shape, because it is the same answer.
 */
const PlanCardGraphSchema = z.object({
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      reason: z.enum(["value", "continuation", "failure", "conflict", "lane-merge"])
    })
  ),
  nodes: z.array(
    z.object({
      id: z.string(),
      declaredAt: z.object({ path: z.string(), line: z.number().int().nonnegative() }).optional()
    })
  ).optional(),
  /**
   * The revision of the tree those declaration sites were read out of.
   *
   * A site is a path and a line, and neither says which bytes were at that
   * line: the workspace moves, so the same path after an edit or a branch
   * switch is a different file. The drawer's Code tab reads the file AT this
   * revision, and a card that carries none shows no code at all rather than
   * code it cannot bind to what ran (D-068).
   */
  sourceRevision: z.string().min(1).optional()
})

/**
 * Which of a selected node's tabs a graph card is showing.
 *
 * Each word names evidence the engine actually records, and a tab whose
 * evidence this node has none of is absent rather than empty (D-035). The
 * enum is the vocabulary, never a promise that every node has all of it.
 */
const GraphDrawerTabSchema = z.enum(["declaration", "code", "output", "events", "attempts"])

/**
 * Which node of a graph a card has open, and which of its tabs.
 *
 * Reader state lives on the card like every other view state, so a reload
 * restores the drawer a person left open and no component owns it.
 */
const GraphDrawerSchema = z.object({
  node: z.string().optional(),
  tab: GraphDrawerTabSchema.optional(),
  /*
   * A refused read of the file a node was declared in: the path it was for
   * and the refusal in the seam's own words. The Code tab renders the file
   * card the read writes, so a read that wrote none has to say so somewhere
   * a reader can see it, and the card is that place. Absent is the normal
   * case, including "not read yet".
   */
  codeError: z.object({ path: z.string(), message: z.string() }).optional()
})

/**
 * Validates card values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
const CurrentCardSchema = z.discriminatedUnion("kind", [
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
  z.object({ ...cardBaseShape, kind: z.literal("repository-setup"), payload: RepositorySetupSchema }),
  // Identity-only tombstones keep historical frames and journals loadable.
  z.object({ ...cardBaseShape, kind: z.literal("retired"), payload: z.object({}) }),
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
  /* The tutorial's ranked repository chooser and its shared-backend creation receipt. */
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
  /* The Library as an embedded card: the agent's browse door onto the same shelf. */
  z.object({
    ...cardBaseShape,
    kind: z.literal("plugin-library"),
    payload: z.object({ tutorial: z.boolean() })
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
      /** The one-time first-run grant ("You have $500 of usage on us."), when unspent. */
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
  z.object({
    ...cardBaseShape,
    kind: z.literal("grant-confirm"),
    payload: z.object({
      login: z.string(),
      amountUsd: z.number().positive(),
      phase: z.enum(["confirm", "sending", "granted", "failed"]),
      grantId: z.string().optional(),
      error: z.string().optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("request-queue"),
    payload: z.object({
      requests: z.array(
        z.object({
          login: z.string(),
          note: z.string().nullable(),
          createdAt: z.string()
        })
      ),
      /** The login an allowlist-add is in flight for (one at a time). */
      approving: z.string().nullable(),
      error: z.string().optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("admin-health"),
    payload: z.object({
      services: z.array(
        z.object({
          name: z.string(),
          status: z.enum(["ok", "failed", "unconfigured"]),
          detail: z.string()
        })
      ),
      queueDepth: z.number().int().nonnegative().nullable(),
      charges: z
        .object({
          chargeCount: z.number().int().nonnegative(),
          lifetimeChargedUsd: z.string()
        })
        .nullable(),
      checkedAt: z.string()
    })
  }),
  /* The connect surface as an embedded chat card (the agent's connect form; §2c″). */
  z.object({
    ...cardBaseShape,
    kind: z.literal("connect"),
    payload: z.object({
      /** Authentication evidence; legacy cards do not establish a GitHub connection. */
      provider: z.enum(["github", "local"]).optional(),
      github: z.object({ connected: z.boolean(), login: z.string().nullable() }),
      nativeAvailable: z.boolean(),
      /** The services that sync with conversations, issues and the wiki (smithers-ui-DESIGN.md §3.6), read by integrations.list. */
      integrations: z.object({ repo: z.string(), rows: z.array(IntegrationRowSchema) }).optional()
    })
  }),
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
          cloud: z.object({ repo: z.string(), slug: z.string(), revision: z.number().int().positive() }).optional()
        })
      ),
      selectedDocumentId: z.string().optional(),
      view: z.enum(["outline", "document"]).optional(),
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
      repo: z.string(),
      space: z.enum(["public", "private"]),
      pageId: z.number().int().positive(),
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
    payload: z.object({
      url: z.string(),
      finalUrl: z.string().nullable(),
      status: z.number().int().nullable(),
      frameable: z.boolean(),
      blockReason: z.string().nullable(),
      error: z.string().optional()
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
    payload: z.object({
      statusRollup: StatusRollupSchema.optional(),
      repo: z.string(),
      /** Owning Plue gateway binding; omission identifies a legacy unbound run. */
      workspaceId: GatewayWorkspaceIdSchema.optional(),
      /** Version 1 records an explicit legacy route when workspaceId is absent. */
      gatewayBindingVersion: z.literal(1).optional(),
      runId: z.string(),
      workflow: z.string(),
      phase: z.enum([
        "launching",
        "running",
        "waiting-approval",
        "reconnecting",
        /*
         * Wave 12 §3 — the bounded client stance. A run the workspace never
         * finishes goes QUIET rather than being polled forever: after a
         * generous stale bound with no event progress the card says so
         * plainly and offers stop/retry. Honest, not silent, and not a
         * pump hammering a workspace that has stopped answering.
         */
        "quiet",
        /*
         * The human stopped WATCHING and the workspace refused the
         * gateway's Cancel, so "cancelled" would be a claim about the
         * workspace that nothing proves — the honest state is the one
         * about this client.
         */
        "stopped",
        "completed",
        "failed",
        "cancelled",
        "no-capacity"
      ]),
      steps: z.array(z.string()),
      result: z.string().nullable(),
      error: z.string().optional(),
      /** Failure to observe evidence; never replaces the run’s recorded diagnosis. */
      observationError: z.string().optional(),
      /**
       * Legacy field name, kept so persisted cards parse: the summary
       * projection's `updatedAt` (when the card last heard from the run),
       * not an event cursor — the pump re-reads the projections in full.
       */
      lastSeq: z.number().int().nonnegative(),
      /** How long the run had gone without progress when it went quiet. */
      quietForMs: z.number().int().nonnegative().optional(),
      /*
       * Lane runs — the run lifecycle the card surfaces. All optional so
       * cards persisted before the lane parse.
       */
      /** The launch input, so `runs.rerun` relaunches the same flow with the same arguments. */
      input: z.record(z.string(), z.unknown()).optional(),
      /**
       * The run's kind (factory spec 06 §3): "prototype" for a run
       * `feature.prototype` started, "implement" for an Implement run.
       * Prototype is a run kind, never a card kind: it selects the
       * never-promoted banner, drops the Steer row and narrows the filters.
       * Absent for every other run.
       */
      kind: z.string().optional(),
      /** Why a live run is not moving, in the control plane's word ("approval", "timer", "executor" when accepted). */
      waiting: z.string().optional(),
      /** Whether an operator steer is queued for the run. */
      steeringPending: z.boolean().optional(),
      /** Which secondary tab the card shows under the trace; the steps tail by default. */
      facet: z.enum(["steps", "transcript", "events"]).optional(),
      /** A remote facet read, pinned to its original card, account and gateway. */
      facetRequest: z.object({
        id: z.string(),
        owner: z.string(),
        repo: z.string(),
        runId: z.string(),
        workspaceId: z.string().optional(),
        facet: z.enum(["transcript", "events"]),
        state: z.enum(["pending", "complete", "failed"]),
        follow: z.boolean().optional(),
        toggleFollow: z.boolean().optional(),
        error: z.string().optional()
      }).optional(),
      /** Whether the transcript keeps following the live run. */
      follow: z.boolean().optional(),
      /** The transcript tab's rows, merged from the transcript projection while the card follows. */
      transcriptAtRevision: z.number().int().nonnegative().optional(),
      transcriptRows: z
        .array(
          z.object({
            sequence: z.number(),
            turn: z.number().optional(),
            at: z.number().optional(),
            kind: z.string(),
            text: z.string()
          })
        )
        .optional(),
      /**
       * The run's journal: its control events in journal order, as the
       * `run-events` projection serves them. The trace folds from these
       * (RunTrace.ts) and the verbose events tab lists them raw.
       */
      events: z.array(z.record(z.string(), z.unknown())).optional(),
      /** The selected trace node (a span id from the fold); absent selects the newest frame while live tail holds, else the run. */
      selection: z.string().optional(),
      /** The scrub cursor, a journal sequence: the trace renders the journal up to it. Absent renders the whole journal. */
      cursorSeq: z.number().int().nonnegative().optional(),
      /** The tree's active filter (factory spec 06 §2, §3); `all` when absent. */
      filter: z.enum(["all", "running", "failed", "model", "flow", "forks", "messages"]).optional(),
      /** Whether the trace follows the newest frame (factory spec 06 §2); true when absent. A select turns it off. */
      liveTail: z.boolean().optional(),
      /**
       * Progressive inspection uses one card: a cheap turn list by default,
       * the full timeline or the run's graph on demand.
       */
      traceView: z.enum(["turns", "timeline", "graph", "steps"]).optional(),
      /**
       * The plan the launch was approved on, snapshotted when the run started.
       *
       * The graph view draws these nodes and folds the engine's own node
       * records onto them (FlowGraphStatus.ts). It is absent for a run this
       * client did not launch, and the graph then draws the nodes the engine
       * recorded instead.
       */
      plan: z.object({
        planId: z.string(),
        digest: z.string(),
        nodes: z.array(PlanCardNodeSchema),
        /**
         * The labelled edges and declaration sites the same answer carried.
         * Without them a graph drawn before the first event has only
         * `dependsOn`, and an unlabelled edge is what it draws.
         */
        graph: PlanCardGraphSchema.optional()
      }).optional(),
      /**
       * The graph view's own reader state: `follow` keeps the camera on the
       * running node, and `node` with `tab` is the drawer a reader opened.
       */
      graph: z.object({ follow: z.boolean().optional(), ...GraphDrawerSchema.shape }).optional(),
      /** The predicted Change inspected within the recorded coding plan. */
      codingChangeId: z.string().optional(),
      /** Local launch intent, retained until the authoring run's real receipt arrives. */
      authoring: z.object({
        requestId: z.string(),
        owner: z.string(),
        launchError: z.string().optional()
      }).optional()
    })
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
   * Wave 12 §2 — which loaded repository. With more than one loaded repo and
   * no `owner/repo` argument, the target is a genuine user choice (the
   * ≤3-questions law permits it), so it is asked as an embedded card among the
   * loaded set — never guessed, never a takeover. One act answers it.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("workflow-repo"),
    payload: z.object({
      /** The pending intent this choice completes. */
      intent: z.literal("create"),
      description: z.string(),
      repos: z.array(z.string()),
      chosen: z.string().nullable()
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
          htmlUrl: z.string().optional(),
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
          authorAvatar: z.string().optional()
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
      source: z.enum(["smithers-cloud", "github"]).optional(),
      htmlUrl: z.string().optional(),
      conversation: z.object({ branchId: z.string(), owner: z.string(), creationKey: z.string() }).optional(),
      commentDraft: z.string().optional(),
      pendingComments: z.array(z.object({
        id: z.string(),
        text: z.string(),
        actor: z.enum(["user", "smithers"]),
        owner: z.string().optional(),
        turnId: z.string().optional(),
        persona: z.object({ username: z.string(), iconEmoji: z.string().optional(), iconUrl: z.string().optional() })
          .optional(),
        status: z.enum(["requested", "failed", "unknown"]),
        error: z.string().optional()
      })).optional(),
      sync: z.object({
        provider: z.enum(["slack", "telegram"]),
        deliveryId: z.number().optional(),
        resolutionToken: z.string().optional(),
        resolution: z.object({
          deliveryId: z.number(),
          expectedToken: z.string(),
          action: z.enum(["sent", "skip", "retry"]),
          evidence: z.string(),
          messageId: z.string(),
          owner: z.string(),
          status: z.enum(["requested", "failed"]),
          error: z.string().optional()
        }).optional(),
        connectionId: z.string(),
        scopeId: z.string(),
        conversationId: z.string(),
        threadId: z.string().optional(),
        externalUserId: z.string().optional(),
        state: z.enum(["synced", "pending", "dispatching", "outcome_unknown", "failed", "unsupported"]).optional(),
        error: z.string().nullable().optional()
      }).optional(),
      labels: z.array(z.string()),
      /*
       * Lane sync (ADR 0005 "Link an issue to Linear"): the Linear mapping
       * when the issue DTO carries one (`Linear ENG-482`); absent until
       * plue#473, and absent-vs-null is not distinguished — no mapping line
       * renders without the DTO field. Optional so older cards parse.
       */
      comments: z.array(
        z.object({
          author: z.string().nullable(),
          id: z.number().int().optional(),
          idempotencyKey: z.string().optional(),
          reactions: z.array(z.object({ name: z.string(), actor: z.string(), active: z.boolean() })).optional(),
          persona: z.object({ username: z.string(), iconEmoji: z.string().optional(), iconUrl: z.string().optional() })
            .optional(),
          commentBody: z.string(),
          createdAt: z.string().nullable(),
          authorAvatar: z.string().optional()
        })
      ),
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
  z.object({
    ...cardBaseShape,
    kind: z.literal("notifications"),
    payload: z.object({
      unread: z.number().int().nonnegative(),
      items: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          repo: z.string().nullable(),
          reason: z.string().nullable(),
          createdAt: z.string().nullable(),
          read: z.boolean()
        })
      )
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("env"),
    payload: z.object({
      repo: z.string(),
      /**
       * Display-only values: decoding keeps at most three leading characters
       * and replaces the rest with an ellipsis. Short values are fully masked.
       * Raw values must be re-read upstream; never persist them in a card.
       */
      vars: z.array(z.object({
        name: z.string(),
        value: z.string().transform((value) => value.length > 3 ? `${value.slice(0, 3)}…` : "…")
      })),
      setupScript: z.string().nullable(),
      /** The environment held a subscription token the platform refuses; it is redacted and unused. */
      reconnect: z.boolean().optional()
    })
  }),
  /*
   * The secrets a repository's sessions may use (Secrets L1): the agent
   * environment's secret METADATA only. plue's AgentEnvironmentSecretMetadata
   * has no value field; hosts and match_headers are the egress-proxy binding,
   * empty on both for a setup-only secret. `scope` names whose secrets the
   * card lists; personal secrets add a second scope in a later lane.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("secrets"),
    payload: z.object({
      repo: z.string(),
      scope: z.literal("repository"),
      secrets: z.array(
        z.object({
          name: z.string(),
          hosts: z.array(z.string()),
          matchHeaders: z.array(z.string()),
          updatedAt: z.string().nullable(),
          /** The secret held a subscription token the platform refuses; it is unused until replaced or removed. */
          reconnect: z.boolean().optional()
        })
      )
    })
  }),
  /*
   * The account's coding-provider pool (GET /api/user/provider-connections):
   * non-revoked connections in pool order, metadata only. `limitedUntil` is
   * the RFC3339 time a usage limit parks the account until; `pending` is a
   * Codex device sign-in awaiting the person (its code and where to enter it).
   * `unavailable` marks a deployment that does not offer coding accounts
   * (plue's feature-gated 403; hosted smithers.sh stores no subscription
   * logins): the card shows no connect buttons.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("provider-accounts"),
    payload: z.object({
      accounts: z.array(z.object({
        id: z.string(),
        provider: z.enum(["claude", "codex"]),
        label: z.string(),
        email: z.string().nullable(),
        state: z.string(),
        limitedUntil: z.string().nullable()
      })),
      pending: z.object({ userCode: z.string(), verificationUri: z.string() }).optional(),
      unavailable: z.literal(true).optional()
    })
  }),
  /*
   * The configured models and the seats they answer for (ConfiguredModel.ts).
   * A credential is a NAME with its presence and origins; no value exists on
   * this payload, and a test's failure is codes and numbers, never a
   * provider's words.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("models"),
    payload: ModelsCardPayloadSchema
  }),
  /*
   * The composer for one configured model (ConfiguredModel.ts): the request a
   * person edits, the typed answer it got, and whether one is out. The
   * request is fields and questions, the answer is numbers and option names
   * or the generated text, and no value exists on this payload.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("model-call"),
    payload: ModelCallCardPayloadSchema
  }),
  /*
   * The repository's mythical stack (@smthrs/rpc/Mythical, epic #1745). The
   * snapshot itself is live server state the stack seam keeps in memory and
   * never journals; the card holds what the person asked for: `failure` is
   * the last failed act, visible with its retry until one succeeds, and
   * `bootstrap` is the durable creation request whose notice runs until the
   * stack reads active, across reloads.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("stack"),
    payload: z.object({
      repo: z.string(),
      failure: z.object({
        act: z.enum(["bootstrap", "backfill", "parallel", "retry"]),
        message: z.string(),
        args: z.string()
      }).nullable(),
      bootstrap: z.object({ requestedAt: z.number() }).optional()
    })
  }),
  /*
   * The account card (factory mock 21, design session §6c): who is signed in
   * and what the identity seam knows about them. Every row is a seam fact:
   * the GitHub login, the scopes the identity worker states (GET
   * /api/auth/scopes), the allowlist answer, and the boxes the workspaces
   * seam has listed across repositories. Billing and usage rows live on the
   * balance card, which the billing seam answers; seat rows stay absent
   * because no seam holds them — a row with no seam is absent, never
   * invented.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("account"),
    payload: z.object({
      login: z.string(),
      /** Absent on legacy cards, which cannot prove a provider or OAuth grant. */
      provider: z.enum(["github", "local"]).optional(),
      /** GET /api/auth/scopes rows, one plain sentence per scope; empty when the seam did not answer, and the section is then absent. */
      scopes: z.array(z.object({ scope: z.string(), plain: z.string() })),
      /** Permission reads survive reload; legacy cards have no pending request. */
      refresh: z.discriminatedUnion("state", [
        z.object({ id: z.string(), state: z.literal("requested") }),
        z.object({ id: z.string(), state: z.literal("complete") }),
        z.object({ id: z.string(), state: z.literal("failed"), error: z.string() })
      ]).optional(),
      allowlisted: z.boolean(),
      accessRequested: z.boolean(),
      /** The cloudWorkspaces rows at render time: the person's boxes across every repository this app has listed. */
      boxes: z.array(z.object({ id: z.string(), repoId: z.string(), name: z.string(), status: z.string() }))
    })
  }),
  /*
   * The Register repository app (docs/mvp/REGISTRATION.md, #2153): the
   * analysis one link starts. `repo` is the canonical GitHub owner/repo; the
   * run itself is the run-trace card of
   * `register-repository` for that link, found by its launch record. `replay`
   * counts replays of a recorded run, so the card re-animates from the start
   * without launching anything.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("registration"),
    payload: z.object({
      link: z.string().max(500),
      repo: z.string(),
      phase: z.enum(["importing", "launching", "launched", "failed"]),
      /** When this attempt started; a run recorded before it belongs to an earlier attempt. */
      startedAt: z.number().int().nonnegative(),
      error: z.string().nullable(),
      /** The Smithers Cloud repository the import produced. */
      cloudRepo: z.string().nullable(),
      replay: z.number().int().nonnegative(),
      accountOwner: z.string().nullable()
    })
  }),
  /*
   * Lane sync (ADR 0005): the import becomes a job card. `stage`, `counts`,
   * `error`, `repository`, and `workspaceId` are the progress fields of
   * plue#471 — all optional, parsed only when the wire carries them, never
   * invented (today's answer carries stage and error only).
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("repo-import"),
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
      accountOwner: z.string().nullable().optional()
    })
  }),
  /*
   * Lane sync (ADR 0005): the connector-setup card — one kind serves both
   * handoffs. The steps are the wizard (`linear`: authorize → team →
   * repository → confirm; `github`: install → reconcile), rendered as rows
   * that fill in; a failed step reads the server error verbatim on its own
   * line. On confirm the SAME card turns into the connected state (`phase:
   * "connected"`), which for Linear carries the integration and for GitHub
   * the installation. The setup key is the OAuth callback's opaque one-time
   * handle (plue#469's team pick; expires in minutes — an expired one reads
   * `authorization expired · Open Linear again`, never a silent retry).
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("connector-setup"),
    payload: z.object({
      connector: z.literal("github"),
      /** `org/repo` — the repository being connected. */
      repo: z.string(),
      phase: z.enum(["setup", "connected"]),
      steps: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          state: z.enum(["pending", "active", "done", "error"]),
          /** The row's filled-in value (`authorized as <actor>`, `ENG · Engineering`); null while unset. */
          detail: z.string().nullable(),
          /** The server error verbatim, under the step that failed. */
          error: z.string().optional()
        })
      ),
      /** The GitHub App installation (the connected state's `installation <id> · configured`). */
      installationId: z.number().int().nullable().optional(),
      configured: z.boolean().optional(),
      /** The trusted install URL (https://github.com only) step 1 opens. */
      installUrl: z.string().optional(),
      /** The rate-limit line: below 20% remaining, and always on a card whose call was refused. */
      rateLimit: GitHubRateLimitSchema.optional(),
      /** The last act's honest refusal, kept on the card. */
      error: z.string().optional()
    })
  }),
  /*
   * Lane sync (ADR 0005): the sync-ops card — one kind serves Linear syncs
   * and GitHub mirror syncs. Rows are the durable ops, newest first, a
   * failed row carrying the server's error verbatim with a Retry act
   * (`sync.retry <opId>`); failures are never filtered out. The header's
   * run state and counts stay live while the run is polled.
   *
   * Lane L5 (plue#468/#470 live): the state words are the WIRE's, never a
   * vocabulary of this app's own — a Linear run is `pending | running |
   * completed | failed`, a mirror run `queued | running | succeeded |
   * failed`, a Linear op `pending | success | failed | skipped`, a mirror
   * ref `pending | succeeded | failed`. They are strings here because the
   * two backends disagree and inventing a shared enum would rename one of
   * them on screen; `@smthrs/ui`'s status vocabulary already tints every
   * one of those words.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("sync-ops"),
    payload: z.object({
      /** The header subject: `Linear ENG ↔ org/repo` or `Mirror · org/repo`. */
      subject: z.string(),
      source: z.literal("github-mirror"),
      /** The Linear integration id the run belongs to (Linear only). */
      integrationId: z.string().optional(),
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
  /* Wave 2 of the multi parity: bookmarks (jj branches) and repo file reads. */
  z.object({
    ...cardBaseShape,
    kind: z.literal("branches"),
    payload: z.object({
      repo: z.string(),
      bookmarks: z.array(z.object({ name: z.string(), head: z.string().nullable() }))
    })
  }),
  /*
   * A repository's commits (commits.list): one branch's first-parent history,
   * newest first, the way GitHub's Commits page lists them. Fields the source
   * did not state stay null or absent; nothing is invented (plue names an
   * author by name and email, never by login, and carries no signature).
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("commit-list"),
    payload: z.object({
      repo: z.string(),
      /** The branch (bookmark) the history was walked from; null when the repository has none. */
      branch: z.string().nullable(),
      commits: z.array(CommitSummarySchema),
      /** True when the walk stopped at its cap before the root commit. */
      truncated: z.boolean().optional(),
      error: z.string().optional()
    })
  }),
  /* One commit (commits.read): the full message, its people, its parents and its diff. */
  z.object({
    ...cardBaseShape,
    kind: z.literal("commit"),
    payload: z.object({
      repo: z.string(),
      commit: CommitSummarySchema,
      /** The full description, title line included. */
      message: z.string(),
      committer: CommitPersonSchema.nullable().optional(),
      parents: z.array(z.object({ changeId: z.string().nullable(), commitId: z.string().nullable() })),
      files: z.array(z.object({
        path: z.string(),
        oldPath: z.string().optional(),
        changeType: z.string(),
        isBinary: z.boolean(),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        patch: z.string().optional()
      })),
      /** Why the diff is missing, when it could not be read; the commit itself still renders. */
      diffError: z.string().optional(),
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
      /** Exact local working copy; retained by refresh and code-intelligence actions. */
      localRepoId: z.string().optional(),
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
       * The digest of the bytes the card shows (RepoFilesResponse.digest). A
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
      /** The one file this card was cut at, when the flow named one. */
      path: z.string().optional(),
      error: z.string().optional()
    })
  }),
  /*
   * Lane citc (ADR 0002), completed by lane L3: the workspace card — a
   * persistent cloud computer bound to a repository bookmark. plue#446 landed,
   * so the DTO now carries `kind`, `environment`, `head`, `ahead`/`behind`,
   * `persistence`, `ssh_host` and `started_at`, and the payload carries them
   * too — every one optional and nullable, so a card written before this lane
   * parses and an absent field renders NOTHING rather than a guess.
   * `bookmarkHead` is still the TARGET BOOKMARK's head from the bookmarks
   * call, labeled as such and distinct from the workspace's own `head`.
   * plue#449 landed too: `files` and `services` carry what the workspace
   * routes answered. `egress` is the sandbox egress audit — what the computer
   * called and with which secret NAMES, never a value.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("workspace"),
    payload: z.object({
      workspaceId: z.string(),
      /** Frame history captures these facts; live cards derive them from the workspace row. */
      snapshot: z.literal(true).optional(),
      /** `org/repo` — the repository the workspace is bound to. */
      repo: z.string(),
      name: z.string(),
      targetBookmark: z.string().nullable(),
      /** plue's six statuses: pending, starting, running, suspended, stopped, failed. */
      status: z.enum(["pending", "starting", "running", "suspended", "stopped", "failed"]),
      /**
       * plue#482: why a `failed` workspace failed — the provider's own code
       * and message, off the DTO and off the status stream. Absent when the
       * platform recorded none; never paraphrased.
       */
      failureCode: z.string().nullable().optional(),
      failureMessage: z.string().nullable().optional(),
      provisioningStage: z.string().nullable(),
      /** When the workspace last suspended (DTO); optional so older cards parse. */
      suspendedAt: z.string().nullable().optional(),
      /** The target bookmark's head from the bookmarks call — the BOOKMARK head, never the workspace head. */
      bookmarkHead: z.object({
        changeId: z.string().nullable(),
        commitId: z.string().nullable()
      }).nullable(),
      /**
       * The sandbox kind the DTO names (`container`, `vm`, `desktop`, and —
       * RFD-004 — `agent` for the computer an agent run executed in); no
       * picker, ADR 0002.
       */
      workspaceKind: z.string().nullable().optional(),
      /** The agent session that drove this workspace (RFD-004); absent for a workspace a human opened. */
      agentSessionId: z.string().nullable().optional(),
      /** The workspace's OWN head, as the guest last reported it (DTO `head`). */
      head: WorkspaceHeadSchema.nullable().optional(),
      /** Commits ahead of / behind the target bookmark (DTO `ahead` / `behind`). */
      ahead: z.number().int().nullable().optional(),
      behind: z.number().int().nullable().optional(),
      /** When the VM last started; the uptime line reads it and is absent when it is null. */
      startedAt: z.string().nullable().optional(),
      /** The NixOS environment the DTO points at (`.smithers/environment.nix` and its revision). */
      environment: WorkspaceEnvironmentSchema.nullable().optional(),
      /** `persistent` / `ephemeral`, verbatim from the DTO. */
      persistence: z.string().nullable().optional(),
      /** `<vm>@<ssh host>` — the copyable line (plue#446). */
      sshHost: z.string().nullable().optional(),
      sessions: z.array(
        z.object({
          id: z.string(),
          status: z.string(),
          createdAt: z.string().nullable(),
          /** plue #505: `terminal` or `lsp`, and the lsp session's language; absent on rows written before. */
          kind: z.string().nullable().optional(),
          language: z.string().nullable().optional()
        })
      ),
      /**
       * Lane L6 (plue #505): the languages the workspace relays a language
       * server for (DTO `lsp.languages`); the header states them. Null when
       * the DTO carried none; absent on cards written before.
       */
      lspLanguages: z.array(z.string()).nullable().optional(),
      /** The Files facet's listing at `filesPath`; absent until the facet loads it. */
      files: z.array(WorkspaceFileEntrySchema).optional(),
      /** Which directory `files` lists; `""` is the working copy's root. */
      filesPath: z.string().optional(),
      /** The Services facet's rows; absent until the facet loads them. */
      services: z.array(WorkspaceServiceSchema).optional(),
      /** The Egress facet's rows, newest first; absent until the facet loads them. */
      egress: z.array(SandboxEgressRowSchema).optional(),
      /** plue's opaque next-page cursor; null when the audit is exhausted. */
      egressCursor: z.string().nullable().optional(),
      /**
       * Lane L3b: the DTO's `desktop` object, present only for a desktop
       * workspace. It carries the relative stream path and the last mint's id
       * and expiry — never the token, the VNC password, or the credentialed
       * absolute URL, all of which stay out of anything persisted.
       */
      desktop: WorkspaceDesktopSchema.nullable().optional(),
      /**
       * Lane L3b: how the desktop session POST refused, plue's status beside
       * its own words. A 409 (the workspace is not running) is the one the
       * facet answers with a Resume; a 400 (this kind has no desktop) reads
       * the message alone.
       */
      desktopRefusal: SessionRefusalSchema.nullable().optional(),
      /**
       * How far `/desktop` — the one-command open — has got on this box:
       * creating, resuming, starting, activating, streaming. Present only while a
       * wait is running, so the card can name the stage and offer a Stop.
       * A stage is a state, never a credential: the minted stream URL stays
       * in module memory (apps/app state/seams/DesktopStream.ts).
       */
      desktopProgress: z.string().optional(),
      desktopStage: z.enum(["creating", "resuming", "starting", "activating", "streaming"]).optional(),
      /**
       * plue#504: how the terminal session POST refused, on the terminal
       * facet. The same four facts as `desktopRefusal` — a 503
       * `guest_not_ready` is the one the seam retries on its own, because the
       * server asked it to with a `Retry-After`.
       */
      terminalRefusal: SessionRefusalSchema.nullable().optional(),
      /** Which body tab the card shows; the terminal by default. */
      facet: z.enum(["terminal", "files", "services", "egress", "desktop"]).optional(),
      /** The plue session the card's Terminal facet (and its tab) is attached to. */
      terminalSessionId: z.string().optional(),
      /** The last act's honest refusal, kept on the card. */
      error: z.string().optional(),
      /**
       * The workspace's creation was refused with plue's `egress_proxy_unavailable`
       * code: the card names that code exactly, never a paraphrase.
       */
      egressProxyUnavailable: z.boolean().optional()
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
  z.object({
    ...cardBaseShape,
    kind: z.literal("service-log"),
    payload: z.object({
      workspaceId: z.string(),
      repo: z.string(),
      service: z.string(),
      lines: z.array(z.string()),
      follow: z.boolean()
    })
  }),
  /*
   * The /theme picker: one swatch per palette, painted in that palette's own
   * colors. `selected` is the palette live when the card last synced; the
   * mainview owns the palette list, so the payload carries only the key.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("theme-picker"),
    payload: z.object({
      selected: z.string()
    })
  }),
  /*
   * The local app's repository cards (apps/app/docs/LOCAL-APP.md "Cards"):
   * the opened repository, its trusted typed target list, and one streamed
   * target run.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("targets"),
    payload: z.object({
      repoId: z.string(),
      /** Stable local repository identity for joining stars across reopen. */
      repoKey: z.string().optional(),
      repoName: z.string(),
      status: z.enum(["pending", "done", "failed"]),
      targets: z.array(TargetSchema),
      warnings: z.array(z.string()),
      /** The row an explicit target.open flow pointed at; the list highlights it. */
      highlighted: z.string().optional(),
      /** The table's filter and selection (TargetsViewSchema). */
      view: TargetsViewSchema.optional(),
      /** The repository's recorded runs, read from /api/targets/runs; the table derives each row's last run. */
      runs: z.array(RunRecordSchema).optional(),
      /** Per-label facts the drawer read (declaration site, plan, deps/rdeps), keyed by label. */
      details: z.record(z.string(), TargetDetailSchema).optional(),
      /** Legacy saved snapshot only; current cards derive labels from app-starred-targets. */
      starred: z.array(z.string()).optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("target-run"),
    /*
     * One execution: a single target (`label`) or a pattern run (`verb` +
     * `pattern`, e.g. `ci //packages/...`, the way "run everything" runs).
     * `nodes` fills as the executor reports each target, `summary` lands at
     * the end; `output` is the raw stream for the Raw output accordion, and
     * `nodeOutput` the chunks the backend attributed to one target.
     */
    payload: z.object({
      runId: z.string(),
      repoId: z.string(),
      label: z.string(),
      verb: z.string().optional(),
      pattern: z.string().optional(),
      status: z.enum(["running", "done", "failed"]),
      exitCode: z.number().nullable(),
      output: z.string(),
      startedAt: z.number().optional(),
      endedAt: z.number().optional(),
      nodes: z.array(NodeTimingSchema).optional(),
      summary: RunSummarySchema.optional(),
      nodeOutput: z.record(z.string(), z.string()).optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("repo"),
    payload: z.object({ repo: RepoSchema })
  }),
  /*
   * The target-graph cards (@smthrs/rpc/TargetGraph): the typed DAG with
   * plan facts and an optional live run overlay, one run's timeline with its
   * critical path, the run history with replay, the diff-affected set, and
   * the generated CI matrix.
   */
  z.object({ ...cardBaseShape, kind: z.literal("graph"), payload: GraphCardPayloadSchema }),
  z.object({ ...cardBaseShape, kind: z.literal("run-timeline"), payload: RunTimelineCardPayloadSchema }),
  z.object({ ...cardBaseShape, kind: z.literal("run-history"), payload: RunHistoryCardPayloadSchema }),
  z.object({ ...cardBaseShape, kind: z.literal("affected"), payload: AffectedCardPayloadSchema }),
  z.object({ ...cardBaseShape, kind: z.literal("ci-matrix"), payload: CiMatrixCardPayloadSchema }),
  /*
   * An agent launched from the `+` menu as a subagent of the conversation
   * (LOCAL-APP.md "Tabs"): the harness runs in its own tab, and this card is
   * the conversation's record of it — which harness, where, whether it is
   * still running, and the way back to its tab.
   *
   * The CLOUD variant (UI-COVERAGE-GAPS.md "agents · Cloud agent sessions";
   * plue's /api/repos/{o}/{r}/agent/sessions family): the same card for a
   * cloud agent session that Smithers Cloud runs in a sandbox — it carries
   * the session's repository, provider and workspace instead of a cwd and
   * tab, and its transcript rows append off the session's SSE stream instead
   * of a PTY tab. `cloud: true` discriminates it; a local card never carries
   * the key.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("agent"),
    payload: z.union([
      z.object({
        statusRollup: StatusRollupSchema.optional(),
        harnessId: z.enum(HARNESS_IDS),
        displayName: z.string(),
        /** The named role the agent was launched as (AgentRoles.ts); absent for a raw harness. */
        roleId: AgentRoleIdSchema.optional(),
        /** The role's purpose at launch (a custom agent's is not in any table); absent on cards written before custom agents. */
        purpose: z.string().optional(),
        /** The task it was delegated, when it was launched with one. */
        task: z.string().optional(),
        /** The tab the agent runs in; the tab id is the PTY session id. */
        tabId: z.string(),
        sessionId: z.string(),
        cwd: z.string(),
        phase: z.enum(["running", "exited"]),
        /** The process exit code once it has exited; null when unknown (the tab was closed). */
        exitCode: z.number().nullable()
      }),
      z.object({
        /** Marks the Smithers Cloud variant; absent on every local card. */
        cloud: z.literal(true),
        statusRollup: StatusRollupSchema.optional(),
        /** The session's title (its first task) or "Agent session" when plue holds none. */
        displayName: z.string(),
        sessionId: z.string(),
        /** `owner/repo` — the session's routes are repository-scoped, so the card carries the routing fact. */
        repo: z.string(),
        /*
         * The agent the run executes (plue's `agent_provider` on the dispatching
         * message). Null when the session was first met through a read: the wire
         * carries the provider per message, never on the session DTO, and a
         * guessed provider is a lie the header would repeat.
         */
        provider: z.enum(["codex", "claude", "smithers"]).nullable(),
        /** The kind=agent workspace the run executes in (RFD-004); null until the session DTO names one. */
        workspaceId: z.string().nullable(),
        /** plue's session status word, verbatim: active, completed, failed, cancelled. */
        state: z.string(),
        /** The task the session was opened with, when the flow carried one. */
        task: z.string().optional(),
        /*
         * The transcript rows the messages read and the SSE stream have
         * delivered, oldest first, capped by the seam (the card is the live
         * window, never the record — plue holds the transcript). One row per
         * message; a part is its type beside the text the seam read out of it.
         */
        transcript: z.array(
          z.object({
            /** plue's message id; the stream replay's dedupe key. */
            id: z.number().int(),
            role: z.string(),
            sequence: z.number().int(),
            createdAt: z.string().nullable(),
            parts: z.array(z.object({ type: z.string(), text: z.string() }))
          })
        ),
        /** The last act's honest refusal, kept on the card. */
        error: z.string().optional()
      })
    ])
  }),
  /*
   * The explainer's answer (AgentRoles.ts "explainer"): `explain <what>` runs
   * a side turn that asks for the explainer role, and this card is where the
   * answer streams in — embedded in the conversation, never a takeover.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("explain"),
    payload: z.object({
      question: z.string(),
      answer: z.string(),
      phase: z.enum(["asking", "answered", "failed"]),
      /**
       * What the serving side told us about who answered. The request names
       * the explainer role; a server that ignores the hint answers on its
       * default model, and the card says so rather than claiming Kimi.
       */
      answeredBy: z.string(),
      error: z.string().optional()
    })
  }),
  /* The agents (the built-in roles and the loaded repository's agent flows) or a repository's cloud session inventory. */
  z.object({
    ...cardBaseShape,
    kind: z.literal("agents"),
    payload: z.union([
      z.object({
        /** False on the web host: no local harnesses, so nothing local is listed. */
        native: z.boolean(),
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
   * apps/app/docs/workbench-lanes/flow-forms.md): a flow invoked without its
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
      /** A submission holds the form until its invocation settles. */
      submitting: z.boolean().optional(),
      submitLabel: z.string().optional(),
      /** A nested input uses the same form editor and submits under this named property. */
      payloadField: z.string().optional(),
      inputSchema: z.unknown().optional(),
      /** The last submit's honest refusal, kept on the card. */
      error: z.string().optional()
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
  /*
   * One kind for every hidden mock behind VITE_SMITHERS_EXPERIMENTAL
   * (apps/app experimental/Registry.ts). A mock is a proposal, not a product
   * surface, so it does not cost the wire a kind of its own: `pane` names the
   * registry entry and `props` is whatever that mock takes. Earning a kind,
   * a payload schema and a migration is what promotion means.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("experimental"),
    payload: z.object({
      pane: z.string(),
      props: z.record(z.string(), z.unknown()).optional()
    })
  })
])
/** Retired UI records keep their identity, without retaining executable forms or feature data. */
const retiredFlows = new Set([
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
  "history.fold"
])
/* `history` is the retired narrative History card: the stack card is the one history view (D-20). */
const retiredKinds = new Set(["factory", "repo-onboarding", "repo-home", "agent-models", "agent-form", "history"])
/**
 * One persisted card, decoded by kind. The preprocessor retires a kind or a flow
 * the product no longer serves before the union sees it, so a frame stored by an
 * older build still parses instead of failing the whole snapshot.
 *
 * @since 1.0.0
 * @category schemas
 */
export const CardSchema = Object.assign(
  z.preprocess((value: unknown) => {
    if (typeof value !== "object" || value === null) return value
    const row = value as Record<string, unknown>
    const payload = row.payload as Record<string, unknown> | undefined
    const flow = payload?.flow
    if (
      retiredKinds.has(String(row.kind)) ||
      (row.kind === "connector-setup" && payload?.connector === "linear") ||
      (row.kind === "sync-ops" && payload?.source === "linear") ||
      (row.kind === "flow-form" && typeof flow === "string" && (retiredFlows.has(flow) || flow.startsWith("linear.")))
    ) {
      const { body: _body, ...base } = row
      return { ...base, kind: "retired", title: "", loading: false, status: "acted", payload: {} }
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
    if (row.kind === "workspace" && payload?.facet === "snapshots") {
      return { ...row, payload: { ...payload, facet: "terminal" } }
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
