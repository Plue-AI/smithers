/**
 * Host-owned context preflight contracts.
 *
 * @since 1.0.0
 */

import { z } from "zod"
import { ContextItemSchema } from "./CardPrimitives.ts"

/**
 * New selections always state their reason; historical lines remain readable.
 *
 * @since 1.0.0
 * @category schemas
 */
export const SelectedContextItemSchema = ContextItemSchema.extend({ reason: z.string().min(1) })
/**
 * Repository data, pinned by the provider before selection.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ContextCandidateSchema = z.object({
  item: ContextItemSchema.omit({ reason: true }).refine(
    (item) => item.kind !== "issue" && (item.kind !== "file" && item.kind !== "page" || Boolean(item.revision)),
    { message: "Preflight files and wiki pages need a pinned revision" }
  ),
  text: z.string()
}).strict()
/**
 * The SharedEntries provider supplies these values, never the browser.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ContextPreflightInputSchema = z.object({
  prompt: z.string().min(1),
  author: z.string().min(1),
  branch: z.string().min(1),
  state: z.string(),
  recent: z.array(z.object({ title: z.string(), summary: z.string().optional(), text: z.string() }).strict()),
  candidates: z.array(ContextCandidateSchema),
  tokenBudget: z.number().int().nonnegative().max(1000000).default(24000),
  wikiOnly: z.boolean().default(false)
}).strict()
/**
 * Stored as the first step's durable output.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ContextPreflightResultSchema = z.object({
  context: z.array(SelectedContextItemSchema),
  candidates: z.array(ContextItemSchema.omit({ reason: true })),
  model: z.string().min(1),
  durationMs: z.number().nonnegative()
}).strict()
/**
 * Pinned repository context.
 *
 * @since 1.0.0
 * @category models
 */
export type ContextCandidate = z.infer<typeof ContextCandidateSchema>
/**
 * Host-supplied selection input.
 *
 * @since 1.0.0
 * @category models
 */
export type ContextPreflightInput = z.infer<typeof ContextPreflightInputSchema>
/**
 * Durable context selection output.
 *
 * @since 1.0.0
 * @category models
 */
export type ContextPreflightResult = z.infer<typeof ContextPreflightResultSchema>

/**
 * Numbered pages of one durable preflight phase. Old unpaged frames remain readable.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ContextPreflightPageSchema = z.object({
  index: z.number().int().nonnegative(),
  total: z.number().int().positive()
}).strict().refine((page) => page.index < page.total)
/**
 * One journal frame; a paged frame always names its phase.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ContextPreflightFrameSchema = z.object({
  runId: z.string(),
  type: z.literal("context.preflight"),
  phase: z.enum(["started", "completed"]).optional(),
  page: ContextPreflightPageSchema.optional(),
  // Optional for replay of frames recorded before host timing was available.
  at: z.number().finite().nonnegative().optional(),
  clock: z.string().regex(/^host monotonic:.+$/).optional(),
  result: ContextPreflightResultSchema
}).refine((frame) => frame.page === undefined || frame.phase !== undefined)
  .refine((frame) => (frame.at === undefined) === (frame.clock === undefined))
/**
 * Replay progress is persisted with the existing HTTP turn projection.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ContextPreflightProgressSchema = z.object({
  preflight: ContextPreflightResultSchema.optional(),
  preflightPhase: z.enum(["started", "completed"]).optional(),
  preflightPage: z.object({
    phase: z.enum(["started", "completed"]),
    next: z.number().int().positive(),
    total: z.number().int().positive()
  }).strict().optional()
})
/**
 * One durable preflight journal frame.
 *
 * @since 1.0.0
 * @category models
 */
export type ContextPreflightFrame = z.infer<typeof ContextPreflightFrameSchema>
/**
 * Persisted preflight replay progress.
 *
 * @since 1.0.0
 * @category models
 */
export type ContextPreflightProgress = z.infer<typeof ContextPreflightProgressSchema>

/**
 * An out-of-order or inconsistent preflight page refused during replay.
 * @since 1.0.0
 * @category errors
 */
export class ContextPreflightRejected extends Error {
  readonly _tag = "ContextPreflightRejected"
  readonly code: "invalid_page_sequence"
  constructor(code: "invalid_page_sequence", message: string) {
    super(message)
    this.code = code
    this.name = "ContextPreflightRejected"
  }
}

/**
 * Fold complete phases only; interrupted pages never expose a completed selection.
 *
 * @since 1.0.0
 * @category projections
 */
export const projectContextPreflight = (
  prior: ContextPreflightProgress,
  frame: ContextPreflightFrame
): ContextPreflightProgress => {
  const parsed = ContextPreflightFrameSchema.parse(frame)
  const phase = parsed.phase ?? "completed"
  if (parsed.page === undefined) return { preflight: parsed.result, preflightPhase: phase, preflightPage: undefined }
  const { index, total } = parsed.page
  let result = parsed.result
  if (index > 0) {
    const pending = prior.preflightPage
    if (
      pending === undefined || prior.preflight === undefined || pending.next !== index || pending.total !== total ||
      pending.phase !== phase ||
      prior.preflight.model !== result.model || prior.preflight.durationMs !== result.durationMs
    ) throw new ContextPreflightRejected("invalid_page_sequence", "Invalid preflight page sequence")
    result = {
      ...result,
      context: [...prior.preflight.context, ...result.context],
      candidates: [...prior.preflight.candidates, ...result.candidates]
    }
  }
  const complete = index + 1 === total
  return {
    preflight: result,
    preflightPhase: complete ? phase : "started",
    preflightPage: complete ? undefined : { phase, next: index + 1, total }
  }
}
