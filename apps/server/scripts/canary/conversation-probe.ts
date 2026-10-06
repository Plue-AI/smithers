import { z } from "zod"
import { AgentTurnFrameSchema } from "@smthrs/rpc/NativeAgent"

export const PROMPT_PATH = "/api/conversations/main/prompt"
export const promptBody = (key: string) => JSON.stringify({ prompt: "Say the word ok and nothing else.", idempotencyKey: key })
const Admission = z.object({ turnId: z.string().min(1), runId: z.string().min(1) })
const Conversation = z.object({ id: z.literal("main"), entries: z.array(z.object({
  id: z.string(), runId: z.string(), state: z.enum(["accepted", "running", "completed", "failed", "cancelled", "uncertain"]), frames: z.array(AgentTurnFrameSchema)
})) })

/** Probe the same durable admission and read projection the composer uses. */
export async function conversationProbe(options: {
  origin: string; key: string; headers: Record<string, string>; signal: AbortSignal;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>; until?: "first-frame" | "complete"
}) {
  const request = (path: string, init: RequestInit = {}) => options.fetch(`${options.origin}${path}`, { ...init, signal: options.signal, headers: { ...options.headers, ...init.headers } })
  const admission = await request(PROMPT_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: promptBody(options.key) })
  if (admission.status !== 202) { await admission.body?.cancel(); return { status: admission.status, frames: [], state: "refused" } }
  const accepted = Admission.parse(await admission.json())
  while (!options.signal.aborted) {
    const response = await request("/api/conversations/main")
    if (!response.ok) { await response.body?.cancel(); return { status: response.status, frames: [], state: "refused" } }
    const conversation = Conversation.parse(await response.json())
    const entry = conversation.entries.find(entry => entry.id === accepted.turnId)
    if (entry) {
      if (entry.runId !== accepted.runId || entry.frames.some(frame => frame.runId !== accepted.runId)) throw new Error("Conversation returned another run")
      if (["completed", "cancelled", "failed", "uncertain"].includes(entry.state) || options.until === "first-frame" && entry.frames.some(frame => frame.type === "delta")) {
        return { status: admission.status, ...entry }
      }
    }
    await options.sleep(100)
  }
  throw new Error("Conversation probe timed out")
}
