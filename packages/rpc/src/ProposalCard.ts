/**
 * Proposal data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks } from "./CardAction.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

/**
 * Proposal projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const ProposalCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  todo: z.object({ n: z.number().int().positive(), title: z.string() }).optional(),
  evidence: z.array(z.string()),
  refs: z.array(z.object({ label: z.string(), url: HttpUrlSchema })),
  state: z.enum(["open", "accepted", "dismissed"])
})

/**
 * The value decoded by {@link ProposalCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type ProposalCard = z.infer<typeof ProposalCardSchema>

/**
 * Typed catalog callbacks for Proposal.
 * @since 1.0.0
 * @category models
 */
export type ProposalCardCallbacks = CardCallbacks<"todo.new" | "learning.accept" | "learning.dismiss">
