import * as Transcript from "@smthrs/harness/ExternalTranscript"
import { Result, Schema } from "effect"

const Context = Schema.Struct({
  owner_id: Schema.String,
  participant_id: Schema.String,
  session_id: Schema.String,
  source_generation: Schema.String
})
/**
 * The decoder refused this record: a release line or a kind of record it does not read. The backend stops the
 * source and shows the import as stopped; it never retries under another profile.
 */
export class TranscriptRefused extends Error {
  readonly reason: Transcript.ExternalTranscriptErrorCode
  readonly line: number
  constructor(reason: Transcript.ExternalTranscriptErrorCode, line: number) {
    super(reason)
    this.reason = reason
    this.line = line
  }
}

// The decoders' own release lists name the profiles: one list, read in one place.
const profiles = [
  ...Transcript.codexReleases.map(release => `codex-rollout/${release}`),
  ...Transcript.claudeReleases.map(release => `claude-code/${release}`)
]
const Input = Schema.Struct({
  profile: Schema.String,
  context: Context,
  record: Schema.String,
  skipped: Schema.optional(Schema.Number),
  start: Schema.Number,
  end: Schema.Number,
  state: Schema.optional(Schema.Unknown)
})
const Base = { pending: Schema.String, line: Schema.Number, seq: Schema.Number }
const Codex = Schema.Struct({
  ...Base,
  session: Schema.optional(Schema.Struct({ id: Schema.String, format_version: Schema.String, cwd: Schema.String })),
  goal: Schema.optional(Schema.String),
  // Code-mode requests the decoder holds until their output: without them a failed script loses its request.
  calls: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ name: Schema.String, input: Schema.String })))
})
const Claude = Schema.Struct({
  ...Base,
  session: Schema.optional(Schema.String),
  turn: Schema.optional(Schema.String),
  calls: Schema.Record(Schema.String, Schema.Struct({ name: Schema.String, input: Schema.Unknown, at: Schema.Number }))
})
const Checkpoint = Schema.Struct({
  offset: Schema.Number,
  pending: Schema.Literal(""),
  profile: Schema.String,
  source_generation: Schema.String,
  decoder: Schema.Unknown
})

// The backend supplies registry identities and the checkpoint from its receipt
// transaction. Transcript session IDs never select a member or a branch.
export const normalizeTranscript = (value: unknown) => {
  const input = Schema.decodeUnknownSync(Input)(value)
  const context = input.context
  if (!/^[1-9]\d*$/.test(context.owner_id) || !/^[1-9]\d*$/.test(context.session_id) ||
    !/^[a-f0-9-]{36}$/.test(context.participant_id) ||
    !/^[a-f0-9-]{36}:[1-9]\d*$/.test(context.source_generation) ||
    Object.values(context).some(value => value.length > 160) ||
    !Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.end) || input.start < 0 ||
    input.end - input.start !== (input.skipped ?? Buffer.byteLength(input.record, "utf8")) + 1 ||
    (input.skipped !== undefined && (!Number.isSafeInteger(input.skipped) || input.skipped < 1024 * 1024 || Buffer.byteLength(input.record, "utf8") > 1024)) ||
    Buffer.byteLength(input.record, "utf8") === 0 ||
    Buffer.byteLength(input.record, "utf8") > 1024 * 1024 || /[\n\0]/.test(input.record)) {
    throw new Error("invalid transcript envelope")
  }
  if (!/^(?:codex-rollout|claude-code)\/\d+\.\d+$/.test(input.profile)) throw new Error("invalid transcript envelope")
  const previous = input.state === undefined ? undefined : Schema.decodeUnknownSync(Checkpoint)(input.state)
  if (previous === undefined ? input.start !== 0 : previous.offset !== input.start ||
    previous.profile !== input.profile || previous.source_generation !== context.source_generation) {
    throw new Error("invalid transcript checkpoint")
  }
  const codex = input.profile.startsWith("codex-rollout/")
  // The line a refusal names: the source line this record is, counted by the decoder's own checkpoint.
  const line = (previous === undefined ? 0 : Schema.decodeUnknownSync(Schema.Struct({ line: Schema.Number }))(previous.decoder).line) + 1
  if (input.skipped !== undefined) {
    // Agent lines are JSON; the skipped payload is only the daemon's note.
    if (/^[ \t\r]*[\{\[]/.test(input.record)) throw new Error("invalid transcript envelope")
    const decoder = previous === undefined ? (codex ? Transcript.codexStart : Transcript.claudeStart) :
      codex ? Schema.decodeUnknownSync(Codex)(previous.decoder) : Schema.decodeUnknownSync(Claude)(previous.decoder)
    validateState(decoder)
    const sourceId = `skipped:${input.start}`
    return {
      entries: [{
        id: `${context.source_generation}:${sourceId}`, source_id: sourceId, source_offset: input.start,
        seq: decoder.seq, at: 0, origin: "external", read_only: true,
        agent: codex ? "codex" : "claude-code", source_format_version: input.profile,
        session_id: context.session_id, participant_id: context.participant_id, owner_id: context.owner_id,
        author_id: context.participant_id, kind: "error", body: { type: "error", message: input.record }, failed: true
      }],
      state: { offset: input.end, pending: "", profile: input.profile, source_generation: context.source_generation,
        decoder: { ...decoder, line, seq: decoder.seq + 1 } },
      needs_more: false
    }
  }
  // An agent of a release line no decoder reads: the registered profile itself is the unsupported version.
  if (!profiles.includes(input.profile)) throw new TranscriptRefused("unsupported_version", line)
  const decode = (): Result.Result<Transcript.Decoded<Transcript.CodexState | Transcript.ClaudeState>, Transcript.ExternalTranscriptError> => {
    if (codex) {
      const state = previous === undefined ? Transcript.codexStart : Schema.decodeUnknownSync(Codex)(previous.decoder)
      validateState(state)
      if (state.session !== undefined && state.session.format_version !== input.profile) throw new Error("profile changed")
      return Transcript.decodeCodex(state, input.record + "\n")
    }
    const state = previous === undefined ? Transcript.claudeStart : Schema.decodeUnknownSync(Claude)(previous.decoder)
    validateState(state)
    return Transcript.decodeClaude(state, input.record + "\n")
  }
  const result = decode()
  if (Result.isFailure(result)) throw new TranscriptRefused(result.failure.code, result.failure.line)
  const decoded = result.success
  validateState(decoded.state)
  const expected = input.profile
  // The transcript names another supported release line than the one this source was registered with.
  if ((codex && typeof decoded.state.session === "object" && decoded.state.session.format_version !== expected) ||
    decoded.entries.some(entry => entry.format_version !== expected)) throw new TranscriptRefused("unsupported_version", line)
  return {
    entries: decoded.entries.map(entry => {
      const part = entry.part
      // The owner's entries (a prompt, a goal) are prompts; the decoder gives them the user role and nothing in
      // the transcript can.
      const kind = entry.role === "user" ? "prompt" : part.type === "text" ? "assistant" :
        part.type === "reasoning" ? "thinking" : part.type === "tool" ?
        (part.status === "running" ? "tool_request" : "tool_result") :
        part.type === "edit" ? "edit" : part.type === "error" ? "error" : "attachment"
      return {
        id: `${context.source_generation}:${entry.source_id}`,
        source_id: entry.source_id,
        source_offset: input.start,
        seq: entry.seq,
        at: entry.at,
        ...(entry.turn_id === undefined ? {} : { turn_id: entry.turn_id }),
        origin: "external",
        read_only: true,
        agent: entry.agent_kind,
        source_format_version: input.profile,
        session_id: context.session_id,
        participant_id: context.participant_id,
        owner_id: context.owner_id,
        author_id: kind === "prompt" ? context.owner_id : context.participant_id,
        kind,
        body: part,
        ...("call_id" in part ? { call_id: part.call_id } : {}),
        failed: (part.type === "tool" && part.status === "error") || (part.type === "edit" && part.outcome === "failed")
      }
    }),
    state: { offset: input.end, pending: "", profile: input.profile, source_generation: context.source_generation, decoder: decoded.state },
    needs_more: false
  }
}

const validateState = (state: { pending: string; line: number; seq: number }) => {
  if (state.pending !== "" || !Number.isSafeInteger(state.line) || state.line < 0 ||
    !Number.isSafeInteger(state.seq) || state.seq < 0) throw new Error("invalid decoder checkpoint")
}
