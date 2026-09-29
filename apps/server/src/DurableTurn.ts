import { markCause } from "./RefusalLog"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import {
  AgentTurnErasureSchema, AgentTurnJournalAccessSchema, agentTurnJournalDigestInput
} from "@smthrs/rpc/AgentTurnJournal"
import type {
  AgentTurnCursor, AgentTurnJournalDelivery, AgentTurnJournalReply, AgentTurnJournalRequest
} from "@smthrs/rpc/AgentTurnJournal"
import { decodeAgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { TurnRequest } from "./cloudRoleTurn"
import { ExecutionContext } from "./Environment"
import { readJsonOrUndefined } from "./Http"
import { json, readBody, refuse, refuseWithStatus, withIsolationHeaders } from "./Responses"
import type { TurnJournalClient } from "./TurnJournalClient"
import { sha256Hex } from "./turnLimit"

const JOURNAL_HEADER = "x-smithers-turn-journal"
const MAX_PRODUCER_APPENDS = 768
const INTERRUPTED = "The response stream ended before Smithers finished the turn."
const STORAGE_LOST = "The turn could not continue recording its response. Reconnect to read its saved output."
const OUTPUT_LIMIT = "The turn reached its recorded-output limit and was stopped."

const privateAuth = (owner: string | undefined, journal: AgentTurnJournalRequest) => Effect.gen(function* () {
  const ownerHash = yield* sha256Hex(agentTurnJournalDigestInput("owner", owner === undefined ? ["anonymous", journal.token] : ["account", owner]))
  const accessHash = yield* sha256Hex(agentTurnJournalDigestInput("access", journal.token))
  return { ownerHash, accessHash }
})

const publicRefusal = (status: number, body: Extract<AgentTurnJournalReply, { status: "error" }>): Response => {
  switch (body.code) {
    case "forbidden": return refuse("turn_not_yours", "That recorded turn is not available to this account.")
    case "not-found": return refuseWithStatus(404, "route_not_found", "The recorded turn could not be found.")
    case "retired": return refuseWithStatus(410, "request_invalid", "That recorded turn was retired.")
    case "cursor": return refuseWithStatus(409, "request_invalid", "The saved replay position does not match that turn.")
    case "conflict": return refuseWithStatus(409, "request_invalid", "That turn identity already names a different accepted request.")
    case "limit": return refuseWithStatus(409, "request_invalid", OUTPUT_LIMIT)
    case "terminal": return refuseWithStatus(409, "request_invalid", "That recorded turn has already ended.")
    case "request_invalid": return refuse("request_invalid", "The turn journal request is invalid.")
    default: return markCause(refuseWithStatus(status >= 500 ? status : 503, "storage_failed", "The recorded turn could not be verified. Its saved output was preserved."), "turn journal", body.code)
  }
}

/** Erasure needs only a deletion proof, so it can finish after sign-out. */
export const eraseDurableTurn = (request: Request, client: TurnJournalClient): Effect.Effect<Response> => Effect.gen(function* () {
  const raw = yield* readBody(request)
  if (raw instanceof Response) return raw
  const parsed = AgentTurnErasureSchema.safeParse(raw)
  if (!parsed.success) return refuse("request_invalid", "A recorded turn identity and erasure proof are required.")
  const { runId, legId, retirementProof } = parsed.data
  const result = yield* client.request(runId, legId, { operation: "erase", runId, legId, accessHash: retirementProof })
  return result.body.status === "error" ? publicRefusal(result.status, result.body) : json(200, result.body)
}).pipe(Effect.catch(failure => Effect.succeed(markCause(refuseWithStatus(503, "storage_failed", "The recorded turn could not be erased yet."), "turn journal", failure))))

/** Each bounded read revalidates the public caller; it never starts inference. */
export const accessDurableTurn = (request: Request, owner: string | undefined, client: TurnJournalClient, retire: boolean): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const raw = yield* readBody(request)
    if (raw instanceof Response) return raw
    const parsed = AgentTurnJournalAccessSchema.safeParse(raw)
    if (!parsed.success) return refuse("request_invalid", "A recorded turn identity and replay capability are required.")
    const body = parsed.data
    const auth = yield* privateAuth(owner, body.journal)
    const result = yield* client.request(body.runId, body.journal.legId, retire
      ? { operation: "retire", ...auth }
      : { operation: "read", ...auth, after: body.after ?? null, limit: 8 })
    return result.body.status === "error" ? publicRefusal(result.status, result.body) : json(200, result.body)
  }).pipe(Effect.catch(failure => Effect.succeed(markCause(refuseWithStatus(503, "storage_failed", "The recorded turn is temporarily unavailable."), "turn journal", failure))))

/** The producer hit its append budget or the journal's output ceiling. */
export class OutputLimitReached extends Data.TaggedError("OutputLimitReached")<{}> {}
/** The journal stopped accepting this producer's writes. */
export class OutputStorageLost extends Data.TaggedError("OutputStorageLost")<{ readonly cause?: unknown }> {}
/** The model's response stream broke off. */
export class OutputInterrupted extends Data.TaggedError("OutputInterrupted")<{ readonly cause?: unknown }> {}
/** A model line that is not a frame of this turn. */
export class OutputFrameInvalid extends Data.TaggedError("OutputFrameInvalid")<{ readonly cause?: unknown }> {}

export type OutputFailure = OutputLimitReached | OutputStorageLost | OutputInterrupted | OutputFrameInvalid

/** The one sentence a recorded turn ends with for each output failure. */
export const OUTPUT_FAILURE_SENTENCE: { readonly [K in OutputFailure["_tag"]]: string } = {
  OutputLimitReached: OUTPUT_LIMIT,
  OutputStorageLost: STORAGE_LOST,
  OutputInterrupted: INTERRUPTED,
  OutputFrameInvalid: "The model response contained an invalid frame."
}

export const outputFailureSentence = (failure: unknown): string =>
  typeof failure === "object" && failure !== null && "_tag" in failure && Object.hasOwn(OUTPUT_FAILURE_SENTENCE, failure._tag as string)
    ? OUTPUT_FAILURE_SENTENCE[failure._tag as OutputFailure["_tag"]]
    : STORAGE_LOST
const encoded = (delivery: AgentTurnJournalDelivery): Uint8Array => new TextEncoder().encode(`${JSON.stringify(delivery)}\n`)

/**
 * Admit a fresh leg, grant one producer, then publish only committed output.
 * Admission runs only when a read finds no saved leg, and before any storage
 * write, so a refused caller creates no journal object. A duplicate POST
 * returns existing metadata and spends nothing; its head is NOT an applied
 * cursor. The native host provides its own start Effect and storage client
 * and admits every local leg.
 */
export const withDurableAgentTurn = <R, A>(
  body: TurnRequest & { readonly journal: AgentTurnJournalRequest },
  owner: string | undefined,
  client: TurnJournalClient,
  start: () => Effect.Effect<Response, never, R>,
  admission: Effect.Effect<Response | undefined, never, A> = Effect.succeed(undefined)
): Effect.Effect<Response, never, R | A | ExecutionContext> => Effect.gen(function* () {
  const journal = body.journal
  const auth = yield* privateAuth(owner, journal)
  const { journal: _journal, ...input } = body
  const requestHash = yield* sha256Hex(agentTurnJournalDigestInput("request", input))
  const writerHash = yield* sha256Hex(agentTurnJournalDigestInput("writer", crypto.randomUUID()))
  const saved = yield* client.request(body.runId, journal.legId, { operation: "read", ...auth, after: null, limit: 1 })
  if (saved.body.status === "error" && saved.body.code === "not-found") {
    const refusal = yield* admission
    if (refusal !== undefined) return refusal
  }
  const registration = yield* client.request(body.runId, journal.legId, {
    operation: "accept", runId: body.runId, legId: journal.legId, ...auth, requestHash, writerHash
  })
  if (registration.body.status === "error") return publicRefusal(registration.status, registration.body)
  if (registration.body.status === "existing") {
    const response = json(200, registration.body)
    response.headers.set(JOURNAL_HEADER, "1")
    return response
  }
  if (registration.body.status !== "accepted") return markCause(refuseWithStatus(503, "storage_failed", "The turn acceptance could not be verified."), "turn journal", "invalid acceptance")
  let cursor: AgentTurnCursor = registration.body.cursor
  let terminal = false
  let appendCalls = 0
  const ctx = yield* ExecutionContext

  const write = (frames: AgentTurnFrame[]) => Effect.gen(function* () {
    if (appendCalls >= MAX_PRODUCER_APPENDS) return yield* Effect.fail(new OutputLimitReached())
    const command = { operation: "append" as const, writerHash, expected: cursor, frames }
    const invoke = Effect.suspend(() => {
      appendCalls++
      return client.request(body.runId, journal.legId, command)
    })
    // One exact retry repairs a lost receipt; it never repeats inference.
    const answer = yield* invoke.pipe(Effect.catch(() => Effect.gen(function* () {
      if (appendCalls >= MAX_PRODUCER_APPENDS) return yield* Effect.fail(new OutputStorageLost({}))
      return yield* invoke
    })))
    if (answer.body.status !== "committed" && answer.body.status !== "duplicate") {
      return yield* Effect.fail(answer.body.status === "error" && answer.body.code === "limit" ? new OutputLimitReached() : new OutputStorageLost({ cause: answer.body }))
    }
    cursor = answer.body.cursor
    terminal = frames.at(-1)?.type === "done"
    return { type: "batch" as const, batch: answer.body.batch, cursor }
  })

  // Re-read after an uncertain write: it may have committed although its
  // receipt was lost. The terminal observation follows the actual head and
  // is published only when no unseen predecessor would be skipped.
  const finish = (message: string): Effect.Effect<AgentTurnJournalDelivery | undefined> => Effect.gen(function* () {
    if (terminal) return undefined
    const page = yield* client.request(body.runId, journal.legId, { operation: "read", ...auth, after: null, limit: 1 })
    if (page.body.status !== "ok") return undefined
    if (page.body.terminal) { terminal = true; return undefined }
    const continuous = page.body.head.hash === cursor.hash && page.body.head.position === cursor.position
    const ended = yield* client.request(body.runId, journal.legId, {
      operation: "append", writerHash, expected: page.body.head,
      frames: [{ runId: body.runId, type: "done", error: message }]
    })
    if (ended.body.status !== "committed" && ended.body.status !== "duplicate") return undefined
    cursor = ended.body.cursor
    terminal = true
    return continuous ? { type: "batch" as const, batch: ended.body.batch, cursor } : undefined
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))

  const recordInterruption = Effect.gen(function* () {
    const fiber = yield* ctx.waitUntil(Effect.asVoid(finish(INTERRUPTED)))
    yield* Fiber.join(fiber)
  })

  return yield* Effect.gen(function* () {
    const response = yield* start()
    let source: Stream.Stream<AgentTurnFrame, OutputFailure>
    if (!response.ok || response.body === null) {
      const raw = yield* readJsonOrUndefined(response)
      const detail = typeof raw === "object" && raw !== null && "message" in raw && typeof raw.message === "string"
        ? raw.message.slice(0, 500) : "Smithers Cloud did not complete that turn."
      source = Stream.make({ runId: body.runId, type: "done", error: detail })
    } else {
      source = Stream.fromReadableStream({ evaluate: () => response.body!, onError: (cause) => new OutputInterrupted({ cause }) }).pipe(
        Stream.decodeText(), Stream.splitLines,
        Stream.filter(line => line.trim() !== ""),
        Stream.mapEffect(line => Effect.try({
          try: () => {
            const frame = decodeAgentTurnFrame(JSON.parse(line))
            if (frame === null || frame.runId !== body.runId) throw new Error("Invalid output")
            return frame
          },
          catch: (cause) => new OutputFrameInvalid({ cause })
        })),
        Stream.takeUntil(frame => frame.type === "done")
      )
    }
    const accepted = encoded({ type: "accepted", cursor })
    const output = source.pipe(
      Stream.groupedWithin(64, 250),
      Stream.mapEffect(write),
      Stream.catch(failure => Stream.fromEffect(finish(outputFailureSentence(failure))).pipe(
        Stream.filter((value): value is AgentTurnJournalDelivery => value !== undefined)
      )),
      Stream.concat(Stream.fromEffect(finish(INTERRUPTED)).pipe(Stream.filter((value): value is AgentTurnJournalDelivery => value !== undefined))),
      Stream.map(encoded),
      Stream.concat(Stream.fromEffect(Effect.sync(() => encoded({ type: "caught-up", cursor, terminal })))),
      Stream.ensuring(recordInterruption)
    )
    const readable = yield* Stream.toReadableStreamEffect(Stream.concat(Stream.make(accepted), output))
    return withIsolationHeaders(new Response(readable, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", [JOURNAL_HEADER]: "1" }
    }))
  }).pipe(Effect.onInterrupt(() => recordInterruption))
}).pipe(Effect.catch(failure => Effect.succeed(markCause(refuseWithStatus(503, "storage_failed", "The turn could not be recorded. Its saved state was preserved."), "turn journal", failure))))
