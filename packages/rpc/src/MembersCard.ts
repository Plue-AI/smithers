/**
 * Members data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ActionSchema } from "./CardAction.ts"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { MemberColorIndexSchema, PersonRefSchema } from "./CardPrimitives.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

/**
 * Members projection fields from spec §14.3 and ui-components.md v0.4 (T-UI-09). `needs_access`: never had write
 * access on GitHub; `suspended`: lost it, automatically (M-05, §5.1.3). `add_refused`: why the last Add stored no row,
 * with `fix` linking where to fix it (a person without write access: the repository's access settings on GitHub).
 * Every Members command is person-only.
 * @since 1.0.0
 * @category schemas
 */
export const MembersCardSchema = z.object({
  members: z.array(
    z.object({
      ...PersonRefSchema.shape,
      color_index: MemberColorIndexSchema,
      role: z.enum(["owner", "maintainer", "member"]),
      needs_access: z.boolean(),
      suspended: z.boolean(),
      actions: z.array(ActionSchema)
    })
  ),
  access_url: HttpUrlSchema,
  add_refused: z.object({ text: z.string(), fix: HttpUrlSchema.optional() }).optional()
})

/**
 * The value decoded by {@link MembersCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type MembersCard = z.infer<typeof MembersCardSchema>

/**
 * The Members View's props (ui-components.md T-UI-09).
 * @since 1.0.0
 * @category models
 */
export type MembersViewProps = CardProps<MembersCard>

/**
 * Typed catalog callbacks for Members.
 * @since 1.0.0
 * @category models
 */
export type MembersCardCallbacks = CardCallbacks<"members" | "members.add" | "members.role" | "members.remove">
