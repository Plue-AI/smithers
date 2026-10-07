import * as Transcript from "@smthrs/harness/Transcript"
import { Result, Schema } from "effect"

const Context = Schema.Struct({
  owner_id: Schema.String,
  participant_id: Schema.String,
  session_id: Schema.String,
  source_generation: Schema.String
})
const Input = Schema.Struct({
  profile: Schema.Literals(["codex/0.160.0", "claude-code/2.1.0"]),
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
  context: Context,
  native: Schema.Unknown
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
  if (previous === undefined ? input.start !== 0 : previous.offset !== input.start || previous.profile !== input.profile) {
    throw new Error("invalid transcript checkpoint")
  }
  const codex = input.profile === "codex/0.160.0"
  const state = previous === undefined ? undefined : {
    ...previous,
    profile: input.profile,
    native: codex ? Schema.decodeUnknownSync(Codex)(previous.native) : Schema.decodeUnknownSync(Claude)(previous.native)
  }
  if (state !== undefined) validateState(state.native)
  const result = codex
    ? Transcript.decodeCodex(input.profile, context, input.record + "\n", state)
    : Transcript.decodeClaudeCode(input.profile, context, input.record + "\n", state)
  if (Result.isFailure(result)) throw new Error(result.failure._tag)
  const decoded = result.success
  validateState(decoded.state.native)
  if (decoded.needs_more || decoded.state.offset !== input.end) throw new Error("invalid decoder framing")
  return decoded
}

const validateState = (state: { pending: string; line: number; seq: number }) => {
  if (state.pending !== "" || !Number.isSafeInteger(state.line) || state.line < 0 ||
    !Number.isSafeInteger(state.seq) || state.seq < 0) throw new Error("invalid decoder checkpoint")
}
