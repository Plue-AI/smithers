/**
 * The S1 live channel wire contract: the requests a browser sends, the committed
 * projection frames it receives, and the refusal for reserved S2/S3 frames.
 *
 * @since 1.0.0
 */

import { z } from "zod"

const id = z.number().int().min(1).max(0xffffffff)
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/**
 * S1 live channel requests: subscribe to a topic from an optional cursor,
 * unsubscribe, or ask for presence. Reserved presence is refused by the server.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LiveRequestSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), id, topic: z.string().min(1), cursor: cursor.optional() }),
  z.object({ t: z.literal("unsub"), id }),
  z.object({ t: z.literal("presence"), id })
])
/**
 * Committed projection frames: a snapshot, a delta, a gap that asks the client to
 * resubscribe, or an error that refuses only its subscription.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LiveReplySchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("snap"), id, cursor, data: z.unknown() }).refine((value) => Object.hasOwn(value, "data")),
  z.object({ t: z.literal("delta"), id, cursor, data: z.unknown() }).refine((value) => Object.hasOwn(value, "data")),
  z.object({ t: z.literal("gap"), id }),
  z.object({ t: z.literal("err"), id, code: z.enum(["unknown_topic", "forbidden", "unsupported"]) })
])
/**
 * A decoded {@link LiveRequestSchema} frame.
 *
 * @since 1.0.0
 * @category models
 */
export type LiveRequest = z.infer<typeof LiveRequestSchema>
/**
 * A decoded {@link LiveReplySchema} frame.
 *
 * @since 1.0.0
 * @category models
 */
export type LiveReply = z.infer<typeof LiveReplySchema>
/**
 * Thrown by {@link decodeLiveReserved} for a frame that is not a reserved S2/S3
 * kind. Reserved kinds have one S1 refusal, which keeps the subscription id.
 *
 * @since 1.0.0
 * @category errors
 */
export class LiveFrameRefused extends Error {
  readonly _tag = "LiveFrameRefused"
  readonly code = "not_reserved"
  constructor() {
    super("Not a reserved frame")
  }
}
/**
 * Answers a reserved S2/S3 frame with the S1 `unsupported` refusal for its
 * subscription id: a binary document frame, or a `presence` request. Any other
 * frame throws {@link LiveFrameRefused}.
 *
 * @since 1.0.0
 * @category parsers
 */
export function decodeLiveReserved(raw: unknown): LiveReply {
  if (raw instanceof Uint8Array && raw.length >= 5 && (raw[0] === 1 || raw[0] === 2)) {
    const id = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(1)
    return LiveReplySchema.parse({ t: "err", id, code: "unsupported" })
  }
  const request = LiveRequestSchema.parse(raw)
  if (request.t !== "presence") throw new LiveFrameRefused()
  return { t: "err", id: request.id, code: "unsupported" }
}
