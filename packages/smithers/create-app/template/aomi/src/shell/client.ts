/**
 * Fetch helpers for the routes declared in src/api.ts. Every response is
 * decoded with the contract schema, so a Worker that drifts from the contract
 * fails here instead of halfway through a render.
 *
 * `POST /api/agent/turn` answers with NDJSON: one JSON `TurnFrame` per line.
 * `streamTurn` splits the byte stream on newlines and yields decoded frames.
 */
import * as Data from "effect/Data"
import * as Schema from "effect/Schema"
import {
  CancelRequest,
  CancelResponse,
  FlowList,
  FlowRunRequest,
  Routes,
  SessionList,
  type SessionSummary,
  SessionState,
  TurnFrame,
  TurnRequest,
  UNKNOWN_FAILURE_SENTENCE
} from "../api.ts"
import { authHeaders } from "./token.ts"

const decodeSessionState = Schema.decodeUnknownSync(SessionState)
const decodeSessionList = Schema.decodeUnknownSync(SessionList)
const decodeCancelResponse = Schema.decodeUnknownSync(CancelResponse)
const decodeFlowList = Schema.decodeUnknownSync(FlowList)
const decodeTurnFrame = Schema.decodeUnknownSync(TurnFrame)

export type { SessionSummary }

/**
 * A request the Worker refused. `message` is the Worker's own `{ error }`
 * sentence when the body carries one; any other body (a proxy's HTML, a
 * stack) stays out of the message, which is then the generic sentence.
 */
export class ApiError extends Data.TaggedError("aomi/ApiError")<{
  readonly status: number
  readonly route: string
  readonly message: string
}> {
  override readonly name = "ApiError"
}

const refusal = async (response: Response, route: string): Promise<ApiError> => {
  const text = await response.text()
  let message = UNKNOWN_FAILURE_SENTENCE
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
      message = body.error
    }
  } catch {
    // Not the Worker's JSON: keep the generic sentence.
  }
  return new ApiError({ status: response.status, route, message })
}

/**
 * The sentence a reader may see for `cause`: an {@link ApiError}'s own
 * message, or the generic sentence for anything else, which is logged.
 */
export const publicMessage = (cause: unknown): string => {
  if (cause instanceof ApiError) return cause.message
  console.error(cause)
  return UNKNOWN_FAILURE_SENTENCE
}

const json = async (response: Response, route: string): Promise<unknown> => {
  if (!response.ok) throw await refusal(response, route)
  return await response.json()
}

// Every call carries the credential when one is configured. `authHeaders` is
// empty against an open Worker, which is what local development runs.
const postJson = (route: string, body: unknown): Promise<Response> =>
  fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body)
  })

// ---------------------------------------------------------------------------
// NDJSON
// ---------------------------------------------------------------------------

export interface NdjsonSplit {
  readonly lines: ReadonlyArray<string>
  readonly rest: string
}

/** Splits a buffer into complete lines plus the unterminated remainder. */
export const splitNdjson = (buffer: string): NdjsonSplit => {
  const parts = buffer.split("\n")
  const rest = parts.pop() ?? ""
  return { lines: parts.map((line) => line.trim()).filter((line) => line.length > 0), rest }
}

/** Yields every decoded frame of an NDJSON response body. */
export async function* readFrames(response: Response, route: string): AsyncGenerator<TurnFrame> {
  if (!response.ok) throw await refusal(response, route)
  const body = response.body
  if (body === null) throw new ApiError({ status: response.status, route, message: UNKNOWN_FAILURE_SENTENCE })
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    const split = splitNdjson(buffer)
    buffer = split.rest
    for (const line of split.lines) yield decodeTurnFrame(JSON.parse(line))
  }
  const tail = buffer.trim()
  if (tail.length > 0) yield decodeTurnFrame(JSON.parse(tail))
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** `POST /api/agent/turn`: streams the turn's frames. */
export const streamTurn = async function* (
  request: TurnRequest,
  signal?: AbortSignal
): AsyncGenerator<TurnFrame> {
  const response = await fetch(Routes.turn, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson", ...authHeaders() },
    body: JSON.stringify(request satisfies TurnRequest),
    ...(signal === undefined ? {} : { signal })
  })
  yield* readFrames(response, Routes.turn)
}

/**
 * `POST /api/agent/turn/cancel`.
 *
 * Answers whether there was anything to abort, so a shell that pressed Esc
 * after the turn already ended learns that rather than assuming it killed a
 * live turn.
 */
export const cancelTurn = async (sessionId: string): Promise<boolean> => {
  const body: typeof CancelRequest.Type = { sessionId }
  return decodeCancelResponse(await json(await postJson(Routes.turnCancel, body), Routes.turnCancel)).cancelled
}

/** `GET /api/session?id=<sessionId>`. */
export const getSession = async (id: string, signal?: AbortSignal): Promise<SessionState> => {
  const route = `${Routes.session}?id=${encodeURIComponent(id)}`
  return decodeSessionState(await json(await fetch(route, {
    headers: authHeaders(),
    ...(signal === undefined ? {} : { signal })
  }), route))
}

/** `GET /api/session`: the Recent column. */
export const listSessions = async (): Promise<ReadonlyArray<SessionSummary>> =>
  decodeSessionList(await json(await fetch(Routes.session, { headers: authHeaders() }), Routes.session)).sessions

/** `GET /api/flows`. */
export const listFlows = async () =>
  decodeFlowList(await json(await fetch(Routes.flows, { headers: authHeaders() }), Routes.flows)).flows

/** `POST /api/flows/run`: subscribe to the run's card replacements. */
export const runFlow = async function* (request: typeof FlowRunRequest.Type): AsyncGenerator<TurnFrame> {
  yield* readFrames(await postJson(Routes.flowRun, request), Routes.flowRun)
}

/**
 * `GET /api/health`.
 *
 * Sent without a credential on purpose: health is the one route a Worker with
 * `APP_API_TOKEN` set still answers to anyone, so this reports reachability
 * rather than whether the browser holds the right token.
 */
export const health = async (): Promise<boolean> => (await fetch(Routes.health)).ok
