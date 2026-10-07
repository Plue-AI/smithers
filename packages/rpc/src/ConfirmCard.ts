/**
 * Confirm data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { ActorSchema, EvidenceSchema, MergeSchema, PersonRefSchema } from "./CardPrimitives.ts"
import { CatalogTagSchema } from "./CatalogTags.ts"
import { type Refusal, refusalOf } from "./Refusal.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

/**
 * The revision a confirmation is bound to; `confirm.cancel` sends it back. Stale or answered confirmations
 * are refused as `native_confirm_stale`.
 * @since 1.0.0
 * @category schemas
 */
export const ConfirmRevisionSchema = z.string()

/**
 * Confirm projection fields from spec §14.3 and ui-components.md T-UI-05. Members, secrets and settings are
 * agent: never and have no confirmation, so the subject is a TODO, branch, flow, agent, wiki page or Learning proposal.
 * @since 1.0.0
 * @category schemas
 */
export const ConfirmCardSchema = z.object({
  kind: z.enum(["one_click", "review_merge"]),
  action: z.object({ tag: CatalogTagSchema, verb: z.string() }),
  summary: z.string(),
  subject: z.object({
    kind: z.enum(["todo", "branch", "flow", "agent", "wiki", "proposal"]),
    ref: z.string(),
    revision: ConfirmRevisionSchema.optional()
  }),
  text: z.string().optional(),
  asked_by: ActorSchema,
  review: z.object({
    title: z.string(),
    place: z.number().int().positive(),
    pr: z.object({ number: z.number().int().positive(), url: HttpUrlSchema }),
    evidence: EvidenceSchema,
    approved_revision: ConfirmRevisionSchema.optional(),
    merge: MergeSchema
  }).optional(),
  receipt: z.object({
    by: PersonRefSchema,
    result: z.enum(["done", "cancelled", "expired"]),
    at: z.string(),
    text: z.string().optional()
  }).optional()
})

/**
 * The value decoded by {@link ConfirmCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type ConfirmCard = z.infer<typeof ConfirmCardSchema>

/** Private approvals projection. This wire value must never enter model context.
 * @since 1.0.0
 * @category schemas
 */
export const MemberConfirmationSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(["pending", "approved", "rejected", "expired"]),
  command: CatalogTagSchema,
  revision: z.string().min(1),
  expires_at: z.string().datetime({ offset: true }),
  decided_at: z.string().datetime({ offset: true }).optional(),
  payload: z.object({
    card: ConfirmCardSchema,
    input: z.record(z.string(), z.unknown()),
    merge_attempt: z.number().int().nonnegative().optional(),
    effect: z.object({
      todo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      request: z.string().min(1),
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
    }).optional()
  })
})

/** @since 1.0.0 @category models */
export type MemberConfirmation = z.infer<typeof MemberConfirmationSchema>

/**
 * The Confirm View's props (ui-components.md T-UI-05).
 * @since 1.0.0
 * @category models
 */
export type ConfirmViewProps = CardProps<ConfirmCard>

/**
 * Typed catalog callbacks for Confirm.
 * @since 1.0.0
 * @category models
 */
export type ConfirmCardCallbacks = CardCallbacks<
  | "approval.approve"
  | "approval.deny"
  | "merge"
  | "merge.confirm"
  | "pr"
  | "todo.steer"
  | "todo.drop"
  | "todo.retry"
  | "branch.add-to-stack"
  | "flow.edit"
  | "agent"
  | "wiki.save"
  | "confirm.cancel"
>

/**
 * Refuse cancellation unless the confirmation is still pending at the supplied revision.
 * Older persisted confirmations without a revision cannot authorize a cancellation.
 * @since 1.0.0
 * @category constructors
 */
export const confirmCancelRefusal = (
  revision: string,
  confirmation: { readonly revision?: string; readonly answered?: boolean } | undefined
): Refusal | undefined =>
  confirmation?.revision !== undefined && confirmation.revision === revision && !confirmation.answered
    ? undefined
    : refusalOf({
      status: 409,
      message: "Confirmation changed or was already answered",
      body: { code: "native_confirm_stale", origin: "client" }
    })
