/**
 * Draft data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { TodoStateSchema } from "./CardPrimitives.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

const PlaceOptionsSchema = z.array(
  z.object({
    n: z.number().int().positive(),
    title: z.string(),
    // Unmerged items only: merged and dropped items have no place on the stack (spec §14.3 Draft, T-UI-04 `place`).
    state: TodoStateSchema.exclude(["merged", "dropped"])
  })
)

/**
 * A Draft's id: the conversation entry that holds it (spec §14.5.1). `draft.discard` names it.
 * @since 1.0.0
 * @category schemas
 */
export const DraftIdSchema = z.string().min(1)

/**
 * Draft projection fields from spec §14.3 and ui-components.md v0.4 (T-UI-03). `place.n` comes with before and
 * amend only.
 * @since 1.0.0
 * @category schemas
 */
export const DraftCardSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  acceptance: z.array(z.string()),
  place: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("append"), options: PlaceOptionsSchema }),
    z.object({ mode: z.enum(["before", "amend"]), n: z.number().int().positive(), options: PlaceOptionsSchema })
  ]),
  issue: z.object({ number: z.number().int().positive(), title: z.string(), url: HttpUrlSchema, fixes: z.boolean() })
    .optional(),
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
 * The Draft View's props. `gestures.set` is a field edit sent on blur as `{ field, value }` (`form.set`, T-APP-02).
 * @since 1.0.0
 * @category models
 */
export type DraftViewProps = CardProps<DraftCard, {}, "set">

/**
 * Typed catalog callbacks for Draft.
 * @since 1.0.0
 * @category models
 */
export type DraftCardCallbacks = CardCallbacks<"todo.new" | "todo.amend" | "form.set" | "draft.discard">
