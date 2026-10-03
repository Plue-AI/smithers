/**
 * Settings data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks } from "./CardAction.ts"
import { SetupCardSchema } from "./SetupCard.ts"

/**
 * Settings projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const SettingsCardSchema = SetupCardSchema.extend({
  machines: z.number().int().nonnegative(),
  max_machines: z.number().int().nonnegative(),
  upgrade: z.object({ version: z.string() }).optional(),
  obsidian_folder: z.string(),
  members: z.array(z.object({ login: z.string(), name: z.string(), role: z.enum(["owner", "maintainer", "member"]) })),
  github: SetupCardSchema.shape.github.extend({ app_error: z.string().optional() }),
  notifications_need_https: z.boolean(),
  parallel: z.number().int().nonnegative(),
  laptop_line: z.string()
})

/**
 * The value decoded by {@link SettingsCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type SettingsCard = z.infer<typeof SettingsCardSchema>

/**
 * Typed catalog callbacks for Settings.
 * @since 1.0.0
 * @category models
 */
export type SettingsCardCallbacks = CardCallbacks<"settings" | "github">
