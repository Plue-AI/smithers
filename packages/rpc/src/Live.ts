import { z } from "zod"

const id = z.number().int().min(1).max(0xffffffff)
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** S1 live channel requests. Reserved presence is refused by the server. */
export const LiveRequestSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), id, topic: z.string().min(1), cursor: cursor.optional() }),
  z.object({ t: z.literal("unsub"), id }),
  z.object({ t: z.literal("presence"), id })
])
/** Committed projection frames; an error refuses only its subscription. */
export const LiveReplySchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("snap"), id, cursor, data: z.unknown() }).refine((value) => Object.hasOwn(value, "data")),
  z.object({ t: z.literal("delta"), id, cursor, data: z.unknown() }).refine((value) => Object.hasOwn(value, "data")),
  z.object({ t: z.literal("gap"), id }),
  z.object({ t: z.literal("err"), id, code: z.enum(["unknown_topic", "forbidden", "unsupported"]) })
])
export type LiveRequest = z.infer<typeof LiveRequestSchema>
export type LiveReply = z.infer<typeof LiveReplySchema>
/** Reserved S2/S3 kinds have one S1 refusal, retaining the subscription id. */
export function decodeLiveReserved(raw: unknown): LiveReply {
  if (raw instanceof Uint8Array && raw.length >= 5 && (raw[0] === 1 || raw[0] === 2)) {
    const id = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(1)
    return LiveReplySchema.parse({ t: "err", id, code: "unsupported" })
  }
  const request = LiveRequestSchema.parse(raw)
  if (request.t !== "presence") throw new Error("Not a reserved frame")
  return { t: "err", id: request.id, code: "unsupported" }
}
