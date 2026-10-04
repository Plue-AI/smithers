/**
 * Proposal data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

/**
 * Proposal projection fields from spec §14.3 and ui-components.md T-UI-20. `todo` is the TODO it became.
 * @since 1.0.0
 * @category schemas
 */
export const ProposalCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  evidence: z.array(z.string()),
  refs: z.array(z.object({ label: z.string(), url: HttpUrlSchema })),
  state: z.enum(["open", "accepted", "dismissed"]),
  todo: z.object({ n: z.number().int().positive(), title: z.string() }).optional()
})

/**
 * The value decoded by {@link ProposalCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type ProposalCard = z.infer<typeof ProposalCardSchema>

/**
 * The Proposal View's props (ui-components.md T-UI-20).
 * @since 1.0.0
 * @category models
 */
export type ProposalViewProps = CardProps<ProposalCard, {}, "todo">

/**
 * The lessons receipt on a merged TODO: the pages and proposals learning wrote (ui-components.md T-UI-20).
 * @since 1.0.0
 * @category schemas
 */
export const LessonsReceiptSchema = z.object({
  todo: z.number().int().positive(),
  lessons: z.array(z.object({ title: z.string(), ref: z.string() }))
})

/**
 * The value decoded by {@link LessonsReceiptSchema}.
 * @since 1.0.0
 * @category models
 */
export type LessonsReceipt = z.infer<typeof LessonsReceiptSchema>

/**
 * Typed catalog callbacks for Proposal.
 * @since 1.0.0
 * @category models
 */
export type ProposalCardCallbacks = CardCallbacks<"learning.accept" | "learning.dismiss">

/**
 * Props for lesson page and proposal navigation supplied by the container.
 * @since 1.0.0
 * @category models
 */
export type LessonsReceiptViewProps = CardProps<LessonsReceipt, {}, string>
