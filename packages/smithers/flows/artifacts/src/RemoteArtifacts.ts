/**
 * The shared artifact tier: an {@link ArtifactStore.Service} spoken over HTTP.
 *
 * The wire protocol mirrors Bazel's dumb-HTTP remote cache, class
 * `HttpCacheClient` in `com.google.devtools.build.lib.remote.http`, which
 * documents it as: "CAS (Content Addressable Storage) blobs are stored under
 * the path `/cas/base16-key`", uploaded with `PUT`, downloaded with `GET`. We add
 * `HEAD /cas/{digest}` for a single existence probe and
 * `POST /cas/findMissing` for the batched one, because Bazel's HTTP client has
 * no `findMissingDigests` at all — it answers "everything is missing" and
 * re-uploads — and a batched probe is the whole reason
 * `MissingDigestsFinder` exists in the gRPC client.
 *
 * Transport is Effect's own `HttpClient` tag. There is no lower transport in
 * this repository, and there does not need to be one: the kernel already
 * decorates that tag with `net:get`/`net:post` capability checks, so a remote
 * artifact fetch is permission-checked like every other egress.
 *
 * ## Chunked uploads
 *
 * With `chunkBytes` set, a blob past that size travels as a sequence of
 * `PUT /cas/{digest}` requests carrying `Content-Range: bytes {a}-{b}/{total}`,
 * preceded by a `HEAD /cas/{digest}` existence probe and a
 * `Content-Range: bytes *\/{total}` probe with an empty body. This is the
 * resumable-upload shape HTTP already has: the range probe asks what prefix
 * the tier holds and `308` means "keep going", with a `Range: bytes=0-{last}`
 * header on the probe or on a chunk answer moving the offset.
 *
 * Only a `308` continues the sequence, and the completing chunk's `2xx` is
 * confirmed with `HEAD` before `put` reports the digest as published. A `2xx`
 * anywhere else, to the empty probe or to a chunk the tier is still owed bytes
 * after, reads as a tier that ignored `Content-Range` and stored the body it
 * was handed, which is what plain WebDAV `PUT` does. That tier, the one that
 * answers `400`, `411`, or `416`, and the one whose `HEAD` will not confirm
 * the stored length all get the same treatment: one whole-blob `PUT`, which
 * overwrites the partial body the sequence left behind. So the blob always
 * lands whole, and the cost of turning the dial on against a server that
 * never learned about it is round trips, never a digest published over bytes
 * the server does not hold.
 *
 * This repository's own hosted and self-hosted cache services are such
 * servers: neither implements the resumable sequence, and both refuse a
 * ranged `PUT` with `400`, RFC 9110 section 14.5's answer from a resource
 * that does not support partial `PUT`. Against them `chunkBytes` costs the
 * probe round trip and the blob travels whole, and both cap one request body
 * at 16 MiB, so a blob past that cap is refused with `413` in either mode.
 *
 * The endpoint and its credentials arrive as **layer construction options**.
 * They are capabilities, never step inputs: they are not hashed into a step
 * key, journaled, or returned in a recorded result. Invalid endpoint errors are
 * sanitized before they cross the boundary.
 *
 * @since 1.0.0-rc.0
 */

import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as ArtifactStore from "./ArtifactStore.ts"

/**
 * How eagerly a composition materializes shared blobs into its local store.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const DownloadPolicy = Schema.Literals(["all", "toplevel", "minimal"] as const)

/**
 * How eagerly a composition materializes remote blobs.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type DownloadPolicy = typeof DownloadPolicy.Type

/**
 * Every download policy, in materialization order.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const downloadPolicies: ReadonlyArray<DownloadPolicy> = Object.freeze(["all", "toplevel", "minimal"])

/**
 * A remote artifact tier, which is an ordinary store that also states how
 * eagerly a composition reading through it should materialize blobs locally.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Service extends ArtifactStore.Service {
  readonly downloadPolicy: DownloadPolicy
}

/**
 * Reads the download policy a store declares, or `undefined` for a store that
 * declares none — every local store, and any foreign implementation.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export const downloadPolicyOf = (store: ArtifactStore.Service): DownloadPolicy | undefined => {
  const declared = (store as { readonly downloadPolicy?: unknown }).downloadPolicy
  return Schema.is(DownloadPolicy)(declared) ? declared : undefined
}

/**
 * How to reach the shared artifact tier.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface Options {
  /**
   * The cache root, e.g. `https://cache.example.com`. `/cas/{digest}` and
   * `/cas/findMissing` are resolved beneath it. A trailing slash is ignored.
   *
   * Four shapes are refused at construction as `invalid_configuration`, before
   * any request leaves and therefore before `headers` can reach a wire: a value
   * that is not a string, one no `URL` parser accepts, a scheme other than
   * `https:` (plain `http:` is accepted only for the literal loopback hosts
   * `localhost`, `127.0.0.1`, and `[::1]`), and an endpoint carrying
   * userinfo, a query, or a fragment. The
   * last rule keeps a credential out of a place nothing here would redact: an
   * endpoint is interpolated into every request path and into span attributes.
   *
   * The refusal message names only the violated rule and never echoes the
   * endpoint, so a rejected `https://user:secret@host` cannot leak its
   * credential into a log line or a durable error.
   */
  readonly endpoint: string
  /**
   * Headers sent with every request — an `Authorization` bearer token, a
   * tenant header, whatever the deployment's gateway wants. This is the
   * credential seam, and it is deliberately construction-time: a credential
   * that arrived as a step input would be hashed into a step key and persisted
   * everywhere the journal goes.
   *
   * The protocol wins every collision. These headers are applied to a request
   * first. Configured `content-type`, `content-length`, and `content-range`
   * are removed, then computed only where the protocol needs them. Whole-blob
   * uploads, including fallbacks, never carry `content-range`.
   * All configured header names are redacted in HTTP spans, in addition to
   * the host's existing redaction rules.
   *
   * A name that is not an HTTP token, or a value longer than 16 KiB or
   * carrying a control character (CR and LF included), is refused at
   * construction as `invalid_configuration`.
   */
  readonly headers?: Record<string, string> | undefined
  /**
   * The deadline on a single download, from the request leaving to the last
   * body byte arriving. A shared tier that stops answering must fail the read
   * rather than park it forever. `CombinedArtifacts.get` propagates a remote
   * `ArtifactStoreError`, including a download timeout. Only opportunistic
   * uploads from `CombinedArtifacts.put` ignore remote failures;
   * `ArtifactSync.hydrate` separately turns a failure into replay rejection.
   * Defaults to 60 seconds, Bazel's `--remote_timeout`
   * default for the same REST protocol (its `RemoteOptions`: "For the REST
   * cache, this is both the connect and the read timeout").
   */
  readonly downloadTimeout?: Duration.Input | undefined
  /**
   * Deadline for an upload, including every resume probe and chunk. Defaults
   * to 60 seconds.
   */
  readonly uploadTimeout?: Duration.Input | undefined
  /**
   * Deadline for an existence probe or one `findMissing` batch, including its
   * response body. Defaults to 60 seconds.
   */
  readonly requestTimeout?: Duration.Input | undefined
  /**
   * The largest download this client will buffer, in bytes. The body is read
   * incrementally and abandoned the moment it exceeds the bound — and refused
   * outright when `Content-Length` already declares the excess — so a
   * mis-serving or hostile cache cannot make this process buffer and hash an
   * arbitrarily large body before the digest check refuses it. Defaults to
   * 256 MiB.
   */
  readonly maxDownloadBytes?: number | undefined
  /**
   * Largest `findMissing` response body accepted. Defaults to the protocol's
   * 256 KiB request/response bound and may only lower that bound.
   */
  readonly maxFindMissingResponseBytes?: number | undefined
  /**
   * Above this many bytes an upload travels as a sequence of `Content-Range`
   * `PUT`s instead of one whole-blob body, and a transfer that died partway
   * resumes from the prefix the tier kept rather than starting over. See
   * {@link module:RemoteArtifacts | the chunked upload protocol} below.
   *
   * Absent by default: every upload is one whole-blob `PUT`, which is what
   * Bazel's dumb-HTTP client does and what every deployment already serving
   * this protocol expects. Set it when a proxy caps request bodies, or when
   * artifacts are large enough that losing a transfer is expensive.
   *
   * The repository's own hosted and self-hosted cache services answer the
   * ranged probe with `400`, so against them this dial degrades to one
   * whole-blob `PUT`, and their 16 MiB body cap refuses a larger blob with
   * `413` in either mode.
   */
  readonly chunkBytes?: number | undefined
  /**
   * How eagerly a composition reading through this tier materializes blobs
   * into its local store. This is Bazel's `--remote_download_{all,toplevel,
   * minimal}` dial (`RemoteOutputChecker`), and it lives here because the
   * shared tier is the thing being conserved.
   *
   * - `all` (the default) prefetches every referenced blob when a replay is
   *   admitted, so the replay reads local bytes.
   * - `toplevel` prefetches nothing and materializes a blob into the local
   *   store on the first read that actually needs it.
   * - `minimal` prefetches nothing and materializes nothing: a read is served
   *   straight from the shared tier and the local store never grows.
   *
   * `CombinedArtifacts.get` honors the last two; `@smthrs/engine-store`'s
   * `ArtifactSync.hydrate` honors the first.
   */
  readonly downloadPolicy?: DownloadPolicy | undefined
}

/**
 * The default download deadline. 60 seconds is Bazel's `--remote_timeout`
 * default, governing the same dumb-HTTP cache protocol.
 */
const defaultDownloadTimeout = Duration.seconds(60)
const defaultUploadTimeout = Duration.seconds(60)
const defaultRequestTimeout = Duration.seconds(60)

/**
 * The default bound on a downloaded blob: 256 MiB. Artifacts are spilled step
 * values, not media libraries; a body past this size is far more likely a
 * mis-serving cache than a legitimate blob, and the dial is per-store for a
 * deployment that knows better.
 */
const defaultMaxDownloadBytes = 256 * 1024 * 1024
const maxFindMissingBatchDigests = 1_000
const maxFindMissingBodyBytes = 256 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

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

const transportFailure = (operation: string, cause?: unknown): ArtifactStore.ArtifactStoreError => {
  const reason = transportReason(cause)
  return new ArtifactStore.ArtifactStoreError({
    code: "transport_failed",
    message: `the remote artifact tier refused ${operation}${reason === undefined ? "" : ` (${reason})`}`
  })
}

const unexpectedStatus = (operation: string, status: number): ArtifactStore.ArtifactStoreError =>
  new ArtifactStore.ArtifactStoreError({
    code: "transport_failed",
    message: `the remote artifact tier answered ${operation} with HTTP ${status}`
  })

const invalidOption = (name: string): ArtifactStore.ArtifactStoreError =>
  new ArtifactStore.ArtifactStoreError({
    code: "invalid_configuration",
    message: `invalid remote artifact option: ${name}`
  })

/** The batched-probe response body. */
const FindMissingResponse = Schema.Struct({ missing: Schema.Array(Schema.String) })

/** An RFC 9110 field-name token. */
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Whether a header value carries a C0 control character or DEL, CR and LF included. */
const hasControlText = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x1f || unit === 0x7f) return true
  }
  return false
}

const configurationFailure = (message: string): ArtifactStore.ArtifactStoreError =>
  new ArtifactStore.ArtifactStoreError({ code: "invalid_configuration", message })

/**
 * A 2xx is success, a 404 is a miss, and everything else is a transport
 * failure. Bazel's HTTP client takes the same three-way split; it is the only
 * classification a dumb-HTTP cache can support, because there is no richer
 * error envelope on the wire.
 */
const isOk = (response: HttpClientResponse.HttpClientResponse): boolean =>
  response.status >= 200 && response.status < 300

/**
 * Builds a remote artifact store over Effect's `HttpClient`.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const make = (
  options: Options
): Effect.Effect<Service, ArtifactStore.ArtifactStoreError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const configured = yield* Effect.try({
      try: () => {
        const headers = options.headers === undefined
          ? undefined
          : Object.freeze(Object.fromEntries(
            Object.entries(options.headers).map(([name, value]) => {
              // Refused here, once, rather than on every request as an opaque
              // transport failure: a CRLF in a value or a space in a name can
              // never become a valid header.
              if (typeof value !== "string" || value.length > 16 * 1024 || hasControlText(value)) {
                throw new TypeError("header value")
              }
              if (!headerName.test(name)) throw new TypeError("header name")
              return [name, value]
            })
          ))
        return {
          endpoint: options.endpoint,
          headers,
          downloadTimeout: options.downloadTimeout,
          uploadTimeout: options.uploadTimeout,
          requestTimeout: options.requestTimeout,
          maxDownloadBytes: options.maxDownloadBytes,
          maxFindMissingResponseBytes: options.maxFindMissingResponseBytes,
          chunkBytes: options.chunkBytes,
          downloadPolicy: options.downloadPolicy
        }
      },
      catch: () => invalidOption("options")
    })
    if (typeof configured.endpoint !== "string") return yield* Effect.fail(invalidOption("endpoint"))
    const endpoint = yield* Effect.try({
      try: () => new URL(configured.endpoint),
      catch: () => configurationFailure("invalid remote artifact endpoint")
    })
    // A self-hosted cache on this machine is reachable over plain HTTP, and
    // loopback traffic never leaves the host. Only literal loopback names are
    // exempt: a `*.localhost` name reaches loopback only on a resolver that
    // follows RFC 6761, and one that forwards it to DNS would carry the
    // credential headers over plaintext to whatever host answers.
    const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" ||
      endpoint.hostname === "[::1]"
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
      return yield* Effect.fail(configurationFailure("remote artifact endpoint must use HTTPS"))
    }
    if (endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "") {
      return yield* Effect.fail(
        configurationFailure("remote artifact endpoint must not contain credentials, a query, or a fragment")
      )
    }
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, "")
    const base = endpoint.toString().replace(/\/+$/, "")
    const headers = configured.headers
    const client = yield* HttpClient.HttpClient
    const credentialNames = Object.keys(headers ?? {}).map((name) => name.toLowerCase())
    /**
     * Protocol-owned headers are computed from each request's body and range,
     * never inherited from credentials, including on a whole-blob fallback.
     */
    const authorized = (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest =>
      (headers === undefined ? request : HttpClientRequest.setHeaders(request, headers)).pipe(
        HttpClientRequest.removeHeader("content-type"),
        HttpClientRequest.removeHeader("content-length"),
        HttpClientRequest.removeHeader("content-range")
      )
    // The address is a URL path segment, so it is refused before it is
    // interpolated and percent-encoded when it is: an address carrying a
    // separator or a `..` would otherwise point this client at a different
    // resource on the configured endpoint. `ArtifactStore.validateDigest` is
    // the same guard the filesystem tier applies to the same untrusted input —
    // a digest read back out of a durable row.
    const casUrl = (digest: ArtifactStore.Digest) => `${base}/cas/${digest}`
    const scopedClient = HttpClient.withScope(client)
    /**
     * Keep body processing inside the exchange; abort unused responses on every exit.
     *
     * Redirects are never followed. A fetch-based client follows them by
     * default and strips only `Authorization` on a cross-origin hop, so a
     * tier answering `3xx` would otherwise receive the credential headers at
     * another origin or over plain HTTP. Manual mode hands the `3xx` back,
     * where it is an unexpected status (or, for `308`, the resumable-upload
     * answer this protocol already speaks).
     */
    const send = <A, E, R>(
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
      use: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E, R>
    ): Effect.Effect<A, E | ArtifactStore.ArtifactStoreError, R> =>
      Effect.gen(function*() {
        const redactedNames = yield* Headers.CurrentRedactedNames
        const requestInit = yield* Effect.serviceOption(FetchHttpClient.RequestInit)
        return yield* scopedClient.execute(request).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            ...Option.getOrUndefined(requestInit),
            redirect: "manual"
          }),
          Effect.mapError((cause) => transportFailure(operation, cause)),
          Effect.flatMap(use),
          Effect.provideService(Headers.CurrentRedactedNames, [...redactedNames, ...credentialNames]),
          Effect.scoped
        )
      })
    const parseDeadline = (name: string, input: Duration.Input | undefined, fallback: Duration.Duration) =>
      Effect.gen(function*() {
        const parsed = Duration.fromInput(input ?? fallback)
        if (
          Option.isNone(parsed) ||
          !Number.isFinite(Duration.toMillis(parsed.value)) ||
          Duration.toMillis(parsed.value) <= 0
        ) {
          return yield* Effect.fail(invalidOption(name))
        }
        return parsed.value
      })
    const downloadDeadline = yield* parseDeadline(
      "downloadTimeout",
      configured.downloadTimeout,
      defaultDownloadTimeout
    )
    const uploadDeadline = yield* parseDeadline("uploadTimeout", configured.uploadTimeout, defaultUploadTimeout)
    const requestDeadline = yield* parseDeadline("requestTimeout", configured.requestTimeout, defaultRequestTimeout)
    const maxDownloadBytes = configured.maxDownloadBytes ?? defaultMaxDownloadBytes
    if (!Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes <= 0) {
      return yield* Effect.fail(invalidOption("maxDownloadBytes"))
    }
    const maxFindMissingResponseBytes = configured.maxFindMissingResponseBytes ?? maxFindMissingBodyBytes
    if (
      !Number.isSafeInteger(maxFindMissingResponseBytes) ||
      maxFindMissingResponseBytes <= 0 ||
      maxFindMissingResponseBytes > maxFindMissingBodyBytes
    ) {
      return yield* Effect.fail(invalidOption("maxFindMissingResponseBytes"))
    }
    const chunkBytes = configured.chunkBytes
    if (chunkBytes !== undefined && (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0)) {
      return yield* Effect.fail(invalidOption("chunkBytes"))
    }
    const downloadPolicy = configured.downloadPolicy ?? "all"
    if (!Schema.is(DownloadPolicy)(downloadPolicy)) {
      return yield* Effect.fail(invalidOption("downloadPolicy"))
    }
    const bodyTooLarge = (operation: string, received: number, bound: number): ArtifactStore.ArtifactStoreError =>
      new ArtifactStore.ArtifactStoreError({
        code: "transport_failed",
        message: `the remote artifact tier answered ${operation} with ${received} bytes, past the ${bound}-byte bound`
      })
    const timedOut = (operation: string): ArtifactStore.ArtifactStoreError =>
      new ArtifactStore.ArtifactStoreError({
        code: "transport_failed",
        message: `the remote artifact tier did not finish ${operation} within its configured deadline`
      })
    const within = <A, E, R>(
      operation: string,
      deadline: Duration.Duration,
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E | ArtifactStore.ArtifactStoreError, R> =>
      effect.pipe(
        Effect.timeout(deadline),
        Effect.catchTag("TimeoutError", () => Effect.fail(timedOut(operation)))
      )
    /**
     * Reads a download body incrementally, refusing it the moment it exceeds
     * the size bound; a `Content-Length` that already declares the excess is
     * refused before a single body byte is read. Streaming instead of
     * buffering the whole body means the guard fires at most one chunk past
     * the bound, never after an arbitrarily large response is in memory.
     */
    const readBounded = (
      response: HttpClientResponse.HttpClientResponse,
      operation: string,
      bound: number
    ) =>
      Effect.gen(function*() {
        const declared = response.headers["content-length"]
        if (declared !== undefined) {
          const declaredBytes = Number(declared)
          if (!/^\d+$/.test(declared) || !Number.isSafeInteger(declaredBytes)) {
            return yield* Effect.fail(transportFailure(`${operation} body`))
          }
          if (declaredBytes > bound) return yield* Effect.fail(bodyTooLarge(operation, declaredBytes, bound))
        }
        const chunks: Array<Uint8Array> = []
        let received = 0
        yield* Stream.runForEach(response.stream, (chunk: Uint8Array) =>
          Effect.suspend(() => {
            received += chunk.byteLength
            if (received > bound) return Effect.fail(bodyTooLarge(operation, received, bound))
            chunks.push(new Uint8Array(chunk))
            return Effect.void
          })).pipe(
            Effect.catchTag("HttpClientError", (cause) =>
              // An absent body is zero bytes, not a transport refusal: the
              // digest check in `get` is the arbiter of whether empty content
              // is the requested artifact.
              cause.reason._tag === "EmptyBodyError"
                ? Effect.void
                : Effect.fail(transportFailure(`${operation} body`)))
          )
        const bytes = new Uint8Array(received)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        return bytes
      })
    /** The network half of `get`: request, status split, bounded body read. */
    const download = (digest: ArtifactStore.Digest) =>
      send("a download", authorized(HttpClientRequest.get(casUrl(digest))), (response) =>
        Effect.gen(function*() {
          if (response.status === 404) {
            return yield* Effect.fail(new ArtifactStore.ArtifactMissing({ code: "artifact_missing", digest }))
          }
          if (!isOk(response)) return yield* Effect.fail(unexpectedStatus("a download", response.status))
          return yield* readBounded(response, "a download", maxDownloadBytes)
        }))

    /** One whole-blob `PUT`: the protocol every dumb-HTTP CAS already speaks. */
    const uploadWhole = (digest: ArtifactStore.Digest, bytes: Uint8Array) =>
      send(
        "an upload",
        authorized(HttpClientRequest.put(casUrl(digest))).pipe(
          HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream")
        ),
        (response) => isOk(response) ? Effect.void : Effect.fail(unexpectedStatus("an upload", response.status))
      )

    /**
     * The byte after the prefix a `Range: bytes=0-{last}` header reports, or
     * `undefined` when the answer names no prefix. Only a prefix starting at
     * zero is usable: a tier holding a middle span has nothing this client can
     * continue from, so it is treated as holding nothing.
     */
    const resumeOffset = (response: HttpClientResponse.HttpClientResponse): number | undefined => {
      const header = response.headers["range"]
      if (header === undefined) return undefined
      const match = /^bytes=0-(\d+)$/.exec(header.trim())
      if (match === null) return undefined
      const last = Number(match[1])
      // A prefix past the safe integer range does not survive `Number`: the
      // decimal digits are rounded, so the offset it names is a number this
      // client made up. It proves nothing about what the tier holds, which is
      // the same as naming no prefix at all.
      if (!Number.isSafeInteger(last)) return undefined
      return last + 1
    }

    /**
     * A tier that refuses ranged bodies, in the three ways HTTP has to say
     * so. `411` and `416` refuse the body's framing; `400` is RFC 9110
     * section 14.5's answer from a resource that "does not support partial
     * PUT requests", and it is what both of this repository's cache services
     * send. Falling back on it can mask no genuine `400`: the whole-blob
     * `PUT` that follows presents the same URL, digest, and credential, so a
     * real refusal comes straight back on that request.
     */
    const rejectsRanges = (status: number): boolean => status === 400 || status === 411 || status === 416

    /**
     * Whether the tier holds exactly `total` bytes under `digest`, read from
     * the `Content-Length` of a `HEAD` answer.
     *
     * This is the only claim about a chunked transfer this client will make on
     * its own behalf. A tier that answers `HEAD` without a length is not
     * refused — it simply proves nothing, so the caller sends the blob whole.
     */
    const holdsWhole = (digest: ArtifactStore.Digest, total: number) =>
      send("an existence probe", authorized(HttpClientRequest.head(casUrl(digest))), (response) =>
        Effect.sync(() => {
          if (!isOk(response)) return false
          const declared = response.headers["content-length"]
          return declared !== undefined && Number(declared) === total
        }))

    /**
     * Sends `bytes` as `Content-Range` chunks, resuming from whatever prefix
     * the tier reports. Answers `false` when the tier has not proved it stored
     * the whole blob, which is the caller's signal to send it whole.
     *
     * A `2xx` answer is never by itself proof of that. A tier that ignores
     * `Content-Range`, such as plain WebDAV `PUT`, which Bazel documents as a
     * supported dumb-HTTP cache, answers every request in this sequence `201`
     * while storing only the last body it was handed, which for the probe is
     * zero bytes. So only a `308` continues the sequence, and the completing
     * chunk's `2xx` is confirmed with `HEAD` before the caller is told the
     * digest is published. Everything else falls back, and the whole-blob
     * `PUT` overwrites whatever partial body the sequence left behind.
     */
    const uploadChunked = (digest: ArtifactStore.Digest, bytes: Uint8Array, chunk: number) =>
      Effect.gen(function*() {
        const total = bytes.byteLength
        const ranged = (range: string, body: Uint8Array) =>
          send(
            "an upload",
            authorized(HttpClientRequest.put(casUrl(digest))).pipe(
              HttpClientRequest.bodyUint8Array(body, "application/octet-stream"),
              HttpClientRequest.setHeader("content-range", range)
            ),
            // Only status and headers are used after the response is released.
            Effect.succeed
          )
        // A blob the tier already holds whole costs one `HEAD` and no body.
        // Asking first is also what makes the probe's answer readable: a `2xx`
        // to it can no longer mean "already there", so the one reading left is
        // a tier that ignored the header and stored the empty body.
        if (yield* holdsWhole(digest, total)) return true
        // The probe carries no bytes: it exists to learn where to start, so
        // that an interrupted transfer costs one round trip rather than the
        // whole blob again.
        const probe = yield* ranged(`bytes */${total}`, new Uint8Array(0))
        if (isOk(probe) || rejectsRanges(probe.status)) return false
        if (probe.status !== 308 && probe.status !== 404) {
          return yield* Effect.fail(unexpectedStatus("an upload probe", probe.status))
        }
        let offset = probe.status === 308 ? resumeOffset(probe) ?? 0 : 0
        while (offset < total) {
          const end = Math.min(offset + chunk, total)
          const answer = yield* ranged(`bytes ${offset}-${end - 1}/${total}`, bytes.subarray(offset, end))
          if (answer.status !== 308) {
            // The completing chunk may answer `2xx`; anything before it may
            // not, because a tier that is still owed bytes and reports success
            // is a tier that is not reading the header. Both are checked
            // against what the tier actually holds below.
            if (end === total && isOk(answer)) break
            if (isOk(answer) || rejectsRanges(answer.status)) return false
            return yield* Effect.fail(unexpectedStatus("an upload", answer.status))
          }
          // A tier that reports a longer prefix than this chunk delivered has
          // more than we just sent, so the next chunk starts there. Never
          // backwards: an answer naming a shorter prefix would loop forever.
          offset = Math.max(end, resumeOffset(answer) ?? 0)
        }
        return yield* holdsWhole(digest, total)
      })

    const put: ArtifactStore.Service["put"] = Effect.fn("RemoteArtifacts.put")((bytes: Uint8Array) =>
      Effect.flatMap(ArtifactStore.snapshotBytes(bytes), (snapshot) =>
        Effect.gen(function*() {
          const digest = yield* ArtifactStore.measureBytes(snapshot)
          yield* Effect.annotateCurrentSpan({ digest })
          yield* within(
            "an upload",
            uploadDeadline,
            Effect.gen(function*() {
              if (chunkBytes === undefined || snapshot.byteLength <= chunkBytes) {
                yield* uploadWhole(digest, snapshot)
                return
              }
              const transferred = yield* uploadChunked(digest, snapshot, chunkBytes)
              if (!transferred) yield* uploadWhole(digest, snapshot)
            })
          )
          return digest
        }))
    )

    const get: ArtifactStore.Service["get"] = Effect.fn("RemoteArtifacts.get")((digest: string) =>
      Effect.gen(function*() {
        const validated = yield* ArtifactStore.validateDigest(digest)
        yield* Effect.annotateCurrentSpan({ digest: validated })
        // The deadline covers the whole exchange — request, headers, body —
        // because a tier that stalls mid-body is exactly as unanswering as
        // one that never accepts the connection.
        const bytes = yield* within("a download", downloadDeadline, download(validated))
        // The shared tier is the least trusted store there is: it is written
        // by machines this one has never met. Verifying the address here means
        // a mis-serving or compromised cache can waste a round trip but can
        // never substitute content.
        const measured = yield* ArtifactStore.measureBytes(bytes)
        if (measured !== validated) {
          return yield* Effect.fail(
            new ArtifactStore.ArtifactCorruption({
              code: "artifact_corruption",
              recordedDigest: validated,
              measuredDigest: measured
            })
          )
        }
        return bytes
      })
    )

    const has: ArtifactStore.Service["has"] = Effect.fn("RemoteArtifacts.has")((digest: string) =>
      Effect.gen(function*() {
        const validated = yield* ArtifactStore.validateDigest(digest)
        yield* Effect.annotateCurrentSpan({ digest: validated })
        const response = yield* within(
          "an existence probe",
          requestDeadline,
          send("an existence probe", authorized(HttpClientRequest.head(casUrl(validated))), Effect.succeed)
        )
        if (response.status === 404) return false
        if (!isOk(response)) return yield* Effect.fail(unexpectedStatus("an existence probe", response.status))
        return true
      })
    )

    const findMissing: ArtifactStore.Service["findMissing"] = Effect.fn("RemoteArtifacts.findMissing")(
      (digests: Iterable<string>) =>
        Effect.gen(function*() {
          const requested = [...new Set(digests)]
          if (requested.length === 0) return []
          // The batch travels in a JSON body rather than a path, but an
          // unusable address is still an unusable address, and the local tier
          // refuses the same batch wholesale rather than probing part of it.
          const validated: Array<ArtifactStore.Digest> = []
          for (const digest of requested) validated.push(yield* ArtifactStore.validateDigest(digest))
          yield* Effect.annotateCurrentSpan({ count: validated.length })
          const missing = new Set<string>()
          for (let offset = 0; offset < validated.length; offset += maxFindMissingBatchDigests) {
            const batch = validated.slice(offset, offset + maxFindMissingBatchDigests)
            const requestBody = encoder.encode(JSON.stringify({ digests: batch }))
            /* v8 ignore next 3 -- strict 64-byte digests plus the 1,000-entry batch cap make this
             * at most 67,013 bytes; keep the protocol assertion beside serialization in case either invariant changes. */
            if (requestBody.byteLength > maxFindMissingBodyBytes) {
              return yield* Effect.fail(configurationFailure("remote artifact findMissing request exceeds 256 KiB"))
            }
            const decoded = yield* within(
              "a batched existence probe",
              requestDeadline,
              send(
                "a batched existence probe",
                authorized(HttpClientRequest.post(`${base}/cas/findMissing`)).pipe(
                  HttpClientRequest.bodyUint8Array(requestBody, "application/json")
                ),
                (response) =>
                  Effect.gen(function*() {
                    if (!isOk(response)) {
                      return yield* Effect.fail(unexpectedStatus("a batched existence probe", response.status))
                    }
                    const bodyBytes = yield* readBounded(
                      response,
                      "a batched existence probe",
                      maxFindMissingResponseBytes
                    )
                    const body = yield* Effect.try({
                      try: () => JSON.parse(decoder.decode(bodyBytes)) as unknown,
                      catch: () => transportFailure("a batched existence probe body")
                    })
                    return yield* Schema.decodeUnknownEffect(FindMissingResponse)(body).pipe(
                      Effect.mapError(() => transportFailure("a batched existence probe body"))
                    )
                  })
              )
            )
            const asked = new Set<string>(batch)
            for (const digest of decoded.missing) if (asked.has(digest)) missing.add(digest)
          }
          // "The returned set is guaranteed to be a subset of `digests`"
          // (`MissingDigestsFinder`). Bazel gets that from the server; we
          // enforce it on this side too, because a server that answered with
          // an unrequested digest would otherwise make the caller upload bytes
          // it never asked about.
          return validated.filter((digest) => missing.has(digest))
        })
    )

    return { put, get, has, findMissing, downloadPolicy }
  })

/**
 * Provides a remote artifact store as the `ArtifactStore` tag.
 *
 * Composing this *alone* makes every artifact read and write a network round
 * trip. The intended production shape is
 * {@link CombinedArtifacts.layer | CombinedArtifacts}, with this as its remote
 * tier.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layer = (
  options: Options
): Layer.Layer<ArtifactStore.ArtifactStore, ArtifactStore.ArtifactStoreError, HttpClient.HttpClient> =>
  Layer.effect(ArtifactStore.ArtifactStore)(make(options))
