/** Host-owned context preflight contracts. @since 1.0.0 */
import { z } from "zod"
import { ContextItemSchema } from "./CardPrimitives.ts"

/** New selections always state their reason; historical lines remain readable. */
export const SelectedContextItemSchema = ContextItemSchema.extend({ reason: z.string().min(1) })
/** Repository data, pinned by the provider before selection. */
export const ContextCandidateSchema = z.object({
  item: ContextItemSchema.omit({ reason: true }).refine(item =>
    item.kind !== "issue" && (item.kind !== "file" && item.kind !== "page" || Boolean(item.revision)),
  { message: "Preflight files and wiki pages need a pinned revision" }),
  text: z.string()
}).strict()
/** The SharedEntries provider supplies these values, never the browser. */
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
/** Stored as the first step's durable output. */
export const ContextPreflightResultSchema = z.object({
  context: z.array(SelectedContextItemSchema),
  candidates: z.array(ContextItemSchema.omit({ reason: true })),
  model: z.string().min(1),
  durationMs: z.number().nonnegative()
}).strict()
export type ContextCandidate = z.infer<typeof ContextCandidateSchema>
export type ContextPreflightInput = z.infer<typeof ContextPreflightInputSchema>
export type ContextPreflightResult = z.infer<typeof ContextPreflightResultSchema>
