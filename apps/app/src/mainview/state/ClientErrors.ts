/*
 * The client half of the crash sink. A page that throws posts one report to
 * POST /api/telemetry/errors, the one route every target serves:
 *   - the Go backend (the desktop app's default target, reached through the
 *     relay) and Plue log it and count it in smithers_client_errors_total;
 *   - the Worker in front of the web build keeps it in a bounded Durable Object
 *     for GET /api/admin/errors and exports the count to Plue.
 * Without this the first anyone hears of a broken flow is a user mentioning it.
 *
 * The body is the Go backend's ClientErrorReport (internal/routes/telemetry.go)
 * plus `kind` and `at`, which Go ignores and the Worker's log keeps. The
 * contract is testable here, so a rename on either side turns a test red
 * instead of quietly pointing every crash report at a 404. There is no second
 * copy of the reporter to drift from it.
 *
 * Bounds, each for a reason:
 *   - the path is a constant, not a literal at the call site, so the client
 *     and the routes cannot drift apart unnoticed;
 *   - each error field is cut to the Go backend's own cap, in UTF-8 bytes, so
 *     Go's byte-index truncation never splits a character;
 *   - the posted body is cut to CLIENT_ERROR_BODY_MAX_BYTES, so escaping
 *     cannot push a report past the Worker route's cap and be answered 413;
 *   - a page reports each kind at most CLIENT_ERROR_REPORT_LIMIT times, so an error in
 *     a render loop cannot turn one broken tab into a request storm.
 *
 * Reporting is fire-and-forget in both directions: it never throws, never
 * awaits, and never surfaces its own failure. A page that just crashed is not
 * helped by the report crashing too.
 */

/** The crash sink every target routes: the Go backend, Plue and the Worker. */
export const CLIENT_ERRORS_PATH = "/api/telemetry/errors"

/** Reports per kind one page may send. A render loop can fail without end. */
export const CLIENT_ERROR_REPORT_LIMIT = 20

/**
 * The largest body this client will post, in UTF-8 bytes.
 *
 * The number and the unit are both the Worker's: apps/server/src/proxies.ts
 * refuses a report with more than CLIENT_ERROR_MAX_BODY (16 * 1024) bytes on
 * the wire. JSON.stringify leaves non-ASCII literal and escapes a control
 * character or a lone surrogate to six bytes, so only the serialized string
 * is an honest place to measure.
 */
export const CLIENT_ERROR_BODY_MAX_BYTES = 16 * 1024

/** The Go backend's maxErrorMessageLen, in bytes. */
export const CLIENT_ERROR_MESSAGE_MAX_BYTES = 512

/** The Go backend's maxErrorStackLen, in bytes. */
export const CLIENT_ERROR_STACK_MAX_BYTES = 4096

/** The Go backend's maxErrorTypeLen, in bytes. */
export const CLIENT_ERROR_TYPE_MAX_BYTES = 128

/**
 * Bytes of page path kept. The path is overhead on every report and a path
 * longer than this is not one anyone reads.
 */
export const CLIENT_ERROR_URL_MAX_BYTES = 1024

export type ClientErrorKind = "error" | "unhandledrejection" | "operational"

/** Exactly what is posted: the Go backend's ClientErrorReport plus `kind` and `at`. */
export interface ClientErrorReport {
  /** The Go route logs and counts only "web" and "cli". */
  readonly client: "web"
  readonly kind: ClientErrorKind
  readonly error: {
    /** The Error's name; empty for a thrown value that is not an Error. */
    readonly type: string
    readonly message: string
    readonly stack: string
  }
  readonly context: { readonly url: string }
  readonly at: string
}

/*
 * Narrower than `typeof fetch` on purpose: the reporter only ever posts one
 * string path, and the wide type drags in the platform's extra statics
 * (`preconnect`), which no test double can satisfy.
 */
export type ClientErrorFetch = (input: string, init: RequestInit) => Promise<Response>

export interface ClientErrorReporterOptions {
  /** Injected for tests. Defaults to the global fetch. */
  readonly fetchImpl?: ClientErrorFetch
  readonly limit?: number
  readonly now?: () => Date
  /** The page the report came from. Defaults to the current pathname. */
  readonly pathname?: () => string
}

export interface ClientErrorReporter {
  readonly report: (kind: ClientErrorKind, error: unknown) => void
  /** Reports sent so far, for asserting the cap. */
  readonly reported: () => number
}

/*
 * Keep the reason and the stack: WebKit stacks contain only frames, while
 * Chromium already includes the error heading. A rejection reason may not be
 * an Error at all; String() keeps those values legible. Throwing field getters
 * cost only their field, and hostile conversions fall back to a safe label.
 */
export const errorMessage = (error: unknown): string => {
  try {
    if (!(error instanceof Error)) return String(error)
    const { type, message, stack } = errorDetail(error)
    const heading = type && message ? `${type}: ${message}` : message || type
    if (!heading) return stack || nonErrorLabel(error)
    if (!stack) return heading
    if (stack === heading || stack.startsWith(`${heading}\n`) || stack.startsWith(`${heading}\r\n`)) return stack
    return `${heading}\n${stack}`
  } catch {
    return nonErrorLabel(error)
  }
}

const nonErrorLabel = (error: unknown): string => {
  try {
    return Object.prototype.toString.call(error)
  } catch {
    return "Unknown error"
  }
}

/* The three error fields, before any bound. A getter that throws costs its field only. */
const errorDetail = (error: unknown): ClientErrorReport["error"] => {
  if (!(error instanceof Error)) {
    let message: string
    try { message = String(error) } catch { message = nonErrorLabel(error) }
    return { type: "", message, stack: "" }
  }
  const field = (read: () => unknown): string => {
    try {
      const value = read()
      return typeof value === "string" ? value : ""
    } catch {
      return ""
    }
  }
  return { type: field(() => error.name), message: field(() => error.message), stack: field(() => error.stack) }
}

const encoder = new TextEncoder()

/** UTF-8 bytes, the unit the Worker measures a request body in. */
export const byteLength = (text: string): number => encoder.encode(text).length

/*
 * Cutting to a byte budget cannot be done by counting characters: a UTF-16
 * code unit is worth one to three UTF-8 bytes, and up to six once JSON escapes
 * it. So the cut is proportional and then re-measured. The first pass lands
 * close for any alphabet and the loop makes it exact. Neither pass can shrink
 * the text to nothing, which is what subtracting the byte excess from a
 * character count does on non-ASCII input.
 */
const cutToBytes = (text: string, maxBytes: number): string => {
  let head = text.length > maxBytes ? text.slice(0, maxBytes) : text
  let size = byteLength(head)
  while (size > maxBytes && head.length > 0) {
    head = head.slice(0, Math.min(head.length - 1, Math.floor((head.length * maxBytes) / size)))
    size = byteLength(head)
  }
  return head
}

/**
 * The exact bytes posted for one report, already inside every sink's caps.
 *
 * Building the body and bounding it are one step on purpose: the escaping
 * JSON.stringify applies is part of what the Worker weighs, so the serialized
 * string is the only honest place to measure. There is no way to build a
 * report body that skips this bound.
 */
export const clientErrorBody = (
  kind: ClientErrorKind,
  error: unknown,
  at: Date,
  url: string
): string => {
  const detail = errorDetail(error)
  const type = cutToBytes(detail.type, CLIENT_ERROR_TYPE_MAX_BYTES)
  const message = cutToBytes(detail.message, CLIENT_ERROR_MESSAGE_MAX_BYTES)
  const context = { url: cutToBytes(url, CLIENT_ERROR_URL_MAX_BYTES) }
  const stamp = at.toISOString()
  const bodyFor = (stack: string): string =>
    JSON.stringify({ client: "web", kind, error: { type, message, stack }, context, at: stamp } satisfies ClientErrorReport)
  // The stack is what gives: the other fields are cut to at most 1,664
  // bytes, which JSON escaping can grow to about 10 KiB, so an empty stack
  // always fits the cap and the loop ends with the head of the stack kept.
  let stack = cutToBytes(detail.stack, CLIENT_ERROR_STACK_MAX_BYTES)
  let body = bodyFor(stack)
  const fixed = byteLength(bodyFor(""))
  while (byteLength(body) > CLIENT_ERROR_BODY_MAX_BYTES && stack.length > 0) {
    const available = CLIENT_ERROR_BODY_MAX_BYTES - fixed
    const used = byteLength(body) - fixed
    stack = stack.slice(0, Math.max(0, Math.min(stack.length - 1, Math.floor((stack.length * available) / used))))
    body = bodyFor(stack)
  }
  return body
}

const currentPathname = (): string => typeof globalThis.location === "undefined" ? "" : globalThis.location.pathname

export const createClientErrorReporter = (
  options?: ClientErrorReporterOptions
): ClientErrorReporter => {
  const limit = options?.limit ?? CLIENT_ERROR_REPORT_LIMIT
  const now = options?.now ?? ((): Date => new Date())
  const pathname = options?.pathname ?? currentPathname
  const sent = new Map<ClientErrorKind, number>()

  const report = (kind: ClientErrorKind, error: unknown): void => {
    try {
      if ((sent.get(kind) ?? 0) >= limit) return
      // Counted before construction and sending: the cap bounds attempts,
      // so any failure cannot be retried into a storm.
      sent.set(kind, (sent.get(kind) ?? 0) + 1)
      const body = clientErrorBody(kind, error, now(), pathname())
      // keepalive so a report survives the navigation that a crash often
      // triggers. The browser allows 64 KiB of keepalive bodies in flight
      // at once, which is four reports at this cap, and a crashing page
      // sends them one at a time.
      const post = options?.fetchImpl ?? globalThis.fetch
      const sending = post(CLIENT_ERRORS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true
      })
      void Promise.resolve(sending).catch(() => undefined)
    } catch {
      // Construction, metadata callbacks, and synchronous fetch failures
      // must not become a second uncaught error on top of the first one.
    }
  }

  return { report, reported: (): number => [...sent.values()].reduce((sum, count) => sum + count, 0) }
}
