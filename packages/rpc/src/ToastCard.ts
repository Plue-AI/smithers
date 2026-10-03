/**
 * Toast data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ActionSchema } from "./CardAction.ts"
import type { CardCallbacks } from "./CardAction.ts"
import { ToneSchema } from "./CardPrimitives.ts"

/**
 * Toast projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const ToastCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string().optional(),
  tone: ToneSchema,
  action: ActionSchema.optional(),
  entry_id: z.string(),
  kind: z.enum([
    "needs_you",
    "approval",
    "in_review",
    "failed",
    "conflict",
    "merged",
    "allow_notifications"
  ])
})

/**
 * The value decoded by {@link ToastCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type ToastCard = z.infer<typeof ToastCardSchema>

/**
 * Typed catalog callbacks for Toast.
 * @since 1.0.0
 * @category models
 */
export type ToastCardCallbacks = CardCallbacks<
  | "todo"
  | "todo.answer"
  | "todo.steer"
  | "todo.stop"
  | "todo.retry"
  | "merge"
  | "merge.confirm"
  | "notifications.allow"
  | "background.retry"
  | "background.dismiss"
>
