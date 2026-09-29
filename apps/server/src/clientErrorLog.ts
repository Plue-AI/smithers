import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Semaphore from "effect/Semaphore"
import { runDurable } from "./Boundary"
import { answeredJson, DurableStorage, namespaceCall, storageLayer } from "./DurableStorage"
import type { NativeNamespace, NativeStorage } from "./DurableStorage"
import { discardBody, readJsonOrUndefined } from "./Http"
import { storageFailureAnswer } from "./Responses"
/**
 * A readable record of what broke in a user's browser.
 *
 * The client already posts its errors to `/api/telemetry/errors`. Until now the
 * handler ran `console.error` and stopped, which means the report survived only
 * as long as someone happened to be running `wrangler tail`. During a private
 * alpha that is the same as having no report at all: the first anyone learns of
 * a broken flow is the user mentioning it, if they bother.
 *
 * So the last reports are kept in one Durable Object — a ring buffer, newest
 * first — and read back through `GET /api/admin/errors`, behind the same admin
 * validation as every other admin route. Deliberately not a log service: no new
 * vendor, no new secret, no egress, and it is bounded, so it cannot grow into a
 * cost of its own.
 *
 * What is stored is what the page sent plus when it arrived, the URL it came
 * from, the user agent, and whether the request carried a session cookie. No
 * session lookup: identifying the reporter would mean an identity round-trip
 * on a route that must stay cheap enough to absorb an error storm, and the
 * report itself is what needs reading.
 *
 * The route is unauthenticated by design (a crash before or during sign-in
 * must still be recorded), so the throttle is the only thing between an
 * anonymous flood and the log. It lives HERE, in the one Durable Object every
 * report reaches, and not in the Worker: a counter in Worker module state is
 * per isolate, workerd runs many isolates and recycles them, and so a counter
 * there bounds nothing. The window is global, one source gets a small share
 * of it, and a report that came with a session cookie is never evicted to
 * make room for one that did not.
 */

/** Reports kept. Bounded independently of the per-tier admission windows. */
export const CLIENT_ERROR_LOG_LIMIT = 200

/** The throttle window, and the most reports it admits from everyone together. */
export const CLIENT_ERROR_WINDOW_MS = 60_000
export const CLIENT_ERROR_WINDOW_MAX = 120

/**
 * The most reports one source (one client address, an IPv6 /64) may add per
 * window. A browser in an error loop says everything it has to say in its
 * first twenty reports; a flood from one address stops there.
 */
export const CLIENT_ERROR_SOURCE_WINDOW_MAX = 20

/** The source a report is counted against when the request carried no client address. */
export const CLIENT_ERROR_UNKNOWN_SOURCE = "unknown"

/**
 * The whole log lives under one Durable Object storage key, and a stored value
 * may not exceed 128 KiB. The route accepts a report of up to 16 KiB, so a
 * count alone is not a bound: two hundred large ones would be megabytes, the
 * `put` would throw, and — because appending must never fail the report — the
 * throw would be swallowed and the log would silently stop recording. Which is
 * the exact failure this module exists to end.
 *
 * So the real constraint is bytes. The budget is set well under the limit to
 * leave room for the key and the store's own framing.
 */
export const CLIENT_ERROR_LOG_MAX_BYTES = 96 * 1024

/**
 * The most one report may occupy. A stack trace is worth keeping and a 16 KiB
 * blob is not worth evicting fifty other reports for, so an oversized one is
 * truncated rather than dropped: what broke is usually in the first lines.
 */
export const CLIENT_ERROR_RECORD_MAX_BYTES = 4 * 1024

/**
 * The most the page URL or the user agent may occupy. Both come from request
 * headers the client controls, and only the report used to be truncated, so a
 * record could outgrow its budget through its headers alone.
 */
export const CLIENT_ERROR_TEXT_MAX_BYTES = 512

export interface ClientErrorRecord {
  /** When the Worker received it, ISO 8601. */
  readonly at: string
  /** The page that reported, when the request carried a referer. */
  readonly page?: string
  readonly userAgent?: string
  /** The Worker validated this report's session through identity. */
  readonly signedIn?: boolean
  /** Exactly what the client posted, parsed when it was JSON and raw text when it was not. */
  readonly report: unknown
}

/** What became of one report offered to the log. */
export type ClientErrorAppendOutcome = "stored" | "throttled" | "unbound" | "failed"

/** What a read answers: how many reports the log holds, the newest of them, and why it is empty when it should not be. */
export interface ClientErrorPage {
  readonly total: number
  readonly reports: ReadonlyArray<ClientErrorRecord>
  readonly note?: string
}

const LOG_KEY = "reports"

/** The internal header that names the source a report counts against. */
export const CLIENT_ERROR_SOURCE_HEADER = "x-client-error-source"

/*
 * Real UTF-8 bytes, not JSON characters. The store measures bytes and
 * JSON.stringify leaves non-ASCII literal, so a message in a language that
 * is not English costs up to three bytes a character — counting characters
 * would under-measure exactly the reports written by the users hardest to
 * support.
 */
const encoder = new TextEncoder()
const sizeOf = (value: unknown): number => encoder.encode(JSON.stringify(value) ?? "").length

/*
 * A header value cut to its byte budget. String.slice counts characters and
 * the budget counts bytes, so shrink until it actually fits.
 */
const capText = (text: string, maxBytes: number): string => {
  if (encoder.encode(text).length <= maxBytes) return text
  let head = text.slice(0, maxBytes)
  while (head.length > 0 && encoder.encode(`${head}…`).length > maxBytes) {
    head = head.slice(0, Math.floor(head.length * 0.75))
  }
  return `${head}…`
}

/** One report, cut to its byte budget. The truncation is stated, never silent. */
export const capRecord = (posted: ClientErrorRecord): ClientErrorRecord => {
  const record: ClientErrorRecord = {
    ...posted,
    ...(posted.page === undefined ? {} : { page: capText(posted.page, CLIENT_ERROR_TEXT_MAX_BYTES) }),
    ...(posted.userAgent === undefined ? {} : { userAgent: capText(posted.userAgent, CLIENT_ERROR_TEXT_MAX_BYTES) })
  }
  if (sizeOf(record) <= CLIENT_ERROR_RECORD_MAX_BYTES) return record
  const text = typeof record.report === "string" ? record.report : (JSON.stringify(record.report) ?? "")
  const withHead = (head: string): ClientErrorRecord => ({
    ...record,
    report: `${head}… [truncated from ${text.length} characters]`
  })
  /*
   * String.slice counts characters and the budget counts bytes, so a first
   * guess in characters overshoots by up to 3x on non-ASCII text. Shrink
   * geometrically until it actually fits — a handful of iterations, and
   * correct for any alphabet rather than for English only.
   */
  let head = text.slice(0, CLIENT_ERROR_RECORD_MAX_BYTES)
  while (head.length > 0 && sizeOf(withHead(head)) > CLIENT_ERROR_RECORD_MAX_BYTES) {
    head = head.slice(0, Math.floor(head.length * 0.75))
  }
  return withHead(head)
}

/**
 * The newest reports that fit, both bounds enforced: count and bytes.
 *
 * Signed-in reports are admitted first, then anonymous ones fill what is
 * left, each newest first. So an anonymous flood evicts anonymous reports
 * only: a signed-in user's crash stays readable until signed-in reports
 * alone fill the log. The result keeps the log's order, newest first.
 *
 * Each record is measured once and the budget accumulated, rather than
 * re-serializing the whole log per eviction — during a storm this runs on
 * every append.
 */
export const bounded = (records: ReadonlyArray<ClientErrorRecord>): Array<ClientErrorRecord> => {
  const kept = new Set<number>()
  // Two bytes of array framing per record ("[", "]", and the commas between).
  let used = 2
  for (const tier of [true, false]) {
    for (const [index, record] of records.entries()) {
      if ((record.signedIn === true) !== tier) continue
      if (kept.size >= CLIENT_ERROR_LOG_LIMIT) break
      const cost = sizeOf(record) + 1
      // The first report admitted is kept whatever it costs: a log that
      // answers nothing because one report was too big has failed at its
      // only job.
      if (kept.size > 0 && used + cost > CLIENT_ERROR_LOG_MAX_BYTES) break
      kept.add(index)
      used += cost
    }
  }
  return records.filter((_, index) => kept.has(index))
}

/* ------------------------------------------------------------------------ */
/* The throttle                                                              */
/* ------------------------------------------------------------------------ */

/** One throttle window: when it opened, what it admitted, and from whom. */
export interface ClientErrorWindow {
  readonly start: number
  readonly anonymous: number
  readonly signedIn: number
  readonly sources: ReadonlyMap<string, number>
}

const CLOSED_WINDOW: ClientErrorWindow = { start: 0, anonymous: 0, signedIn: 0, sources: new Map() }

/**
 * The window is Durable Object memory, not storage: a flood keeps the object
 * alive, and a quiet minute that lets it go is a window that has passed
 * anyway. What matters is that there is exactly one of it per object, so the
 * native class makes the `Ref` once and provides it to every request.
 */
export class ClientErrorThrottle extends Context.Service<ClientErrorThrottle, Ref.Ref<ClientErrorWindow>>()("smithers-server/ClientErrorThrottle") {}

/** A fresh throttle: the Durable Object's, made once when the object wakes. */
export const makeClientErrorThrottle = (): Ref.Ref<ClientErrorWindow> => Ref.makeUnsafe(CLOSED_WINDOW)

export const clientErrorThrottleLayer = (throttle: Ref.Ref<ClientErrorWindow>): Layer.Layer<ClientErrorThrottle> =>
  Layer.succeed(ClientErrorThrottle, throttle)

/** Count one report from `source` at `now`: admitted, or refused by its tier or the per-source ceiling. */
const admit = (throttle: Ref.Ref<ClientErrorWindow>, source: string, now: number, signedIn: boolean): Effect.Effect<boolean> =>
  Ref.modify(throttle, (current) => {
    const window = now - current.start > CLIENT_ERROR_WINDOW_MS ? { start: now, anonymous: 0, signedIn: 0, sources: new Map<string, number>() } : current
    const fromSource = window.sources.get(source) ?? 0
    if (fromSource >= CLIENT_ERROR_SOURCE_WINDOW_MAX) return [false, window]
    const tier = signedIn ? "signedIn" : "anonymous"
    if (window[tier] >= CLIENT_ERROR_WINDOW_MAX) return [false, window]
    const sources = new Map(window.sources)
    sources.set(source, fromSource + 1)
    return [true, { ...window, [tier]: window[tier] + 1, sources }]
  })

/** Every deployment shares one log; the name is fixed so any request finds it. */
export const CLIENT_ERROR_LOG_NAME = "client-errors"

const isRecord = (value: unknown): value is ClientErrorRecord => typeof value === "object" && value !== null

/* ------------------------------------------------------------------------ */
/* The Durable Object                                                        */
/* ------------------------------------------------------------------------ */

/**
 * The log's request: `POST /append` counts one report against the source
 * named by `x-client-error-source` (429 `{ status: "throttled" }` when the
 * window or the source is spent) and records it; `GET /read?limit=` answers
 * the newest. A storage failure is the object's own 500; the Worker-side
 * `append` reports it as "failed", because the report must never fail.
 * An append holds `writes` from its read of the ring to its write, so a
 * storm never loads one snapshot twice; the body is read before, so a slow
 * body never holds the log.
 */
export const clientErrorLogRequest = (
  request: Request,
  writes: Semaphore.Semaphore
): Effect.Effect<Response, never, DurableStorage | ClientErrorThrottle> =>
  Effect.gen(function*() {
    const storage = yield* DurableStorage
    const url = new URL(request.url)
    switch (url.pathname) {
      case "/append": {
        const record = yield* readJsonOrUndefined(request)
        if (!isRecord(record)) return new Response("bad record", { status: 400 })
        const throttle = yield* ClientErrorThrottle
        const now = yield* Clock.currentTimeMillis
        const source = request.headers.get(CLIENT_ERROR_SOURCE_HEADER) ?? CLIENT_ERROR_UNKNOWN_SOURCE
        if (!(yield* admit(throttle, source, now, record.signedIn === true))) {
          return new Response(JSON.stringify({ status: "throttled" }), {
            status: 429,
            headers: { "content-type": "application/json" }
          })
        }
        return yield* writes.withPermit(Effect.gen(function*() {
          const stored = (yield* storage.get<ReadonlyArray<ClientErrorRecord>>(LOG_KEY)) ?? []
          // Newest first, oldest evicted: a storm never buries the report
          // that is being read right now.
          const next = bounded([capRecord(record), ...stored])
          yield* storage.put(LOG_KEY, next)
          return new Response(JSON.stringify({ status: "ok", kept: next.length }), {
            headers: { "content-type": "application/json" }
          })
        }))
      }
      case "/read": {
        const asked = Number(url.searchParams.get("limit") ?? CLIENT_ERROR_LOG_LIMIT)
        const limit = Number.isInteger(asked) && asked > 0
          ? Math.min(asked, CLIENT_ERROR_LOG_LIMIT)
          : CLIENT_ERROR_LOG_LIMIT
        const stored = (yield* storage.get<ReadonlyArray<ClientErrorRecord>>(LOG_KEY)) ?? []
        return new Response(
          JSON.stringify({ status: "ok", total: stored.length, reports: stored.slice(0, limit) }),
          { headers: { "content-type": "application/json" } }
        )
      }
      default:
        return new Response("not found", { status: 404 })
    }
  }).pipe(
    Effect.catchTag("StorageFailure", (failure) => Effect.succeed(storageFailureAnswer("client error log", failure)))
  )

export class ClientErrorLog {
  private readonly throttle = makeClientErrorThrottle()
  private readonly writes = Semaphore.makeUnsafe(1)

  constructor(private readonly ctx: { readonly storage: NativeStorage }) {}

  fetch(request: Request): Promise<Response> {
    return runDurable(
      clientErrorLogRequest(request, this.writes).pipe(
        Effect.provide(Layer.mergeAll(storageLayer(this.ctx.storage), clientErrorThrottleLayer(this.throttle)))
      )
    )
  }
}

/* ------------------------------------------------------------------------ */
/* The Worker-side service                                                   */
/* ------------------------------------------------------------------------ */

export interface ClientErrorsShape {
  /**
   * Record one report, counted against `source`. Never fails: a browser
   * that just hit an error is not helped by the report failing too, so a
   * log that cannot be reached answers "failed" and the caller still
   * accepts the report. "throttled" is the one outcome the caller refuses
   * on.
   */
  readonly append: (record: ClientErrorRecord, source?: string) => Effect.Effect<ClientErrorAppendOutcome>
  /** The stored reports, newest first, at most `limit` of them. */
  readonly read: (limit?: number) => Effect.Effect<ReadonlyArray<ClientErrorRecord>>
  /** The stored reports with the log's total, for the admin read; an unavailable log says so in `note`. */
  readonly page: (limit?: number) => Effect.Effect<ClientErrorPage>
}

export class ClientErrors extends Context.Service<ClientErrors, ClientErrorsShape>()("smithers-server/ClientErrors") {}

const EMPTY: ClientErrorPage = { total: 0, reports: [] }

/** What the admin read answers when the log cannot be reached. */
export const CLIENT_ERROR_LOG_UNAVAILABLE_NOTE = "The client-error log is unavailable right now. Try again in a moment."

const UNAVAILABLE: ClientErrorPage = { total: 0, reports: [], note: CLIENT_ERROR_LOG_UNAVAILABLE_NOTE }

const isPage = (value: unknown): value is ClientErrorPage =>
  typeof value === "object" && value !== null &&
  typeof (value as { total?: unknown }).total === "number" &&
  Array.isArray((value as { reports?: unknown }).reports)

/**
 * The log over the CLIENT_ERRORS namespace. With no namespace bound (local
 * dev, the stub stack) appending is "unbound" and the handler's
 * `console.error` remains the only trace, as it always was; a read is
 * honestly empty.
 */
export const clientErrorsLayer = (namespace: NativeNamespace | undefined): Layer.Layer<ClientErrors> => {
  const page = Effect.fn("ClientErrors.read")(function*(limit?: number) {
    if (namespace === undefined) return EMPTY
    const query = limit === undefined ? "" : `?limit=${limit}`
    const body = yield* namespaceCall(
      "clientErrors.read",
      namespace,
      CLIENT_ERROR_LOG_NAME,
      new Request(`https://client-errors.internal/read${query}`)
    ).pipe(
      Effect.flatMap((response) => answeredJson("clientErrors.read", "The client-error log", response)),
      Effect.catch((failure) =>
        Effect.sync(() => {
          console.error("client-error log read failed:", failure.cause)
          return UNAVAILABLE
        }))
    )
    return isPage(body) ? body : UNAVAILABLE
  })
  return Layer.succeed(ClientErrors, {
    append: Effect.fn("ClientErrors.append")(function*(record: ClientErrorRecord, source: string = CLIENT_ERROR_UNKNOWN_SOURCE) {
      if (namespace === undefined) return "unbound"
      const response = yield* namespaceCall(
        "clientErrors.append",
        namespace,
        CLIENT_ERROR_LOG_NAME,
        new Request("https://client-errors.internal/append", {
          method: "POST",
          headers: { [CLIENT_ERROR_SOURCE_HEADER]: source },
          body: JSON.stringify(record)
        })
      ).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (response === undefined) return "failed"
      yield* discardBody(response)
      if (response.status === 429) return "throttled"
      return response.ok ? "stored" : "failed"
    }),
    read: (limit) => Effect.map(page(limit), (found) => found.reports),
    page
  })
}
