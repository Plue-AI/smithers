/**
 * Diff data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"

import type { CardCallbacks } from "./CardAction.ts"
import { ActorSchema } from "./CardPrimitives.ts"

/**
 * Diff projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const DiffCardSchema = z.object({
  path: z.string(),
  branch: z.string(),
  base: z.string(),
  hunks: z.array(
    z.object({
      header: z.string(),
      authors: z.array(ActorSchema),
      lines: z.array(z.object({ op: z.enum([" ", "+", "-"]), text: z.string() }))
    })
  )
})

/**
 * The value decoded by {@link DiffCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type DiffCard = z.infer<typeof DiffCardSchema>

/**
 * Typed catalog callbacks for Diff.
 * @since 1.0.0
 * @category models
 */
export type DiffCardCallbacks = CardCallbacks<"file" | "diff">
