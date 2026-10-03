/**
 * Diff data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"

import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { ActorSchema } from "./CardPrimitives.ts"

/**
 * What a diff compares against: an item's previous candidate (§12.5.1), a scratch branch's fork revision
 * (§8.5.3b) or one burst's before and after versions (§9.3.4).
 * @since 1.0.0
 * @category schemas
 */
export const DiffAgainstSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item_base"), rev: z.string() }),
  z.object({ kind: z.literal("fork"), rev: z.string() }),
  z.object({ kind: z.literal("burst"), burst: z.string(), actor: ActorSchema, at: z.string() })
])

/**
 * Diff projection fields from spec §14.3 and ui-components.md T-UI-11. `renamed_to` appears only on a rename.
 * @since 1.0.0
 * @category schemas
 */
export const DiffCardSchema = z.object({
  path: z.string(),
  branch: z.string(),
  against: DiffAgainstSchema,
  change: z.enum(["added", "modified", "deleted", "renamed"]),
  renamed_to: z.string().optional(),
  binary: z.object({ before_bytes: z.number().int().nonnegative(), after_bytes: z.number().int().nonnegative() })
    .optional(),
  hunks: z.array(z.object({
    old_start: z.number().int().nonnegative(),
    new_start: z.number().int().nonnegative(),
    lines: z.array(z.object({ op: z.enum([" ", "+", "-"]), text: z.string() }))
  }))
}).refine((diff) => diff.renamed_to === undefined || diff.change === "renamed", {
  message: "renamed_to belongs to a rename",
  path: ["renamed_to"]
})

/**
 * The value decoded by {@link DiffCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type DiffCard = z.infer<typeof DiffCardSchema>

/**
 * The Diff View's props. Its one button, Restore this file, appears only on a burst diff (§9.3.5).
 * @since 1.0.0
 * @category models
 */
export type DiffViewProps = CardProps<DiffCard>

/**
 * Typed catalog callbacks for Diff.
 * @since 1.0.0
 * @category models
 */
export type DiffCardCallbacks = CardCallbacks<"file" | "diff" | "file.restore">
