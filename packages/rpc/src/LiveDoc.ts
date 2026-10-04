import { z } from "zod"

// No existing RPC module describes the reserved stage-3 document channel.
/**
 * The maximum document frame size accepted for transmission.
 * @since 1.0.0
 * @category models
 */
export const LIVE_DOC_SEND_BUDGET = 2 * 1024 * 1024
/**
 * Validates a document channel identifier at the wire boundary.
 * @since 1.0.0
 * @category schemas
 */
export const LiveDocId = z.number().int().min(1).max(0xffffffff)
const path = z.string().min(1).refine((value) =>
  new TextEncoder().encode(value).length <= 4096 &&
  new TextDecoder().decode(new TextEncoder().encode(value)) === value &&
  !/[\\\u0000]/.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
)
const identifier = z.string().regex(/^[^:\s/\\\u0000]+$/).refine((value) =>
  new TextDecoder().decode(new TextEncoder().encode(value)) === value
)
/**
 * Validates a code or wiki document subscription.
 * @since 1.0.0
 * @category schemas
 */
export const LiveDocTopic = z.union([
  z.strictObject({ kind: z.literal("code"), branch: identifier, path }),
  z.strictObject({ kind: z.literal("wiki"), page: identifier })
])
/**
 * The value decoded by {@link LiveDocTopic}.
 * @since 1.0.0
 * @category models
 */
export type LiveDocTopic = z.infer<typeof LiveDocTopic>

/**
 * Decodes a document subscription topic into its validated channel.
 * @since 1.0.0
 * @category constructors
 */
export function parseLiveDocTopic(topic: string): LiveDocTopic {
  const code = /^doc:code:([^:]+):(.+)$/.exec(topic)
  if (code) return LiveDocTopic.parse({ kind: "code", branch: code[1], path: code[2] })
  return LiveDocTopic.parse({ kind: "wiki", page: /^doc:wiki:([^:]+)$/.exec(topic)?.[1] })
}

const base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
/**
 * Validates a document channel reply at the wire boundary.
 * @since 1.0.0
 * @category schemas
 */
export const LiveDocReply = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("snap"),
    id: LiveDocId,
    cursor: z.number().int().nonnegative(),
    data: z.strictObject({ epoch: z.string().regex(/^[0-9a-f]{32}$/), client_id: LiveDocId })
  }),
  z.strictObject({ t: z.literal("saved"), id: LiveDocId, sv: base64, at: z.iso.datetime() }),
  z.strictObject({ t: z.literal("gap"), id: LiveDocId }),
  z.strictObject({ t: z.literal("err"), id: LiveDocId, code: z.enum(["unknown_topic", "forbidden", "unsupported"]) })
])
/**
 * The value decoded by {@link LiveDocReply}.
 * @since 1.0.0
 * @category models
 */
export type LiveDocReply = z.infer<typeof LiveDocReply>
/**
 * The HTTP status returned for a stale document write.
 * @since 1.0.0
 * @category errors
 */
export const LIVE_DOC_STALE_STATUS = 409
/**
 * Validates a stale or unsupported document write refusal.
 * @since 1.0.0
 * @category schemas
 */
export const LiveDocWriteRefusal = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal("stale"),
    class: z.literal("conflict"),
    message: z.string(),
    current_digest: z.string().regex(/^[0-9a-f]{64}$/).optional()
  }),
  z.strictObject({ code: z.literal("unsupported"), class: z.literal("infra"), message: z.string() })
])

/**
 * A malformed or oversized document frame refused before transmission.
 * @since 1.0.0
 * @category errors
 */
export class LiveDocBinaryRejected extends Error {
  readonly _tag = "LiveDocBinaryRejected"
  readonly code: "malformed" | "frame_too_large"
  constructor(code: "malformed" | "frame_too_large") {
    super(code)
    this.name = "LiveDocBinaryRejected"
    this.code = code
  }
}

/**
 * A document update or state vector carried in a binary frame.
 * @since 1.0.0
 * @category models
 */
export type LiveDocBinary = { kind: 1 | 2; id: number; payload: Uint8Array }
/**
 * Decodes a validated document binary frame.
 * @since 1.0.0
 * @category constructors
 */
export function decodeLiveDocBinary(bytes: Uint8Array): LiveDocBinary {
  if (bytes.byteLength < 5 || (bytes[0] !== 1 && bytes[0] !== 2)) throw new LiveDocBinaryRejected("malformed")
  if (bytes.byteLength > LIVE_DOC_SEND_BUDGET) throw new LiveDocBinaryRejected("frame_too_large")
  const id = LiveDocId.parse(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1))
  return { kind: bytes[0], id, payload: bytes.slice(5) }
}

/**
 * Encodes a document binary frame within the send budget.
 * @since 1.0.0
 * @category constructors
 */
export function encodeLiveDocBinary(frame: LiveDocBinary): Uint8Array {
  LiveDocId.parse(frame.id)
  if (frame.kind !== 1 && frame.kind !== 2) throw new LiveDocBinaryRejected("malformed")
  if (frame.payload.byteLength + 5 > LIVE_DOC_SEND_BUDGET) throw new LiveDocBinaryRejected("frame_too_large")
  const bytes = new Uint8Array(frame.payload.byteLength + 5)
  bytes[0] = frame.kind
  new DataView(bytes.buffer).setUint32(1, frame.id)
  bytes.set(frame.payload, 5)
  return bytes
}
