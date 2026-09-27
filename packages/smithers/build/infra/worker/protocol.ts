/**
 * The hosted result-only HTTP cache protocol.
 *
 * Routes and JSON shapes overlap the self-hosted tier, but journal identity
 * publication and lookup are unsupported and explicitly refused.
 *
 * @since 0.1.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import { CacheFailure } from "./cache-failure.ts"
import { constantTimeEquals } from "./constantTimeEquals.ts"
import { digestBytes } from "./digestBytes.ts"
import { discardBody } from "./discardBody.ts"
import { jsonTextFault } from "./jsonTextFault.ts"

const hexDigest = /^[0-9a-f]{64}$/
const jsonContentType = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/
const decimalDigits = /^[0-9]+$/
const controlCharacters = /[\u0000-\u001f\u007f]/

/** The buffer an undeclared-length body starts at before it grows. */
const initialBodyBufferBytes = 64 * 1024

const isWellFormedText = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/**
 * The largest action-cache document the service accepts.
 *
 * Migration 0002 also bounds `entry_json`. Changing this bound requires a new
 * migration and an updated migration contract test; never edit an applied migration.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxActionCacheBodyBytes = 1024 * 1024

/**
 * The largest row D1 stores: its documented 2,000,000-byte row and string
 * limit.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxD1RowBytes = 2_000_000

/**
 * The most bytes one action-cache row's key, body, and discriminator may hold.
 *
 * D1 stores the body and its canonical result discriminator in one row, so a
 * body inside {@link maxActionCacheBodyBytes} can still make a row D1 refuses
 * at insert time, which would surface as a `503` the client cannot fix. The
 * protocol refuses that publication first with a `413`. The reserve below
 * {@link maxD1RowBytes} covers the fixed-width columns and the record header.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxActionCacheRowBytes = maxD1RowBytes - 1024

/**
 * The largest `findMissing` request the service accepts.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxFindMissingBodyBytes = 256 * 1024

/**
 * The most digests one `findMissing` request may probe.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxFindMissingDigests = 1000

/**
 * The longest action-cache key the service stores.
 *
 * `worker/migrations/0002_bound_cache_rows.sql` hardcodes the same 512 bytes
 * for `key_digest`; the migration contract test pins this relationship.
 * Changing a persisted bound requires a new migration and an updated contract
 * test. Never edit an applied migration.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxKeyDigestLength = 512

/**
 * The most artifact references one publication records.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxReferencedDigests = 1000

/**
 * The longest journal run identifier the service stores.
 *
 * Separate from {@link maxKeyDigestLength} because a cache key and a run
 * identifier are unrelated protocol limits that happen to share a value.
 * `worker/migrations/0002_bound_cache_rows.sql` hardcodes the same 512 bytes
 * for `recorded_run_id`. Changing this bound requires a new migration and
 * an updated migration contract test; never edit an applied migration.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxRecordedRunIdLength = 512

/**
 * The absolute per-artifact ceiling supported by both cache deployments.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxArtifactBodyBytes = 16 * 1024 * 1024

/**
 * The deepest and widest JSON document accepted by the action cache.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxJsonDepth = 64

/**
 * The total number of object members and array elements accepted per document.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxJsonMembers = 100_000

/**
 * The largest canonical conflict discriminator retained in memory.
 *
 * Migration 0002 also bounds `result_json`. Changing this bound requires a new
 * migration and an updated migration contract test; never edit an applied migration.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxCanonicalJsonBytes = 2 * 1024 * 1024

/**
 * The maximum number of chunks accepted for one bounded body.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxBodyChunks = 16_384

/**
 * The maximum number of requests admitted by one Worker isolate.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxConcurrentCacheRequests = 64

/**
 * The maximum number of action-cache publications admitted by one isolate.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxConcurrentActionCachePublications = 4

/**
 * The maximum number of `findMissing` bodies admitted by one isolate.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxConcurrentFindMissingRequests = 8

/**
 * The maximum number of large CAS transfers admitted by one Worker isolate.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxConcurrentArtifactTransfers = 2

/**
 * Successful readiness checks are coalesced for this monotonic interval.
 *
 * @category constants
 * @since 0.1.0
 */
export const healthCacheMilliseconds = 1000

// Body progress and total duration are bounded independently. Dependencies
// get their own deadline because the platform stores may ignore cancellation.
const bodyIdleMilliseconds = 10_000
const bodyTotalMilliseconds = 60_000
const dependencyMilliseconds = 30_000

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })

type Publication = "inserted" | "identical" | "conflict"

/**
 * Optional journal provenance used to fence action-cache deletion.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeleteFence {
  readonly runId: string
  readonly eventSeq: number
}

/**
 * One validated action-cache publication.
 *
 * `body` is the exact JSON text supplied by the client. `resultJson` is a
 * canonical conflict discriminator: `result` only when the document has both
 * own `keyDigest` and `result` properties; otherwise the entire JSON document.
 *
 * The service stores the publication verbatim and does not index the
 * artifacts it declares. Nothing consumed the reference list this type once
 * carried, so entries are not reference counted and eviction is time based.
 *
 * @category models
 * @since 0.1.0
 */
export interface ActionCachePublication {
  readonly body: string
  readonly resultJson: string
  readonly createdAtMs: number | null
  readonly recordedRunId: string | null
  readonly recordedEventSeq: number | null
}

/**
 * Storage operations required by the `/ac` protocol.
 *
 * @category services
 * @since 0.1.0
 */
export interface ActionCache {
  readonly get: (keyDigest: string, signal?: AbortSignal) => Promise<string | null>
  readonly put: (
    keyDigest: string,
    publication: ActionCachePublication,
    signal?: AbortSignal
  ) => Promise<Publication>
  readonly delete: (keyDigest: string, fence: DeleteFence | null, signal?: AbortSignal) => Promise<boolean>
}

/**
 * One content-addressed object returned by the backing store.
 *
 * @category models
 * @since 0.1.0
 */
export interface ContentObject {
  readonly body: BodyInit
}

/**
 * Storage operations required by the `/cas` protocol.
 *
 * @category services
 * @since 0.1.0
 */
export interface ContentStore {
  readonly get: (digest: string, signal?: AbortSignal) => Promise<ContentObject | null>
  readonly has: (digest: string, signal?: AbortSignal) => Promise<boolean>
  readonly put: (
    digest: string,
    bytes: Uint8Array<ArrayBuffer>,
    signal?: AbortSignal
  ) => Promise<"inserted" | "present">
  readonly presentDigests: (digests: ReadonlyArray<string>, signal?: AbortSignal) => Promise<ReadonlySet<string>>
}

/**
 * Which of a credential's budgets one admitted request draws on.
 *
 * @category models
 * @since 0.1.0
 */
export type CredentialBudgetRoute = "request" | "findMissing"

/**
 * Charges admitted requests to the credential that presented them.
 *
 * The per-isolate concurrency ceilings bound what one isolate holds in memory,
 * not what a credential may cost over time: Cloudflare scales isolates per
 * location, and every pull-request job holds the read credential. A budget is
 * charged once the credential is classified and the method authorized, so an
 * unauthenticated caller has no key to spend, and before any store is touched,
 * so a refused request costs nothing metered. `findMissing` draws on the
 * `request` budget and then on its own, because one probe fans out to up to
 * {@link maxFindMissingDigests} metered existence checks.
 *
 * @category models
 * @since 0.1.0
 */
export interface CredentialBudget {
  /**
   * Draws one unit from `route`'s budget for the credential whose SHA-256 is
   * `credentialDigest`. Resolves `false` once that budget is spent.
   */
  readonly charge: (
    credentialDigest: string,
    route: CredentialBudgetRoute,
    signal?: AbortSignal
  ) => Promise<boolean>
}

/**
 * Dependencies for the remote-cache protocol handler.
 *
 * Supply an inspectable plain record of enumerable data properties. Store
 * methods are captured at construction. Credential hashes must be distinct
 * lowercase SHA-256 digests. Invalid configuration throws `TypeError` from
 * {@link createHandler}; dependency failures during requests produce `503`.
 *
 * @category models
 * @since 0.1.0
 */
export interface ProtocolDependencies {
  readonly actionCache: ActionCache
  readonly contentStore: ContentStore
  /**
   * SHA-256 of the credential that may read the cache. A reader is an
   * untrusted context: every job that pulls, including one building an
   * unreviewed branch, holds this one.
   */
  readonly readTokenHash: string
  /** When set, the read credential may GET only action keys in this namespace. */
  readonly readNamespacePrefix?: string
  /**
   * SHA-256 of the credential that may publish to it. Only a context whose
   * inputs were reviewed holds this one. This digest must differ from the read
   * credential digest.
   */
  readonly writeTokenHash: string
  /**
   * The budget every admitted request is charged to. Absent, a credential may
   * make any number of requests and only the per-isolate concurrency ceilings
   * apply; the deployed Worker always configures one.
   */
  readonly credentialBudget?: CredentialBudget
  /** Readiness probe; defaults to an async no-op. Rejection makes `/healthz` return `503`. */
  readonly health?: (signal?: AbortSignal) => Promise<void>
  /** Integer from 1 through 16 MiB; defaults to {@link maxArtifactBodyBytes}. */
  readonly maxArtifactBytes?: number
}

type BodyRead =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly ok: false; readonly response: Response }

type JsonRead =
  | { readonly ok: true; readonly text: string; readonly value: unknown }
  | { readonly ok: false; readonly response: Response }

type PublicationRead =
  | { readonly ok: true; readonly publication: ActionCachePublication }
  | { readonly ok: false; readonly response: Response }

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

const empty = (status: number): Response => new Response(null, { status })

const unauthorized = (): Response =>
  new Response(null, {
    status: 401,
    headers: { "www-authenticate": "Bearer realm=\"smithers-build-cache\"" }
  })

const forbidden = (): Response =>
  new Response(JSON.stringify({ error: "this credential may read the cache but not publish to it" }), {
    status: 403,
    headers: { "content-type": "application/json" }
  })

const busy = (message: string): Response =>
  new Response(JSON.stringify({ error: message }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "1" }
  })

/**
 * Refuses a request whose credential has spent its budget.
 *
 * A budget window is tens of seconds, not the instant a concurrency slot
 * frees, so the retry hint is longer than {@link busy}'s.
 */
const throttled = (message: string): Response =>
  new Response(JSON.stringify({ error: message }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "10" }
  })

const methodNotAllowed = (allowed: string): Response => new Response(null, { status: 405, headers: { allow: allowed } })

const mediaType = (request: Request): string => {
  const header = request.headers.get("content-type")
  if (header === null) return ""
  const parameters = header.indexOf(";")
  return (parameters === -1 ? header : header.slice(0, parameters)).trim().toLowerCase()
}

const utf8Bytes = (value: string): number => textEncoder.encode(value).byteLength

/** Stop waiting promptly, and pass cancellation to dependencies that support it. */
const boundedWait = <A>(
  start: (signal: AbortSignal) => Promise<A>,
  signal: AbortSignal | undefined,
  milliseconds: number
): Promise<A> =>
  new Promise((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
    const stop = (): void => {
      settled = true
      cleanup()
      reject(new CacheFailure("OPERATION_STOPPED", "wait", "cache operation cancelled or timed out"))
      controller.abort()
    }
    const abort = (): void => stop()
    const timer = setTimeout(stop, milliseconds)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted === true) {
      stop()
      return
    }
    let pending: Promise<A>
    try {
      pending = start(controller.signal)
    } catch (cause) {
      cleanup()
      reject(cause)
      return
    }
    pending.then((value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }, (cause: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(cause)
    })
  })

/**
 * A timeout returns the request permit, but an uncancellable store operation
 * retains this separate permit until it actually settles. Retries therefore
 * cannot accumulate unlimited abandoned work or publication buffers.
 */
const boundedOperation = <Args extends Array<unknown>, A>(
  name: CacheFailure["operation"],
  operation: (...args: [...Args, AbortSignal?]) => Promise<A>,
  maximum: number,
  admission: Map<string, number>,
  discard?: (value: A) => void
): (signal: AbortSignal | undefined, ...args: Args) => Promise<A> => {
  return (signal, ...args) =>
    boundedWait(
      async (cancellation) => {
        if ((admission.get(name) ?? 0) >= maximum) {
          throw new CacheFailure("DEPENDENCY_OCCUPIED", "wait", "cache dependency is still occupied")
        }
        admission.set(name, (admission.get(name) ?? 0) + 1)
        try {
          const value = await operation(...args, cancellation)
          if (cancellation.aborted) discard?.(value)
          return value
        } finally {
          admission.set(name, admission.get(name)! - 1)
        }
      },
      signal,
      dependencyMilliseconds
    ).catch((cause: unknown) => {
      throw new CacheFailure("DEPENDENCY_FAILED", name, "cache dependency failed", { cause })
    })
}

const readBody = async (request: Request, limit: number): Promise<BodyRead> => {
  const contentLength = request.headers.get("content-length")
  let declaredLength: number | null = null
  if (contentLength !== null) {
    if (!decimalDigits.test(contentLength)) {
      await discardBody(request.body)
      return { ok: false, response: json(400, { error: "invalid content-length" }) }
    }
    declaredLength = Number(contentLength)
    if (!Number.isSafeInteger(declaredLength) || declaredLength > limit) {
      await discardBody(request.body)
      return { ok: false, response: json(413, { error: "request body exceeds the configured bound" }) }
    }
  }

  if (request.body === null) {
    return declaredLength === null || declaredLength === 0
      ? { ok: true, bytes: new Uint8Array() }
      : { ok: false, response: json(400, { error: "content-length does not match the request body" }) }
  }

  const reader = request.body.getReader()
  const release = (): void => {
    try {
      reader.releaseLock()
    } catch {
      // A reader that cannot be released is already unusable; the answer stands.
    }
  }
  const abandon = (): Promise<void> => {
    try {
      void reader.cancel().catch(() => undefined)
    } catch {
      // Cancellation is best effort and must not replace the client-facing error.
    }
    release()
    return Promise.resolve()
  }

  // A declared length is reserved exactly. An undeclared one grows from a
  // small buffer instead of reserving the whole ceiling, so a one-byte chunked
  // upload costs one small buffer rather than the route's maximum.
  const exact = declaredLength !== null
  let bytes = new Uint8Array(declaredLength ?? Math.min(initialBodyBufferBytes, limit))
  let length = 0
  let chunks = 0
  const deadline = performance.now() + bodyTotalMilliseconds
  try {
    while (true) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new Error("request body deadline exceeded")
      const chunk = await boundedWait(() => reader.read(), request.signal, Math.min(bodyIdleMilliseconds, remaining))
      if (chunk.done) break
      chunks += 1
      if (chunks > maxBodyChunks) {
        await abandon()
        return { ok: false, response: json(413, { error: "request body has too many chunks" }) }
      }
      if (!(chunk.value instanceof Uint8Array)) {
        await abandon()
        return { ok: false, response: json(400, { error: "request body must be a byte stream" }) }
      }
      if (chunk.value.byteLength === 0) continue
      if (length + chunk.value.byteLength > limit) {
        await abandon()
        return { ok: false, response: json(413, { error: "request body exceeds the configured bound" }) }
      }
      if (length + chunk.value.byteLength > bytes.byteLength) {
        if (exact) {
          await abandon()
          return { ok: false, response: json(400, { error: "content-length does not match the request body" }) }
        }
        // The bound above already refused anything past `limit`, so doubling
        // to at least what this chunk needs and no further than the ceiling
        // always fits and never iterates.
        const capacity = Math.min(Math.max(bytes.byteLength * 2, length + chunk.value.byteLength), limit)
        const grown = new Uint8Array(capacity)
        grown.set(bytes.subarray(0, length))
        bytes = grown
      }
      bytes.set(chunk.value, length)
      length += chunk.value.byteLength
    }
  } catch (cause) {
    await abandon()
    throw cause
  }
  release()

  if (declaredLength !== null && length !== declaredLength) {
    return { ok: false, response: json(400, { error: "content-length does not match the request body" }) }
  }
  return { ok: true, bytes: bytes.subarray(0, length) }
}

/**
 * Refuses JSON text whose parse is not reversible.
 *
 * `JSON.parse` collapses information the raw text carried: a duplicate member
 * name keeps only the last value, and a number literal beyond IEEE-754 double
 * precision becomes the nearest double. Conflict classification compares the
 * parsed value, so two mathematically different published results would
 * compare identical and answer `200` where the protocol promises `409`.
 *
 * The scan runs over text `JSON.parse` already accepted, so it may assume
 * well-formed JSON, and it is linear in the body length, which the caller has
 * already bounded.
 */
const irreversibleJson = (text: string): string | null => {
  const fault = jsonTextFault(text, { numbers: true })
  if (fault === "duplicate-member") return "body contains a duplicate object member name"
  if (fault === "lossy-number") return "body contains a JSON number that does not round-trip through a double"
  return null
}

const readJson = async (request: Request, limit: number): Promise<JsonRead> => {
  if (!jsonContentType.test(mediaType(request))) {
    await discardBody(request.body)
    return { ok: false, response: json(415, { error: "content-type must be application/json" }) }
  }
  const body = await readBody(request, limit)
  if (!body.ok) return body
  let text: string
  try {
    text = textDecoder.decode(body.bytes)
  } catch {
    return { ok: false, response: json(400, { error: "body must be UTF-8 JSON" }) }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, response: json(400, { error: "body must be valid JSON" }) }
  }
  const irreversible = irreversibleJson(text)
  if (irreversible !== null) return { ok: false, response: json(400, { error: irreversible }) }
  return { ok: true, text, value }
}

/**
 * Renders an inert JSON value with deterministic member order and hard bounds.
 *
 * The argument must be a value a JSON parser owns. Rendering reads own keys
 * and member values, both of which a `Proxy` can trap, so a caller-supplied
 * object could run code during canonicalization. Every caller in this service
 * passes `JSON.parse` output, which is inert.
 *
 * The bounds enforced here are the rules parsed JSON can still break: nesting
 * depth, aggregate member count, encoded output bytes, and the numbers
 * `JSON.parse` accepts but a conflict discriminator cannot round-trip. Shapes
 * a parser cannot produce, such as cycles, sparse arrays, accessors, foreign
 * prototypes and symbol keys, are the precondition's business and are not
 * inspected.
 *
 * `BoundedJson.admit` from `@smthrs/canonical` carries the same traversal and
 * a stricter admission, but not the same policy: it accepts `-0`, which this
 * discriminator must refuse because rendering erases the sign and two
 * different published results would then compare equal, and it refuses
 * unpaired surrogates, which this service accepts because `JSON.stringify`
 * re-encodes them faithfully. Reconciling those two rules is what a shared
 * renderer would need before this one could be retired.
 *
 * @category utilities
 * @since 0.1.0
 */
export const canonicalJson = (value: unknown): string => {
  const chunks: Array<string> = []
  let bytes = 0
  let members = 0
  const append = (fragment: string): void => {
    bytes += utf8Bytes(fragment)
    if (bytes > maxCanonicalJsonBytes) throw new Error("canonical JSON exceeds its byte bound")
    chunks.push(fragment)
  }
  const appendString = (text: string): void => {
    if (text.length > maxCanonicalJsonBytes) throw new Error("canonical JSON exceeds its byte bound")
    append(JSON.stringify(text))
  }
  const spend = (count: number): void => {
    if (count > maxJsonMembers - members) throw new Error("JSON has too many members")
    members += count
  }
  const render = (current: unknown, depth: number): void => {
    if (depth > maxJsonDepth) throw new Error("JSON is nested too deeply")
    if (current === null) {
      append("null")
      return
    }
    if (typeof current === "string") {
      appendString(current)
      return
    }
    if (typeof current === "boolean") {
      append(current ? "true" : "false")
      return
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        throw new Error("JSON number is outside the supported range")
      }
      append(JSON.stringify(current))
      return
    }
    if (Array.isArray(current)) {
      spend(current.length)
      append("[")
      for (let index = 0; index < current.length; index += 1) {
        if (index > 0) append(",")
        render(current[index], depth + 1)
      }
      append("]")
      return
    }
    if (!isRecord(current)) throw new Error("unsupported JSON value")
    // RFC 8785 orders members by their UTF-16 code units, which is what the
    // default comparator does. The depth bound above is also what stops a
    // cyclic value: it recurses until the bound refuses it rather than
    // forever.
    const keys = Object.keys(current).sort()
    spend(keys.length)
    append("{")
    for (const [index, key] of keys.entries()) {
      if (index > 0) append(",")
      appendString(key)
      append(":")
      render(current[key], depth + 1)
    }
    append("}")
  }

  render(value, 0)
  return chunks.join("")
}

/**
 * Names the single rule an action-cache key breaks, or `null` when it holds.
 *
 * Exported because one clause is unreachable through the HTTP surface and can
 * only be pinned directly: URL parsing substitutes `U+FFFD` for a lone
 * surrogate before the handler ever sees the path, and a percent-escape that
 * would decode to one (`%ED%A0%80`) makes `decodeURIComponent` throw first. The
 * well-formedness clause therefore guards a non-HTTP caller, and a test that
 * only drove requests would report it as dead code.
 *
 * @category utilities
 * @since 0.1.0
 */
export const invalidKeyDigest = (keyDigest: string): string | null => {
  if (keyDigest.length === 0) return "empty keyDigest"
  if (!isWellFormedText(keyDigest)) return "keyDigest must be well-formed Unicode text"
  if (utf8Bytes(keyDigest) > maxKeyDigestLength) {
    return `keyDigest must be at most ${maxKeyDigestLength} UTF-8 bytes`
  }
  if (controlCharacters.test(keyDigest)) return "keyDigest must not contain control characters"
  return null
}

const validateStoredActionBody = (keyDigest: string, body: unknown): string => {
  if (typeof body !== "string" || utf8Bytes(body) > maxActionCacheBodyBytes) {
    throw new CacheFailure("AC_BODY_INVALID", "actionCache.get", "action cache returned an invalid stored body")
  }
  let value: unknown
  try {
    value = JSON.parse(body) as unknown
    canonicalJson(value)
  } catch {
    throw new CacheFailure("AC_JSON_INVALID", "actionCache.get", "action cache returned invalid stored JSON")
  }
  if (isRecord(value) && Object.hasOwn(value, "keyDigest") && value["keyDigest"] !== keyDigest) {
    throw new CacheFailure("AC_KEY_MISMATCH", "actionCache.get", "action cache returned a row for a different key")
  }
  return body
}

const validatedContentBody = (object: unknown): BodyInit => {
  if (!isRecord(object)) {
    throw new CacheFailure("CAS_OBJECT_INVALID", "contentStore.get", "content store returned an invalid object")
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, "body")
  if (
    descriptor === undefined || !("value" in descriptor) || descriptor.value === null || descriptor.value === undefined
  ) {
    throw new CacheFailure("CAS_BODY_INVALID", "contentStore.get", "content store returned an invalid object body")
  }
  return descriptor.value as BodyInit
}

/** Validates declared outputs and bounds their unique artifact digests. */
const assertDeclaredOutputsValid = (record: Record<string, unknown>): void => {
  const outputs = (
    record["meta"] as
      | {
        readonly boundary?: { readonly declaredOutputs?: { readonly outputs?: unknown } }
      }
      | null
      | undefined
  )?.boundary?.declaredOutputs?.outputs
  if (outputs === undefined) return
  if (!Array.isArray(outputs)) throw new Error("declared outputs must be an array")
  const references = new Set<string>()
  for (const output of outputs) {
    if (!isRecord(output)) throw new Error("declared output must be an object")
    if (!Object.hasOwn(output, "digest") || output["digest"] === null || Object.hasOwn(output, "content")) continue
    if (typeof output["digest"] !== "string" || !hexDigest.test(output["digest"])) {
      throw new Error("declared output digest is invalid")
    }
    references.add(output["digest"])
    if (references.size > maxReferencedDigests) throw new Error("publication references too many artifacts")
  }
}

const readPublication = async (request: Request, keyDigest: string): Promise<PublicationRead> => {
  const parsed = await readJson(request, maxActionCacheBodyBytes)
  if (!parsed.ok) return parsed
  const record = isRecord(parsed.value) ? parsed.value : null
  if (record !== null && Object.hasOwn(record, "keyDigest") && record["keyDigest"] !== keyDigest) {
    return {
      ok: false,
      response: json(400, { error: "keyDigest must match the request path when supplied" })
    }
  }

  const enveloped = record !== null && Object.hasOwn(record, "keyDigest") && Object.hasOwn(record, "result")
  let resultJson: string
  try {
    const documentJson = canonicalJson(parsed.value)
    resultJson = enveloped ? canonicalJson(record["result"]) : documentJson
    // Both deployments validate references, even though the self-hosted tier
    // refcounts them and the hosted tier only stores them.
    if (enveloped) assertDeclaredOutputsValid(record)
  } catch {
    return {
      ok: false,
      response: json(400, { error: "body contains invalid or unsupported cache metadata" })
    }
  }

  if (utf8Bytes(keyDigest) + utf8Bytes(parsed.text) + utf8Bytes(resultJson) > maxActionCacheRowBytes) {
    return {
      ok: false,
      response: json(413, { error: "publication and its result exceed the stored row bound" })
    }
  }

  const metadata = enveloped ? record : null
  const hasCreatedAtMs = metadata !== null && Object.hasOwn(metadata, "createdAtMs")
  const createdAtMs = hasCreatedAtMs ? metadata["createdAtMs"] : null
  if (hasCreatedAtMs && (!Number.isSafeInteger(createdAtMs) || (createdAtMs as number) < 0)) {
    return {
      ok: false,
      response: json(400, { error: "createdAtMs must be a non-negative safe integer" })
    }
  }

  const hasRecordedRunId = metadata !== null && Object.hasOwn(metadata, "recordedRunId")
  const hasRecordedEventSeq = metadata !== null && Object.hasOwn(metadata, "recordedEventSeq")
  if (hasRecordedRunId !== hasRecordedEventSeq) {
    return {
      ok: false,
      response: json(400, { error: "recordedRunId and recordedEventSeq must be supplied together" })
    }
  }
  const recordedRunId = hasRecordedRunId ? metadata["recordedRunId"] : null
  const recordedEventSeq = hasRecordedEventSeq ? metadata["recordedEventSeq"] : null
  if (
    hasRecordedRunId &&
    (typeof recordedRunId !== "string" ||
      recordedRunId.length === 0 ||
      !isWellFormedText(recordedRunId) ||
      utf8Bytes(recordedRunId) > maxRecordedRunIdLength ||
      controlCharacters.test(recordedRunId) ||
      !Number.isSafeInteger(recordedEventSeq) ||
      (recordedEventSeq as number) < 0)
  ) {
    return { ok: false, response: json(400, { error: "publication provenance is invalid" }) }
  }

  // A journal identity promises immutable result, meta and createdAtMs.
  // This tier stores only a result-arbitrated head, so accepting the identity
  // would let a changed retry masquerade as an identical publication.
  if (hasRecordedRunId) return { ok: false, response: unsupportedProvenance() }

  return {
    ok: true,
    publication: {
      body: parsed.text,
      resultJson,
      createdAtMs: hasCreatedAtMs ? (createdAtMs as number) : null,
      recordedRunId: null,
      recordedEventSeq: null
    }
  }
}

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))

const bearerScheme = /^Bearer +/i

/** What the credential a request presented is allowed to do. */
type Presented = "write" | "read" | "none"

/** The classified credential and the digest its budget is keyed by. */
interface Credential {
  readonly kind: Presented
  /** SHA-256 of the presented token, so the budget never sees the bearer value. */
  readonly digest: string
}

/**
 * Classifies the presented bearer token against both credential digests.
 *
 * Both comparisons always run and neither short circuits, so the answer costs
 * the same work whichever credential was presented and whichever byte first
 * differs. The two digests are refused at construction when they are equal, so
 * a token can classify as `write` or as `read` but never as both by
 * configuration.
 */
const presentedCredential = async (
  request: Request,
  expectedWrite: Uint8Array<ArrayBuffer>,
  expectedRead: Uint8Array<ArrayBuffer>
): Promise<Credential> => {
  const authorization = request.headers.get("authorization") ?? ""
  const scheme = bearerScheme.exec(authorization)
  const bearer = scheme !== null
  const suppliedToken = bearer ? authorization.slice(scheme[0].length) : ""
  const suppliedDigest = await crypto.subtle.digest("SHA-256", textEncoder.encode(suppliedToken))
  const supplied = new Uint8Array(suppliedDigest)
  const isWrite = constantTimeEquals(supplied, expectedWrite)
  const isRead = constantTimeEquals(supplied, expectedRead)
  const digest = hexOf(supplied)
  if (!bearer) return { kind: "none", digest }
  if (isWrite) return { kind: "write", digest }
  return { kind: isRead ? "read" : "none", digest }
}

const unsupportedProvenance = (): Response =>
  json(422, {
    code: "UNSUPPORTED_PROVENANCE",
    error: "the hosted cache supports result-only arbitration, not journal provenance"
  })

const handleActionCache = async (
  request: Request,
  keyDigest: string,
  url: URL,
  actionCache: ActionCache
): Promise<Response> => {
  const problem = invalidKeyDigest(keyDigest)
  if (problem !== null) {
    await discardBody(request.body)
    return json(400, { error: problem })
  }
  if (request.method === "GET") {
    await discardBody(request.body)
    if (url.searchParams.has("recordedRunId") || url.searchParams.has("recordedEventSeq")) {
      return unsupportedProvenance()
    }
    const body = await actionCache.get(keyDigest, request.signal)
    return body === null
      ? empty(404)
      : new Response(validateStoredActionBody(keyDigest, body), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  }
  if (request.method === "PUT") {
    const publication = await readPublication(request, keyDigest)
    if (!publication.ok) return publication.response
    const result = await actionCache.put(keyDigest, publication.publication, request.signal)
    if (result === "inserted") return json(201, { keyDigest })
    if (result === "identical") return empty(200)
    if (result === "conflict") return empty(409)
    throw new CacheFailure(
      "AC_PUBLICATION_INVALID",
      "actionCache.put",
      "action cache returned an invalid publication outcome"
    )
  }
  if (request.method === "DELETE") {
    await discardBody(request.body)
    const runIds = url.searchParams.getAll("recordedRunId")
    const eventSeqs = url.searchParams.getAll("recordedEventSeq")
    if (runIds.length > 1 || eventSeqs.length > 1) {
      return json(400, { error: "deletion fence parameters must not be repeated" })
    }
    const runId = runIds[0] ?? null
    const eventSeq = eventSeqs[0] ?? null
    if ((runId === null) !== (eventSeq === null)) {
      return json(400, {
        error: "recordedRunId and recordedEventSeq must be supplied together"
      })
    }
    let fence: DeleteFence | null = null
    if (runId !== null && eventSeq !== null) {
      if (
        runId.length === 0 ||
        !isWellFormedText(runId) ||
        utf8Bytes(runId) > maxRecordedRunIdLength ||
        controlCharacters.test(runId)
      ) {
        return json(400, { error: "recordedRunId must be a non-empty bounded string" })
      }
      const parsedEventSeq = Number(eventSeq)
      if (!decimalDigits.test(eventSeq) || !Number.isSafeInteger(parsedEventSeq)) {
        return json(400, {
          error: "recordedEventSeq must be a non-negative safe integer"
        })
      }
      fence = { runId, eventSeq: parsedEventSeq }
    }
    const deleted = await actionCache.delete(keyDigest, fence, request.signal)
    if (typeof deleted !== "boolean") {
      throw new CacheFailure(
        "AC_DELETION_INVALID",
        "actionCache.delete",
        "action cache returned an invalid deletion outcome"
      )
    }
    return empty(deleted ? 200 : 404)
  }
  await discardBody(request.body)
  return methodNotAllowed("GET, PUT, DELETE")
}

const handleArtifact = async (
  request: Request,
  digest: string,
  contentStore: ContentStore,
  maxArtifactBytes: number
): Promise<Response> => {
  if (!hexDigest.test(digest)) {
    await discardBody(request.body)
    return json(400, { error: "digest must be 64 lowercase hex characters" })
  }
  if (request.method === "HEAD") {
    await discardBody(request.body)
    const present = await contentStore.has(digest, request.signal)
    if (typeof present !== "boolean") {
      throw new CacheFailure(
        "CAS_PRESENCE_INVALID",
        "contentStore.has",
        "content store returned an invalid presence outcome"
      )
    }
    return empty(present ? 200 : 404)
  }
  if (request.method === "GET") {
    await discardBody(request.body)
    const object = await contentStore.get(digest, request.signal)
    return object === null
      ? empty(404)
      : new Response(validatedContentBody(object), {
        status: 200,
        headers: { "content-type": "application/octet-stream" }
      })
  }
  if (request.method === "PUT") {
    // This service does not implement the resumable Content-Range/308
    // sequence `RemoteArtifacts.Options.chunkBytes` speaks. RFC 9110 section
    // 14.5 names the answer of a resource that does not support partial PUT:
    // 400, which that client reads as its cue to send the blob whole.
    // Refusing before the body is read makes the refusal deliberate; before,
    // the empty probe fell through to the digest check below and got the same
    // status with a misleading answer.
    if (request.headers.get("content-range") !== null) {
      await discardBody(request.body)
      return json(400, { error: "content-range is not supported; send the whole blob in one request" })
    }
    if (mediaType(request) !== "application/octet-stream") {
      await discardBody(request.body)
      return json(415, { error: "content-type must be application/octet-stream" })
    }
    const body = await readBody(request, maxArtifactBytes)
    if (!body.ok) return body.response
    const measured = await sha256Hex(body.bytes)
    if (measured !== digest) return json(400, { error: `bytes digest to ${measured}` })
    const result = await contentStore.put(digest, body.bytes, request.signal)
    if (result === "inserted") return empty(201)
    if (result === "present") return empty(200)
    throw new CacheFailure(
      "CAS_PUBLICATION_INVALID",
      "contentStore.put",
      "content store returned an invalid publication outcome"
    )
  }
  await discardBody(request.body)
  return methodNotAllowed("GET, HEAD, PUT")
}

/**
 * Returns the same response with its body holding an admission slot.
 *
 * The runtime streams a `GET` body after the handler has returned, so a
 * counter decremented on return bounds the store lookup rather than the
 * transfer. Wrapping the body moves the release to the point the client
 * actually stops consuming it: end of stream, error, or cancellation.
 */
const heldWhileStreaming = (
  response: Response,
  body: NonNullable<Response["body"]>,
  release: () => void,
  operation: CacheFailure["operation"],
  onEnd?: (outcome: "complete" | "failed" | "cancelled") => void
): Response => {
  let ended = false
  const finish = (outcome: "complete" | "failed" | "cancelled", cause?: unknown): void => {
    if (ended) return
    ended = true
    release()
    if (outcome === "failed") {
      console.error(
        describeFailure(new CacheFailure("STREAM_READ_FAILED", operation, "cache stream failed", { cause }))
      )
    }
    onEnd?.(outcome)
  }
  const reader = body.getReader()
  const held = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          controller.close()
          finish("complete")
          return
        }
        controller.enqueue(chunk.value)
      } catch (cause) {
        finish("failed", cause)
        controller.error(cause)
      }
    },
    cancel(reason) {
      finish("cancelled")
      return reader.cancel(reason)
    }
  }, { highWaterMark: 0 })
  return new Response(held, { status: response.status, headers: response.headers })
}

const handleFindMissing = async (
  request: Request,
  contentStore: ContentStore
): Promise<Response> => {
  if (request.method !== "POST") {
    await discardBody(request.body)
    return methodNotAllowed("POST")
  }
  const parsed = await readJson(request, maxFindMissingBodyBytes)
  if (!parsed.ok) return parsed.response
  if (
    !isRecord(parsed.value) ||
    Reflect.ownKeys(parsed.value).length !== 1 ||
    !Object.hasOwn(parsed.value, "digests")
  ) return json(400, { error: "body must be exactly {\"digests\":[...]}" })
  const digests = parsed.value["digests"]
  if (!Array.isArray(digests)) return json(400, { error: "body must be {\"digests\":[...]}" })
  if (digests.length > maxFindMissingDigests) {
    return json(413, { error: `at most ${maxFindMissingDigests} digests may be probed at once` })
  }
  const unique = [...new Set(digests)]
  if (!unique.every((digest) => typeof digest === "string" && hexDigest.test(digest))) {
    return json(400, { error: "every digest must be 64 lowercase hex characters" })
  }
  const requested: ReadonlyArray<string> = Object.freeze([...unique] as Array<string>)
  if (requested.length === 0) return json(200, { missing: [] })
  // The store gets its own frozen copy and the answer is built from the
  // snapshot above: a store that assigned into the array it was handed while
  // its promise was pending could otherwise put a digest the client never
  // asked for into `missing`.
  const present = await contentStore.presentDigests(Object.freeze([...requested]), request.signal)
  if (!(present instanceof Set)) {
    throw new CacheFailure(
      "CAS_DIGEST_SET_INVALID",
      "contentStore.presentDigests",
      "content store returned an invalid digest set"
    )
  }
  const requestedSet = new Set(requested)
  for (const digest of present) {
    if (typeof digest !== "string" || !requestedSet.has(digest)) {
      throw new CacheFailure(
        "CAS_DIGEST_UNREQUESTED",
        "contentStore.presentDigests",
        "content store returned a digest outside the request"
      )
    }
  }
  return json(200, {
    missing: requested.filter((digest) => !present.has(digest))
  })
}

const diagnosticName = /^[A-Za-z][A-Za-z0-9_$]{0,39}$/
const diagnosticCode = /^[A-Za-z0-9_.-]{1,32}$/
const diagnosticOperation =
  /^(?:actionCache\.(?:get|put|delete)|contentStore\.(?:get|has|put|presentDigests)|credentialBudget\.charge|health|wait|r2\.validate|retention)$/

const diagnosticValue = (cause: object, field: string): unknown => {
  let current: object | null = cause
  let value: unknown
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, field)
      if (descriptor !== undefined) {
        if (!("value" in descriptor)) return null
        value = descriptor.value
        break
      }
      current = Object.getPrototypeOf(current) as object | null
    } catch {
      return null
    }
  }
  return value
}

const diagnosticTag = (cause: object, field: string, shape: RegExp): string | null => {
  const value = diagnosticValue(cause, field)
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null
  return typeof value === "string" && shape.test(value) ? value : null
}

/**
 * Renders bounded diagnostic fields without provider messages or request data.
 *
 * Operations are restricted to fixed internal names. At most four nested
 * causes contribute format-allowlisted codes; accessors are never invoked.
 *
 * @category utilities
 * @since 0.1.0
 */
export const describeFailure = (cause: unknown): string => {
  const kind = typeof cause
  if (typeof cause !== "object" || cause === null) {
    return `smithers build cache: request failed (kind=${cause === null ? "null" : kind})`
  }
  const operation = diagnosticValue(cause, "operation")
  const tags = [
    ["name", diagnosticTag(cause, "name", diagnosticName)],
    ["code", diagnosticTag(cause, "code", diagnosticCode)],
    ["operation", typeof operation === "string" && diagnosticOperation.test(operation) ? operation : null],
    ["errno", diagnosticTag(cause, "errno", diagnosticCode)],
    ["syscall", diagnosticTag(cause, "syscall", diagnosticCode)]
  ].filter((tag): tag is [string, string] => tag[1] !== null)
  let nested = diagnosticValue(cause, "cause")
  for (let depth = 1; depth <= 4 && typeof nested === "object" && nested !== null; depth += 1) {
    const code = diagnosticTag(nested, "code", diagnosticCode)
    if (code !== null) tags.push([`cause${depth}.code`, code])
    nested = diagnosticValue(nested, "cause")
  }
  const attribution = tags.length === 0
    ? "unattributed"
    : tags.map((tag) => `${tag[0]}=${tag[1]}`).join(" ")
  return `smithers build cache: request failed (${attribution})`
}

interface NormalizedProtocolDependencies {
  readonly actionCache: ActionCache
  readonly contentStore: ContentStore
  readonly credentialBudget: CredentialBudget
  readonly health: (signal?: AbortSignal) => Promise<void>
  readonly maxArtifactBytes: number
  readonly readTokenHash: string
  readonly readNamespacePrefix: string
  readonly writeTokenHash: string
}

const serviceMethod = <Args extends ReadonlyArray<unknown>, Result>(
  service: unknown,
  name: string,
  what: string
): (...args: Args) => Result => {
  if ((typeof service !== "object" || service === null) && typeof service !== "function") {
    throw new TypeError(`${what} must be an object`)
  }
  let current: object | null = service
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, name)
    } catch {
      throw new TypeError(`${what}.${name} could not be inspected safely`)
    }
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`${what}.${name} must be a data method`)
      }
      const implementation: (...args: Args) => Result = descriptor.value
      return (...args: Args): Result => Reflect.apply(implementation, service, args)
    }
    try {
      current = Object.getPrototypeOf(current)
    } catch {
      throw new TypeError(`${what}.${name} could not be inspected safely`)
    }
  }
  throw new TypeError(`${what}.${name} must be a method`)
}

const normalizeDependencies = (value: ProtocolDependencies): NormalizedProtocolDependencies => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("protocol dependencies must be a plain object")
  }
  let prototype: object | null
  let keys: Array<string | symbol>
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    keys = Reflect.ownKeys(value)
  } catch {
    throw new TypeError("protocol dependencies could not be inspected safely")
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("protocol dependencies must be a plain object")
  }
  const allowed = new Set([
    "actionCache",
    "contentStore",
    "credentialBudget",
    "health",
    "maxArtifactBytes",
    "readTokenHash",
    "readNamespacePrefix",
    "writeTokenHash"
  ])
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`protocol dependencies contain an unknown property: ${String(key)}`)
    }
  }
  const read = (name: string): unknown => {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, name)
    } catch {
      throw new TypeError(`protocol dependency ${name} could not be inspected safely`)
    }
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`protocol dependency ${name} must be an enumerable data property`)
    }
    return descriptor.value
  }
  const action = read("actionCache")
  const content = read("contentStore")
  const configuredHealth = read("health")
  const health = configuredHealth ?? (async (): Promise<void> => undefined)
  if (typeof health !== "function") throw new TypeError("health must be a function")
  const configuredBudget = read("credentialBudget")
  const charge = configuredBudget === undefined
    ? async (): Promise<boolean> => true
    : serviceMethod<[credentialDigest: string, route: CredentialBudgetRoute, signal?: AbortSignal], Promise<boolean>>(
      configuredBudget,
      "charge",
      "credentialBudget"
    )
  const readTokenHash = read("readTokenHash")
  const readNamespacePrefix = read("readNamespacePrefix") ?? ""
  if (
    typeof readNamespacePrefix !== "string" ||
    (readNamespacePrefix !== "" && !/^[A-Za-z0-9_-]+\/$/.test(readNamespacePrefix))
  ) {
    throw new TypeError("readNamespacePrefix must be one namespace ending in /")
  }
  if (typeof readTokenHash !== "string" || !hexDigest.test(readTokenHash)) {
    throw new TypeError("readTokenHash must be a lowercase SHA-256 digest")
  }
  const writeTokenHash = read("writeTokenHash")
  if (typeof writeTokenHash !== "string" || !hexDigest.test(writeTokenHash)) {
    throw new TypeError("writeTokenHash must be a lowercase SHA-256 digest")
  }
  if (readTokenHash === writeTokenHash) {
    throw new TypeError("readTokenHash and writeTokenHash must differ, or the read credential can publish")
  }
  const configuredMaximum = read("maxArtifactBytes")
  const maxArtifactBytes = configuredMaximum ?? maxArtifactBodyBytes
  if (
    !Number.isSafeInteger(maxArtifactBytes) ||
    (maxArtifactBytes as number) < 1 ||
    (maxArtifactBytes as number) > maxArtifactBodyBytes
  ) throw new TypeError(`maxArtifactBytes must be an integer from 1 through ${maxArtifactBodyBytes}`)

  return Object.freeze({
    actionCache: Object.freeze({
      get: serviceMethod<[keyDigest: string, signal?: AbortSignal], Promise<string | null>>(
        action,
        "get",
        "actionCache"
      ),
      put: serviceMethod<
        [keyDigest: string, publication: ActionCachePublication, signal?: AbortSignal],
        Promise<Publication>
      >(action, "put", "actionCache"),
      delete: serviceMethod<
        [keyDigest: string, fence: DeleteFence | null, signal?: AbortSignal],
        Promise<boolean>
      >(action, "delete", "actionCache")
    }),
    contentStore: Object.freeze({
      get: serviceMethod<[digest: string, signal?: AbortSignal], Promise<ContentObject | null>>(
        content,
        "get",
        "contentStore"
      ),
      has: serviceMethod<[digest: string, signal?: AbortSignal], Promise<boolean>>(content, "has", "contentStore"),
      put: serviceMethod<
        [digest: string, bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal],
        Promise<"inserted" | "present">
      >(content, "put", "contentStore"),
      presentDigests: serviceMethod<
        [digests: ReadonlyArray<string>, signal?: AbortSignal],
        Promise<ReadonlySet<string>>
      >(content, "presentDigests", "contentStore")
    }),
    credentialBudget: Object.freeze({ charge }),
    health: health as (signal?: AbortSignal) => Promise<void>,
    maxArtifactBytes: maxArtifactBytes as number,
    readTokenHash,
    readNamespacePrefix,
    writeTokenHash
  })
}

/**
 * Creates admission accounting shared by all binding generations in an isolate.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeAdmissionState = () => ({
  activeCacheRequests: 0,
  activeActionCachePublications: 0,
  activeArtifactTransfers: 0,
  activeFindMissingRequests: 0,
  dependencies: new Map<string, number>()
})

/**
 * Creates the authenticated HTTP handler for the remote-cache protocol.
 *
 * Retain the handler while bindings are unchanged. Pass the same admission
 * state when rebuilding it so in-flight work remains counted across rotations.
 * `maxArtifactBytes` defaults to 16 MiB, `health` to an async no-op, and an
 * omitted credential budget admits every request within the isolate limits.
 *
 * @returns An async `(request: Request) => Promise<Response>` handler. Storage
 * failures are logged with safe diagnostics and answered with a generic `503`.
 * @throws {TypeError} Synchronously for invalid dependency records or methods,
 * invalid or identical credential hashes, or an artifact limit outside 1..16777216.
 * @example
 * ```ts
 * const handle = createHandler({ actionCache, contentStore, readTokenHash, writeTokenHash })
 * const response = await handle(new Request("https://cache.example/healthz"))
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const createHandler = (dependencies: ProtocolDependencies, admission = makeAdmissionState()) => {
  const normalized = normalizeDependencies(dependencies)
  const { maxArtifactBytes, readTokenHash, readNamespacePrefix, writeTokenHash } = normalized
  const actionGet = boundedOperation<[string], string | null>(
    "actionCache.get",
    normalized.actionCache.get,
    maxConcurrentCacheRequests,
    admission.dependencies
  )
  const actionPut = boundedOperation<[string, ActionCachePublication], Publication>(
    "actionCache.put",
    normalized.actionCache.put,
    maxConcurrentActionCachePublications,
    admission.dependencies
  )
  const actionDelete = boundedOperation<[string, DeleteFence | null], boolean>(
    "actionCache.delete",
    normalized.actionCache.delete,
    maxConcurrentCacheRequests,
    admission.dependencies
  )
  const contentGet = boundedOperation<[string], ContentObject | null>(
    "contentStore.get",
    normalized.contentStore.get,
    maxConcurrentArtifactTransfers,
    admission.dependencies,
    (object) => {
      if (object?.body instanceof ReadableStream) void discardBody(object.body)
    }
  )
  const contentHas = boundedOperation<[string], boolean>(
    "contentStore.has",
    normalized.contentStore.has,
    maxConcurrentCacheRequests,
    admission.dependencies
  )
  const contentPut = boundedOperation<[string, Uint8Array<ArrayBuffer>], "inserted" | "present">(
    "contentStore.put",
    normalized.contentStore.put,
    maxConcurrentArtifactTransfers,
    admission.dependencies
  )
  const contentPresent = boundedOperation<[ReadonlyArray<string>], ReadonlySet<string>>(
    "contentStore.presentDigests",
    normalized.contentStore.presentDigests,
    maxConcurrentFindMissingRequests,
    admission.dependencies
  )
  const budgetCharge = boundedOperation<[string, CredentialBudgetRoute], boolean>(
    "credentialBudget.charge",
    normalized.credentialBudget.charge,
    maxConcurrentCacheRequests,
    admission.dependencies
  )
  // A budget that cannot answer, or a request already cancelled when it is
  // asked, still owes the body a cancellation: the failure path below answers
  // 503 without touching it.
  const charge = async (request: Request, credentialDigest: string, route: CredentialBudgetRoute): Promise<boolean> => {
    try {
      return await budgetCharge(request.signal, credentialDigest, route)
    } catch (cause) {
      await discardBody(request.body)
      throw cause
    }
  }
  const health = boundedOperation<[], void>("health", normalized.health, 1, admission.dependencies)
  const actionCache: ActionCache = {
    get: (key, signal) => actionGet(signal, key),
    put: (key, publication, signal) => actionPut(signal, key, publication),
    delete: (key, fence, signal) => actionDelete(signal, key, fence)
  }
  const contentStore: ContentStore = {
    get: (digest, signal) => contentGet(signal, digest),
    has: (digest, signal) => contentHas(signal, digest),
    put: (digest, bytes, signal) => contentPut(signal, digest, bytes),
    presentDigests: (digests, signal) => contentPresent(signal, digests)
  }
  const expectedReadTokenHash = digestBytes(readTokenHash)
  const expectedWriteTokenHash = digestBytes(writeTokenHash)

  let healthInFlight: {
    readonly promise: Promise<void>
    readonly controller: AbortController
    waiters: number
  } | null = null
  let lastHealthyAt = Number.NEGATIVE_INFINITY
  const ready = async (signal: AbortSignal): Promise<void> => {
    if (signal?.aborted === true) throw new CacheFailure("READINESS_CANCELLED", "health", "readiness request cancelled")
    const now = performance.now()
    if (now >= lastHealthyAt && now - lastHealthyAt < healthCacheMilliseconds) return
    if (healthInFlight === null) {
      const controller = new AbortController()
      const promise = health(controller.signal).then(() => {
        lastHealthyAt = performance.now()
      }).finally(() => {
        healthInFlight = null
      })
      healthInFlight = { promise, controller, waiters: 0 }
    }
    const current = healthInFlight
    current.waiters += 1
    try {
      await boundedWait(() => current.promise, signal, dependencyMilliseconds)
    } finally {
      current.waiters -= 1
      if (current.waiters === 0) current.controller.abort()
    }
  }

  const handle = async (
    request: Request,
    onStreamEnd?: (outcome: "complete" | "failed" | "cancelled") => void
  ): Promise<Response> => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      // A URL the runtime cannot parse is a client error. Reporting it as a
      // storage refusal would tell the client to retry an unfixable request.
      await discardBody(request.body)
      return json(400, { error: "request URL is malformed" })
    }
    // Set when a streamed response body took ownership of the admission slots
    // it holds; the request's own `finally` must then leave them alone.
    let streaming = false
    try {
      if (url.pathname === "/healthz") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          await discardBody(request.body)
          return methodNotAllowed("GET, HEAD")
        }
        await discardBody(request.body)
        await ready(request.signal)
        return request.method === "HEAD" ? empty(200) : json(200, { ok: true })
      }
      if (admission.activeCacheRequests >= maxConcurrentCacheRequests) {
        await discardBody(request.body)
        return busy("too many simultaneous cache requests")
      }
      admission.activeCacheRequests += 1
      try {
        const credential = await presentedCredential(request, expectedWriteTokenHash, expectedReadTokenHash)
        if (credential.kind === "none") {
          await discardBody(request.body)
          return unauthorized()
        }
        // Authorization is decided by method before the route is even parsed,
        // so a publication presented on the read credential is refused without
        // reading its body. Every route below this line either reads state or
        // probes it; `findMissing` is a POST that mutates nothing, so it is not
        // in the mutating set.
        if ((request.method === "PUT" || request.method === "DELETE") && credential.kind !== "write") {
          await discardBody(request.body)
          return forbidden()
        }
        // The budget is charged once the credential is known and the method
        // authorized, and before any route touches a store: a refused request
        // costs nothing metered, and a caller without a credential has no key
        // to spend.
        if (!(await charge(request, credential.digest, "request"))) {
          await discardBody(request.body)
          return throttled("this credential's request budget is spent")
        }
        const [root, route, encoded, ...rest] = url.pathname.split("/")
        // Every cache route is `/<route>/<one segment>`: nothing before the
        // first slash and exactly one segment after the route.
        const routed = root === "" && encoded !== undefined && rest.length === 0
        if (credential.kind === "read" && readNamespacePrefix !== "" && routed && route === "cas") {
          await discardBody(request.body)
          return forbidden()
        }
        if (routed && route === "cas" && encoded === "findMissing") {
          if (admission.activeFindMissingRequests >= maxConcurrentFindMissingRequests) {
            await discardBody(request.body)
            return busy("too many simultaneous findMissing requests")
          }
          if (!(await charge(request, credential.digest, "findMissing"))) {
            await discardBody(request.body)
            return throttled("this credential's findMissing budget is spent")
          }
          admission.activeFindMissingRequests += 1
          try {
            return await handleFindMissing(request, contentStore)
          } finally {
            admission.activeFindMissingRequests -= 1
          }
        }
        if (routed && route === "ac") {
          let keyDigest: string
          try {
            keyDigest = decodeURIComponent(encoded)
          } catch {
            await discardBody(request.body)
            return json(400, { error: "keyDigest must be valid URL encoding" })
          }
          if (credential.kind === "read" && readNamespacePrefix !== "" && !keyDigest.startsWith(readNamespacePrefix)) {
            await discardBody(request.body)
            return forbidden()
          }
          if (request.method === "PUT") {
            if (admission.activeActionCachePublications >= maxConcurrentActionCachePublications) {
              await discardBody(request.body)
              return busy("too many simultaneous action-cache publications")
            }
            admission.activeActionCachePublications += 1
            try {
              return await handleActionCache(request, keyDigest, url, actionCache)
            } finally {
              admission.activeActionCachePublications -= 1
            }
          }
          const response = await handleActionCache(request, keyDigest, url, actionCache)
          const body = response.body
          // A hit streams its stored body after the handler returns, so the
          // request slot has to outlive the return and end with the stream.
          if (request.method !== "GET" || response.status !== 200 || body === null) {
            return response
          }
          // The flag is set only once the wrapper exists. Setting it first
          // would leak the counter for the isolate's lifetime if wrapping
          // threw: the wrapper that owes the decrement would never have been
          // built, and this request's `finally` would already be disarmed.
          // This body is built here from validated stored text, so no store
          // can hand the wrapper something that refuses a reader; the order
          // matches the artifact path, where a store can.
          const held = heldWhileStreaming(
            response,
            body,
            () => {
              admission.activeCacheRequests -= 1
            },
            "actionCache.get",
            onStreamEnd
          )
          streaming = true
          return held
        }
        if (routed && route === "cas") {
          let digest: string
          try {
            digest = decodeURIComponent(encoded)
          } catch {
            await discardBody(request.body)
            return json(400, { error: "digest must be valid URL encoding" })
          }
          if (request.method === "GET" || request.method === "PUT") {
            if (admission.activeArtifactTransfers >= maxConcurrentArtifactTransfers) {
              await discardBody(request.body)
              return busy("too many simultaneous artifact transfers")
            }
            admission.activeArtifactTransfers += 1
            let transferred = false
            try {
              const response = await handleArtifact(
                request,
                digest,
                contentStore,
                maxArtifactBytes
              )
              const body = response.body
              // A `PUT` body is buffered inside the slot, so the transfer is
              // over when the handler returns. A `GET` body streams after it,
              // so the slot the README promises bounds artifact transfers has
              // to outlive the return and end with the stream.
              if (request.method !== "GET" || response.status !== 200 || body === null) {
                return response
              }
              // Both flags are set only once the wrapper exists, so a throw
              // inside the wrapping leaves this request's own `finally` and
              // the outer one still responsible for the two counters. Setting
              // them first would strand both for the isolate's lifetime.
              const held = heldWhileStreaming(
                response,
                body,
                () => {
                  admission.activeArtifactTransfers -= 1
                  admission.activeCacheRequests -= 1
                },
                "contentStore.get",
                onStreamEnd
              )
              transferred = true
              streaming = true
              return held
            } finally {
              if (!transferred) admission.activeArtifactTransfers -= 1
            }
          }
          return await handleArtifact(request, digest, contentStore, maxArtifactBytes)
        }
        await discardBody(request.body)
        return empty(404)
      } finally {
        if (!streaming) admission.activeCacheRequests -= 1
      }
    } catch (cause) {
      console.error(describeFailure(cause))
      return json(503, { error: "the cache tier failed to answer" })
    }
  }

  return async (
    request: Request,
    onStreamEnd?: (outcome: "complete" | "failed" | "cancelled") => void
  ): Promise<Response> => {
    const response = await handle(request, onStreamEnd)
    response.headers.set("Smithers-Cache-Contract", "result-only-v1")
    return response
  }
}
