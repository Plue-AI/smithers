/**
 * Toast, toast stack and edge map data contracts shared by the Views and their Containers.
 * @since 1.0.0
 */

import { z } from "zod"
import { ActionSchema } from "./CardAction.ts"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { ToneSchema } from "./CardPrimitives.ts"

/**
 * Why a toast pops (spec §14.4.1, §14.4.3, §14.6).
 * @since 1.0.0
 * @category schemas
 */
export const ToastKindSchema = z.enum([
  "needs_you",
  "approval",
  "in_review",
  "failed",
  "conflict",
  "merged",
  "progress",
  "allow_notifications"
])

/**
 * The value decoded by {@link ToastKindSchema}.
 * @since 1.0.0
 * @category models
 */
export type ToastKind = z.infer<typeof ToastKindSchema>

/**
 * One toast with its single action and the conversation entry it belongs to (ui-components.md T-UI-08).
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
  kind: ToastKindSchema
})

/**
 * The value decoded by {@link ToastCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type ToastCard = z.infer<typeof ToastCardSchema>

/**
 * The shared toast stack (spec §14.4.3): the View shows at most three; `toasts` also holds the hidden ones that
 * "+N more" discloses, and `more` is their count.
 * @since 1.0.0
 * @category schemas
 */
export const ToastStackCardSchema = z.object({
  toasts: z.array(ToastCardSchema),
  more: z.number().int().nonnegative()
})

/**
 * The value decoded by {@link ToastStackCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type ToastStackCard = z.infer<typeof ToastStackCardSchema>

/**
 * Live work scrolled out of view, top-left for above and bottom-left for below (spec §14.4.4); `narrow` collapses
 * each edge to one pill (§14.5.4).
 * @since 1.0.0
 * @category schemas
 */
export const EdgeMapCardSchema = z.object({
  above: z.array(ToastCardSchema),
  below: z.array(ToastCardSchema),
  narrow: z.boolean()
})

/**
 * The value decoded by {@link EdgeMapCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type EdgeMapCard = z.infer<typeof EdgeMapCardSchema>

/**
 * Per-member shell view state (spec §14.4.2, §14.5.4): Hide is `{ toast_hidden: id }`, a timeline click is
 * `{ jump_to: entry_id }`.
 * @since 1.0.0
 * @category models
 */
export interface ShellView {
  readonly toast_hidden?: string
  readonly jump_to?: string
  /** The shell's visible entry band; T-APP-07 turns it into the band (C-UI-04). */
  readonly on_screen?: readonly [first: string, last: string]
  /** Whether the timeline is visible; T-APP-07 turns it into the timeline_visible lease. */
  readonly timeline_visible?: boolean
}

/**
 * The ToastStack View's props (ui-components.md T-UI-08).
 * @since 1.0.0
 * @category models
 */
export type ToastStackProps = ToastStackCard & {
  readonly onAction: CardProps<unknown>["onAction"]
  readonly onView: (patch: ShellView) => void
}

/**
 * The EdgeMap View's props (ui-components.md T-UI-08).
 * @since 1.0.0
 * @category models
 */
export type EdgeMapProps = EdgeMapCard & {
  readonly onAction: CardProps<unknown>["onAction"]
  readonly onView: (patch: ShellView) => void
}

/**
 * Typed catalog callbacks for toast actions (spec §14.4.3).
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
