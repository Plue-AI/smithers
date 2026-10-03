/**
 * Timeline data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ToneSchema } from "./CardPrimitives.ts"
import { EntryKindSchema } from "./EntryRowCard.ts"
import type { ShellView } from "./ToastCard.ts"

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
  tone: ToneSchema
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
export type TimelineProps = TimelineCard & { readonly onView: (patch: ShellView) => void }
