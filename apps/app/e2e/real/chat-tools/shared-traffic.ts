import { AgentTurnFrameSchema } from "@smthrs/rpc/NativeAgent"
import { z } from "zod"

export const sharedPromptRequest = (method: string, url: string): boolean =>
  method === "POST" && /^\/api\/conversations\/[^/]+\/prompt$/.test(new URL(url).pathname)

export const sharedStopRequest = (method: string, url: string): boolean =>
  method === "POST" && /^\/api\/conversations\/[^/]+\/turns\/[^/]+\/stop$/.test(new URL(url).pathname)

const snapshotSchema = z.object({ entries: z.array(z.object({ id: z.string(), runId: z.string(), frames: z.array(AgentTurnFrameSchema) })) })

/** A reply belongs to the admitted prompt, never the latest unrelated author. */
export const admittedReplyFrames = (snapshot: unknown, turnId: string) => {
  const entry = snapshotSchema.parse(snapshot).entries.find(entry => entry.id === turnId)
  if (!entry) return []
  if (entry.frames.some(frame => frame.runId !== entry.runId)) throw new Error("Reply frames cross the admitted run")
  const terminal = entry.frames.findIndex(frame => frame.type === "done")
  if (terminal >= 0 && terminal !== entry.frames.length - 1) throw new Error("Reply frames extend a terminal reply")
  return entry.frames
}
