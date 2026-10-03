/**
 * Settings data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { SyncHealthSchema } from "./CardPrimitives.ts"
import { SetupCardSchema } from "./SetupCard.ts"

/**
 * Settings projection fields from spec §14.3 and ui-components.md v0.4 (T-UI-02): the setup fields plus the
 * Machines and TODOs-at-once steppers, the owner-only `todo_daily_admissions` allowance (default 12, §10.4.1b),
 * laptop sign-in lines, health and the Obsidian folder [S2].
 * @since 1.0.0
 * @category schemas
 */
export const SettingsCardSchema = SetupCardSchema.extend({
  capacity: z.number().int().nonnegative(),
  parallel: z.number().int().nonnegative().optional(),
  todo_daily_admissions: z.number().int().positive().optional(),
  laptop_lines: z.array(z.string()),
  notifications_need_https: z.boolean(),
  health: z.object({
    process: z.enum(["ok", "degraded"]),
    postgres_bytes: z.number().int().nonnegative(),
    disk_free_gb: z.number().nonnegative(),
    github: z.object({
      health: SyncHealthSchema,
      cause: z.string().optional(),
      retry_at: z.string().optional(),
      rate_remaining: z.number().int().nonnegative(),
      rate_limit: z.number().int().nonnegative()
    })
  }),
  obsidian: z.object({ path: z.string(), last_sync_at: z.string().optional(), error: z.string().optional() })
    .optional()
})

/**
 * The value decoded by {@link SettingsCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type SettingsCard = z.infer<typeof SettingsCardSchema>

/**
 * The Settings View's props (ui-components.md T-UI-02).
 * @since 1.0.0
 * @category models
 */
export type SettingsViewProps = CardProps<SettingsCard>

/**
 * Typed catalog callbacks for Settings.
 * @since 1.0.0
 * @category models
 */
export type SettingsCardCallbacks = CardCallbacks<"settings" | "settings.model.set" | "github" | "docs">
