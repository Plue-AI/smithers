/**
 * TimelineEntry data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ActionSchema } from "./CardAction.ts"
import type { CardCallbacks } from "./CardAction.ts"
import { ActorSchema, ContextItemSchema, TodoStateSchema, ToneSchema } from "./CardPrimitives.ts"

/**
 * TimelineEntry projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const TimelineEntryCardSchema = z.object({
  entry_id: z.string(),
  kind: z.enum(["prompt", "answer", "card", "event"]),
  author: ActorSchema,
  title: z.string(),
  summary: z.string().optional(),
  tone: ToneSchema,
  state: TodoStateSchema.nullable(),
  context: z.object({ count: z.number().int().nonnegative(), items: z.array(ContextItemSchema) }).optional(),
  action: ActionSchema.optional(),
  private: z.boolean().optional()
})

/**
 * The value decoded by {@link TimelineEntryCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type TimelineEntryCard = z.infer<typeof TimelineEntryCardSchema>

/**
 * Typed catalog callbacks for TimelineEntry.
 * @since 1.0.0
 * @category models
 */
export type TimelineEntryCardCallbacks = CardCallbacks<"todo" | "todo.answer" | "todo.retry" | "merge" | "branch">
