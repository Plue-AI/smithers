import { z } from "zod"

/** A projection on the existing Wiki row, not a second document store. */
export const CloudWikiState = z.object({
  repo: z.string(),
  pageId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  slug: z.string(),
  /** The page's space (D-18 wiki: public or private); absent on rows saved before spaces existed, which were public. */
  visibility: z.enum(["public", "private"]).optional(),
  /** The page's Markdown path in its space (`Guides/Start.md`); absent before paths existed. */
  path: z.string().optional(),
  remoteRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  remoteAuthor: z.string(),
  remoteUpdatedAt: z.string(),
  state: z.string(),
  accountLogin: z.string(),
  branchId: z.string(),
  phase: z.enum(["cached", "live", "offline", "deleted"]),
  error: z.string().nullable(),
  pending: z.array(z.object({
    updateId: z.string().uuid(),
    update: z.string(),
    actor: z.enum(["user", "smithers"]),
    // Older saved updates were created by already-admitted handlers.
    admitted: z.boolean().optional()
  }))
})
export type CloudWikiState = z.infer<typeof CloudWikiState>
