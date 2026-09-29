/**
 * The HTTP contract between the browser shell (app/, src/) and the Worker
 * (worker/). Both sides import these schemas; nothing else crosses the wire.
 */
import * as Schema from "effect/Schema"
import { AppCard, TurnFrame } from "@smthrs/create-app/ui"

/** What a reader sees for a failure that is not a designed refusal. */
export const UNKNOWN_FAILURE_SENTENCE = "Something went wrong on our side. Not your fault."

export const Routes = {
  turn: "/api/agent/turn",
  turnCancel: "/api/agent/turn/cancel",
  session: "/api/session",
  flows: "/api/flows",
  flowRun: "/api/flows/run",
  health: "/api/health"
} as const

export const Message = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  at: Schema.Number
})
export type Message = typeof Message.Type

/** POST /api/agent/turn -> NDJSON stream of TurnFrame */
export const TurnRequest = Schema.Struct({
  sessionId: Schema.String,
  flowId: Schema.String,
  message: Schema.String
})
export type TurnRequest = typeof TurnRequest.Type

/** POST /api/agent/turn/cancel */
export const CancelRequest = Schema.Struct({ sessionId: Schema.String })
export type CancelRequest = typeof CancelRequest.Type

/**
 * GET /api/session (no id): one row of the Recent column.
 *
 * `title` is the session's first user message, trimmed to one line. `stage` is
 * the id of the flow the session last ran, so the column reads "chat" or
 * "build" beside the age. `at` is epoch milliseconds of the last activity.
 */
export const SessionSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.Literals(["ready", "running", "failed", "idle"]),
  stage: Schema.String,
  at: Schema.Number
})
export type SessionSummary = typeof SessionSummary.Type

/** GET /api/session (no id): the whole Recent column, newest first. */
export const SessionList = Schema.Struct({ sessions: Schema.Array(SessionSummary) })
export type SessionList = typeof SessionList.Type

/** GET /api/session?id=<sessionId> */
export const SessionState = Schema.Struct({
  id: Schema.String,
  messages: Schema.Array(Message),
  cards: Schema.Array(AppCard),
  /** Shared write order. Absent only on responses from older Workers. */
  entries: Schema.optionalKey(Schema.Array(Schema.Union([
    Schema.Struct({ kind: Schema.Literal("message"), messageId: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("card"), cardId: Schema.String })
  ]))),
  /** True while a turn is streaming for this session. */
  busy: Schema.Boolean
})
export type SessionState = typeof SessionState.Type

/** GET /api/flows[?sessionId=<sessionId>] */
export const FlowSummary = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  /** `file` = routed from flows/**; `saved` = written by flows/write-flow into the session store. */
  source: Schema.Literals(["file", "saved"]),
  chat: Schema.Boolean
})
export type FlowSummary = typeof FlowSummary.Type
export const FlowList = Schema.Struct({ flows: Schema.Array(FlowSummary) })
export type FlowList = typeof FlowList.Type

/**
 * POST /api/flows/run: starts one pipeline flow and answers with its execution
 * id. Progress does not come back on this response. The run writes a
 * `flow-run` card into the session and replaces it as steps settle, so the
 * shell reads the run through `GET /api/session?id=` like any other card.
 */
export const FlowRunRequest = Schema.Struct({
  sessionId: Schema.String,
  flowId: Schema.String,
  payload: Schema.Unknown
})
export type FlowRunRequest = typeof FlowRunRequest.Type

export const FlowRunResponse = Schema.Struct({ executionId: Schema.String })
export type FlowRunResponse = typeof FlowRunResponse.Type

/** POST /api/agent/turn/cancel answers with what it did. */
export const CancelResponse = Schema.Struct({ cancelled: Schema.Boolean })
export type CancelResponse = typeof CancelResponse.Type

export { AppCard, TurnFrame }
