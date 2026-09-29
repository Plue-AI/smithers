import { CANCEL_PATH, TURN_PATH, TURN_REPLAY_PATH, TURN_RETIRE_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { AgentTurnJournalDeliverySchema, AgentTurnJournalReplySchema } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnJournalDelivery } from "@smthrs/rpc/AgentTurnJournal"
import { decodeAgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { AgentTurnFrame, FetchLike, StartAgentTurnResult, TurnRefusal } from "@smthrs/rpc/NativeAgent"
import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalLine } from "@smthrs/rpc/RefusalCopy"
import type { AgentPort } from "../runtime/AgentPort"
import { AgentJournalIntegrityError } from "../runtime/AgentPort"

const MAX_ERROR_BYTES = 320

export interface WebAgentOptions {
  /** Same origin by default; override for tests or a deployed boundary. */
  readonly baseUrl?: string
  readonly fetchImpl?: FetchLike
  /** The turn route; defaults to the shared TURN_PATH. */
  readonly turnPath?: string
  /** The cancel route; defaults to the shared CANCEL_PATH. */
  readonly cancelPath?: string
}

/**
 * What a status MEANS, in the product's own words.
 *
 * Rendering `HTTP <status>: <body>` for every status made the app's honesty
 * depend on every upstream writing user-facing prose. Our own limiter does
 * (§24.3 confirms that path reads correctly); a model provider answers
 * `{"type":"error","error":{"type":"rate_limit_error",…}}` and a Worker crash
 * answers a Cloudflare HTML page, and both were pasted into the chat raw.
 * The status is classified here so the sentence is right whatever the upstream
 * sent, and the upstream's own prose is kept only when it reads as prose.
 */
const statusSentence = (status: number): string | undefined => {
  if (status === 429) return "The model provider is rate-limiting this account. Try again in a minute."
  if (status === 401 || status === 403) return "That turn wasn't authorized — sign in again and retry."
  if (status === 402) return "That turn wasn't run because the account has no balance left."
  if (status === 408 || status === 504) return "That turn timed out before the model answered."
  if (status === 502 || status === 503) return "Smithers Cloud is unreachable right now. Try again in a moment."
  if (status >= 500) return "Smithers Cloud hit an error on that turn."
  return undefined
}

/** The words a JSON error body wrote; `refusalLine` decides whether a person reads them. */
const bodyWords = (body: unknown): string =>
  typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
    ? body.message.slice(0, MAX_ERROR_BYTES)
    : ""

/**
 * The one sentence for a refused turn. A turn refusal the Worker coded for a
 * person (TurnRefusal's contract) is its own sentence; an uncoded status is
 * classified; anything else speaks through `refusalLine`, so a Worker code
 * reads as its written lead and an upstream's prose, an HTML page or a
 * provider's wire error never reaches the chat.
 */
const errorDetail = (status: number, body: string, turn: TurnRefusal | undefined): string => {
  if (turn !== undefined) return turn.message
  let parsed: unknown = null
  try {
    parsed = JSON.parse(body)
  } catch {
    // Not JSON: plumbing, never copy.
  }
  const answer = refusalOf({ body: parsed, status, message: bodyWords(parsed) })
  const classified = answer.rawCode === null ? statusSentence(status) : undefined
  return classified ?? refusalLine(answer, "The Smithers web agent didn't run that turn.")
}

/*
 * The Worker's own turn ceiling (apps/server turnLimit.ts) answers 429 with
 * `{ code: "turn_rate_limited", message, retryAt }`. That is the one refusal
 * the app renders as its own card rather than a failure line, so it is
 * recognised by its code, never by its sentence. Sign-in refusals also carry
 * their code so the composer can preserve the draft and offer sign-in.
 * A provider's 429 carries no such code and stays a classified failure.
 */
const TURN_REFUSAL_CODES = { 401: "sign_in_required", 402: "out_of_credit", 429: "turn_rate_limited" } as const

const turnRefusal = (status: number, body: string): TurnRefusal | undefined => {
  if (status !== 429 && status !== 401 && status !== 402) return undefined
  const expected = TURN_REFUSAL_CODES[status]
  try {
    const parsed: unknown = JSON.parse(body)
    if (
      typeof parsed !== "object" || parsed === null || !("code" in parsed) ||
      // The shared backend's authentication middleware uses `unauthorized`.
      (parsed.code !== expected && !(status === 401 && parsed.code === "unauthorized")) ||
      !("message" in parsed) || typeof parsed.message !== "string" || parsed.message === ""
    ) {
      return undefined
    }
    const retryAt = "retryAt" in parsed && typeof parsed.retryAt === "string" && !Number.isNaN(Date.parse(parsed.retryAt))
      ? parsed.retryAt
      : null
    return { code: expected, message: parsed.message, retryAt }
  } catch {
    return undefined
  }
}

const streamFrames = async (
  body: ReadableStream<Uint8Array>,
  expectedRunId: string,
  publish: (frame: AgentTurnFrame) => void,
  onTerminal?: () => void
): Promise<void> => {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let settled = false
  for (;;) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split("\n")
    buffer = done ? "" : (lines.pop() ?? "")
    for (const line of lines) {
      if (line.trim() === "") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      // Publish the decoded frame, never the raw JSON: the card schemas
      // default nested fields (`RunRecord.labels`) that subscribers read
      // through the frame type.
      const frame = decodeAgentTurnFrame(parsed)
      if (frame === null || frame.runId !== expectedRunId) continue
      if (frame.type === "done") {
        settled = true
        // Release the turn's cancel handle BEFORE the terminal frame is
        // published: a tool-loop continuation leg re-POSTs this runId from
        // its own `done` listener, and must not meet a stale "already
        // running" from this agent's map. Publishing first refused that leg
        // outright.
        onTerminal?.()
      }
      publish(frame)
      if (settled) break
    }
    if (done || settled) break
  }
  // A `done` frame ends the turn even if the boundary keeps the socket open.
  if (settled) {
    await reader.cancel().catch(() => {})
  } else {
    // The stream ended without a terminal frame: the turn died server-side
    // (upstream disconnect). That is an honest failure, never a silent stall,
    // and it releases the handle first for the same reason a `done` frame does.
    onTerminal?.()
    publish({
      runId: expectedRunId,
      type: "done",
      error: "The response stream ended before Smithers finished the turn."
    })
  }
}

/** Journal delivery never turns a disconnected socket into a terminal model fact. */
const streamJournal = async (body: ReadableStream<Uint8Array>, runId: string, legId: string,
  publish: (delivery: AgentTurnJournalDelivery) => Promise<void>, terminal: () => void): Promise<void> => {
  const reader = body.getReader(), decoder = new TextDecoder()
  let buffer = "", done = false
  try {
    while (!done) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      const lines = buffer.split("\n")
      buffer = chunk.done ? "" : lines.pop() ?? ""
      for (const line of lines) {
        if (line.trim() === "") continue
        const delivery = AgentTurnJournalDeliverySchema.parse(JSON.parse(line))
        if (delivery.cursor.runId !== runId || delivery.cursor.legId !== legId) throw new Error("Wrong HTTP journal delivery identity")
        if (delivery.type === "batch" && (delivery.cursor.batch !== delivery.batch.batch || delivery.cursor.hash !== delivery.batch.hash ||
          delivery.cursor.position !== delivery.batch.from + delivery.batch.frames.length - 1)) throw new Error("HTTP journal cursor does not match its batch")
        // Release before delivery: a committed terminal batch may start its next leg.
        if ((delivery.type === "batch" && delivery.batch.frames.at(-1)?.type === "done") || (delivery.type === "caught-up" && delivery.terminal)) {
          done = true; terminal()
        }
        await publish(delivery)
        if (done) break
      }
      if (chunk.done) break
    }
  } finally { await reader.cancel().catch(() => {}) }
}

/**
 * The HTTP agent: POSTs turns to a same-origin boundary that keeps the
 * chat.smithers.sh URL and origin server-side, then renders the streamed
 * NDJSON AgentTurnFrames.
 */
/*
 * Every host composes this on the default /api/agent seam (Runtime.ts passes
 * a fetch and nothing else): the product Worker serves TURN_PATH and
 * CANCEL_PATH, and so does the local app's own boundary (LOCAL-APP.md), which
 * additionally aliases the older /api/chat pair. `turnPath` and `cancelPath`
 * exist for a test or a boundary that moves the routes; nothing in the app
 * passes them.
 */
export const createWebAgent = (options: WebAgentOptions = {}): AgentPort => {
  const baseUrl = options.baseUrl ?? ""
  const turnPath = options.turnPath ?? TURN_PATH
  const cancelPath = options.cancelPath ?? CANCEL_PATH
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const journalListeners = new Set<(delivery: AgentTurnJournalDelivery) => Promise<void>>()
  const activeTurns = new Map<string, AbortController>()
  const publish = (frame: AgentTurnFrame): void => {
    for (const listener of listeners) listener(frame)
  }

  return {
    available: true,
    journal: {
      subscribe: listener => { journalListeners.add(listener); return () => { journalListeners.delete(listener) } },
      read: async access => {
        const response = await fetchImpl(`${baseUrl}${TURN_REPLAY_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(access) })
        const parsed = AgentTurnJournalReplySchema.safeParse(await response.json().catch(() => null))
        if (!parsed.success && response.status === 404) return { status: "error", code: "not-found" }
        if (!parsed.success && (response.status === 401 || response.status === 403)) return { status: "error", code: "forbidden" }
        if (!parsed.success && response.status === 410) return { status: "error", code: "retired" }
        if (!parsed.success && response.status === 409) return { status: "error", code: "cursor" }
        if (!parsed.success && response.status === 400) return { status: "error", code: "request_invalid" }
        // A relay without its backend or a panicking server answers 5xx with HTML or text: transport, not corruption.
        if (!parsed.success && (response.status === 408 || response.status === 429 || response.status >= 500)) throw new Error("HTTP journal replay is temporarily unavailable")
        if (!parsed.success || (!response.ok && parsed.data.status !== "error")) throw new AgentJournalIntegrityError("Invalid HTTP journal replay response")
        return parsed.data
      },
      retire: async access => {
        const response = await fetchImpl(`${baseUrl}${TURN_RETIRE_PATH}`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId: access.runId, journal: access.journal }) })
        const reply = AgentTurnJournalReplySchema.parse(await response.json())
        if (!response.ok || reply.status !== "retired") throw new Error("HTTP journal retirement was not committed")
      },
      disconnect: runId => { const active = activeTurns.get(runId); active?.abort(); if (active !== undefined) activeTurns.delete(runId) }
    },
    startTurn: async (request): Promise<StartAgentTurnResult> => {
      if (activeTurns.has(request.runId)) {
        return { status: "error", message: "That Smithers turn is already running." }
      }
      const abortController = new AbortController()
      // Registered before the request so a stop pressed while still connecting aborts it.
      activeTurns.set(request.runId, abortController)
      /*
       * The map is keyed by runId, but the entry belongs to THIS leg. A
       * continuation that re-POSTs the same runId owns the key from that
       * moment, so this leg's teardown (which settles later, once the reader
       * is cancelled) must never delete the replacement's cancel handle:
       * doing so left a live stream Stop could not abort locally, and one
       * that no longer refused a duplicate.
       */
      const release = (): void => {
        if (activeTurns.get(request.runId) === abortController) activeTurns.delete(request.runId)
      }
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}${turnPath}`, {
          method: "POST",
          signal: abortController.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request)
        })
      } catch {
        release()
        // A cancelled connect is the user's own doing, not a failed turn to report.
        if (abortController.signal.aborted) return { status: "started" }
        // The thrown text is transport detail, never the transcript's sentence.
        return { status: "error", message: "Could not reach the Smithers web agent." }
      }
      if (!response.ok || response.body === null) {
        release()
        if (response.ok) return { status: "error", message: "The Smithers web agent returned no response stream." }
        const body = (await response.text().catch(() => "")).trim()
        const refusal = turnRefusal(response.status, body)
        return {
          status: "error",
          message: errorDetail(response.status, body, refusal),
          ...(refusal === undefined ? {} : { refusal })
        }
      }
      if (request.journal !== undefined) {
        if (response.headers.get("content-type")?.includes("application/json")) {
          let reply: ReturnType<typeof AgentTurnJournalReplySchema.safeParse>
          try { reply = AgentTurnJournalReplySchema.safeParse(await response.json()) }
          finally { release() }
          // An existing head is server progress, not proof this browser applied it.
          if (reply.success && reply.data.status === "existing") return { status: "started" }
          return { status: "error", message: "The accepted turn could not be resumed." }
        }
        if (response.headers.get("x-smithers-turn-journal") !== "1") {
          release(); await response.body.cancel().catch(() => {})
          return { status: "error", message: "This host did not provide a recoverable turn stream." }
        }
        void streamJournal(response.body, request.runId, request.journal.legId, async delivery => {
          if (journalListeners.size === 0) throw new Error("No HTTP journal commit owner")
          for (const listener of journalListeners) await listener(delivery)
        }, release).catch(() => {
          // Durable catch-up owns recovery. A transport exception is not a model done frame.
        }).finally(release)
        return { status: "started" }
      }
      void streamFrames(response.body, request.runId, publish, release)
        .catch(() => {
          if (abortController.signal.aborted) return
          publish({ runId: request.runId, type: "done", error: "The Smithers web agent stream failed." })
        })
        .finally(release)
      return { status: "started" }
    },
    cancelTurn: async (runId) => {
      const active = activeTurns.get(runId)
      if (active !== undefined) {
        active.abort()
        activeTurns.delete(runId)
      }
      await fetchImpl(`${baseUrl}${cancelPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId })
      }).catch(() => {})
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
