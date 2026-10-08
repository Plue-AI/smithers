import * as Transcript from "@smthrs/harness/ExternalTranscript"
import { Result, Schema } from "effect"

const Context = Schema.Struct({
  owner_id: Schema.String,
  participant_id: Schema.String,
  session_id: Schema.String,
  source_generation: Schema.String
})
const Input = Schema.Struct({
  profile: Schema.Literals(["codex-rollout/0.159", "codex-rollout/0.160", "claude-code/2.1"]),
  context: Context,
  record: Schema.String,
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
    input.end - input.start !== Buffer.byteLength(input.record, "utf8") + 1 ||
    Buffer.byteLength(input.record, "utf8") > 1024 * 1024 || /[\n\0]/.test(input.record)) {
    throw new Error("invalid transcript envelope")
  }
  const previous = input.state === undefined ? undefined : Schema.decodeUnknownSync(Checkpoint)(input.state)
  if (previous === undefined ? input.start !== 0 : previous.offset !== input.start ||
    previous.profile !== input.profile || previous.source_generation !== context.source_generation) {
    throw new Error("invalid transcript checkpoint")
  }
  const codex = input.profile.startsWith("codex-rollout/")
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
  if (Result.isFailure(result)) throw new Error(result.failure.code)
  const decoded = result.success
  validateState(decoded.state)
  const expected = input.profile
  if (codex && typeof decoded.state.session === "object" && decoded.state.session.format_version !== expected) throw new Error("profile changed")
  if (decoded.entries.some(entry => entry.format_version !== expected)) throw new Error("profile changed")
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
