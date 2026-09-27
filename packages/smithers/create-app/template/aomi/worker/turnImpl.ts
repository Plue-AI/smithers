/**
 * One agent turn, rendered as an NDJSON stream of `TurnFrame` lines.
 *
 * The Worker owns the turn because the agent runs here: the seat credential is
 * a Worker secret, the sandbox is a Worker-side QuickJS realm, and the cards
 * the agent paints come back over the same stream the text does. The browser
 * shell reads one JSON object per line and never polls.
 *
 * The run itself is `runTurn` from `@smthrs/create-app/worker`, on the host
 * `./host.ts` builds. This file writes the turn into the session: the user
 * message before the run, each card as it streams, and the answer once the
 * run ends.
 */
import { runTurn as runHostTurn, type TurnRefusal } from "@smthrs/create-app/worker"
import type { AppCard, Message, SessionSummary, TurnRequest } from "../src/api.ts"
import type { Env } from "./env.ts"
import { type HostSeams, hostFor, type SessionFlows } from "./host.ts"

/**
 * The half of `AppSession` a turn writes back into.
 *
 * A narrow structural seam rather than the class itself: `AppSession` imports
 * this module, so the dependency has to point one way.
 */
export interface TurnSession extends SessionFlows {
  /** Appends a transcript message and returns the stored row. */
  readonly appendMessage: (role: Message["role"], text: string) => Message
  /** Persists a card the turn emitted, so a reload replays it. */
  readonly appendCard: (card: AppCard) => void
  /** Reports the turn's outcome to the session's row in the Recent column. */
  readonly settle: (status: SessionSummary["status"]) => void
}

export interface TurnOptions {
  readonly env: Env
  readonly session: TurnSession
  readonly request: TurnRequest
  /** Aborted by `POST /api/agent/turn/cancel` or by the client hanging up. */
  readonly signal: AbortSignal
  /** Test seams; the Worker passes none. See `HostSeams`. */
  readonly seams?: HostSeams | undefined
}

const answerOf = (output: unknown, streamed: string): string =>
  typeof output === "object" && output !== null && "answer" in output && typeof output.answer === "string"
    ? output.answer
    : streamed

/**
 * Runs one turn, or refuses it before anything is written.
 *
 * A refusal (unrouted or non-chat flow, missing seat key or fork
 * endpoint) returns before the user message is stored, so a misconfigured
 * deploy leaves no half-written transcript. Once the stream opens it ends with
 * exactly one `done` or `error` frame, and the session is settled from it:
 * `ready` on `done`, `idle` when cancelled, `failed` otherwise.
 */
export const runTurn = async (options: TurnOptions): Promise<ReadableStream<Uint8Array> | TurnRefusal> => {
  const { env, request, session, signal } = options
  // The user message is the turn's first row: stored once, before the first
  // frame the run produces is written, and never for a refused turn.
  let opened = false
  const open = (): void => {
    if (opened) return
    opened = true
    session.appendMessage("user", request.message)
  }
  let streamed = ""
  const host = await hostFor(env, session, {
    card: (card) => {
      open()
      session.appendCard(card)
    },
    delta: (text) => {
      open()
      streamed += text
    },
    end: (frame) => {
      open()
      if (frame.type === "done") {
        session.appendMessage("assistant", answerOf(frame.output, streamed))
        session.settle("ready")
      } else {
        session.settle(signal.aborted ? "idle" : "failed")
      }
    }
  }, options.seams)
  if ("error" in host) return host
  const stream = await runHostTurn(host, { flow: request.flowId, payload: { message: request.message } }, signal)
  if (!(stream instanceof ReadableStream)) return stream
  open()
  return stream
}
