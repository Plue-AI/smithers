/**
 * Secrets data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ActionSchema } from "./CardAction.ts"
import type { CardCallbacks, CardProps } from "./CardAction.ts"

/**
 * Secrets projection fields from spec §14.3 and ui-components.md v0.4 (T-UI-18): names, scope ("all branches",
 * "main only", §8.8), optional egress-bound hosts (§8.8.0) and each row's Replace and Delete. Values are
 * write-only and never part of the model.
 * @since 1.0.0
 * @category schemas
 */
export const SecretsCardSchema = z.object({
  secrets: z.array(
    z.object({
      name: z.string(),
      scope: z.enum(["all_branches", "main_only"]),
      hosts: z.array(z.string()).optional(),
      actions: z.array(ActionSchema)
    })
  )
})

/**
 * The value decoded by {@link SecretsCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type SecretsCard = z.infer<typeof SecretsCardSchema>

/**
 * The Secrets View's props (ui-components.md T-UI-18).
 * @since 1.0.0
 * @category models
 */
export type SecretsViewProps = CardProps<SecretsCard>

/**
 * Typed catalog callbacks for Secrets.
 * @since 1.0.0
 * @category models
 */
export type SecretsCardCallbacks = CardCallbacks<"secrets" | "secrets.set" | "secrets.delete" | "secrets.scope">
