/**
 * Secrets data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"

import type { CardCallbacks } from "./CardAction.ts"

/**
 * Secrets projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const SecretsCardSchema = z.object({
  secrets: z.array(
    z.object({ name: z.string(), scope: z.enum(["all_branches", "main_only"]) })
  )
})

/**
 * The value decoded by {@link SecretsCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type SecretsCard = z.infer<typeof SecretsCardSchema>

/**
 * Typed catalog callbacks for Secrets.
 * @since 1.0.0
 * @category models
 */
export type SecretsCardCallbacks = CardCallbacks<"secrets" | "secrets.set" | "secrets.delete" | "secrets.scope">
