/**
 * EntryRow data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ActionSchema } from "./CardAction.ts"
import type { CardCallbacks } from "./CardAction.ts"
import { ActorSchema, ContextItemSchema, TodoStateSchema, ToneSchema } from "./CardPrimitives.ts"

/**
 * The kind of a conversation entry (spec §14.5.1).
 * @since 1.0.0
 * @category schemas
 */
export const EntryKindSchema = z.enum(["prompt", "answer", "card", "event"])

/**
 * The value decoded by {@link EntryKindSchema}.
 * @since 1.0.0
 * @category models
 */
export type EntryKind = z.infer<typeof EntryKindSchema>

/**
 * One conversation entry row (ui-components.md T-UI-07, spec §14.5.1): its author, title, summary, tone, TODO
 * state, context (§15.1.2) and derived action. The rendered card body (`card`) and `onAction` are React props the
 * Container passes beside this data.
 * @since 1.0.0
 * @category schemas
 */
export const EntryRowCardSchema = z.object({
  kind: EntryKindSchema,
  author: ActorSchema,
  title: z.string(),
  summary: z.string().optional(),
  tone: ToneSchema,
  state: TodoStateSchema.optional(),
  context: z.object({ count: z.number().int().nonnegative(), items: z.array(ContextItemSchema) }).optional(),
  action: ActionSchema.optional(),
  private: z.boolean().optional(),
  tombstone: z.boolean().optional()
})

/**
 * The value decoded by {@link EntryRowCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type EntryRowCard = z.infer<typeof EntryRowCardSchema>

/**
 * Typed catalog callbacks for an entry row's derived action (spec §14.5.2).
 * @since 1.0.0
 * @category models
 */
export type EntryRowCardCallbacks = CardCallbacks<"todo" | "todo.answer" | "todo.retry" | "merge" | "branch">
