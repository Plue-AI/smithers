/**
 * Executes provider requests with bounded retries, quota classification, and
 * credential-safe diagnostics.
 *
 * One call makes at most three attempts by default (the first plus
 * `MAX_RETRIES`, or the `maxRetries` its executor was built with), with a
 * 500 ms exponential base, a 10 s cap on that computed delay, and a 60 s total
 * retry budget. `Retry-After` replaces the computed delay without jitter and
 * is slept in full, so no retry reaches the provider before it said it would
 * accept one. A provider wait beyond the total budget is surfaced to the
 * caller intact instead of being slept inside the executor.
 *
 * @since 0.1.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import { decodePermissionError } from "@smthrs/capability"
import type * as Permission from "@smthrs/capability/Permission"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Headers from "effect/unstable/http/Headers"
import type * as HttpClientError from "effect/unstable/http/HttpClientError"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as Auth from "./Auth.ts"
import { classifyHttpStatus } from "./HttpStatusClassifier.ts"
import { ModelError } from "./ModelError.ts"

const BODY_LIMIT = 16_384
const RAW_BODY_LIMIT = 65_536
const MAX_BODY_DEPTH = 12
const MAX_RETRIES = 2
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 10_000
const MAX_RETRY_DURATION_MS = 60_000
const REDACTED = "<redacted>"

// One source of truth for sensitive names across headers, URL query keys, and
// fields embedded in request or response bodies.
const SENSITIVE_NAME = Auth.credentialNamePattern
const SHORT_QUERY_NAME = /^(key|sig)$/i
const SENSITIVE_BODY_KEY = /^(?:.*(?:api[-_]?key|secret[-_]?key|private[-_]?key))$|^key$/i
const JSON_STRING_FIELD = /"((?:[^"\\]|\\.)*)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g
const QUERY_FIELD = /(^|[?&\s"])([A-Za-z0-9_.\-%[\]]+)=([^&\s"]+)/g

interface ResetMetadata {
  readonly retryAfterMillis?: number | undefined
  readonly resetAtEpochMillis?: number | undefined
  readonly resetSource?: string | undefined
}

interface ResetCandidate {
  readonly at: number
  readonly source: string
  readonly relevance: "retry" | "exhausted" | "unqualified"
}

const matchesName = (name: string, matcher: string | RegExp): boolean => {
  if (typeof matcher === "string") return name.toLowerCase() === matcher.toLowerCase()
  matcher.lastIndex = 0
  return matcher.test(name)
}

const isSensitiveHeaderName = (
  name: string,
  redactedNames: ReadonlyArray<string | RegExp> = []
): boolean => SENSITIVE_NAME.test(name) || redactedNames.some((matcher) => matchesName(name, matcher))

const isSensitiveQueryName = (name: string): boolean => isSensitiveHeaderName(name) || SHORT_QUERY_NAME.test(name)

const isSensitiveBodyField = (name: string): boolean => SENSITIVE_NAME.test(name) || SENSITIVE_BODY_KEY.test(name)

const redactHeaders = (
  headers: Headers.Headers,
  redactedNames: ReadonlyArray<string | RegExp>
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(Headers.redact(headers, [...redactedNames, SENSITIVE_NAME])).map(([name, value]) => [
      name,
      String(value)
    ])
  )

const redactUrl = (value: string): string => {
  if (!URL.canParse(value)) return REDACTED
  const url = new URL(value)
  // Snapshot before replacing values: URLSearchParams.forEach observes its
  // own mutations, and `set` on a credential key can revisit that key forever.
  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveQueryName(key)) url.searchParams.set(key, REDACTED)
  }
  return url.toString()
}

const redactedRequestUrl = (request: HttpClientRequest.HttpClientRequest): string => {
  const value = redactUrl(request.url)
  if (value === REDACTED) return value
  const url = new URL(value)
  for (const [key, item] of request.urlParams) {
    url.searchParams.append(key, isSensitiveQueryName(key) ? REDACTED : item)
  }
  return url.toString()
}

const normalizedHeaders = (headers: Headers.Headers): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))

const requestId = (headers: Record<string, string>): string | undefined =>
  headers["x-request-id"] ??
    headers["request-id"] ??
    headers["x-amzn-requestid"] ??
    headers["x-amz-request-id"] ??
    headers["x-goog-request-id"] ??
    headers["cf-ray"]

const finiteNonNegative = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined
}

const retryAfter = (headers: Record<string, string>, now: number): ResetMetadata => {
  const millis = finiteNonNegative(headers["retry-after-ms"])
  if (millis !== undefined) {
    return {
      retryAfterMillis: millis,
      resetAtEpochMillis: now + millis,
      resetSource: "retry-after-ms"
    }
  }

  const value = headers["retry-after"]
  if (!value) return {}

  const seconds = finiteNonNegative(value)
  if (seconds !== undefined) {
    const retryAfterMillis = seconds * 1_000
    return {
      retryAfterMillis,
      resetAtEpochMillis: now + retryAfterMillis,
      resetSource: "retry-after"
    }
  }

  const date = Date.parse(value)
  if (Number.isNaN(date)) return {}
  return {
    retryAfterMillis: Math.max(0, date - now),
    resetAtEpochMillis: date,
    resetSource: "retry-after"
  }
}

const durationMillis = (value: string): number | undefined => {
  const input = value.trim().toLowerCase()
  if (input === "") return undefined
  const token = /(?<amount>\d+(?:\.\d+)?)(?<unit>ms|s|m|h|d)/g
  let total = 0
  let consumed = 0
  let match: RegExpExecArray | null
  while ((match = token.exec(input)) !== null) {
    if (match.index !== consumed) return undefined
    // Named captures make the regex-guaranteed token shape explicit without unreachable defensive branches.
    const { amount, unit } = match.groups as { readonly amount: string; readonly unit: "ms" | "s" | "m" | "h" | "d" }
    const factor = unit === "ms"
      ? 1
      : unit === "s"
      ? 1_000
      : unit === "m"
      ? 60_000
      : unit === "h"
      ? 3_600_000
      : 86_400_000
    total += Number(amount) * factor
    consumed = token.lastIndex
  }
  return consumed === input.length && Number.isFinite(total) ? Math.max(0, total) : undefined
}

const timestampOrDuration = (value: unknown, now: number): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 1_000_000_000_000) return value
    if (value >= 1_000_000_000) return value * 1_000
    return now + Math.max(0, value) * 1_000
  }
  if (typeof value !== "string") return undefined

  const duration = durationMillis(value)
  if (duration !== undefined) return now + duration

  const numeric = Number(value)
  if (Number.isFinite(numeric)) return timestampOrDuration(numeric, now)

  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : date
}

const chooseReset = (candidates: ReadonlyArray<ResetCandidate>): ResetCandidate | undefined => {
  const retry = candidates.filter((candidate) => candidate.relevance === "retry")
  const exhausted = candidates.filter((candidate) => candidate.relevance === "exhausted")
  const unqualified = candidates.filter((candidate) => candidate.relevance === "unqualified")
  const eligible = retry.length > 0
    ? retry
    : exhausted.length > 0
    ? exhausted
    : unqualified.length === 1
    ? unqualified
    : []
  let selected: ResetCandidate | undefined
  for (const candidate of eligible) {
    if (!Number.isFinite(candidate.at)) continue
    if (selected === undefined || candidate.at < selected.at) selected = candidate
  }
  return selected
}

const headerResetCandidates = (
  headers: Record<string, string>,
  now: number
): ReadonlyArray<ResetCandidate> => {
  const remaining = new Map<string, number>()
  for (const [name, value] of Object.entries(headers)) {
    const openAi = /^x-ratelimit-remaining-(.+)$/.exec(name)?.[1]
    const anthropic = /^anthropic-ratelimit-(.+)-remaining$/.exec(name)?.[1]
    const resource = openAi ?? anthropic
    const parsed = finiteNonNegative(value)
    if (resource !== undefined && parsed !== undefined) remaining.set(resource, parsed)
  }

  const candidates: Array<ResetCandidate> = []
  for (const [name, value] of Object.entries(headers)) {
    const openAi = /^x-ratelimit-reset-(.+)$/.exec(name)?.[1]
    const anthropic = /^anthropic-ratelimit-(.+)-reset$/.exec(name)?.[1]
    const resource = openAi ?? anthropic
    if (resource === undefined) continue
    const remainingValue = remaining.get(resource)
    if (remainingValue !== undefined && remainingValue > 0) continue
    const at = timestampOrDuration(value, now)
    if (at !== undefined) {
      candidates.push({
        at,
        source: name,
        relevance: remainingValue === undefined ? "unqualified" : "exhausted"
      })
    }
  }
  return candidates
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String))

const parsedBody = (body: string | undefined): unknown =>
  body === undefined || body.trim() === ""
    ? undefined
    : Option.getOrUndefined(decodeJson(body))

const bodyResetCandidates = (
  value: unknown,
  now: number,
  path = "body",
  depth = 0
): ReadonlyArray<ResetCandidate> => {
  if (depth > MAX_BODY_DEPTH) return []
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => bodyResetCandidates(item, now, `${path}[${index}]`, depth + 1))
  }
  if (!isRecord(value)) return []

  const candidates: Array<ResetCandidate> = []
  const remainingFields = Object.entries(value).filter(([key, item]) =>
    /(?:^|[-_])remaining$/i.test(key) && finiteNonNegative(String(item)) !== undefined
  )
  const hasRemaining = remainingFields.length > 0
  const isExhausted = remainingFields.some(([, item]) => finiteNonNegative(String(item)) === 0)
  for (const [key, item] of Object.entries(value)) {
    const nextPath = `${path}.${key}`
    if (
      /^(?:reset|resets?[-_]?at|reset[-_]?time|quota[-_]?reset(?:[-_]?at)?|rate[-_]?limit[-_]?reset(?:[-_]?at)?)$/i
        .test(key)
    ) {
      const at = timestampOrDuration(item, now)
      if (at !== undefined && (!hasRemaining || isExhausted)) {
        candidates.push({
          at,
          source: nextPath,
          relevance: hasRemaining ? "exhausted" : "unqualified"
        })
      }
    } else if (/^(?:reset|retry)[-_]?after(?:[-_]?ms)?$|^resets?[-_]?in[-_]?seconds$/i.test(key)) {
      const millis = typeof item === "number" ? item : Number(item)
      if (Number.isFinite(millis)) {
        const multiplier = /ms$/i.test(key) ? 1 : 1_000
        candidates.push({
          at: now + Math.max(0, millis) * multiplier,
          source: nextPath,
          relevance: "retry"
        })
      }
    }
    candidates.push(...bodyResetCandidates(item, now, nextPath, depth + 1))
  }
  return candidates
}

const stringField = (value: unknown, names: ReadonlyArray<string>): string | undefined => {
  if (!isRecord(value)) return undefined
  for (const name of names) {
    const field = value[name]
    if (typeof field === "string") return field
  }
  return undefined
}

const providerFields = (body: unknown): {
  readonly code?: string | undefined
  readonly message?: string | undefined
} => {
  if (!isRecord(body)) return {}
  const nested = isRecord(body.error) ? body.error : undefined
  return {
    code: stringField(nested, ["code", "type"]) ?? stringField(body, ["code", "type"]),
    message: stringField(nested, ["message", "detail"]) ?? stringField(body, ["message", "detail"])
  }
}

const addSecret = (values: Set<string>, value: string): void => {
  if (value.length === 0) return
  values.add(value)
  values.add(Encoding.encodeBase64(value))
  values.add(Encoding.encodeBase64Url(value))
  values.add(encodeURIComponent(value))
  const json = encodeJsonString(value)
  // Encoding a string always emits its two JSON quotes, including for the
  // empty string (which returned above), so the interior slice is total.
  values.add(json.slice(1, -1))
}

const addStructuredSecrets = (values: Set<string>, value: unknown, depth = 0): void => {
  if (depth > MAX_BODY_DEPTH) return
  if (Array.isArray(value)) {
    for (const item of value) addStructuredSecrets(values, item, depth + 1)
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveBodyField(key) && typeof item === "string" && item.length >= 8) {
      addSecret(values, item)
    }
    addStructuredSecrets(values, item, depth + 1)
  }
}

const addTextBodySecrets = (values: Set<string>, text: string): void => {
  const decoded = decodeJson(text)
  if (Option.isSome(decoded)) addStructuredSecrets(values, decoded.value)
  try {
    const params = new URLSearchParams(text)
    params.forEach((value, key) => {
      if (isSensitiveQueryName(key)) addSecret(values, value)
    })
  } catch {
    // An opaque body has no structured credentials we can safely identify.
  }
}

const secretValues = (
  request: HttpClientRequest.HttpClientRequest,
  redactedNames: ReadonlyArray<string | RegExp>
): Set<string> => {
  const values = new Set<string>()
  const safeHeaders = redactHeaders(request.headers, redactedNames)

  for (const [name, value] of Object.entries(request.headers)) {
    if (!isSensitiveHeaderName(name, redactedNames) && safeHeaders[name] === value) continue
    addSecret(values, value)
    const bearer = /^Bearer\s+(.+)$/i.exec(value)?.[1]
    if (bearer) addSecret(values, bearer)
  }

  if (URL.canParse(request.url)) {
    new URL(request.url).searchParams.forEach((value, key) => {
      if (isSensitiveQueryName(key)) addSecret(values, value)
    })
  }
  for (const [key, value] of request.urlParams) {
    if (isSensitiveQueryName(key)) addSecret(values, value)
  }

  if (request.body._tag === "Uint8Array") {
    addTextBodySecrets(values, new TextDecoder().decode(request.body.body))
  } else if (request.body._tag === "Raw") {
    if (typeof request.body.body === "string") {
      addTextBodySecrets(values, request.body.body)
    } else if (request.body.body instanceof globalThis.Uint8Array) {
      addTextBodySecrets(values, new TextDecoder().decode(request.body.body))
    } else {
      addStructuredSecrets(values, request.body.body)
    }
  } else if (request.body._tag === "FormData") {
    request.body.formData.forEach((value, key) => {
      if (isSensitiveQueryName(key) && typeof value === "string") addSecret(values, value)
    })
  }

  return values
}

// The same `MAX_BODY_DEPTH` horizon the reset and secret walks already stop
// at, for the same reason and one more: a provider body is untrusted input, V8
// parses arbitrarily deep JSON iteratively and then overflows the stack on the
// first recursive walk of it, so an unguarded walk here turns a hostile 5000
// level body into a `RangeError` defect instead of a typed `ModelError`. Past
// the horizon the subtree is replaced wholesale rather than descended, because
// a redaction walk that merely stops looking is a redaction walk that leaks.
const redactStructuredValue = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_BODY_DEPTH) return REDACTED
  if (Array.isArray(value)) return value.map((item) => redactStructuredValue(item, depth + 1))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveBodyField(key) ? REDACTED : redactStructuredValue(item, depth + 1)
    ])
  )
}

const redactTextBody = (body: string): string =>
  body
    .replace(
      JSON_STRING_FIELD,
      (field, key: string, separator: string) => isSensitiveBodyField(key) ? `"${key}"${separator}"${REDACTED}"` : field
    )
    .replace(
      QUERY_FIELD,
      (field, prefix: string, key: string) => isSensitiveQueryName(key) ? `${prefix}${key}=${REDACTED}` : field
    )

const redactFields = (body: string): string => {
  const parsed = parsedBody(body)
  return parsed === undefined ? redactTextBody(body) : JSON.stringify(redactStructuredValue(parsed))
}

// Structural and literal passes run before diagnostic truncation.
const redactSecrets = (body: string, secrets: ReadonlyArray<string>): string =>
  secrets.reduce((text, secret) => text.split(secret).join(REDACTED), redactFields(body))

const redactBody = (
  body: string,
  request: HttpClientRequest.HttpClientRequest,
  redactedNames: ReadonlyArray<string | RegExp>
): string =>
  redactSecrets(
    body,
    Array.from(secretValues(request, redactedNames)).sort((left, right) => right.length - left.length)
  )

const encoder = new TextEncoder()

// The budgets are documented in bytes, and a string's `length` counts UTF-16
// code units: an emoji is one unit of four bytes, so a unit-counted cap keeps
// up to twice what it promises. This is the longest prefix whose UTF-8 encoding
// fits, cut only between code points — `encodeInto` never writes a partial
// character, so the byte it stops at is a boundary.
const utf8Prefix = (value: string, limit: number): string => {
  if (value.length * 3 <= limit) return value
  const { read } = encoder.encodeInto(value, new Uint8Array(limit))
  return read === value.length ? value : value.slice(0, read)
}

const responseBody = (
  body: string | undefined,
  request: HttpClientRequest.HttpClientRequest,
  redactedNames: ReadonlyArray<string | RegExp>
): { readonly body?: string | undefined; readonly bodyTruncated?: boolean | undefined } => {
  if (body === undefined) return {}
  const redacted = redactBody(body, request, redactedNames)
  const kept = utf8Prefix(redacted, BODY_LIMIT)
  if (kept === redacted) return { body: redacted }
  return { body: kept, bodyTruncated: true }
}

// A cap on a string the whole body already materialized is not a cap: by the
// time `response.text` answers, a broken or hostile provider has already made
// this process allocate every byte it chose to send. This bounds the *read* —
// bytes are counted before they are decoded, the chunk that crosses
// `RAW_BODY_LIMIT` is cut at the limit, and the stream is abandoned there, so
// nothing beyond the limit is ever held, parsed, walked or redacted. A cut that
// lands inside a multibyte sequence drops the partial sequence rather than
// flushing it as U+FFFD, so what is kept is a prefix of what was sent. A read
// that fails part way keeps what arrived; a read that fails with nothing has no
// body, which is what the caller's `undefined` means.
const cappedBody = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<string | undefined> =>
  Effect.suspend(() => {
    const decoder = new TextDecoder()
    let text = ""
    let bytes = 0
    return Stream.runForEachWhile(
      response.stream,
      (chunk: Uint8Array) =>
        Effect.sync(() => {
          const room = RAW_BODY_LIMIT - bytes
          const taken = chunk.byteLength > room ? chunk.subarray(0, room) : chunk
          bytes += taken.byteLength
          text += decoder.decode(taken, { stream: true })
          return bytes < RAW_BODY_LIMIT
        })
    ).pipe(
      Effect.as(false),
      Effect.catch(() => Effect.succeed(true)),
      Effect.map((failed) => {
        if (bytes < RAW_BODY_LIMIT) text += decoder.decode()
        return failed && text === "" ? undefined : text
      })
    )
  })

const providerMessage = (
  status: number,
  details: { readonly body?: string | undefined; readonly bodyTruncated?: boolean | undefined }
): string => {
  if (details.body && details.body.length <= 500 && details.bodyTruncated !== true) {
    return `Provider request failed with HTTP ${status}: ${details.body}`
  }
  return `Provider request failed with HTTP ${status}`
}

const reasonForStatus = (status: number, body: string | undefined, parsed: unknown): ModelError["code"] => {
  const fields = providerFields(parsed)
  // Parsed metadata is diagnostic context, not a provider error signal.
  return classifyHttpStatus(status, fields.code, isRecord(parsed) ? fields.message ?? "" : body ?? "")
}

const sanitizedField = (
  value: string | undefined,
  request: HttpClientRequest.HttpClientRequest,
  redactedNames: ReadonlyArray<string | RegExp>
): string | undefined =>
  value === undefined ? undefined : utf8Prefix(redactBody(value, request, redactedNames), BODY_LIMIT)

// HTTP 200 protocol failures need the same redaction and caps as status errors.
const sanitizeModelError = (error: ModelError, redact: (value: string) => string): ModelError => {
  const field = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : utf8Prefix(redact(value), BODY_LIMIT)
  const message = utf8Prefix(redact(error.message), BODY_LIMIT)
  const path = field(error.path)
  const resetSource = field(error.resetSource)
  const providerCode = field(error.providerCode)
  const requestId = field(error.requestId)
  const redactedBody = error.body === undefined ? undefined : redact(error.body)
  const body = redactedBody === undefined ? undefined : utf8Prefix(redactedBody, BODY_LIMIT)
  const bodyTruncated = redactedBody !== undefined && body !== redactedBody ? true : error.bodyTruncated
  if (
    message === error.message && path === error.path && resetSource === error.resetSource &&
    providerCode === error.providerCode && requestId === error.requestId &&
    body === error.body && bodyTruncated === error.bodyTruncated
  ) {
    return error
  }
  const sanitized = new ModelError({
    code: error.code,
    message,
    path,
    retryAfterMillis: error.retryAfterMillis,
    resetAtEpochMillis: error.resetAtEpochMillis,
    resetSource,
    quotaScope: error.quotaScope,
    providerCode,
    requestId,
    httpStatus: error.httpStatus
  })
  Object.defineProperties(sanitized, {
    body: { value: body, enumerable: false },
    bodyTruncated: { value: bodyTruncated, enumerable: false }
  })
  return sanitized
}

/**
 * Captures the signed request and current header policy for response-stream
 * failures, including protocol errors delivered over HTTP 200.
 *
 * @category constructors
 * @since 0.1.0
 */
export const errorSanitizer = (
  request: HttpClientRequest.HttpClientRequest
): Effect.Effect<(error: ModelError) => ModelError> =>
  Effect.gen(function*() {
    const redactedNames = yield* Headers.CurrentRedactedNames
    const secrets = Array.from(secretValues(request, redactedNames)).sort((left, right) => right.length - left.length)
    return (error: ModelError) => sanitizeModelError(error, (value) => redactSecrets(value, secrets))
  })

const statusError = (
  request: HttpClientRequest.HttpClientRequest,
  redactedNames: ReadonlyArray<string | RegExp>,
  classifyError: ErrorClassifier | undefined
) =>
(
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<HttpClientResponse.HttpClientResponse, ModelError> =>
  Effect.gen(function*() {
    if (response.status < 400) return response

    const body = yield* cappedBody(response)
    const headers = normalizedHeaders(response.headers)
    const now = yield* Clock.currentTimeMillis
    const retry = retryAfter(headers, now)
    const parsed = parsedBody(body)

    // A run that parks on this failure needs exactly one durable wake instant.
    // Retry-After is authoritative; otherwise only the exhausted resource's
    // window is eligible, preventing unrelated early wake/spin loops.
    const candidates: Array<ResetCandidate> = [
      ...headerResetCandidates(headers, now),
      ...bodyResetCandidates(parsed, now)
    ]
    const reset = retry.resetAtEpochMillis !== undefined && retry.resetSource !== undefined
      ? {
        at: retry.resetAtEpochMillis,
        source: retry.resetSource,
        relevance: "retry" as const
      }
      : chooseReset(candidates)
    const details = responseBody(body, request, redactedNames)
    const fields = providerFields(parsed)
    const classified = classifyError?.(response.status, body ?? "")
    const classifiedMessage = classified === undefined
      ? undefined
      : responseBody(classified.message, request, redactedNames).body
    const code = classified !== undefined && classified.code !== "unknown"
      ? classified.code
      : reasonForStatus(response.status, body, parsed)

    const error = new ModelError({
      code,
      message: classifiedMessage ?? providerMessage(response.status, details),
      retryAfterMillis: classified?.retryAfterMillis ?? retry.retryAfterMillis ??
        (code === "rate_limited" && reset !== undefined ? Math.max(0, reset.at - now) : undefined),
      resetAtEpochMillis: classified?.resetAtEpochMillis ?? reset?.at,
      resetSource: sanitizedField(classified?.resetSource ?? reset?.source, request, redactedNames),
      quotaScope: classified?.quotaScope,
      providerCode: sanitizedField(classified?.providerCode ?? fields.code, request, redactedNames),
      requestId: sanitizedField(classified?.requestId ?? requestId(headers), request, redactedNames),
      httpStatus: response.status
    })
    Object.defineProperties(error, {
      body: { value: details.body, enumerable: false },
      bodyTruncated: { value: details.bodyTruncated, enumerable: false }
    })
    return yield* Effect.fail(error)
  })

const transportError = (
  error: HttpClientError.HttpClientError,
  redactedNames: ReadonlyArray<string | RegExp>
): ModelError => {
  const safeHeaders = redactHeaders(error.request.headers, redactedNames)
  const hasHeaders = Object.keys(safeHeaders).length > 0
  const reason = error.reason
  const cause = "cause" in reason ? reason.cause : undefined
  const causeName = cause instanceof Error && cause.name !== "Error" ? cause.name : undefined
  const causeMessage = cause instanceof Error
    ? cause.message
    : typeof cause === "string" || typeof cause === "number" || typeof cause === "boolean"
    ? String(cause)
    : undefined
  const causeCode = isRecord(cause) && (typeof cause.code === "string" || typeof cause.code === "number")
    ? String(cause.code)
    : undefined
  const causeDetail = causeMessage === undefined || causeMessage.trim() === ""
    ? undefined
    : `${causeName === undefined ? "" : `${causeName} `}${
      causeCode === undefined ? "" : `[${causeCode}] `
    }${causeMessage}`.trim()
  const description = "description" in reason ? reason.description : undefined
  const details = [...new Set([description, causeDetail].filter((value): value is string => value !== undefined))]
    .map((value) => redactBody(value, error.request, redactedNames))
    .join(": ")
  return new ModelError({
    code: "transport",
    message: `HTTP transport failed: ${error.reason._tag}${
      details === "" ? "" : `: ${details}`
    } (${error.request.method} ${redactedRequestUrl(error.request)}${hasHeaders ? ", headers redacted" : ""})`
  })
}

const mapHttpError = (
  error: HttpClientError.HttpClientError,
  redactedNames: ReadonlyArray<string | RegExp>
): RequestError => {
  // The kernel projects permission failures into the error channel Effect's
  // `HttpClient` tag fixes, keeping the structured failure on the cause; this
  // recovers it so suspension metadata survives the model boundary.
  const permission = Option.flatMap(KernelHttpClient.fromHttpClientError(error), decodePermissionError)
  return Option.isSome(permission) ? permission.value : transportError(error, redactedNames)
}

const retryFailures = <A, R>(
  effect: Effect.Effect<A, RequestError, R>,
  times: number
): Effect.Effect<A, RequestError, R> => {
  const schedule = Schedule.exponential(Duration.millis(BASE_DELAY_MS)).pipe(
    Schedule.jittered,
    // The cap bounds the computed backoff only. A provider's own Retry-After
    // is slept in full: retrying before it spends quota on a certain refusal,
    // and the `while` below already surfaces one beyond the total budget.
    Schedule.modifyDelay(({ duration, input }) =>
      Effect.succeed(
        Duration.millis(
          input instanceof ModelError && input.retryAfterMillis !== undefined
            ? input.retryAfterMillis
            : Math.min(Duration.toMillis(duration), MAX_DELAY_MS)
        )
      )
    ),
    Schedule.upTo({ times, duration: Duration.millis(MAX_RETRY_DURATION_MS) })
  )
  return Effect.retry(effect, {
    schedule,
    while: (error): boolean =>
      error instanceof ModelError && error.retryable &&
      (error.retryAfterMillis === undefined || error.retryAfterMillis <= MAX_RETRY_DURATION_MS)
  })
}

/**
 * Protocol-specific classification for a failed HTTP response.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ErrorClassifier = (status: number, body: string) => ModelError

/**
 * Per-request execution policy supplied by the composed route.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ExecuteOptions {
  readonly modelId: string
  readonly classifyError?: ErrorClassifier | undefined
}

/**
 * Failures from provider execution. Kernel permission failures retain their
 * original classes and suspension metadata across the model boundary.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export type RequestError =
  | ModelError
  | Permission.PermissionRequired
  | Permission.PermissionDenied
  | Permission.GrantStoreError

/**
 * How many consecutive transport failures replace the client.
 *
 * A retry ladder assumes waiting repairs the failure, and for a rate limit or a
 * 5xx it does. For a *transport* failure it sometimes does not: an HTTP/2
 * session the peer has destroyed stays destroyed, and every attempt that reuses
 * the connection pool holding it fails the same way however long the ladder
 * waits between them. r92 of the SWE-bench full benchmark is the measurement —
 * ten `transport` retries across two instances, roughly half a minute of
 * jittered backoff each, and both runs died anyway against a socket that never
 * came back.
 *
 * Three is where waiting has stopped being the explanation. It is exactly what
 * one `execute` spends when every attempt fails on the transport — the first
 * attempt plus `MAX_RETRIES` — so no attempt inside a request ever runs on a
 * client the request itself discarded, and the replacement lands on the first
 * rung of the *outer* ladder, the sealed model step's, which is where a socket
 * that is genuinely dead first shows itself. A single request cannot both
 * throw away a connection pool and go on using the replacement, and a request
 * that fails on anything other than the transport leaves the pool alone.
 *
 * The counter is about the transport, which every request in the process
 * shares, so it is shared too. Any success resets it: a client that answers is
 * a client that works.
 *
 * @category constants
 * @since 0.1.0
 */
export const rebuildAfter = 3

/**
 * The client an executor runs on, and the host's way of replacing it.
 *
 * Two fields rather than a factory called twice, because the first client is
 * usually a resource somebody else already built — the layer's own — and only
 * the replacement has to be made on demand. A host with nothing to rebuild says
 * so with {@link fixed}, and its executor behaves exactly as it did before this
 * existed.
 *
 * What a rebuild *means* is the host's business and deliberately not this
 * module's: on Node it is a fresh Undici `Agent`, which is a fresh connection
 * pool; in a browser there is no pool to replace and `fixed` is the honest
 * answer.
 *
 * @category models
 * @since 0.1.0
 */
export interface Transport {
  /** The client every request goes through until a rebuild replaces it. */
  readonly client: KernelHttpClient.HttpClient
  /**
   * Builds a replacement, called after {@link rebuildAfter} consecutive
   * transport failures and before the attempt that follows them.
   */
  readonly rebuild: Effect.Effect<KernelHttpClient.HttpClient>
}

/**
 * A transport with nothing behind it to replace: every rebuild answers the same
 * client.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fixed = (client: KernelHttpClient.HttpClient): Transport => ({
  client,
  rebuild: Effect.succeed(client)
})

/**
 * What an executor is built with, fixed for every request it makes.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  /**
   * Retries after the first attempt. Defaults to 2; 0 makes `execute` a single
   * attempt, which is what a probe of a route wants. Negative counts are 0 and
   * a count that is not a finite number is the default.
   */
  readonly maxRetries?: number | undefined
  /**
   * Milliseconds an attempt may wait for its response to start: the status
   * line and headers, not the body. Defaults to {@link defaultResponseStartMs};
   * 0 disarms it.
   */
  readonly responseStartMs?: number | undefined
}

/**
 * How long an attempt may wait for the provider to start answering.
 *
 * A reasoning model streams nothing while it thinks, so no bound on the gap
 * between body chunks is safe: a direct probe of the ChatGPT backend on
 * 2026-09-22 went 5.3 s between chunks on one short proof, and a longer one
 * goes minutes. The response itself starts at once: the same probes had
 * headers at 0.9 s and 3.3 s, followed by `response.created` within 30 ms.
 * A request the backend accepted and never answered held a TUI turn silent
 * for the whole 300 s model-call budget (`CellTurn.defaultModelCallMs`)
 * before the retry that then answered immediately. Sixty seconds is about
 * eighteen times the slowest start measured, and a stall fails as `transport`,
 * so it is retried and counts toward replacing the connection pool.
 *
 * Undici bounds the same wait itself (`headersTimeout`, 300 s by default);
 * Bun's fetch, which a Bun host uses because Undici's pool does not run
 * there, bounds nothing.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultResponseStartMs = 60_000

/**
 * Scoped provider request executor.
 *
 * The caller's scope owns the successful response body and aborts its transport
 * when that scope closes.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface RequestExecutor {
  readonly execute: (
    request: HttpClientRequest.HttpClientRequest,
    options: ExecuteOptions
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, RequestError, Scope.Scope>
}

/**
 * Service tag for the provider request executor.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const RequestExecutor: Context.Service<RequestExecutor, RequestExecutor> = Context.Service<
  RequestExecutor,
  RequestExecutor
>("/model/RequestExecutor")

/**
 * Builds a request executor over a transport it may replace.
 *
 * The replacement is the rung the retry ladder did not have. Everything above
 * it — this module's own bounded retry, and the sealed model step's jittered
 * ladder in `@smthrs/agent` — repairs a failure by waiting, and a destroyed
 * session is the failure waiting does not repair. After
 * {@link rebuildAfter} consecutive transport failures the next attempt is made
 * on a client the host built fresh, and the counter starts again.
 *
 * The counter lives in this closure rather than in a request, because what it
 * counts is a property of the client and not of any one call: the run that
 * motivated it made ten attempts across two ladders and one dead socket.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeWith = (transport: Transport, options: MakeOptions = {}): Effect.Effect<RequestExecutor> =>
  Effect.gen(function*() {
    const maxRetries = options.maxRetries !== undefined && Number.isFinite(options.maxRetries)
      ? Math.max(0, Math.floor(options.maxRetries))
      : MAX_RETRIES
    const responseStartMs = options.responseStartMs !== undefined && Number.isFinite(options.responseStartMs)
      ? Math.max(0, Math.floor(options.responseStartMs))
      : defaultResponseStartMs
    let http = transport.client
    /**
     * Which client `http` is: bumped by every replacement, and stamped on each
     * attempt so an attempt that was in flight on a client the executor has
     * since discarded cannot count against the one that replaced it.
     */
    let generation = 0
    /** Transport failures on the current client since its last response of any kind. */
    let failures = 0
    /**
     * One replacement at a time. Every request shares the counter, so once it
     * reaches the bound every request in flight sees it at once; without this
     * each would build its own replacement and the last one written would win,
     * with the others' requests running on pools the host had already closed.
     * The holder rebuilds, and a waiter finding the count already cleared
     * takes the holder's client instead of building another.
     */
    const gate = yield* Semaphore.make(1)
    const replace = gate.withPermit(
      Effect.suspend(() =>
        failures < rebuildAfter
          ? Effect.void
          : transport.rebuild.pipe(
            Effect.map((client) => {
              http = client
              generation += 1
              failures = 0
            })
          )
      )
    )

    const executeOnce = (
      request: HttpClientRequest.HttpClientRequest,
      options: ExecuteOptions
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, RequestError, Scope.Scope> =>
      Effect.gen(function*() {
        if (failures >= rebuildAfter) yield* replace
        const client = http
        const on = generation
        const redactedNames = [...yield* Headers.CurrentRedactedNames, SENSITIVE_NAME]
        const started = client.execute(request).pipe(
          // `model:call` on this model, not a plain `net:*` effect: the same host
          // answers many models and a grant for one is not a grant for the rest.
          KernelHttpClient.withModelCall(options.modelId),
          Effect.provideService(Headers.CurrentRedactedNames, redactedNames),
          Effect.mapError((error) => mapHttpError(error, redactedNames))
        )
        const response = yield* (responseStartMs === 0 ? started : started.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(responseStartMs),
            orElse: () =>
              Effect.fail(
                new ModelError({
                  code: "transport",
                  message: `The provider did not start a response within ${responseStartMs / 1000} s`
                })
              )
          })
        )).pipe(
          // A response of any kind clears the count. Only the transport failing
          // says the client itself may be the problem; a 429 or a 500 arrived
          // over a connection that worked. A verdict on a client that has
          // already been replaced says nothing about its replacement.
          Effect.tap(() =>
            Effect.sync(() => {
              if (on === generation) failures = 0
            })
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (on !== generation) return
              failures = error instanceof ModelError && error.code === "transport" ? failures + 1 : 0
            })
          )
        )
        return yield* statusError(request, redactedNames, options.classifyError)(response)
      })

    return RequestExecutor.of({
      execute: Effect.fn("RequestExecutor.execute")((request, options) =>
        retryFailures(executeOnce(request, options), maxRetries)
      )
    })
  })

/**
 * Builds a request executor around the permission-aware kernel HTTP client.
 *
 * The client in context is the only one there is, so a rebuild answers with it
 * unchanged. A host that can build a second one — a Node process, whose
 * connection pool is a value it owns — passes {@link makeWith} a transport that
 * says so.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make: Effect.Effect<RequestExecutor, never, KernelHttpClient.HttpClient> = Effect.gen(function*() {
  const http = yield* KernelHttpClient.HttpClient
  return yield* makeWith(fixed(http))
})

/**
 * Provides the request executor, requiring the kernel HTTP client.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<RequestExecutor, never, KernelHttpClient.HttpClient> = Layer.effect(
  RequestExecutor,
  make
)
