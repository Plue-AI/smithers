import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Semaphore from "effect/Semaphore"
import { runDurable } from "./Boundary"
import { ServerConfig } from "./Config"
import { answeredJson, namespaceCall } from "./DurableStorage"
import type { NativeNamespace } from "./DurableStorage"
import { StorageFailure } from "./Failures"
import type { WorkerFailureCode } from "@smthrs/rpc/WorkerFailureCodes"
import { routeRefusal, storageFailureAnswer } from "./Responses"
import type { BodyFailure } from "./Failures"
import { discardBody, fetchWithDeadline, readBoundedJson, readJsonOrUndefined } from "./Http"
import type { Transport } from "./Http"
import {
  AGENT_TURN_COMMAND_NAME_MAX_CHARS,
  AGENT_TURN_COMMAND_SUMMARY_MAX_CHARS,
  AGENT_TURN_COMMANDS_MAX
} from "@smthrs/rpc/NativeAgent"
import type { AgentTurnCommand } from "@smthrs/rpc/NativeAgent"
import { ModelBindingSchema } from "@smthrs/rpc/ConfiguredModel"
import type { ModelBinding } from "@smthrs/rpc/ConfiguredModel"
import { modelRefusal, planDecisionModel } from "./configuredModel"
import { jevEvaluate } from "./jev"
import { isOutOfCredit, modelRoute, paidBy } from "./modelPayer"
import type { JevAnswer, JevAnswerValue, JevQuestion } from "./jev"
/**
 * The command recommender: which `/command` should this user run next?
 *
 * The browser posts the tail of the current chat and every command the user
 * can invoke right now, and this route answers an ordered list of up to five
 * of those commands. Jev, a decision model that picks among named options and
 * reports a probability for each, is the only model this route asks. There is
 * no Cerebras path for pills: when Jev is unavailable the route refuses, and
 * an LLM is never asked in its place. A catalog too long for one choice
 * question is split across several questions in ONE request — the gateway
 * answers them in parallel — and their probabilities are merged, so size is
 * never a reason to ask someone else. The client renders the answer as pills
 * under the composer. The route works for a signed-out visitor as well as a
 * login, because the pills are how a visitor learns what the product can do.
 *
 * Every recommendation is a row in a bounded log (one Durable Object for the
 * deployment), and when the user runs a command next the client posts the
 * outcome under the recommendation's id. That pair is the whole eval: a hit
 * is an outcome that was on the list, a top-1 is an outcome that was first.
 * The log never holds the chat text, only a digest of it, so a scorer can
 * tell two tails apart without reading either.
 *
 * Honesty rules the answers. A hallucinated command name is dropped, never
 * shown. An unset `AI_GATEWAY_API_KEY` is a `seam_not_configured` 503; a Jev
 * that refuses, times out or answers something unreadable is a
 * `service_temporarily_unavailable` 503 naming what went wrong. Never a
 * made-up list, and never a second model: the client's rule-based pills are
 * the client's business, and the log must only ever hold what Jev said.
 *
 * `cerebrasChat` below is NOT part of this route. It is the Worker's one
 * Cerebras client, and the cloud roles (cloudRoleTurn.ts: the Librarian, the
 * Flows agent) spend it. Those are LLM roles a user asked for, not a fallback
 * for a decision Jev owes.
 */
import {
  ANONYMOUS_TURN_WINDOW_MS,
  anonymousTurnKey,
  sha256Hex,
  TurnLimits,
  turnLimitResponse
} from "./turnLimit"
import type { TurnCeiling } from "./turnLimit"

/** The most tail messages a request may carry; the client truncates first. */
export const RECOMMEND_TAIL_MAX_ENTRIES = 12
/** The most characters of tail text, summed over every entry. */
export const RECOMMEND_TAIL_MAX_CHARS = 4000
/** The most commands a request may offer; the turn body's catalog shares it. */
export const RECOMMEND_COMMANDS_MAX = AGENT_TURN_COMMANDS_MAX
/** The most names an answer carries. */
export const RECOMMEND_ANSWER_MAX = 5
/** Rows the log keeps: a ring of the newest. */
export const RECOMMEND_LOG_LIMIT = 5000
/**
 * How long Jev gets, in ms. Jev answers a decision in well under a second,
 * and pills that arrive after the user has moved on are noise, so this is the
 * whole budget: there is nobody else to ask with the rest of it.
 */
export const RECOMMEND_JEV_TIMEOUT_MS = 1500
/**
 * The most options ONE Jev choice question holds. A longer catalog is split
 * across several questions in one request (`recommendQuestions`), never
 * refused and never handed to another model.
 */
export const RECOMMEND_JEV_COMMANDS_MAX = 255
export const CEREBRAS_CHAT_COMPLETIONS_URL = "https://api.cerebras.ai/v1/chat/completions"

/**
 * The request body's byte cap, checked before parsing. The tail is at most
 * 4000 characters and the command list at most 300 short lines, so a body
 * past this is not a client that forgot to truncate.
 */
export const RECOMMEND_BODY_MAX_BYTES = 256 * 1024

/**
 * The outcome body's byte cap. An outcome is an id and a command name, so a
 * body past a few KiB is not a client reporting what the user ran.
 */
export const RECOMMEND_OUTCOME_BODY_MAX_BYTES = 4 * 1024

/**
 * `repo` is "owner/name" or null, and nothing else: a GitHub owner is up to
 * 39 characters of letters, digits and hyphens, a name up to 100 of letters,
 * digits, dots, underscores and hyphens. The log holds the repo verbatim and
 * admins and the scorer read it, so it only ever holds a repository name.
 */
export const RECOMMEND_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
/** The most characters a command name may carry, in a request and in an outcome. */
export const RECOMMEND_COMMAND_NAME_MAX_CHARS = AGENT_TURN_COMMAND_NAME_MAX_CHARS
/** The most characters a command's one-line summary may carry. */
export const RECOMMEND_COMMAND_SUMMARY_MAX_CHARS = AGENT_TURN_COMMAND_SUMMARY_MAX_CHARS

/**
 * Recommendations one address, or one login, may ask for per day. A pill
 * refresh follows each turn, and a hard day of chatting is about a hundred
 * turns, so three hundred is headroom, not a ration.
 */
export const RECOMMEND_ADDRESS_MAX = 300
/** Recommendations the whole deployment may ask for per day. */
export const RECOMMEND_ALL_MAX = 5000

export const RECOMMEND_CEILING: TurnCeiling = {
  kind: "recommend",
  max: RECOMMEND_ADDRESS_MAX,
  windowMs: ANONYMOUS_TURN_WINDOW_MS
}

export const RECOMMEND_ALL_CEILING: TurnCeiling = {
  kind: "recommend",
  max: RECOMMEND_ALL_MAX,
  windowMs: ANONYMOUS_TURN_WINDOW_MS
}

/**
 * The deployment-wide bucket. The `recommend:` prefix keeps every recommend
 * bucket apart from the turn buckets, which are a bare login or an
 * `anonymous:` digest, because one bucket only ever sees one ceiling.
 */
export const RECOMMEND_ALL_KEY = "recommend:all"

export interface RecommendTailMessage {
  readonly role: "user" | "assistant" | "system"
  readonly text: string
}

/** One offered command; the turn body's catalog and this request share the shape. */
export type RecommendCommand = AgentTurnCommand

export interface RecommendRequest {
  readonly repo: string | null
  readonly tail: ReadonlyArray<RecommendTailMessage>
  readonly commands: ReadonlyArray<RecommendCommand>
  /** The decision model the `recommend` seat binds. Absent is the deployment's default. */
  readonly model?: ModelBinding
}

/** What the scorer reads: one row per recommendation, the tail digested. */
export interface RecommendLogRow {
  readonly id: string
  /** ISO 8601, when the recommendation was made. */
  readonly at: string
  readonly repo: string | null
  /** SHA-256 hex of the tail text. The text itself is never stored. */
  readonly tailDigest: string
  /** How many commands the request offered. */
  readonly commandCount: number
  /** The answer, best first. */
  readonly commands: ReadonlyArray<string>
  readonly model: string
  /**
   * Present only on a FRONT-DOOR row (frontDoor.ts): the turn route's own Jev
   * read, which decides whether the Worker answers a command-shaped message
   * itself instead of paying for a concierge turn. A row without this field is
   * a composer pill, as every row was before the front door existed, so one
   * log scores both without a second store.
   */
  readonly frontDoor?: {
    /** Jev's probability for the chosen command; the floor is FRONT_DOOR_CONFIDENCE_FLOOR. */
    readonly confidence: number
    /** The impossible-act class Jev read from the message. Logged only; the client's regexes still decide. */
    readonly impossible: string
    /** Whether the turn was answered here (true) or fell through to the chat upstream. */
    readonly routed: boolean
  }
  /** The command the user ran next, once the client reports it. */
  readonly outcome: { readonly command: string; readonly at: string } | null
}

/* ------------------------------------------------------------------------ */
/* The log's storage                                                         */
/* ------------------------------------------------------------------------ */

/**
 * The subset of Durable Object storage the log uses. Wider than
 * `DurableStorage` (src/DurableStorage.ts): the ring deletes the row that
 * fell off its far end and lists the newest rows in key order.
 */
export interface NativeRecommendStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>
  readonly put: (key: string, value: unknown) => Promise<void>
  readonly delete: (key: string) => Promise<boolean>
  readonly list: <T>(
    options: { readonly prefix: string; readonly reverse: boolean; readonly limit: number }
  ) => Promise<Map<string, T>>
}

export interface RecommendStorageShape {
  readonly get: <T>(key: string) => Effect.Effect<T | undefined, StorageFailure>
  readonly put: (key: string, value: unknown) => Effect.Effect<void, StorageFailure>
  readonly delete: (key: string) => Effect.Effect<boolean, StorageFailure>
  readonly list: <T>(
    options: { readonly prefix: string; readonly reverse: boolean; readonly limit: number }
  ) => Effect.Effect<Map<string, T>, StorageFailure>
}

/** The log's storage as its Effect sees it. */
export class RecommendStorage extends Context.Service<RecommendStorage, RecommendStorageShape>()("smithers-server/RecommendStorage") {}

export const recommendStorageFrom = (storage: NativeRecommendStorage): RecommendStorageShape => ({
  get: <T>(key: string) =>
    Effect.tryPromise({ try: () => storage.get<T>(key), catch: (cause) => new StorageFailure({ operation: `storage.get ${key}`, cause }) }),
  put: (key, value) =>
    Effect.tryPromise({ try: () => storage.put(key, value), catch: (cause) => new StorageFailure({ operation: `storage.put ${key}`, cause }) }),
  delete: (key) =>
    Effect.tryPromise({ try: () => storage.delete(key), catch: (cause) => new StorageFailure({ operation: `storage.delete ${key}`, cause }) }),
  list: <T>(options: { readonly prefix: string; readonly reverse: boolean; readonly limit: number }) =>
    Effect.tryPromise({
      try: () => storage.list<T>(options),
      catch: (cause) => new StorageFailure({ operation: `storage.list ${options.prefix}`, cause })
    })
})

export const recommendStorageLayer = (storage: NativeRecommendStorage): Layer.Layer<RecommendStorage> =>
  Layer.succeed(RecommendStorage, recommendStorageFrom(storage))

/** An in-memory log storage for tests. */
export const memoryRecommendStorage = (): NativeRecommendStorage & { readonly data: Map<string, unknown> } => {
  const data = new Map<string, unknown>()
  return {
    data,
    get: <T>(key: string) => Promise.resolve(data.get(key) as T | undefined),
    put: (key, value) => {
      data.set(key, value)
      return Promise.resolve()
    },
    delete: (key) => Promise.resolve(data.delete(key)),
    list: <T>({ prefix, reverse, limit }: { readonly prefix: string; readonly reverse: boolean; readonly limit: number }) => {
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix)).sort()
      if (reverse) keys.reverse()
      return Promise.resolve(new Map(keys.slice(0, limit).map((key) => [key, data.get(key) as T])))
    }
  }
}

/* ------------------------------------------------------------------------ */
/* The log                                                                   */
/* ------------------------------------------------------------------------ */

/** Every deployment shares one log; the name is fixed so any request finds it. */
export const RECOMMEND_LOG_NAME = "recommendations"

const SEQ_KEY = "seq"
const ROW_PREFIX = "row:"
/** Wide enough that lexical key order is numeric order for the life of the log. */
const SEQ_WIDTH = 12

const rowKey = (seq: number): string => `${ROW_PREFIX}${String(seq).padStart(SEQ_WIDTH, "0")}`

/**
 * An id names its row: the sequence number is its head, so an outcome finds
 * its row with one storage read, and the random tail is what stops a caller
 * from recording outcomes against ids it never received.
 */
const mintId = (seq: number): string => {
  const random = crypto.getRandomValues(new Uint8Array(8))
  return `${seq.toString(36)}-${[...random].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

const seqOf = (id: string): number | undefined => {
  const head = id.split("-", 1)[0] ?? ""
  if (!/^[0-9a-z]+$/.test(head)) return undefined
  const seq = parseInt(head, 36)
  return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined
}

const answer = (status: number, body: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

const isRow = (value: unknown): value is Omit<RecommendLogRow, "id"> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The log's request: `POST /append` mints an id and keeps the row, `POST
 * /outcome` records what the user ran next, `GET /read?limit=` answers the
 * newest rows. A storage failure is the object's own 500. Each append and
 * outcome reads before it writes, so both hold `writes` from the read to the
 * last write; bodies are read before, so a slow body never holds the log.
 */
export const recommendLogRequest = (
  request: Request,
  writes: Semaphore.Semaphore
): Effect.Effect<Response, never, RecommendStorage> =>
  Effect.gen(function*() {
    const storage = yield* RecommendStorage
    const url = new URL(request.url)
    switch (url.pathname) {
      case "/append": {
        const row = yield* readJsonOrUndefined(request)
        if (!isRow(row)) return answer(400, { status: "error", code: "request_invalid", message: "bad row" })
        return yield* writes.withPermit(Effect.gen(function*() {
          const seq = ((yield* storage.get<number>(SEQ_KEY)) ?? 0) + 1
          const id = mintId(seq)
          yield* storage.put(SEQ_KEY, seq)
          yield* storage.put(rowKey(seq), { ...row, id })
          // A ring: the row that fell off the far end goes with each append.
          if (seq > RECOMMEND_LOG_LIMIT) yield* storage.delete(rowKey(seq - RECOMMEND_LOG_LIMIT))
          return answer(200, { id })
        }))
      }
      case "/outcome": {
        const body = (yield* readJsonOrUndefined(request)) as
          | { readonly id?: unknown; readonly command?: unknown; readonly at?: unknown }
          | null
          | undefined
        if (
          body === undefined || body === null || typeof body.id !== "string" || typeof body.command !== "string" ||
          typeof body.at !== "string"
        ) return answer(400, { status: "error", code: "request_invalid", message: "bad outcome" })
        const seq = seqOf(body.id)
        if (seq === undefined) return answer(404, { status: "error", code: "route_not_found", message: "unknown id" })
        const { id, command, at } = body
        return yield* writes.withPermit(Effect.gen(function*() {
          const row = yield* storage.get<RecommendLogRow>(rowKey(seq))
          if (row === undefined || row.id !== id) {
            return answer(404, { status: "error", code: "route_not_found", message: "unknown id" })
          }
          if (row.outcome !== null) {
            return answer(409, { status: "error", code: "request_conflict", message: "outcome already recorded" })
          }
          yield* storage.put(rowKey(seq), { ...row, outcome: { command, at } })
          return answer(204, undefined)
        }))
      }
      case "/read": {
        const asked = Number(url.searchParams.get("limit") ?? "")
        const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, RECOMMEND_LOG_LIMIT) : RECOMMEND_LOG_LIMIT
        const rows = yield* storage.list<RecommendLogRow>({ prefix: ROW_PREFIX, reverse: true, limit })
        return answer(200, { rows: [...rows.values()] })
      }
      default:
        return answer(404, { status: "error", code: "route_not_found", message: "not found" })
    }
  }).pipe(
    Effect.catchTag(
      "StorageFailure",
      (failure) => Effect.succeed(storageFailureAnswer("recommend log", failure))
    )
  )

export class RecommendLog {
  private readonly writes = Semaphore.makeUnsafe(1)
  constructor(private readonly ctx: { readonly storage: NativeRecommendStorage }) {}

  fetch(request: Request): Promise<Response> {
    return runDurable(recommendLogRequest(request, this.writes).pipe(Effect.provide(recommendStorageLayer(this.ctx.storage))))
  }
}

/* ------------------------------------------------------------------------ */
/* The Worker-side service                                                   */
/* ------------------------------------------------------------------------ */

/** What recording an outcome decided, as the log's own status codes say it. */
export type OutcomeRecorded = 204 | 404 | 409 | 500

export interface RecommendLogStoreShape {
  /**
   * Append one row and answer its id. With no log bound (local dev, the
   * stub stack) the recommendation still answers, under an id that no
   * outcome can ever match: the eval is a deployment concern, the pills
   * are not.
   */
  readonly append: (row: Omit<RecommendLogRow, "id">) => Effect.Effect<string>
  /** The newest rows, for the scorer; empty with no log bound. */
  readonly read: (limit?: number) => Effect.Effect<ReadonlyArray<RecommendLogRow>>
  /** Record what the user ran next; `undefined` when no log is bound. */
  readonly outcome: (id: string, command: string, at: string) => Effect.Effect<OutcomeRecorded | undefined>
}

export class RecommendLogStore extends Context.Service<RecommendLogStore, RecommendLogStoreShape>()("smithers-server/RecommendLogStore") {}

const unlogged = (): string => `unlogged-${crypto.randomUUID()}`

export const recommendLogLayer = (namespace: NativeNamespace | undefined): Layer.Layer<RecommendLogStore> =>
  Layer.succeed(RecommendLogStore, {
    append: Effect.fn("RecommendLog.append")(function*(row: Omit<RecommendLogRow, "id">) {
      if (namespace === undefined) return unlogged()
      const body = (yield* namespaceCall(
        "recommendLog.append",
        namespace,
        RECOMMEND_LOG_NAME,
        new Request("https://recommend-log.internal/append", { method: "POST", body: JSON.stringify(row) })
      ).pipe(
        Effect.flatMap((response) => answeredJson("recommendLog.append", "The recommendation log", response)),
        Effect.catch((failure) =>
          Effect.sync(() => {
            console.error("recommend log append failed:", failure.cause)
            return undefined
          }))
      )) as { readonly id?: unknown } | undefined
      return typeof body?.id === "string" ? body.id : unlogged()
    }),
    read: Effect.fn("RecommendLog.read")(function*(limit?: number) {
      if (namespace === undefined) return []
      const query = limit === undefined ? "" : `?limit=${limit}`
      const body = (yield* namespaceCall(
        "recommendLog.read",
        namespace,
        RECOMMEND_LOG_NAME,
        new Request(`https://recommend-log.internal/read${query}`)
      ).pipe(
        Effect.flatMap((response) => answeredJson("recommendLog.read", "The recommendation log", response)),
        Effect.catch((failure) =>
          Effect.sync(() => {
            console.error("recommend log read failed:", failure.cause)
            return undefined
          }))
      )) as { readonly rows?: unknown } | undefined
      return Array.isArray(body?.rows) ? (body.rows as ReadonlyArray<RecommendLogRow>) : []
    }),
    outcome: Effect.fn("RecommendLog.outcome")(function*(id: string, command: string, at: string) {
      if (namespace === undefined) return undefined
      const response = yield* namespaceCall(
        "recommendLog.outcome",
        namespace,
        RECOMMEND_LOG_NAME,
        new Request("https://recommend-log.internal/outcome", { method: "POST", body: JSON.stringify({ id, command, at }) })
      ).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (response === undefined) return 500
      yield* discardBody(response)
      return response.status === 204 || response.status === 404 || response.status === 409 ? response.status : 500
    })
  })

/** The newest rows, for the scorer. */
export const readRecommendLog = (limit?: number): Effect.Effect<ReadonlyArray<RecommendLogRow>, never, RecommendLogStore> =>
  RecommendLogStore.use((store) => store.read(limit))

/* ------------------------------------------------------------------------ */
/* The request                                                               */
/* ------------------------------------------------------------------------ */

const ROLES: ReadonlyArray<string> = ["user", "assistant", "system"]

/** What reading a body decided: a request, or the status the refusal carries. */
export type ParsedRecommendRequest =
  | { readonly ok: true; readonly body: RecommendRequest }
  | { readonly ok: false; readonly code: WorkerFailureCode; readonly message: string }

const isTailMessage = (value: unknown): value is RecommendTailMessage =>
  typeof value === "object" && value !== null &&
  typeof (value as { role?: unknown }).role === "string" && ROLES.includes((value as { role: string }).role) &&
  typeof (value as { text?: unknown }).text === "string"

const isCommand = (value: unknown): value is RecommendCommand =>
  typeof value === "object" && value !== null &&
  typeof (value as { name?: unknown }).name === "string" && (value as { name: string }).name !== "" &&
  typeof (value as { summary?: unknown }).summary === "string"

/** A bounded JSON read as the routes report it, in the Worker's own failure vocabulary. */
const bodyRefusal = (
  failure: BodyFailure,
  subject: string
): { readonly code: WorkerFailureCode; readonly message: string } => {
  switch (failure._tag) {
    case "BodyTooLarge":
      return { code: "request_body_too_large", message: `${subject} is too large.` }
    case "BodyUnreadable":
      return { code: "request_body_unreadable", message: `${subject} could not be read.` }
    case "BodyNotJson":
      return { code: "request_body_not_json", message: `${subject} is not JSON.` }
  }
}

/** Validate a decoded body. Malformed is 400; well-formed but too big is 413. */
export const validateRecommendRequest = (value: unknown): ParsedRecommendRequest => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "request_invalid", message: "The recommendation request must be a JSON object." }
  }
  const { repo, tail, commands } = value as { repo?: unknown; tail?: unknown; commands?: unknown }
  // Not a hint: a binding this contract cannot read is refused, never dropped for the default.
  const model = "model" in value ? ModelBindingSchema.safeParse(value.model) : undefined
  if (model?.success === false) {
    return { ok: false, code: "request_invalid", message: "model must be a model binding: { protocol, modelId, credential } with optional baseUrl and path." }
  }
  if (repo !== null && (typeof repo !== "string" || !RECOMMEND_REPO_PATTERN.test(repo))) {
    return { ok: false, code: "request_invalid", message: "repo must be \"owner/name\" or null." }
  }
  if (!Array.isArray(tail) || !tail.every(isTailMessage)) {
    return { ok: false, code: "request_invalid", message: "tail must be a list of { role, text } messages." }
  }
  if (!Array.isArray(commands) || !commands.every(isCommand)) {
    return { ok: false, code: "request_invalid", message: "commands must be a list of { name, summary } entries." }
  }
  if (commands.some((command) => command.name.length > RECOMMEND_COMMAND_NAME_MAX_CHARS)) {
    return { ok: false, code: "request_invalid", message: `A command name may carry at most ${RECOMMEND_COMMAND_NAME_MAX_CHARS} characters.` }
  }
  if (commands.some((command) => command.summary.length > RECOMMEND_COMMAND_SUMMARY_MAX_CHARS)) {
    return { ok: false, code: "request_invalid", message: `A command summary may carry at most ${RECOMMEND_COMMAND_SUMMARY_MAX_CHARS} characters.` }
  }
  if (tail.length > RECOMMEND_TAIL_MAX_ENTRIES) {
    return { ok: false, code: "request_body_too_large", message: `tail may carry at most ${RECOMMEND_TAIL_MAX_ENTRIES} messages.` }
  }
  if (tail.reduce((sum, message) => sum + message.text.length, 0) > RECOMMEND_TAIL_MAX_CHARS) {
    return { ok: false, code: "request_body_too_large", message: `tail may carry at most ${RECOMMEND_TAIL_MAX_CHARS} characters of text.` }
  }
  if (commands.length > RECOMMEND_COMMANDS_MAX) {
    return { ok: false, code: "request_body_too_large", message: `commands may carry at most ${RECOMMEND_COMMANDS_MAX} entries.` }
  }
  return { ok: true, body: { repo: repo ?? null, tail, commands, ...(model === undefined ? {} : { model: model.data }) } }
}

/** Read and validate the body under its byte cap. */
export const parseRecommendRequest = (request: Request): Effect.Effect<ParsedRecommendRequest> =>
  readBoundedJson(request, RECOMMEND_BODY_MAX_BYTES).pipe(
    Effect.map(validateRecommendRequest),
    Effect.catch((failure) => Effect.succeed<ParsedRecommendRequest>({ ok: false, ...bodyRefusal(failure, "The recommendation request") }))
  )

/** The text the digest is over: one line per message, role first. */
export const tailText = (tail: ReadonlyArray<RecommendTailMessage>): string =>
  tail.map((message) => `${message.role}: ${message.text}`).join("\n")

/* ------------------------------------------------------------------------ */
/* The model                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * What Jev decides, in its own words. A decision model picks among the
 * options the question offers, so the instructions say the job and nothing
 * about an answer format.
 */
export const RECOMMEND_CHOICE_INSTRUCTIONS =
  "Choose the next command this user should run in Smithers, a product where a coding agent works on a repository. " +
  "Prefer commands that continue what the user is doing; when the conversation is empty, prefer commands that start something."

/** The key of the `index`-th choice question in one request. */
export const recommendQuestionKey = (index: number): string => `command${index + 1}`

/**
 * The offered catalog in order, cut into chunks of at most `size` commands —
 * one question's worth each. An empty catalog is still one (empty) chunk, so
 * a request's shape never depends on whether the client had anything to
 * offer. The front door cuts the same catalog one command smaller
 * (frontDoor.ts FRONT_DOOR_JEV_COMMANDS_MAX), because each of its questions
 * carries a `none` option beside the commands.
 */
export const jevCommandChunks = (
  commands: ReadonlyArray<RecommendCommand>,
  size: number
): ReadonlyArray<ReadonlyArray<RecommendCommand>> => {
  const chunks: Array<ReadonlyArray<RecommendCommand>> = []
  for (let start = 0; start < commands.length; start += size) chunks.push(commands.slice(start, start + size))
  if (chunks.length === 0) chunks.push([])
  return chunks
}

/**
 * The offered catalog as choice questions: one per RECOMMEND_JEV_COMMANDS_MAX
 * commands, all carried by ONE request. The gateway answers the questions of
 * a request in parallel, so a catalog of three hundred costs the latency of
 * one question, and a catalog too big for one question is still Jev's
 * decision rather than someone else's.
 */
export const recommendQuestions = (
  commands: ReadonlyArray<RecommendCommand>
): Readonly<Record<string, JevQuestion>> => {
  const chunks = jevCommandChunks(commands, RECOMMEND_JEV_COMMANDS_MAX)
  return Object.fromEntries(chunks.map((chunk, index) => [
    recommendQuestionKey(index),
    {
      type: "choice",
      instructions: RECOMMEND_CHOICE_INSTRUCTIONS,
      criteria: Object.fromEntries(chunk.map((command) => [command.name, command.summary]))
    } satisfies JevQuestion
  ]))
}

/**
 * Every name Jev weighted, best first, merged across the questions of one
 * request. A question that reported probabilities contributes each option it
 * gave weight to; a question that reported only its chosen option contributes
 * that one name, after every weighted name, because an unmeasured choice
 * cannot be compared with a measured one. `undefined` means no question came
 * back as a choice at all, which is Jev failing rather than Jev answering
 * "nothing".
 */
export const rankJevAnswers = (
  answers: Readonly<Record<string, JevAnswerValue>>,
  keys: ReadonlyArray<string>
): ReadonlyArray<string> | undefined => {
  const weighted: Array<{ readonly name: string; readonly probability: number }> = []
  const unweighted: Array<string> = []
  let read = 0
  for (const key of keys) {
    const answer = answers[key]
    if (answer?.type !== "choice" || typeof answer.choice !== "string") continue
    read += 1
    const probabilities = answer.probabilities
    if (typeof probabilities !== "object" || probabilities === null) {
      unweighted.push(answer.choice)
      continue
    }
    for (const [name, probability] of Object.entries(probabilities)) {
      if (typeof probability === "number" && probability > 0) weighted.push({ name, probability })
    }
  }
  if (read === 0) return undefined
  weighted.sort((left, right) => right.probability - left.probability)
  return [...weighted.map((entry) => entry.name), ...unweighted]
}

/** Keep only offered names, first mention wins, at most the answer cap. */
export const filterAnswer = (
  names: ReadonlyArray<string>,
  offered: ReadonlyArray<RecommendCommand>
): ReadonlyArray<string> => {
  const known = new Set(offered.map((command) => command.name))
  const kept: Array<string> = []
  for (const name of names) {
    const trimmed = name.trim()
    if (known.has(trimmed) && !kept.includes(trimmed)) kept.push(trimmed)
    if (kept.length === RECOMMEND_ANSWER_MAX) break
  }
  return kept
}

/** One message of a Cerebras chat completion. */
export interface CerebrasChatMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
}

/** One Cerebras chat completion: the model, the messages, and its bounds. */
export interface CerebrasChatRequest {
  readonly model: string
  readonly messages: ReadonlyArray<CerebrasChatMessage>
  readonly maxTokens: number
  readonly temperature: number
  /**
   * How much reasoning the completion may spend. Cerebras's default is
   * `high`, so every call site here states its own: an omitted effort is not
   * "the cheap one", it is the most expensive one.
   */
  readonly reasoningEffort?: "none" | "low" | "medium" | "high"
  /** The provider's `response_format` object, when the caller wants structured output. */
  readonly responseFormat?: Record<string, unknown>
}

/**
 * What one completion answered. `http` carries the provider's status so a
 * caller can retry a 400 differently from a 429; `empty` is a 200 whose
 * first choice carried no text; `timeout` is this call's own deadline. The
 * client going away is the fiber's interruption, which ends the call without
 * an answer.
 */
export type CerebrasChatAnswer =
  | { readonly ok: true; readonly content: string; readonly model: string }
  | { readonly ok: false; readonly reason: "http"; readonly status: number }
  | { readonly ok: false; readonly reason: "empty" }
  | { readonly ok: false; readonly reason: "timeout" }
  | { readonly ok: false; readonly reason: "unreachable"; readonly message: string }
  | { readonly ok: false; readonly reason: "out_of_credit" }

const CEREBRAS_SEAM = "cerebras"

/**
 * One Cerebras chat completion, non-streaming, under a deadline. The one
 * client every Cerebras-spending route on this Worker uses — today only the
 * cloud role turns in cloudRoleTurn.ts, the Librarian and the Flows agent —
 * so there is one place that says what a Cerebras request looks like and how
 * its failures read. The recommender above does not use it: pills are Jev's
 * decision or no decision at all.
 * The deadline covers the whole call, headers and body; when it wins, the
 * fetch is interrupted and so aborted. A refused response has its body
 * cancelled here. The key is the deployment's (`ServerConfig`); callers
 * check it is set before spending a call, so an unset key here reads as the
 * provider being unreachable rather than as an invented answer.
 */
export const cerebrasChat = (
  request: CerebrasChatRequest,
  timeoutMs: number
): Effect.Effect<CerebrasChatAnswer, never, Transport | ServerConfig> =>
  Effect.gen(function*() {
    const config = yield* ServerConfig
    // A login's call goes through Smithers Cloud's metered proxy on its own token (modelPayer.ts).
    const route = yield* modelRoute(CEREBRAS_CHAT_COMPLETIONS_URL, config.cerebrasApiKey)
    if (!route.ok) {
      return { ok: false, reason: "unreachable", message: config.cerebrasApiKey === undefined ? "CEREBRAS_API_KEY is unset." : route.message } as const
    }
    const response = yield* fetchWithDeadline(CEREBRAS_SEAM, route.url, {
      method: "POST",
      headers: { authorization: route.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        ...(request.reasoningEffort === undefined ? {} : { reasoning_effort: request.reasoningEffort }),
        messages: request.messages,
        ...(request.responseFormat === undefined ? {} : { response_format: request.responseFormat })
      })
    }, timeoutMs)
    if (route.metered && response.status === 402 && (yield* isOutOfCredit(response))) return { ok: false, reason: "out_of_credit" } as const
    if (!response.ok) {
      yield* discardBody(response)
      return { ok: false, reason: "http", status: response.status } as const
    }
    const answer = (yield* readJsonOrUndefined(response)) as
      | { readonly model?: unknown; readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: unknown } }> }
      | undefined
    const content = answer?.choices?.[0]?.message?.content
    if (typeof content !== "string") return { ok: false, reason: "empty" } as const
    return { ok: true, content, model: typeof answer?.model === "string" ? answer.model : request.model } as const
  }).pipe(
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed<CerebrasChatAnswer>({ ok: false, reason: "timeout" }) }),
    Effect.catchTag("UpstreamTimeout", () => Effect.succeed<CerebrasChatAnswer>({ ok: false, reason: "timeout" })),
    Effect.catchTag("UpstreamUnreachable", (failure) =>
      Effect.succeed<CerebrasChatAnswer>({ ok: false, reason: "unreachable", message: failure.message }))
  )

type ModelAnswer =
  | { readonly ok: true; readonly commands: ReadonlyArray<string>; readonly model: string }
  | { readonly ok: false; readonly message: string; readonly outOfCredit?: true; readonly cause: JevFailure }

type JevFailure = Exclude<JevAnswer, { readonly ok: true }>

/** The operator evidence for a Jev failure: its reason, status or native cause. */
export const jevFailureDetail = (answer: JevFailure): { readonly seam: string; readonly cause: unknown } => ({
  seam: "jev",
  cause: answer.reason === "http" ? `http ${answer.status}` : answer.reason === "unreachable" ? answer.message : answer.reason
})

/**
 * Why Jev did not decide, in product words a 503 body can carry. The HTTP
 * status and the native cause are operator evidence: `jevFailureDetail` puts
 * them on the refusal log line, never in the body.
 */
export const jevFailureMessage = (answer: Exclude<JevAnswer, { readonly ok: true }>): string => {
  switch (answer.reason) {
    case "http":
      return answer.status === 429
        ? "Smithers' decision model is busy right now. Try again in a minute."
        : "Smithers' decision model refused that just now. Try again in a moment."
    case "empty":
      return "Smithers' decision model sent no decision. Try again."
    case "timeout":
      return "Smithers' decision model took too long to answer. Try again in a moment."
    case "unreachable":
      return "Smithers' decision model can't be reached right now. Try again in a moment."
    case "out_of_credit":
      return "Out of credit."
  }
}

/**
 * One recommendation from Jev, and from nobody else. The offered commands are
 * the options of one choice question, or of several when the catalog is
 * longer than one question holds — all in one request, merged by probability.
 * A Jev that refuses, misses its deadline, or answers something this client
 * cannot read is a failure the route reports; no LLM is asked in its place.
 */
const askJev = (body: RecommendRequest, model: string): Effect.Effect<ModelAnswer, never, Transport | ServerConfig> =>
  Effect.gen(function*() {
    const questions = recommendQuestions(body.commands)
    const answer = yield* jevEvaluate({
      model,
      state: {
        repository: body.repo ?? "(none selected)",
        conversation: body.tail.length === 0 ? "(no messages yet)" : tailText(body.tail)
      },
      questions
    }, RECOMMEND_JEV_TIMEOUT_MS)
    if (!answer.ok) return { ok: false, message: jevFailureMessage(answer), cause: answer, ...(answer.reason === "out_of_credit" ? { outOfCredit: true } : {}) } as const
    const ranked = rankJevAnswers(answer.answers, Object.keys(questions))
    if (ranked === undefined) return { ok: false, message: jevFailureMessage({ ok: false, reason: "empty" }), cause: { ok: false, reason: "empty" } } as const
    return { ok: true, commands: filterAnswer(ranked, body.commands), model: answer.model } as const
  })

/* ------------------------------------------------------------------------ */
/* The routes                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The bucket a recommendation spends from: the login when the session is
 * known, else the same salted address digest the anonymous turn ceiling
 * uses, both under a `recommend:` prefix so no turn bucket is ever shared.
 */
export const recommendKey = (request: Request, login: string | undefined, salt: string | undefined): Effect.Effect<string> =>
  login === undefined
    ? Effect.map(anonymousTurnKey(request, salt), (key) => `recommend:${key}`)
    : Effect.succeed(`recommend:login:${login}`)

const jsonWith = (status: number, body: unknown, headers: Record<string, string>): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

/* This route's own refusal: the code names the status, and the caller's headers ride along. */
const refusal = routeRefusal

/**
 * POST /api/recommend. `login` is the validated session's login when the
 * caller has one; the router resolves it and passes `undefined` for a
 * visitor. Order: the body first (a refusal there costs nothing), then the
 * key (a deployment without one spends no ceiling), then both ceilings,
 * then Jev.
 */
export const handleRecommend = (
  request: Request,
  login: string | undefined,
  headers: Record<string, string>
): Effect.Effect<Response, never, RecommendLogStore | TurnLimits | ServerConfig | Transport> =>
  Effect.gen(function*() {
    const parsed = yield* parseRecommendRequest(request)
    if (!parsed.ok) return refusal(parsed.code, parsed.message, headers)
    const config = yield* ServerConfig
    // The decision model this request armed (the `recommend` seat). A binding
    // this deployment does not allow is refused before a ceiling or Jev is spent.
    const armed = planDecisionModel(parsed.body.model, config)
    if (!armed.ok) return modelRefusal(armed.failure, headers)
    if (config.aiGatewayApiKey === undefined) {
      return refusal("seam_not_configured", "Command suggestions aren't available on this deployment.", headers, {
        seam: "recommend",
        cause: "AI_GATEWAY_API_KEY is unset"
      })
    }
    const limits = yield* TurnLimits
    const salt = config.anonymousTurnSalt === undefined ? undefined : Redacted.value(config.anonymousTurnSalt)
    const key = yield* recommendKey(request, login, salt)
    const own = yield* limits.spend(key, RECOMMEND_CEILING)
    if (!own.allowed) return turnLimitResponse(own, headers, RECOMMEND_CEILING)
    const shared = yield* limits.spend(RECOMMEND_ALL_KEY, RECOMMEND_ALL_CEILING)
    if (!shared.allowed) return turnLimitResponse(shared, headers, RECOMMEND_ALL_CEILING)
    // A login's Jev call is metered against its own credit (modelPayer.ts).
    const answer = yield* askJev(parsed.body, armed.modelId).pipe(paidBy(login))
    if (!answer.ok) {
      return refusal(answer.outOfCredit ? "out_of_credit" : "service_temporarily_unavailable", answer.message, headers, jevFailureDetail(answer.cause))
    }
    const digest = yield* sha256Hex(tailText(parsed.body.tail))
    const store = yield* RecommendLogStore
    const id = yield* store.append({
      at: new Date().toISOString(),
      repo: parsed.body.repo,
      tailDigest: digest,
      commandCount: parsed.body.commands.length,
      commands: answer.commands,
      model: answer.model,
      outcome: null
    })
    return jsonWith(200, { id, commands: answer.commands, model: answer.model }, headers)
  })

/** POST /api/recommend/outcome: 204 once per id, 404 for an id the log never minted, 409 for a second outcome. */
export const handleRecommendOutcome = (
  request: Request,
  headers: Record<string, string>
): Effect.Effect<Response, never, RecommendLogStore> =>
  Effect.gen(function*() {
    const read = yield* Effect.result(readBoundedJson(request, RECOMMEND_OUTCOME_BODY_MAX_BYTES))
    if (Result.isFailure(read)) {
      switch (read.failure._tag) {
        case "BodyTooLarge":
          return refusal("request_body_too_large", "The outcome is too large.", headers)
        case "BodyUnreadable":
          return refusal("request_body_unreadable", "The outcome could not be read.", headers)
        case "BodyNotJson":
          // A body that is not JSON is a malformed outcome, as it always was.
          return refusal("request_invalid", "An outcome is { id, command }, both strings.", headers)
      }
    }
    const body = read.success as { readonly id?: unknown; readonly command?: unknown } | null | undefined
    if (
      body === undefined || body === null || typeof body !== "object" ||
      typeof body.id !== "string" || body.id === "" || typeof body.command !== "string" || body.command === ""
    ) {
      return refusal("request_invalid", "An outcome is { id, command }, both strings.", headers)
    }
    if (body.command.length > RECOMMEND_COMMAND_NAME_MAX_CHARS) {
      return refusal(
        "request_invalid",
        `An outcome's command is a command name of at most ${RECOMMEND_COMMAND_NAME_MAX_CHARS} characters.`,
        headers
      )
    }
    const store = yield* RecommendLogStore
    const recorded = yield* store.outcome(body.id, body.command, new Date().toISOString())
    switch (recorded) {
      case undefined:
        return refusal("route_not_found", "No recommendation log on this deployment: no recommendation has that id.", headers)
      case 204:
        return new Response(null, { status: 204, headers })
      case 409:
        return refusal("request_conflict", "An outcome is already recorded for that recommendation.", headers)
      case 404:
        return refusal("route_not_found", "No recommendation has that id.", headers)
      default:
        return refusal("storage_failed", "The recommendation log did not record the outcome.", headers)
    }
  })
