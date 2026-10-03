/**
 * Draft data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks } from "./CardAction.ts"
import { TodoStateSchema } from "./CardPrimitives.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

/**
 * Draft projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const DraftCardSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  acceptance: z.array(z.string()),
  issue: z.object({ number: z.number().int().positive(), title: z.string(), url: HttpUrlSchema, fixes: z.boolean() })
    .optional(),
  place: z.object({
    mode: z.enum(["append", "before", "amend"]),
    n: z.number().int().positive().optional(),
    options: z.array(z.object({ n: z.number().int().positive(), title: z.string(), state: TodoStateSchema }))
  }),
  seed: z.object({ files: z.array(z.string()) }).optional(),
  committed: z.object({ n: z.number().int().positive(), rev: z.number().int().positive() }).optional(),
  private: z.boolean()
})

/**
 * The value decoded by {@link DraftCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type DraftCard = z.infer<typeof DraftCardSchema>

/**
 * Typed catalog callbacks for Draft.
 * @since 1.0.0
 * @category models
 */
export type DraftCardCallbacks = CardCallbacks<"todo.new" | "todo.amend">
