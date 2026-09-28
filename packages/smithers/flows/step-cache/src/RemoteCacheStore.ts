/**
 * The shared step-result tier: a {@link CacheStore.Service} spoken over HTTP.
 *
 * This is Bazel's *action cache* half of the dumb-HTTP remote cache protocol,
 * from `src/main/java/com/google/devtools/build/lib/remote/http/HttpCacheClient.java`
 * in {@link https://github.com/bazelbuild/bazel | bazelbuild/bazel}: "Action
 * cache blobs are stored under the path `/ac/base16-key`", written with `PUT`
 * and read with `GET`. The blob we carry is the JSON encoding of a
 * {@link CacheStore.CacheEntry} rather than a REAPI `ActionResult` proto,
 * because our recorded result and its journal provenance are the thing being
 * shared.
 *
 * The load-bearing protocol constraint lives with the *caller*, not here:
 * every artifact an entry references must be durable in the shared artifact
 * tier before the entry is `put`. Bazel states it in
 * `src/main/java/com/google/devtools/build/lib/remote/UploadManifest.java`:
 * "action results may fail to validate server-side if they are accessed before
 * all blobs they refer to are present". See the
 * {@link https://smithers.sh/docs/reference/api/step-cache | step-cache reference}.
 *
 * The endpoint and its credentials arrive as layer construction options. They
 * are a capability, never an input: they are not hashed into a step key and
 * never journaled; see the
 * {@link https://smithers.sh/docs/concepts/content-addressing | step-key contract}.
 *
 * ## Server contract
 *
 * A conforming tier owes three answers under `/ac/{keyDigest}`, and this
 * client speaks two extensions plain Bazel HTTP does not define:
 *
 * - `GET` answers `200` with the {@link CacheStore.CacheEntry} JSON or `404`
 *   for a miss. When the request carries `recordedRunId` and
 *   `recordedEventSeq`, the tier answers the entry that provenance recorded if
 *   it still holds it, and its head otherwise, which is exactly the SQL tier's
 *   ledger-then-head rule.
 * - `PUT` answers `201` for a first write, any other 2xx when what it already
 *   holds does not disagree, and `409` when it does. Decide that in the two
 *   stages the SQL tier decides it in. A publication reusing a
 *   `(keyDigest, recordedRunId, recordedEventSeq)` the tier already recorded is
 *   `409` unless its `result`, `meta`, and `createdAtMs` all match, because
 *   that provenance record is immutable. Every other publication is arbitrated
 *   on the canonical `result` alone, as the head is: a second run recording the
 *   same result under its own provenance carries a different `meta`,
 *   `createdAtMs`, and run identity without being a conflict, and answering
 *   `409` there would report cross-host divergence that has not happened. That
 *   is what makes first-writer-wins decidable over dumb HTTP.
 * - `DELETE` answers 2xx when it removed the entry and `404` when it did not.
 *   With `recordedRunId` and `recordedEventSeq` the delete is a
 *   compare-and-swap: remove the entry only while it still carries that
 *   provenance, and answer `404` on a mismatch.
 *
 * **Against a tier that ignores query parameters both extensions degrade
 * silently.** A fenced eviction becomes an unconditional `DELETE`, which is
 * the poison-drop the fence exists to prevent (issue #119), and a fenced
 * lookup becomes a head read. The client cannot tell the two apart, because a
 * conforming tier answers a fenced lookup with its head whenever it holds no
 * row for that provenance: a returned entry recorded under different
 * provenance is therefore accepted as that documented fallback, the same value
 * the SQL tier serves. Provenance-fenced reads and evictions need a conforming
 * server; against any other tier, compose this store for its head semantics
 * alone.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as CacheStore from "./CacheStore.ts"
import * as CacheAdmission from "./internal/CacheAdmission.ts"

/**
 * How to reach the shared step-result tier.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The cache root, e.g. `https://cache.example.com`. `/ac/{keyDigest}` is
   * resolved beneath it. A trailing slash is ignored.
   */
  readonly endpoint: string
  /**
   * Headers sent with every request. This is the credential seam, and it is
   * deliberately construction-time — see the module doc.
   * All configured names are redacted case-insensitively in Effect HTTP
   * tracing spans, preserving the caller's existing header redaction policy.
   * Redirects are never followed, so these headers reach only the endpoint.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined
  /**
   * Deadline for one whole cache operation: its request, its response body,
   * and the decoding between them, measured from the call. Defaults to 60
   * seconds. It is one budget rather than one per phase, so a tier that
   * answers headers promptly and then stalls the body cannot spend it twice.
   */
  readonly requestTimeout?: Duration.Input | undefined
  /** Largest cache-entry response accepted. Defaults to four MiB. */
  readonly maxResponseBytes?: number | undefined
}

/**
 * Default deadline for one whole remote cache operation, its request and its
 * response body together.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultRequestTimeout = Duration.seconds(60)

/**
 * Default and absolute maximum encoded cache entry size.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumEntryBytes = CacheAdmission.maximumJsonBytes

const decoder = new TextDecoder("utf-8", { fatal: true })

const isWellFormedText = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

const hasControlText = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x1f || unit === 0x7f) return true
  }
  return false
}

/**
 * The credential-free part of a transport failure: the HTTP client's reason
 * tag and the first operating-system error code (`ECONNREFUSED`, `ENOTFOUND`,
 * `CERT_HAS_EXPIRED`) in its cause chain. Never the request, the URL, the
 * headers, or free-form text, any of which may carry a credential.
 */
const transportReason = (cause: unknown): string | undefined => {
  const reason = (cause as { readonly reason?: { readonly _tag?: unknown } } | null)?.reason
  const tag = typeof reason?._tag === "string" ? reason._tag : undefined
  let code: string | undefined
  let current: unknown = reason ?? cause
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    const candidate = (current as { readonly code?: unknown }).code
    if (typeof candidate === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate)) {
      code = candidate
      break
    }
    current = (current as { readonly cause?: unknown }).cause
  }
  const parts = [tag, code].filter((part): part is string => part !== undefined)
  return parts.length === 0 ? undefined : parts.join(" ")
}

const transportFailure = (operation: string, cause: unknown): CacheStore.CacheStoreError => {
  const reason = transportReason(cause)
  return new CacheStore.CacheStoreError({
    code: "persistence_failed",
    message: `the remote cache tier refused ${operation}${reason === undefined ? "" : ` (${reason})`}`
  })
}

const unexpectedStatus = (operation: string, status: number): CacheStore.CacheStoreError =>
  new CacheStore.CacheStoreError({
    code: "persistence_failed",
    message: `the remote cache tier answered ${operation} with HTTP ${status}`
  })

const isOk = (status: number): boolean => status >= 200 && status < 300

const invalidConfiguration = (field: string): CacheStore.CacheStoreError =>
  new CacheStore.CacheStoreError({
    code: "invalid_cache",
    message: `remote cache ${field} is invalid`
  })

const bodyTooLarge = (received: number, bound: number): CacheStore.CacheStoreError =>
  new CacheStore.CacheStoreError({
    code: "persistence_failed",
    message: `the remote cache tier returned ${received} bytes, past the ${bound}-byte bound`
  })

const timedOut = (): CacheStore.CacheStoreError =>
  new CacheStore.CacheStoreError({
    code: "persistence_failed",
    message: "the remote cache tier did not finish within its configured deadline"
  })

/**
 * Builds a remote cache store over Effect's `HttpClient`.
 *
 * Status mapping for `put`, which is the only operation with a three-way
 * outcome: `201 Created` is `Inserted`, any other 2xx is `ExistingSame` (the
 * server already held an entry this publication does not disagree with), and
 * `409 Conflict` is `Conflict` (it held one it does). What counts as
 * disagreement is the two-stage rule in the module doc's server contract. That
 * is the smallest vocabulary that preserves `CacheStore`'s first-writer-wins
 * contract over dumb HTTP.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options
): Effect.Effect<CacheStore.Service, CacheStore.CacheStoreError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const configured = yield* Effect.try({
      try: () => {
        if (typeof options !== "object" || options === null) throw new TypeError("options")
        const allowed = new Set(["endpoint", "headers", "requestTimeout", "maxResponseBytes"])
        for (const key of Reflect.ownKeys(options)) {
          if (typeof key !== "string" || !allowed.has(key)) throw new TypeError("option")
          const descriptor = Object.getOwnPropertyDescriptor(options, key)
          if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
            throw new TypeError("option")
          }
        }
        const data = (key: keyof Options): unknown => Object.getOwnPropertyDescriptor(options, key)?.value
        const endpoint = data("endpoint")
        if (
          typeof endpoint !== "string" || endpoint.length > 16 * 1024 ||
          endpoint.trim() !== endpoint || !isWellFormedText(endpoint) ||
          hasControlText(endpoint)
        ) throw new TypeError("endpoint")
        const rawHeaders = data("headers")
        let headers: Readonly<Record<string, string>> | undefined
        if (rawHeaders !== undefined) {
          if (typeof rawHeaders !== "object" || rawHeaders === null) throw new TypeError("headers")
          const prototype = Object.getPrototypeOf(rawHeaders)
          if (prototype !== Object.prototype && prototype !== null) throw new TypeError("headers")
          const snapshot = Object.create(null) as Record<string, string>
          for (const key of Reflect.ownKeys(rawHeaders)) {
            if (typeof key !== "string") throw new TypeError("headers")
            const descriptor = Object.getOwnPropertyDescriptor(rawHeaders, key)
            if (
              descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable ||
              typeof descriptor.value !== "string" ||
              !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
              descriptor.value.length > 16 * 1024 || !isWellFormedText(descriptor.value) ||
              hasControlText(descriptor.value)
            ) throw new TypeError("headers")
            Object.defineProperty(snapshot, key, {
              value: descriptor.value,
              enumerable: true,
              configurable: false,
              writable: false
            })
          }
          headers = Object.freeze(snapshot)
        }
        return {
          endpoint,
          headers,
          requestTimeout: data("requestTimeout") as Duration.Input | undefined,
          maxResponseBytes: data("maxResponseBytes") as number | undefined
        }
      },
      catch: () => invalidConfiguration("options")
    })
    const endpoint = yield* Effect.try({
      try: () => new URL(configured.endpoint),
      catch: () => invalidConfiguration("endpoint")
    })
    const loopback = endpoint.hostname === "localhost" || endpoint.hostname.endsWith(".localhost") ||
      endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]"
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
      return yield* Effect.fail(invalidConfiguration("endpoint protocol"))
    }
    if (endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "") {
      return yield* Effect.fail(invalidConfiguration("endpoint authority"))
    }
    // Only the trailing slash is the client's to drop, which is all
    // `Options.endpoint` promises. Trimming it leaves either an empty path or
    // one that does not end in a separator, so the join below cannot double a
    // separator, and an empty interior segment the operator configured stays a
    // segment the server may route on. The trim is a local: assigning `""` to
    // `URL.pathname` reads back as `/`, which is what a collapsing pass here
    // used to hide by rewriting interior separators too.
    const rootPath = endpoint.pathname.replace(/\/+$/, "")
    const acPrefix = `${rootPath}/ac/`
    const base = endpoint.origin
    const requestDeadlineOption = yield* Effect.try({
      try: () => Duration.fromInput(configured.requestTimeout ?? defaultRequestTimeout),
      /* v8 ignore next -- defensive normalization if a future Duration input implementation throws */
      catch: () => invalidConfiguration("requestTimeout")
    })
    if (
      Option.isNone(requestDeadlineOption) ||
      !Number.isFinite(Duration.toMillis(requestDeadlineOption.value)) ||
      Duration.toMillis(requestDeadlineOption.value) <= 0
    ) return yield* Effect.fail(invalidConfiguration("requestTimeout"))
    const requestDeadline = requestDeadlineOption.value
    const maxResponseBytes = configured.maxResponseBytes ?? maximumEntryBytes
    if (
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 ||
      maxResponseBytes > maximumEntryBytes
    ) return yield* Effect.fail(invalidConfiguration("maxResponseBytes"))
    const client = yield* HttpClient.HttpClient
    const headers = configured.headers
    const credentialNames = Object.keys(headers ?? {}).map((name) => name.toLowerCase())
    const authorize = (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest =>
      headers === undefined ? request : HttpClientRequest.setHeaders(request, headers)
    const acUrl = (keyDigest: string) => {
      const target = new URL(base)
      target.pathname = `${acPrefix}${keyDigest}`
      /* v8 ignore next -- KeyDigest excludes every path separator and dot segment */
      if (!target.pathname.startsWith(acPrefix)) throw new Error("cache-key path escaped its namespace")
      return target.toString()
    }
    // One budget for the whole operation, not one per phase. `client.execute`
    // resolves when the response *headers* arrive, so a per-phase deadline let
    // a tier that answered headers promptly and then stalled the body spend the
    // configured value twice, and a caller budgeting 60 s waited 120 s.
    // The scope also aborts unread bodies on early status/length returns.
    const withDeadline = <A>(
      effect: Effect.Effect<A, CacheStore.CacheStoreError, Scope.Scope>
    ): Effect.Effect<A, CacheStore.CacheStoreError> =>
      effect.pipe(
        Effect.scoped,
        Effect.timeout(requestDeadline),
        Effect.catchTag("TimeoutError", () => Effect.fail(timedOut()))
      )
    // Redirects are never followed. A tier that answers 3xx to another origin
    // would otherwise receive the credential headers there: fetch strips only
    // `authorization` on a cross-origin hop, never a custom header such as
    // `x-api-key`. A fetch-backed client keeps the caller's other options and
    // hands back the 3xx, which every operation reports as `persistence_failed`.
    const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
      Effect.flatMap(Effect.serviceOption(FetchHttpClient.RequestInit), (init) =>
        HttpClient.withScope(client).execute(authorize(request)).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { ...Option.getOrUndefined(init), redirect: "manual" }),
          Effect.updateService(Headers.CurrentRedactedNames, (names) => [...names, ...credentialNames]),
          Effect.mapError((cause) =>
            transportFailure(operation, cause)
          )
        ))
    const readBounded = (response: HttpClientResponse.HttpClientResponse) =>
      Effect.gen(function*() {
        const declared = response.headers["content-length"]
        if (declared !== undefined) {
          const declaredBytes = Number(declared)
          if (!/^\d+$/.test(declared) || !Number.isSafeInteger(declaredBytes)) {
            return yield* Effect.fail(transportFailure("a lookup body", undefined))
          }
          if (declaredBytes > maxResponseBytes) {
            return yield* Effect.fail(bodyTooLarge(declaredBytes, maxResponseBytes))
          }
        }
        const chunks: Array<Uint8Array> = []
        let received = 0
        yield* Stream.runForEach(response.stream, (chunk: Uint8Array) =>
          Effect.suspend(() => {
            received += chunk.byteLength
            if (received > maxResponseBytes) return Effect.fail(bodyTooLarge(received, maxResponseBytes))
            chunks.push(new Uint8Array(chunk))
            return Effect.void
          })).pipe(Effect.mapError((cause) =>
            Schema.is(CacheStore.CacheStoreError)(cause)
              ? cause
              : transportFailure("a lookup body", cause)
          ))
        const bytes = new Uint8Array(received)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        return bytes
      })

    const get: CacheStore.Service["get"] = Effect.fn("RemoteCacheStore.get")((keyDigest, getOptions) =>
      withDeadline(Effect.gen(function*() {
        yield* CacheAdmission.validateKey(keyDigest)
        yield* Effect.annotateCurrentSpan({ keyDigest })
        const recordedBy = yield* CacheAdmission.validateRecordedBy(getOptions?.recordedBy)
        const maxAgeMs = yield* CacheAdmission.validateAge("maxAgeMs", getOptions?.maxAgeMs)
        const floorMs = maxAgeMs === undefined
          ? undefined
          : (yield* Clock.currentTimeMillis) - maxAgeMs
        const lookup = HttpClientRequest.get(acUrl(keyDigest))
        const request = recordedBy === undefined
          ? lookup
          : HttpClientRequest.setUrlParams(lookup, {
            recordedRunId: recordedBy.runId,
            recordedEventSeq: String(recordedBy.eventSeq)
          })
        const response = yield* send("a lookup", request)
        if (response.status === 404) return Option.none()
        if (!isOk(response.status)) return yield* Effect.fail(unexpectedStatus("a lookup", response.status))
        const bytes = yield* readBounded(response)
        const body = yield* Effect.try({
          try: () => JSON.parse(decoder.decode(bytes)) as unknown,
          catch: (cause) => transportFailure("a lookup body", cause)
        })
        const entry = yield* CacheAdmission.snapshotEntry(body as CacheStore.CacheEntry).pipe(
          Effect.mapError(() =>
            new CacheStore.CacheStoreError({
              code: "decode_failed",
              message: "the remote cache tier returned an entry that is not a bounded CacheEntry"
            })
          )
        )
        // A tier that answers a lookup with someone else's entry would hand
        // the caller a result under the wrong key — the one thing content
        // addressing must never allow.
        if (entry.keyDigest !== keyDigest) {
          return yield* Effect.fail(
            new CacheStore.CacheStoreError({
              code: "decode_failed",
              message: `the remote cache tier answered ${keyDigest} with an entry for ${entry.keyDigest}`
            })
          )
        }
        // A tier answering a fenced lookup with an entry recorded under
        // different provenance is serving its head, which is what the server
        // contract asks of a tier holding no row for that provenance and what
        // the SQL tier does in the same position. It is accepted as that
        // fallback: nothing on the wire distinguishes it from a tier that
        // ignored the parameters, which is why the module doc makes a
        // conforming server a precondition of a fenced read.
        if (floorMs !== undefined && entry.createdAtMs < floorMs) return Option.none()
        return Option.some(entry)
      }))
    )

    const put: CacheStore.Service["put"] = Effect.fn("RemoteCacheStore.put")((candidate: CacheStore.CacheEntry) =>
      withDeadline(Effect.gen(function*() {
        const entry = yield* CacheAdmission.snapshotEntry(candidate)
        yield* Effect.annotateCurrentSpan({ keyDigest: entry.keyDigest })
        // The wire bytes are the canonical form itself. Besides refusing
        // values JSON cannot represent, this gives structurally equal entries
        // identical bytes on every host regardless of object insertion order.
        // `snapshotEntry` has already admitted `result` and `meta` under the
        // per-field policy (an `undefined` member, a bigint or a cycle fails
        // there), so this is the one encoding a publication performs: the
        // whole entry under the envelope-aware policy, not the per-field one.
        // Each field keeps its own node and depth budget, the envelope adds
        // one nesting level and a fixed node allowance, and the whole-entry
        // byte bound is enforced on the encoding itself. `get` admits an entry
        // field-by-field under the same byte bound, so a publication never
        // refuses an entry a lookup could have returned.
        const body = yield* CacheAdmission.encodeEntryCanonical(entry)
        const response = yield* send(
          "a publication",
          HttpClientRequest.put(acUrl(entry.keyDigest)).pipe(
            HttpClientRequest.bodyText(body, "application/json")
          )
        )
        if (response.status === 409) return { _tag: "Conflict" } as const
        if (!isOk(response.status)) return yield* Effect.fail(unexpectedStatus("a publication", response.status))
        return response.status === 201 ? { _tag: "Inserted" } as const : { _tag: "ExistingSame" } as const
      }))
    )

    const evict: CacheStore.Service["evict"] = Effect.fn("RemoteCacheStore.evict")((keyDigest, evictOptions) =>
      withDeadline(Effect.gen(function*() {
        // An empty key would aim the protocol's one destructive verb at the
        // `/ac/` collection root instead of a single entry, so the preflight
        // that guards `get` guards the DELETE all the more.
        yield* CacheAdmission.validateKey(keyDigest)
        yield* Effect.annotateCurrentSpan({ keyDigest })
        const fenced = yield* CacheAdmission.validateFence(evictOptions?.ifRecordedBy)
        // The provenance fence rides in the request the same way it rides in
        // the SQL `DELETE`: the server compares before deleting, so a fresher
        // entry recorded by another machine between this caller's lookup and
        // its eviction is never dropped with the poison. The request reads the
        // decoded fence, never the caller's provenance object.
        const deletion = HttpClientRequest.make("DELETE")(acUrl(keyDigest))
        const request = fenced === undefined
          ? deletion
          : HttpClientRequest.setUrlParams(deletion, {
            recordedRunId: fenced.runId,
            recordedEventSeq: String(fenced.eventSeq)
          })
        const response = yield* send("an eviction", request)
        if (response.status === 404) return false
        if (!isOk(response.status)) return yield* Effect.fail(unexpectedStatus("an eviction", response.status))
        return true
      }))
    )

    const sweepExpired: CacheStore.Service["sweepExpired"] = Effect.fn("RemoteCacheStore.sweepExpired")(
      (olderThanMs) =>
        // The shared tier owns its retention. A client that swept it would
        // delete rows other machines are still replaying from, which is the
        // same reason `CombinedCacheStore.evict` never reaches across. The
        // argument is still validated, so a caller mistake is reported here
        // rather than silently absorbed.
        Effect.as(CacheAdmission.validateAge("olderThanMs", olderThanMs), 0)
    )

    return { get, put, evict, sweepExpired }
  })

/**
 * Provides a remote cache store as the `CacheStore` tag.
 *
 * Composing this alone makes every step-cache lookup a network round trip and
 * leaves this machine with no durable record. The intended production shape is
 * `CombinedCacheStore`, with this as its remote tier.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<CacheStore.CacheStore, CacheStore.CacheStoreError, HttpClient.HttpClient> =>
  Layer.effect(CacheStore.CacheStore)(make(options))
