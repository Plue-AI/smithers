import { Effect } from "effect"
import { CONVERSATIONS_PATH, CONVERSATION_REPLAY_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { AgentConversationPageSchema, AgentConversationReplaySchema } from "@smthrs/rpc/AgentTurnJournal"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { AgentJournalIntegrityError, type AgentPort } from "../runtime/AgentPort"

export interface WebAgentOptions {
  readonly baseUrl?: string
  readonly fetchImpl?: FetchLike
}

/** Read-only private Earlier history. Shared turns are owned by the install host. */
export const createWebAgent = (options: WebAgentOptions = {}): AgentPort => {
  const baseUrl = options.baseUrl ?? ""
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
  // Account reads are finite JSON, with the deadline covering their body.
  // The cap matches the app request seam and exceeds the bounded server page.
  const historyJson = (path: string, init?: RequestInit): Promise<unknown> => Effect.runPromise(Effect.tryPromise({
    try: async signal => {
      const response = await fetchImpl(`${baseUrl}${path}`, { ...init, signal })
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error("This saved conversation is unavailable.") }
      const reader = response.body?.getReader()
      if (!reader) throw new AgentJournalIntegrityError("Invalid conversation response")
      const abort = (): void => { void reader.cancel().catch(() => {}) }
      signal.addEventListener("abort", abort, { once: true })
      try {
        const decoder = new TextDecoder(), parts: string[] = []; let bytes = 0
        while (true) {
          const chunk = await reader.read()
          if (signal.aborted) throw new Error("Conversation history timed out.")
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 8 * 1024 * 1024) throw new AgentJournalIntegrityError("Conversation response exceeds its bound")
          parts.push(decoder.decode(chunk.value, { stream: true }))
        }
        parts.push(decoder.decode())
        try { const value: unknown = JSON.parse(parts.join("")); return value }
        catch { throw new AgentJournalIntegrityError("Invalid conversation response") }
      } finally { signal.removeEventListener("abort", abort); abort(); reader.releaseLock() }
    }, catch: error => error instanceof Error ? error : new Error("Conversation history is unavailable.")
  }).pipe(Effect.timeoutOrElse({ duration: 10_000, orElse: () => Effect.fail(new Error("Conversation history timed out.")) })))

  return {
    available: false,
    startTurn: async () => ({ status: "error", message: "Use the branch conversation to ask Smithers." }),
    cancelTurn: async () => {},
    subscribe: () => () => {},
    history: {
      list: async after => {
        const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`
        const parsed = AgentConversationPageSchema.safeParse(await historyJson(`${CONVERSATIONS_PATH}${query}`))
        if (!parsed.success) throw new AgentJournalIntegrityError("Invalid conversation index")
        return parsed.data
      },
      replay: async access => {
        const parsed = AgentConversationReplaySchema.safeParse(await historyJson(CONVERSATION_REPLAY_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(access) }))
        if (!parsed.success) throw new AgentJournalIntegrityError("Invalid account replay")
        return parsed.data
      }
    }
  }
}
