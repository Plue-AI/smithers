import { z } from "zod"
import { ContextItemSchema } from "@smthrs/rpc/CardPrimitives"
import { readErrorMessage, readResult, type SeamFetch } from "./SeamContext"

// T-APP-17: extend the retained item decoder; old answers need no backfill.
export const StoredContextItemSchema = ContextItemSchema.extend({ reason: z.string() })
export const StoredAnswerSchema = z.object({ id: z.string(), runId: z.string().min(1).optional(), context: z.array(StoredContextItemSchema).optional() })
export type StoredAnswer = z.infer<typeof StoredAnswerSchema>
export interface ContextProvider {
  // Only supplied after SharedEntries, durable answers, View and card handlers pass C-UI-07.
  readonly available: () => boolean
  /** Present the full list embedded and read-only, with preflight first; never maximize. */
  readonly present: (answer: StoredAnswer, branch: string, actor: "user" | "smithers") => Promise<void>
}
export const createContextSeam = (http: SeamFetch, baseUrl: string, provider?: ContextProvider,
  captureCurrent: () => () => boolean = () => () => true,
  actor: () => "user" | "smithers" = () => "user") => {
  const contextAvailable = () => provider?.available() === true
  const inspectContext = async (branch: string, answer: string) => {
    if (!contextAvailable()) return "Context is unavailable"
    const current = captureCurrent()
    const principal = actor()
    try {
      const response = await http(`${baseUrl}/api/conversations/${encodeURIComponent(branch)}`, { method: "GET" })
      if (!current() || !contextAvailable()) return "Context is unavailable"
      if (!response.ok) return await readErrorMessage(response, "Context could not be read")
      // Assumed entries envelope, pending T-APP-16. Never select from browser history.
      const body = z.object({ entries: z.array(z.unknown()) }).parse(await response.json())
      const raw = body.entries.find(entry => typeof entry === "object" && entry !== null && "id" in entry && entry.id === answer)
      const stored = StoredAnswerSchema.parse(raw)
      if (stored.context === undefined || !current() || !contextAvailable()) return "Context is unavailable"
      await provider!.present(stored, branch, principal)
      return readResult(JSON.stringify(stored))
    } catch { return "Context could not be read" }
  }
  return { contextAvailable, inspectContext }
}
