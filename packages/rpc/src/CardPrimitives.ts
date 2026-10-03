/**
 * Shared data contracts for the MVP card projections.
 * @since 1.0.0
 */

import { z } from "zod"
import { HttpUrlSchema } from "./WebUrl.ts"

/**
 * The offline avatar shown when a person's avatar is unavailable.
 * @since 1.0.0
 * @category constants
 */
export const PlaceholderAvatarUrl =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cmVjdCB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHJ4PSIyNCIgZmlsbD0iI2RkZCIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iMTgiIHI9IjgiIGZpbGw9IiM4ODgiLz48cGF0aCBkPSJNOCA0NGExNiAxNiAwIDAgMSAzMiAwIiBmaWxsPSIjODg4Ii8+PC9zdmc+"

/**
 * A remote avatar URL or the fixed safe offline avatar.
 * @since 1.0.0
 * @category schemas
 */
export const AvatarUrlSchema = z.union([HttpUrlSchema, z.literal(PlaceholderAvatarUrl)])

/**
 * An identity colour from M-34: 0–5 a member's colour, which an agent or Smithers acting for that member also
 * takes; 6 an agent or Smithers acting for nobody; 7 neutral (GitHub users, outside writes and install events).
 * @since 1.0.0
 * @category schemas
 */
export const ColorIndexSchema = z.number().int().min(0).max(7)

/**
 * A member's own colour, 0–5.
 * @since 1.0.0
 * @category schemas
 */
export const MemberColorIndexSchema = ColorIndexSchema.max(5)

/**
 * A participant's colour: its member's 0–5 when it acts for one, otherwise 6.
 * @since 1.0.0
 * @category schemas
 */
export const ParticipantColorIndexSchema = ColorIndexSchema.max(6)

/**
 * The neutral colour of GitHub users and outside writes.
 * @since 1.0.0
 * @category schemas
 */
export const NeutralColorIndexSchema = z.literal(7)

/**
 * A member as a card references them.
 * @since 1.0.0
 * @category schemas
 */
export const PersonRefSchema = z.object({
  login: z.string(),
  name: z.string(),
  avatar_url: AvatarUrlSchema
})

/**
 * The value decoded by {@link PersonRefSchema}.
 * @since 1.0.0
 * @category models
 */
export type PersonRef = z.infer<typeof PersonRefSchema>

/**
 * How a person reached the branch when it is not the app: "Ben via SSH", "Ben's terminal", "Ben via CLI".
 * Claude Code and Codex are agent actors acting for the person, never a person's `via` (M-34).
 * @since 1.0.0
 * @category schemas
 */
export const ViaSchema = z.enum(["ssh", "terminal", "cli"])

/**
 * The value decoded by {@link ViaSchema}.
 * @since 1.0.0
 * @category models
 */
export type Via = z.infer<typeof ViaSchema>

/**
 * Which agent a participant is: Smithers, ours (coding, reviewer) or one a person runs (Claude Code, Codex,
 * another).
 * @since 1.0.0
 * @category schemas
 */
export const AgentKindSchema = z.enum(["smithers", "coding", "reviewer", "claude-code", "codex", "external"])

/**
 * The value decoded by {@link AgentKindSchema}.
 * @since 1.0.0
 * @category models
 */
export type AgentKind = z.infer<typeof AgentKindSchema>

/**
 * The actor rendering contract from spec §14.6a.1 and M-34. Every agent doing work, Smithers included, is a
 * participant with a stable `id` and its own avatar; `for_member` names the person it acts for, is absent when
 * nobody delegated the work, and confers no authorization. The system actor is an install event.
 * @since 1.0.0
 * @category schemas
 */
export const ActorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("person"),
    ...PersonRefSchema.shape,
    via: ViaSchema.optional(),
    color_index: MemberColorIndexSchema
  }),
  z.object({
    kind: z.literal("agent"),
    id: z.string(),
    agent: AgentKindSchema,
    avatar_url: AvatarUrlSchema,
    session_id: z.string().optional(),
    run_id: z.string().optional(),
    for_member: PersonRefSchema.optional(),
    name: z.string().optional(),
    todo: z.number().int().positive().optional(),
    color_index: ParticipantColorIndexSchema
  }),
  z.object({ kind: z.literal("system"), color_index: NeutralColorIndexSchema }),
  z.object({ kind: z.literal("github"), login: z.string(), color_index: NeutralColorIndexSchema }),
  z.object({ kind: z.literal("outside"), color_index: NeutralColorIndexSchema })
])

/**
 * The value decoded by {@link ActorSchema}.
 * @since 1.0.0
 * @category models
 */
export type Actor = z.infer<typeof ActorSchema>

/**
 * Every TODO state from spec §4.1, including Starting.
 * @since 1.0.0
 * @category schemas
 */
export const TodoStateSchema = z.enum([
  "queued",
  "starting",
  "working",
  "needs_you",
  "paused",
  "failed",
  "in_review",
  "merged",
  "dropped"
])

/**
 * The value decoded by {@link TodoStateSchema}.
 * @since 1.0.0
 * @category models
 */
export type TodoState = z.infer<typeof TodoStateSchema>

/**
 * The timeline color role from spec §14.5.2.
 * @since 1.0.0
 * @category schemas
 */
export const ToneSchema = z.enum(["live", "attention", "failed", "done", "quiet"])

/**
 * The value decoded by {@link ToneSchema}.
 * @since 1.0.0
 * @category models
 */
export type Tone = z.infer<typeof ToneSchema>

/**
 * The kind of a TODO's open wait for a person (spec §10.8.0). Stack attention (`order`, `force_push`) is not a
 * wait (§4.1.2a).
 * @since 1.0.0
 * @category schemas
 */
export const NeedsYouKindSchema = z.enum(["question", "approval", "conflict", "moved_off", "foreign_push"])

/**
 * The value decoded by {@link NeedsYouKindSchema}.
 * @since 1.0.0
 * @category models
 */
export type NeedsYouKind = z.infer<typeof NeedsYouKindSchema>

/**
 * The phase and cell indicator role.
 * @since 1.0.0
 * @category schemas
 */
export const PhaseToneSchema = z.enum(["live", "ok", "fail", "thrash", "wait"])

/**
 * The value decoded by {@link PhaseToneSchema}.
 * @since 1.0.0
 * @category models
 */
export type PhaseTone = z.infer<typeof PhaseToneSchema>

/**
 * An install step state.
 * @since 1.0.0
 * @category schemas
 */
export const StepStateSchema = z.enum(["next", "active", "done", "failed"])

/**
 * The value decoded by {@link StepStateSchema}.
 * @since 1.0.0
 * @category models
 */
export type StepState = z.infer<typeof StepStateSchema>

/**
 * The admission queue reason and position.
 * @since 1.0.0
 * @category schemas
 */
export const QueueSchema = z.object({
  reason: z.enum(["machine", "merge_order", "rebase"]),
  after: z.number().int().positive().optional(),
  position: z.number().int().positive()
})

/**
 * The value decoded by {@link QueueSchema}.
 * @since 1.0.0
 * @category models
 */
export type Queue = z.infer<typeof QueueSchema>

/**
 * A rebase that waits to run: "Rebase pending onto T2" (spec §4.2).
 * @since 1.0.0
 * @category schemas
 */
export const RebasePendingSchema = z.object({ onto: z.string() })

/**
 * A Context line item from ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const ContextItemSchema = z.object({
  kind: z.enum(["file", "page", "todo", "run", "issue"]),
  label: z.string(),
  ref: z.string(),
  revision: z.string().optional()
})

/**
 * The value decoded by {@link ContextItemSchema}.
 * @since 1.0.0
 * @category models
 */
export type ContextItem = z.infer<typeof ContextItemSchema>

/**
 * Revision-bound evidence recorded for one attempt.
 * @since 1.0.0
 * @category schemas
 */
export const EvidenceSchema = z.array(z.object({
  attempt: z.number().int().positive(),
  revision: z.string(),
  items: z.array(z.object({ kind: z.string(), label: z.string(), url: HttpUrlSchema.optional() })),
  previous: z.object({
    revision: z.string(),
    items: z.array(z.object({ kind: z.string(), label: z.string(), url: HttpUrlSchema.optional() }))
  }).optional(),
  reviewing: z.boolean().optional()
}))
/**
 * The shared merge predicate result.
 * @since 1.0.0
 * @category schemas
 */
export const MergeSchema = z.object({
  state: z.enum(["ready", "waiting", "blocked", "merging", "done"]),
  reason: z.enum([
    "state",
    "order",
    "attention",
    "merging",
    "rechecking",
    "pending_work",
    "stale_head",
    "checks",
    "github"
  ]).optional(),
  detail: z.string().optional(),
  on_github: z.boolean()
})
/**
 * A TODO branch and machine state.
 * @since 1.0.0
 * @category schemas
 */
export const BranchRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  machine: z.enum(["waiting", "building", "ready", "sleeping", "closed", "failed"])
})
