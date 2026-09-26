/** Signed event payloads name source; a workspace tip cannot substitute for it. */
import { CodingError } from "../coding/schema.ts"
import type { Event } from "./schema.ts"
const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const commit = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value)
const zero = "0".repeat(40)
export const sourceEvent = (event: typeof Event.Type) => {
  if (event.source !== "github" || event.type !== "push") return { ignored: false, payload: event.payload }
  const payload = object(event.payload)
  if (event.action !== "" && event.action !== "pushed") throw invalid("GitHub push events do not have that action")
  if (
    !commit(payload.before) || !commit(payload.after) || typeof payload.ref !== "string" ||
    !/^refs\/(heads|tags)\/[^\s]+$/.test(payload.ref)
  ) throw invalid("The GitHub push must name its exact ref and before/after commits")
  if (payload.deleted === true) {
    if (payload.after !== zero || payload.before === zero) {
      throw invalid("The deleted ref has an invalid GitHub push identity")
    }
    return { ignored: true, payload: event.payload }
  }
  if (payload.after === zero || payload.before === zero && payload.created !== true) {
    throw invalid("The GitHub push has no valid candidate or creation identity")
  }
  return {
    ignored: false,
    sourceRevision: payload.after,
    payload: {
      ...payload,
      candidateCommitId: payload.after,
      baseCommitId: payload.before
    } as typeof Event.Type["payload"]
  }
}
