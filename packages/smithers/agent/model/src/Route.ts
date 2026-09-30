/**
 * A resolved model route: an endpoint, a protocol, a framing, and the
 * credentials to authorize with. Preparing a route yields a credential-free
 * request that can enter a sealed step's key material, with the secret
 * applied only as the request leaves.
 *
 * @since 0.1.0
 */

import { Effect, Layer, Redacted, Result, Schema, Stream } from "effect"
import type * as SchemaIssue from "effect/SchemaIssue"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as AnthropicMessages from "./AnthropicMessages.ts"
import * as Auth from "./Auth.ts"
import * as CanonicalJson from "./CanonicalJson.ts"
import * as Endpoint from "./Endpoint.ts"
import * as Framing from "./Framing.ts"
import * as WireTrace from "./internal/WireTrace.ts"
import * as Model from "./Model.ts"
import { ModelError } from "./ModelError.ts"
import type { ModelEvent } from "./ModelEvent.ts"
import { type ModelRequest, ModelRequest as ModelRequestSchema } from "./ModelRequest.ts"
import * as OpenAIChatCompletions from "./OpenAIChatCompletions.ts"
import * as OpenAIResponses from "./OpenAIResponses.ts"
import type * as Protocol from "./Protocol.ts"
import * as RequestExecutor from "./RequestExecutor.ts"

/**
 * The credential-free representation used to construct a sealed model step.
 * This view, including the canonical body bytes, is what the engine digests
 * into the sealed-step key when it services `EngineLike.sealStep`
 * (`packages/smithers/agent/harness/src/EngineLike.ts`).
 * Credentials are signed onto a copy afterwards and never enter this value.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface PreparedRequest {
  readonly routeId: string
  readonly protocolId: string
  readonly method: "POST"
  readonly url: string
  readonly publicHeaders: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly bodyText: string
}

/**
 * The deployment-specific pieces which compose a protocol into a model route.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Config<Body, Frame, Event, State> {
  readonly id: string
  /** OpenTelemetry provider name; independent of route identity and wire protocol. */
  readonly providerName: string
  readonly protocol: Protocol.Protocol<Body, Frame, Event, State>
  readonly endpoint: Endpoint.Endpoint
  readonly auth: Auth.Auth
  readonly framing: Framing.Framing<Frame>
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * A configured, but not yet authenticated, protocol route.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Route<Body, Frame, Event, State> = Config<Body, Frame, Event, State>

const sensitiveHeader = (name: string): boolean => Auth.isCredentialName(name)

// Map keys are unique, so canonical header comparisons have only two possible orderings.
const compareCanonical = (left: string, right: string): number => left < right ? -1 : 1

const publicHeaders = (
  headers: Readonly<Record<string, string>>
): Result.Result<Record<string, string>, ModelError> => {
  const normalized = new Map<string, string>([["content-type", "application/json"]])
  for (const [name, value] of Object.entries(headers)) {
    if (sensitiveHeader(name)) {
      return Result.fail(
        new ModelError({
          code: "invalid_request",
          message: `Route header ${name} must be applied through Auth`
        })
      )
    }
    normalized.set(name.toLowerCase(), value)
  }
  return Result.succeed(Object.fromEntries([...normalized].sort(([left], [right]) => compareCanonical(left, right))))
}

// A preparation failure has to say WHERE without saying WHAT: a request member
// may hold a credential or user content, and a ModelError is serialized into
// journals and diagnostics. Both sources of a location are key paths already.
const issueSegments = (issue: SchemaIssue.Issue): ReadonlyArray<PropertyKey> => {
  const segments: Array<PropertyKey> = []
  let current: SchemaIssue.Issue | undefined = issue
  while (current !== undefined) {
    if (current._tag === "Pointer") {
      segments.push(...current.path)
      current = current.issue
    } else if (current._tag === "Filter" || current._tag === "Encoding") {
      current = current.issue
    } else if (current._tag === "Composite" || current._tag === "AnyOf") {
      // The first issue is the one a reader fixes first; the rest are usually
      // the same member reported against the other members of a union.
      current = current.issues[0]
    } else {
      current = undefined
    }
  }
  return segments
}

const formatSegments = (segments: ReadonlyArray<PropertyKey>): string | undefined =>
  segments.length === 0 ? undefined : segments.reduce<string>((text, segment) => {
    if (typeof segment === "number") return `${text}[${segment}]`
    return text === "" ? String(segment) : `${text}.${String(segment)}`
  }, "")

const schemaPath = (error: unknown): string | undefined => {
  const issue = (error as { readonly issue?: SchemaIssue.Issue } | undefined)?.issue
  return issue === undefined ? undefined : formatSegments(issueSegments(issue))
}

const withPath = (
  code: ModelError["code"],
  message: string,
  path: string | undefined
): ModelError => new ModelError({ code, message, ...(path === undefined ? {} : { path }) })

// `CanonicalJson` reports the offending member in its own message, and that
// message is the only place the path exists.
const canonicalPath = (error: unknown): string | undefined =>
  error instanceof Error ? /^Value at (.+) is not valid JSON$/.exec(error.message)?.[1] : undefined

const preparationError = (error: unknown): ModelError =>
  withPath(
    "invalid_request",
    "Model request could not be encoded as canonical JSON",
    canonicalPath(error)
  )

/**
 * Compiles a request exactly once into its credential-free sealed-step view.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const prepare = <Body, Frame, Event, State>(
  route: Route<Body, Frame, Event, State>,
  request: ModelRequest
): Effect.Effect<PreparedRequest, ModelError> => Effect.map(compile(route, request), (compiled) => compiled.prepared)

/**
 * The request every later step reads, and the sealed view built from it.
 *
 * Validating once and threading the result is what keeps a call self-consistent:
 * the caller owns the `ModelRequest` object and may mutate it while signing is
 * pending, and without a snapshot the body, the `model:call` capability check
 * and the protocol's initial state could each describe a different request.
 */
interface Compiled {
  readonly prepared: PreparedRequest
  readonly request: ModelRequest
}

const compile = <Body, Frame, Event, State>(
  route: Route<Body, Frame, Event, State>,
  request: ModelRequest
): Effect.Effect<Compiled, ModelError> =>
  Effect.fn("flows/model/Route.prepare")(function*() {
    const validatedRequest = yield* Schema.decodeUnknownEffect(ModelRequestSchema)(request).pipe(
      Effect.mapError((error) =>
        withPath("invalid_request", "Model request failed Schema validation", schemaPath(error))
      )
    )
    const native = route.protocol.supportsDeferred(validatedRequest.modelId)
    const candidate = yield* route.protocol.body.from(validatedRequest, { native })
    const body = yield* Schema.encodeUnknownEffect(route.protocol.body.schema)(candidate).pipe(
      Effect.mapError((error) =>
        withPath(
          "invalid_request",
          `${route.protocol.id} produced an invalid provider request body`,
          schemaPath(error)
        )
      )
    )
    const headers = yield* Effect.fromResult(
      publicHeaders({ ...route.headers, ...route.protocol.headers?.(validatedRequest) })
    )
    const bytes = yield* Effect.try({
      try: () => CanonicalJson.bytes(body),
      catch: preparationError
    })
    return {
      prepared: {
        routeId: route.id,
        protocolId: route.protocol.id,
        method: "POST" as const,
        url: Endpoint.render(route.endpoint),
        publicHeaders: headers,
        body: bytes,
        bodyText: new TextDecoder().decode(bytes)
      },
      request: validatedRequest
    }
  })()

/**
 * The latest affinity token per conversation, process-wide so every model a
 * seat builds for one run shares it. Bounded: the oldest conversation is
 * forgotten first, and a forgotten one only costs its next request the
 * routing hint.
 *
 * A slot is keyed by the route, the endpoint, a fingerprint of the signed
 * credential and the cache key, so two accounts in one process that share a
 * cache key never carry each other's token. A refreshed credential starts a
 * new slot, which costs one request the routing hint.
 */
const affinity = new Map<string, string>()
const affinityLimit = 1024

/** A fingerprint of what `Auth.sign` added to the public headers. */
const credentialFingerprint = (
  publicHeaders: Readonly<Record<string, string>>,
  signed: Readonly<Record<string, string>>
): string =>
  CanonicalJson.shortHash(
    Object.entries(signed)
      .filter(([name, value]) => publicHeaders[name] !== value)
      .map(([name, value]) => `${name.toLowerCase()}\u0000${value}`)
      .sort()
      .join("\u0000")
  )

const affinitySlot = (
  prepared: {
    readonly routeId: string
    readonly url: string
    readonly publicHeaders: Readonly<Record<string, string>>
  },
  request: ModelRequest,
  signed: Readonly<Record<string, string>>
): string | undefined =>
  request.cacheKey === undefined
    ? undefined
    : [prepared.routeId, prepared.url, credentialFingerprint(prepared.publicHeaders, signed), request.cacheKey]
      .join("\u0000")

const rememberAffinity = (slot: string, value: string): void => {
  affinity.delete(slot)
  affinity.set(slot, value)
  if (affinity.size > affinityLimit) affinity.delete(affinity.keys().next().value!)
}

const stream = <Body, Frame, Event, State>(
  route: Route<Body, Frame, Event, State>,
  executor: RequestExecutor.RequestExecutor,
  request: ModelRequest
): Stream.Stream<ModelEvent, Model.ModelFailure> =>
  Stream.scoped(
    Stream.unwrap(
      Effect.fn("flows/model/Route.stream")(function*() {
        const { prepared, request: snapshot } = yield* compile(route, request)
        const affinityHeader = route.protocol.affinityHeader
        let traced = false
        const attempt = Effect.gen(function*() {
          const signed = yield* route.auth.sign({ ...prepared.publicHeaders })
          const slot = affinityHeader === undefined ? undefined : affinitySlot(prepared, snapshot, signed)
          const token = slot === undefined ? undefined : affinity.get(slot)
          if (!traced) {
            traced = true
            WireTrace.record({ ...prepared, affinity: token !== undefined })
          }
          const signedHeaders = {
            ...signed,
            ...(token === undefined ? {} : { [affinityHeader!]: token })
          }
          const httpRequest = HttpClientRequest.post(prepared.url, { headers: signedHeaders }).pipe(
            HttpClientRequest.bodyUint8Array(prepared.body, "application/json")
          )
          const sanitize = yield* RequestExecutor.errorSanitizer(httpRequest)
          const response = yield* executor.execute(httpRequest, {
            modelId: snapshot.modelId,
            classifyError: route.protocol.classifyError
          })
          const returned = slot === undefined ? undefined : response.headers[affinityHeader!.toLowerCase()]
          if (returned !== undefined && returned !== "") rememberAffinity(slot!, returned)
          return { response, sanitize }
        }).pipe(Auth.withRedaction(route.auth))
        // An `authentication` failure is terminal on both retry ladders — a bad
        // key never repairs itself by waiting. A refresh-capable Auth is the
        // one case where recovery is possible: run its refresh and re-sign
        // exactly once, so an access token that expired mid-flight costs one
        // recovery, while a credential the refresh cannot repair still fails
        // typed on the second attempt.
        const refresh = route.auth.refresh
        const { response, sanitize } = yield* (refresh === undefined
          ? attempt
          : attempt.pipe(
            Effect.catchIf(
              (error): error is ModelError => error instanceof ModelError && error.code === "authentication",
              () => Effect.andThen(refresh, attempt)
            )
          ))
        const decodeEvent = Schema.decodeUnknownEffect(route.protocol.stream.event)
        const events = route.framing.frame(
          response.stream.pipe(
            // The code is the contract and the transport's own text is not:
            // `HttpClientError`'s message ends in the method and URL, which a
            // provider authorizing by query parameter would make a credential.
            // `transport` is what the retry ladder classifies on, and a body
            // that dies after the headers is on that ladder from here.
            Stream.mapError(() => new ModelError({ code: "transport", message: "Model response stream failed" }))
          )
        ).pipe(
          // effect rc.108's SSE decoder adds `SseError` (oversized events) to
          // the framing channel; a framing failure is a transport failure here.
          Stream.mapError((error) =>
            error._tag === "SseError"
              ? new ModelError({ code: "transport", message: "Model response stream failed" })
              : error
          ),
          Stream.mapEffect((frame) =>
            decodeEvent(frame).pipe(
              Effect.mapError((error) =>
                withPath(
                  "invalid_provider_output",
                  `${route.protocol.id} emitted an invalid stream event`,
                  schemaPath(error)
                )
              )
            )
          ),
          route.protocol.stream.terminal === undefined
            ? (framed) => framed
            : Stream.takeUntil(route.protocol.stream.terminal)
        )
        return events.pipe(
          Stream.mapAccumEffect(
            () => route.protocol.stream.initial(snapshot),
            route.protocol.stream.step,
            route.protocol.stream.onHalt === undefined
              ? undefined
              : { onHalt: route.protocol.stream.onHalt }
          ),
          // Keep the signed attempt's policy after the HTTP effect completes,
          // including when refresh replaced the original credential.
          Stream.mapError(sanitize)
        )
      })()
    )
  )

/**
 * Composes Protocol × Endpoint × Auth × Framing into a route value.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = <Body, Frame, Event, State>(
  config: Config<Body, Frame, Event, State>
): Route<Body, Frame, Event, State> => config

/**
 * Builds a `Model` implementation from a composed route.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const toModel = <Body, Frame, Event, State>(
  config: Config<Body, Frame, Event, State>
): Effect.Effect<Model.Model, never, RequestExecutor.RequestExecutor> =>
  Effect.gen(function*() {
    const executor = yield* RequestExecutor.RequestExecutor
    return Model.make({ providerName: config.providerName, stream: (request) => stream(config, executor, request) })
  })

/**
 * Provides a configured route as the `Model` service.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const layer = <Body, Frame, Event, State>(
  config: Config<Body, Frame, Event, State>
): Layer.Layer<Model.Model, never, RequestExecutor.RequestExecutor> => Layer.effect(Model.Model, toModel(config))

/**
 * Creates Anthropic's Messages deployment configuration.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const anthropic = (
  input: {
    readonly apiKey?: Auth.Redacted<string> | undefined
    /** The origin, `Endpoint.providerOrigins` by default; see `Endpoint.providerOrigin`. */
    readonly baseUrl?: string | undefined
  }
): Result.Result<
  Route<
    AnthropicMessages.Body,
    string,
    Parameters<typeof AnthropicMessages.protocol.stream.step>[1],
    ReturnType<typeof AnthropicMessages.protocol.stream.initial>
  >,
  ModelError
> =>
  Result.map(
    Endpoint.make({ url: input.baseUrl ?? Endpoint.providerOrigins.anthropic, path: "/v1/messages" }),
    (endpoint) =>
      make({
        id: "anthropic",
        providerName: "anthropic",
        protocol: AnthropicMessages.protocol,
        endpoint,
        auth: Auth.apiKeyHeader("x-api-key", input.apiKey ?? Redacted.make("")),
        framing: Framing.sse,
        headers: { "anthropic-version": "2023-06-01" }
      })
  )

/**
 * Creates OpenAI's Responses deployment configuration.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const openai = (
  input: {
    readonly apiKey: Auth.Redacted<string>
    /** The origin, `Endpoint.providerOrigins` by default; see `Endpoint.providerOrigin`. */
    readonly baseUrl?: string | undefined
  }
): Result.Result<
  Route<
    OpenAIResponses.Body,
    string,
    Parameters<typeof OpenAIResponses.protocol.stream.step>[1],
    ReturnType<typeof OpenAIResponses.protocol.stream.initial>
  >,
  ModelError
> =>
  Result.map(
    Endpoint.make({ url: input.baseUrl ?? Endpoint.providerOrigins.openai, path: "/v1/responses" }),
    (endpoint) =>
      make({
        id: "openai",
        providerName: "openai",
        protocol: OpenAIResponses.protocol,
        endpoint,
        auth: Auth.bearer(input.apiKey),
        framing: Framing.sse
      })
  )

/**
 * Creates a route for a provider that serves the OpenAI **Responses** API
 * without OpenAI's native deferred-tool extensions.
 *
 * `baseUrl` is the provider origin and this constructor appends
 * `/v1/responses` itself, so one origin can only ever produce one URL:
 * `https://openrouter.ai/api` becomes
 * `https://openrouter.ai/api/v1/responses`. A trailing slash is accepted.
 *
 * Responses and Chat Completions are different wire shapes. `api.openai.com`
 * and OpenRouter's `/v1/responses` serve Responses; Ollama, Gemini's
 * compatibility layer, Cerebras and most other self-hosted or third-party
 * "OpenAI-compatible" servers serve Chat Completions and need
 * {@link openaiChatCompatible} instead.
 *
 * @since 0.1.0
 * @category constructors
 */
export const openaiResponsesCompatible = (
  input: {
    readonly id: string
    readonly providerName: string
    readonly baseUrl: string
    readonly apiKey: Auth.Redacted<string>
    readonly headers?: Readonly<Record<string, string>>
  }
): Result.Result<
  Route<
    OpenAIResponses.Body,
    string,
    Parameters<typeof OpenAIResponses.protocol.stream.step>[1],
    ReturnType<typeof OpenAIResponses.protocol.stream.initial>
  >,
  ModelError
> =>
  Result.map(Endpoint.make({ url: input.baseUrl, path: "/v1/responses" }), (endpoint) =>
    make({
      id: input.id,
      providerName: input.providerName,
      protocol: { ...OpenAIResponses.protocol, supportsDeferred: () => false },
      endpoint,
      auth: Auth.bearer(input.apiKey),
      framing: Framing.sse,
      ...(input.headers === undefined ? {} : { headers: input.headers })
    }))

/**
 * Creates a route for a provider that serves the OpenAI **Chat Completions**
 * API: Ollama, Gemini's OpenAI-compatibility layer, Cerebras, and most other
 * self-hosted or third-party "OpenAI-compatible" servers.
 *
 * `baseUrl` is the provider origin and `path` defaults to
 * `/v1/chat/completions`. Providers with a different compatible endpoint,
 * such as Gemini, pass their exact path explicitly.
 *
 * `apiKey` may be a non-empty placeholder for a server that does not check it
 * (Ollama ignores its `Authorization` header entirely); {@link Auth.bearer}
 * only rejects an empty credential. `structuredOutput` behaves exactly as it
 * does on this route.
 *
 * @since 0.1.0
 * @category constructors
 */
export const openaiChatCompatible = (
  input: {
    readonly id: string
    readonly providerName: string
    readonly baseUrl: string
    readonly path?: string | undefined
    readonly apiKey: Auth.Redacted<string>
    readonly structuredOutput?: OpenAIChatCompletions.StructuredOutput | undefined
  }
): Result.Result<
  Route<
    OpenAIChatCompletions.Body,
    string,
    Parameters<typeof OpenAIChatCompletions.protocol.stream.step>[1],
    ReturnType<typeof OpenAIChatCompletions.protocol.stream.initial>
  >,
  ModelError
> =>
  Result.map(Endpoint.make({ url: input.baseUrl, path: input.path ?? "/v1/chat/completions" }), (endpoint) =>
    make({
      id: input.id,
      providerName: input.providerName,
      protocol: OpenAIChatCompletions.protocolWith(
        input.structuredOutput === undefined ? {} : { structuredOutput: input.structuredOutput }
      ),
      endpoint,
      auth: Auth.bearer(input.apiKey),
      framing: Framing.sse
    }))
