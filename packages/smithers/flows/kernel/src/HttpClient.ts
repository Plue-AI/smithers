/**
 * Permission-aware outgoing HTTP requests.
 *
 * There is no kernel `HttpClient` interface and no kernel `HttpClient` tag.
 * Effect owns both, and its tag fixes the error channel to `HttpClientError`,
 * so this module is only the middleware: a `Layer` over Effect's own tag that
 * reads the raw client out of context and returns a guarded one in its place.
 * Permission failures are projected into `HttpClientError` by
 * {@link toHttpClientError}, which keeps the structured kernel failure on the
 * transport reason's `cause` so {@link fromHttpClientError} can hand it back.
 *
 * **Redirects.** A redirect is a second network destination, so it needs a
 * second grant check. Two halves guarantee that:
 *
 *  1. The client below this layer must **not** follow redirects on its own.
 *     That is a precondition on the host: Undici without a redirect
 *     interceptor, or Effect's fetch layer with `redirect: "manual"`. This
 *     layer also forces `RequestInit { redirect: "manual" }` over the ambient
 *     value for every request it executes, so a plain `FetchHttpClient.layer`,
 *     which follows redirects by default, cannot walk to another origin below
 *     the guard either. A custom client that ignores `RequestInit` must meet
 *     the precondition itself.
 *  2. This layer composes Effect's own `HttpClient.followRedirects` *above*
 *     the guard. That combinator re-enters `postprocess` for every hop, and
 *     `postprocess` is the guarded one, so hop *n* is checked exactly like hop
 *     zero and an authorized origin cannot lend its grant to another.
 *     A caller that sets `FetchHttpClient.RequestInit.redirect` to `manual`
 *     receives one guarded hop and owns any further redirect requests itself.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md`,
 * `docs/specs/Concepts/Effect Taxonomy.md`, and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 1.0.0-rc.0
 */

import type { Capability } from "@smthrs/capability/Capability"
import {
  formatError,
  isPermissionError,
  PermissionDenied,
  type PermissionError,
  type PermissionErrorPayload
} from "@smthrs/capability/Permission"
import { Context, Effect, Layer, Option } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as UrlParams from "effect/unstable/http/UrlParams"
import { GrantStore, type Service as GrantService } from "./GrantStore.ts"
import { makeCapability } from "./internal/makeCapability.ts"

const snapshotRawBody = (value: unknown): unknown => {
  if (value instanceof globalThis.Uint8Array) return value.slice()
  if (value instanceof ArrayBuffer) return value.slice(0)
  if (value instanceof URLSearchParams) {
    return new URLSearchParams(value)
  }
  if (value instanceof Blob) return value
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  throw new TypeError("raw HTTP bodies must be immutable or copyable")
}

const snapshotBody = (body: HttpBody.HttpBody): HttpBody.HttpBody => {
  switch (body._tag) {
    case "Empty":
      return HttpBody.empty
    case "Raw":
      return HttpBody.raw(snapshotRawBody(body.body), {
        contentType: body.contentType,
        contentLength: body.contentLength
      })
    case "Uint8Array":
      return HttpBody.uint8Array(body.body.slice(), body.contentType)
    case "FormData": {
      const formData = new globalThis.FormData()
      for (const [name, value] of body.formData.entries()) formData.append(name, value)
      return HttpBody.formData(formData)
    }
    case "Stream":
      return HttpBody.stream(body.stream, body.contentType, body.contentLength)
  }
}

const snapshotRequest = (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.makeWith(
    request.method,
    request.url,
    UrlParams.make(
      Object.freeze(request.urlParams.params.map(([name, value]) => Object.freeze([name, value] as const)))
    ),
    Option.map(request.hash, (value) => value),
    Headers.fromInput(request.headers),
    snapshotBody(request.body)
  )

const invalidRequest = (request: HttpClientRequest.HttpClientRequest): HttpClientError.HttpClientError =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      description: "HTTP request must be an immutable supported request description"
    })
  })

/**
 * Effect's own outgoing HTTP client tag, unchanged. Re-exported so the kernel
 * namespace stays one-stop; it is the *same* tag, never a second one.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export { HttpClient } from "effect/unstable/http/HttpClient"

/**
 * Constructs a client from a low-level request runner, keeping Effect's own
 * URL construction, tracing, header redaction, and interruption behavior.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export { make } from "effect/unstable/http/HttpClient"

/**
 * The model identity an outgoing request is made on behalf of, if any.
 *
 * A model call is not a general `net:*` effect: the same host answers many
 * models, and a grant for one must not be a grant for the rest. Effect's tag
 * has no room for an extra method, so the intent rides on a `Context`
 * reference instead — set it with {@link withModelCall} and the decorator asks
 * for `model:call` rather than `net:get`/`net:post`.
 *
 * @category references
 * @since 1.0.0-rc.0
 */
export const ModelCall: Context.Reference<string | undefined> = Context.Reference<string | undefined>(
  "@smthrs/kernel/HttpClient/ModelCall",
  { defaultValue: (): string | undefined => undefined }
)

/**
 * Runs `effect` with every outgoing request in it checked as a `model:call` on
 * `modelId` instead of as plain network access.
 *
 * @category references
 * @since 1.0.0-rc.0
 */
export const withModelCall = (modelId: string) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, ModelCall, modelId)

/**
 * Projects a permission failure into the error channel Effect's `HttpClient`
 * tag fixes.
 *
 * Nothing is lost: the reason is always a `TransportError` — the request did
 * not leave the host because the capability kernel refused, suspended, or
 * could not decide it — `description` carries the human rendering from
 * `Permission.formatError`, and `cause` carries the structured failure itself,
 * so {@link fromHttpClientError} hands the attended surface back the original
 * `capability`, `tier`, `requestId`, and `reason`.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const toHttpClientError = (options: {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly error: PermissionError
}): HttpClientError.HttpClientError =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request: options.request,
      description: formatError(options.error),
      cause: options.error
    })
  })

/**
 * Recovers the structured permission failure a {@link toHttpClientError}
 * projection carries, so an attended surface can still reply to the request
 * and an unattended report can still name the capability.
 *
 * Recovery validates data fields and the transport reason tag, not origin or
 * class operations. Establish producer or request identity separately across
 * a trust boundary.
 *
 * @category refinements
 * @since 1.0.0-rc.0
 */
export const fromHttpClientError = (
  error: HttpClientError.HttpClientError
): Option.Option<PermissionErrorPayload> =>
  error.reason._tag === "TransportError" && isPermissionError(error.reason.cause)
    ? Option.some(error.reason.cause)
    : Option.none()

/**
 * Constructs an unavailable HTTP client stub.
 *
 * Every request reports the missing host as a `TransportError` naming the
 * request, so an unconfigured capability answers rather than vanishing.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const makeNoop = (): EffectHttpClient.HttpClient =>
  EffectHttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          cause: new Error("HTTP is unavailable on this host")
        })
      })
    )
  )

/**
 * Provides an unavailable HTTP client stub.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerNoop = (): Layer.Layer<EffectHttpClient.HttpClient> =>
  Layer.succeed(EffectHttpClient.HttpClient)(makeNoop())

/**
 * Keeps HTTPS resources host-only so existing grants remain valid. Every
 * other scheme is explicit, which prevents an HTTPS grant from authorizing a
 * cleartext or otherwise different transport.
 */
const capabilityFor = (
  request: HttpClientRequest.HttpClientRequest,
  modelId: string | undefined
): Effect.Effect<Capability, PermissionError> => {
  const action = modelId === undefined
    ? request.method === "GET" || request.method === "HEAD" ? "net:get" : "net:post"
    : "model:call"
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return makeCapability(action, request.url).pipe(
      Effect.flatMap((capability) =>
        Effect.fail(
          new PermissionDenied({
            code: "permission_denied",
            capability,
            reason: "HTTP capability checks require an absolute, parseable URL"
          })
        )
      )
    )
  }
  const host = url.host.toLowerCase()
  const resource = url.protocol === "https:" ? host : `${url.protocol}//${host}`
  return makeCapability(action, modelId === undefined ? resource : `${resource}/${modelId}`)
}

interface PreflightAdmission {
  readonly store: GrantService
  readonly capability: Capability
  consumed: boolean
}

const Admission = Context.Reference<PreflightAdmission | undefined>("@smthrs/kernel/HttpClient/Admission", {
  defaultValue: () => undefined
})

/**
 * Authorizes a request before a caller performs network preflight work such as
 * DNS. The guarded transport consumes the same admission once, so a one-shot
 * grant is not spent twice. Admissions match both store identity and the exact
 * capability; redirects and retries require their own authorization.
 *
 * @category authorization
 * @since 1.0.0
 */
export const authorizePreflight = <A, E, R>(
  request: HttpClientRequest.HttpClientRequest,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | HttpClientError.HttpClientError, R | GrantStore> =>
  Effect.gen(function*() {
    const store = yield* GrantStore
    const capability = yield* Effect.withFiber((fiber) => capabilityFor(request, fiber.getRef(ModelCall))).pipe(
      Effect.tap((capability) => store.check(capability)),
      Effect.mapError((error) => toHttpClientError({ request, error }))
    )
    return yield* Effect.provideService(effect, Admission, { store, capability, consumed: false })
  })

/**
 * Forces `redirect: "manual"` on the fetch options a fetch-backed client reads
 * at execute time, keeping every other ambient field.
 */
const manualRedirects = (context: Context.Context<never>): Context.Context<never> =>
  Context.add(context, FetchHttpClient.RequestInit, {
    ...Context.getOrUndefined(context, FetchHttpClient.RequestInit),
    redirect: "manual"
  })

/**
 * Decorates the HTTP client in place with a `net:get`/`net:post`/`model:call`
 * capability check, then follows redirects *through* that check.
 *
 * The layer provides the tag it also requires: compose it over a host client
 * layer with `Layer.provide` and a consumer that never heard of the kernel is
 * guarded too. Because every hop re-enters the guarded `postprocess`, an
 * authorized first URL that redirects to an unauthorized one is denied at the
 * second hop instead of being fetched.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer: Layer.Layer<
  EffectHttpClient.HttpClient,
  never,
  EffectHttpClient.HttpClient | GrantStore
> = Layer.effect(
  EffectHttpClient.HttpClient,
  Effect.gen(function*() {
    const client = yield* EffectHttpClient.HttpClient
    const grants = yield* GrantStore
    const snapshotted = EffectHttpClient.mapRequestEffect(
      client,
      (request) =>
        Effect.try({
          try: () => snapshotRequest(request),
          catch: () => invalidRequest(request)
        })
    )
    const guarded = EffectHttpClient.transform(
      snapshotted,
      (execute, request) =>
        Effect.withFiber((fiber) =>
          capabilityFor(request, fiber.getRef(ModelCall)).pipe(
            Effect.flatMap((capability) => {
              const admission = fiber.getRef(Admission)
              if (
                admission !== undefined && !admission.consumed && admission.store === grants
                && admission.capability.action === capability.action &&
                admission.capability.resource === capability.resource
              ) {
                admission.consumed = true
                return Effect.void
              }
              return grants.check(capability)
            }),
            Effect.mapError((error: PermissionError) => toHttpClientError({ request, error })),
            Effect.andThen(Effect.updateContext(execute, manualRedirects))
          )
        )
    )
    const followed = EffectHttpClient.followRedirects(guarded)
    const result = EffectHttpClient.makeWith(
      (request) =>
        Effect.withFiber((fiber) =>
          // Read caller policy before the guard forces manual transport.
          Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect === "manual"
            ? guarded.postprocess(request)
            : followed.postprocess(request)
        ),
      guarded.preprocess
    )
    return supportsDestinationPinning(client) ? withDestinationPinning(result) : result
  })
)

/**
 * Address snapshot authorized for one web request. Host transports must reject
 * a different origin and use only these addresses for every connection attempt.
 * Ordinary model traffic leaves this reference unset.
 * @category references
 * @since 1.0.0
 */
export const Destination = Context.Reference<
  {
    readonly origin: string
    readonly addresses: ReadonlyArray<string>
  } | undefined
>("@smthrs/kernel/HttpClient/Destination", { defaultValue: () => undefined })

const pinnedClients = new WeakSet<EffectHttpClient.HttpClient>()

/**
 * Marks a trusted transport that enforces Destination on every connection.
 * The assertion belongs to this client instance, not ambient context. A
 * replacement client must establish its own transport guarantee.
 * @category constructors
 * @since 1.0.0
 */
export const withDestinationPinning = <A extends EffectHttpClient.HttpClient>(client: A): A => {
  pinnedClients.add(client)
  return client
}

/**
 * Whether this exact client implements the Destination transport contract.
 * @category predicates
 * @since 1.0.0
 */
export const supportsDestinationPinning = (client: EffectHttpClient.HttpClient): boolean => pinnedClients.has(client)
