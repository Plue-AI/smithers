/**
 * Members data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks } from "./CardAction.ts"
import { PersonRefSchema } from "./CardPrimitives.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

/**
 * Members projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const MembersCardSchema = z.object({
  access_url: HttpUrlSchema,
  members: z.array(
    z.object({
      login: z.string(),
      name: z.string(),
      avatar_url: PersonRefSchema.shape.avatar_url,
      role: z.enum(["owner", "maintainer", "member"]),
      needs_access: z.boolean(),
      suspended: z.boolean()
    })
  )
})

/**
 * The value decoded by {@link MembersCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type MembersCard = z.infer<typeof MembersCardSchema>

/**
 * Typed catalog callbacks for Members.
 * @since 1.0.0
 * @category models
 */
export type MembersCardCallbacks = CardCallbacks<"members" | "members.add" | "members.role" | "members.remove">
