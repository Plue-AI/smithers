/**
 * Confirm data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks } from "./CardAction.ts"
import { ActorSchema, EvidenceSchema, MergeSchema, PersonRefSchema } from "./CardPrimitives.ts"
import { CatalogTagSchema } from "./catalog/index.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

/**
 * Confirm projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const ConfirmCardSchema = z.object({
  kind: z.enum(["one_click", "review_merge"]),
  action: z.object({ tag: CatalogTagSchema, verb: z.string() }),
  title: z.string().optional(),
  text: z.string().optional(),
  pr: z.object({ number: z.number().int().positive(), url: HttpUrlSchema }).optional(),
  evidence: EvidenceSchema.optional(),
  approved_revision: z.string().optional(),
  merge: MergeSchema.optional(),
  subject: z.object({
    kind: z.enum(["todo", "branch", "flow", "secret", "member"]),
    ref: z.string(),
    label: z.string(),
    revision: z.string().optional()
  }),
  place: z.number().int().positive().optional(),
  asked_by: ActorSchema,
  waiting_for: PersonRefSchema.optional(),
  receipt: z.object({
    by: PersonRefSchema,
    text: z.string(),
    result: z.enum(["done", "cancelled", "stale"]),
    at: z.string()
  })
    .optional()
})

/**
 * The value decoded by {@link ConfirmCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type ConfirmCard = z.infer<typeof ConfirmCardSchema>

/**
 * Typed catalog callbacks for Confirm.
 * @since 1.0.0
 * @category models
 */
export type ConfirmCardCallbacks = CardCallbacks<
  "merge" | "merge.confirm" | "todo.new" | "todo.drop" | "branch.add-to-stack" | "flow.edit"
>
