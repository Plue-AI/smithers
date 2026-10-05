/**
 * Timeline data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ActionSchema, type CardProps } from "./CardAction.ts"
import { ActorSchema, TodoStateSchema, ToneSchema } from "./CardPrimitives.ts"
import { EntryKindSchema } from "./EntryRowCard.ts"
import type { ShellView } from "./ToastCard.ts"

/**
 * A zoomed-out line (T-UI-08 zoom, Will 2026-10-05): it stands for a run of entries far from the on-screen band.
 * Level 1 is one message and what followed it, level 2 a run of those, level 3 a run of level 2s, and so on while
 * the coarsest level still holds more than a screenful. `entry_id` is the
 * run's first entry (a click jumps there); `last_entry_id` its last; `from`/`to` its span in epoch milliseconds when
 * the entries carry times.
 * @since 1.0.0
 * @category schemas
 */
export const TimelineZoomSchema = z.object({
  /** 1 to 3, and higher only for conversations long enough to need more levels. */
  level: z.number().int().min(1),
  count: z.number().int().min(2),
  last_entry_id: z.string(),
  from: z.number().optional(),
  to: z.number().optional()
})

/**
 * The value decoded by {@link TimelineZoomSchema}.
 * @since 1.0.0
 * @category models
 */
export type TimelineZoom = z.infer<typeof TimelineZoomSchema>

/**
 * One timeline line per conversation entry: its title, summary and tone (spec §14.5.4).
 * @since 1.0.0
 * @category schemas
 */
export const TimelineLineSchema = z.object({
  entry_id: z.string(),
  kind: EntryKindSchema,
  title: z.string(),
  summary: z.string().optional(),
  tone: ToneSchema,
  glyph: z.union([
    z.object({ state: TodoStateSchema }),
    z.object({ actor: ActorSchema }),
    z.object({ event: z.enum(["running", "ok", "attention", "failed"]) })
  ]),
  action: ActionSchema.optional(),
  fresh: z.boolean().optional(),
  zoom: TimelineZoomSchema.optional()
})

/**
 * The value decoded by {@link TimelineLineSchema}.
 * @since 1.0.0
 * @category models
 */
export type TimelineLine = z.infer<typeof TimelineLineSchema>

/**
 * The timeline (ui-components.md T-UI-08): every line, and the first and last entry ids on screen, which the band
 * marks.
 * @since 1.0.0
 * @category schemas
 */
export const TimelineCardSchema = z.object({
  lines: z.array(TimelineLineSchema),
  on_screen: z.tuple([z.string(), z.string()])
})

/**
 * The value decoded by {@link TimelineCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type TimelineCard = z.infer<typeof TimelineCardSchema>

/**
 * The Timeline View's props: a click is `onView({ jump_to: entry_id })` (ui-components.md T-UI-08).
 * @since 1.0.0
 * @category models
 */
export type TimelineProps = TimelineCard & {
  readonly onAction: CardProps<unknown>["onAction"]
  readonly onView: (patch: ShellView) => void
}
