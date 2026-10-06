import { Result } from "effect"
import { decodeClaudeCode, decodeCodex } from "../../../packages/smithers/agent/harness/src/ExternalTranscript.ts"
import type { Context, State } from "../../../packages/smithers/agent/harness/src/ExternalTranscript.ts"

/** Inert normalization inside the existing install-shipped host. No files,
 * commands, model seats or provider credentials are used by this endpoint. */
export const normalizeTranscript = async (request: Request, authorized: (request: Request) => boolean): Promise<Response> => {
  if (!authorized(request)) return Response.json({ code: "unauthorized" }, { status: 401 })
  let raw: unknown
  try { raw = await request.json() } catch { return Response.json({ code: "request_invalid" }, { status: 400 }) }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return Response.json({ code: "request_invalid" }, { status: 400 })
  const value = raw as Record<string, unknown>
  const context = value.context
  if (typeof context !== "object" || context === null || Array.isArray(context) || typeof value.record !== "string" || typeof value.profile !== "string" || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || (value.start as number) < 0 || (value.end as number) - (value.start as number) !== new TextEncoder().encode(value.record).length + 1 || value.record.includes("\n") || value.record.includes("\0")) {
    return Response.json({ code: "request_invalid" }, { status: 400 })
  }
  if (new TextEncoder().encode(value.record).length > 1024 * 1024) return Response.json({ code: "request_invalid" }, { status: 400 })
  const binding = context as unknown as Context
  if ([binding.owner_id, binding.participant_id, binding.session_id, binding.source_generation].some((s) => typeof s !== "string" || s.length === 0 || s.length > 4096)) return Response.json({ code: "request_invalid" }, { status: 400 })
  // Checkpoints are host data, but malformed/stale callers still fail closed.
  const previous = value.state as State | undefined
  if ((previous === undefined && value.start !== 0) || (previous !== undefined && (typeof previous !== "object" || previous === null || previous.offset !== value.start || previous.pending !== "" || typeof previous.context !== "object" || previous.context === null || typeof previous.calls !== "object" || previous.calls === null || Array.isArray(previous.calls)))) {
    return Response.json({ code: "checkpoint_conflict" }, { status: 409 })
  }
  const decode = value.profile.startsWith("claude-code/") ? decodeClaudeCode : decodeCodex
  const result = decode(value.profile, binding, value.record + "\n", previous)
  if (Result.isFailure(result)) return Response.json({ code: "transcript_import_error", error: result.failure }, { status: 422 })
  if (result.success.state.offset !== value.end || result.success.needs_more) return Response.json({ code: "checkpoint_conflict" }, { status: 409 })
  return Response.json(result.success)
}
