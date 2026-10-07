/**
 * Bounded records for the host-owned preflight input.
 *
 * @since 1.0.0
 */

import { ContextCandidateSchema, ContextPreflightInputSchema } from "@smthrs/rpc/ContextPreflight"
import type { ContextPreflightInput } from "@smthrs/rpc/ContextPreflight"
import { z } from "zod"
import { ResolveFailed } from "../ModelHostError.ts"

const MAX_RECORD_BYTES = 2 * 1024 * 1024
const HeaderSchema = ContextPreflightInputSchema.omit({ recent: true, candidates: true })
const RecordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), version: z.literal(1), value: HeaderSchema }).strict(),
  z.object({ type: z.literal("recent"), value: ContextPreflightInputSchema.shape.recent.element }).strict(),
  z.object({ type: z.literal("candidate"), value: ContextCandidateSchema }).strict(),
  z.object({
    type: z.literal("end"),
    recent: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative()
  })
    .strict()
])

/**
 * Assemble the existing input schema from bounded, ordered records. The end
 * record binds both counts; EOF alone never authorizes a partial selection.
 * @private
 * @since 1.0.0
 */
export const readContextStream = async (response: Response): Promise<ContextPreflightInput> => {
  if (response.headers.get("content-type") !== "application/x-ndjson" || response.body === null) {
    await response.body?.cancel()
    throw new ResolveFailed({ message: "context stream unavailable" })
  }
  const reader = response.body.getReader()
  let header: z.infer<typeof HeaderSchema> | undefined
  const recent: ContextPreflightInput["recent"] = []
  const candidates: ContextPreflightInput["candidates"] = []
  let ended = false
  let complete = false
  let size = 0
  let fragments: Array<Uint8Array> = []
  const decode = new TextDecoder("utf-8", { fatal: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      let start = 0
      while (start < value.length) {
        const newline = value.indexOf(10, start)
        const stop = newline < 0 ? value.length : newline + 1
        const fragment = value.subarray(start, stop)
        size += fragment.length
        if (size > MAX_RECORD_BYTES) throw new ResolveFailed({ message: "context record too large" })
        fragments.push(fragment)
        start = stop
        if (newline < 0) continue
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const part of fragments) {
          bytes.set(part, offset)
          offset += part.length
        }
        const record = RecordSchema.parse(JSON.parse(decode.decode(bytes)))
        if (ended || (header === undefined && record.type !== "input")) {
          throw new ResolveFailed({ message: "context record out of order" })
        }
        switch (record.type) {
          case "input":
            if (header !== undefined) throw new ResolveFailed({ message: "duplicate context header" })
            header = record.value
            break
          case "recent":
            if (candidates.length !== 0) throw new ResolveFailed({ message: "late context history" })
            recent.push(record.value)
            break
          case "candidate":
            candidates.push(record.value)
            break
          case "end":
            if (record.recent !== recent.length || record.candidates !== candidates.length) {
              throw new ResolveFailed({ message: "context count mismatch" })
            }
            ended = true
        }
        size = 0
        fragments = []
      }
    }
    if (!ended || size !== 0) throw new ResolveFailed({ message: "incomplete context stream" })
    const input = ContextPreflightInputSchema.parse({ ...header, recent, candidates })
    complete = true
    return input
  } finally {
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
