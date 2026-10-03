/**
 * Confirm data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { ActorSchema, EvidenceSchema, MergeSchema, PersonRefSchema } from "./CardPrimitives.ts"
import { CatalogTagSchema } from "./catalog/index.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

/**
 * The revision a confirmation is bound to; `confirm.cancel` sends it back, and a stale one is refused as `stale`.
 * @since 1.0.0
 * @category schemas
 */
export const ConfirmRevisionSchema = z.string()

/**
 * Confirm projection fields from spec §14.3 and ui-components.md T-UI-05. Members, secrets and settings are
 * agent: never and have no confirmation, so the subject is a TODO, branch, flow, agent or wiki page.
 * @since 1.0.0
 * @category schemas
 */
export const ConfirmCardSchema = z.object({
  kind: z.enum(["one_click", "review_merge"]),
  action: z.object({ tag: CatalogTagSchema, verb: z.string() }),
  summary: z.string(),
  subject: z.object({
    kind: z.enum(["todo", "branch", "flow", "agent", "wiki"]),
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
