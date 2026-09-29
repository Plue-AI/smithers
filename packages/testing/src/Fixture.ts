/**
 * Recorded-model fixture values and their portable decoder.
 *
 * @since 0.0.0
 */

import type { Effect } from "effect"
import { Schema } from "effect"
import { compare, snapshot } from "./internal/Structural.ts"
import type { ModelErrorLike, ModelEventLike, ModelRequestLike, RecordedRequestLike } from "./ModelLike.ts"
import { FixtureEncodingError } from "./TestingError.ts"

/**
 * One recorded model invocation.
 *
 * `model` is the model the exchange was recorded against, and it is the same
 * value as `request.modelId`: every recorder in this package writes it from
 * the projected request. It is stored separately because `RecordedModel`
 * matches a call by request SHAPE, with `modelId` erased, so `model` is what
 * answers "was this recorded against the model now asking?" once the shape has
 * already matched. {@link canonicalRequestDigest} itself erases nothing:
 * `CachedModel` keys on the whole canonical request, `modelId` included. The
 * two agreeing is a decoding rule, not a convention: see {@link Fixture}.
 *
 * @category models
 * @since 0.0.0
 */
export interface RecordedCall {
  readonly request: RecordedRequestLike
  readonly model: string
  readonly events: ReadonlyArray<ModelEventLike>
  readonly failure?: ModelErrorLike | undefined
}

/**
 * A portable recording of model calls.
 *
 * This interface and the {@link Fixture} schema below share one name and are
 * one contract. `decode` is typed by this interface rather than by
 * `typeof Fixture.Type`, so nothing in the compiler stops the two from
 * drifting as long as they stay structurally assignable in the one direction
 * a signature happens to use. `test/FixtureSchema.test.ts` holds them
 * together: it asserts the decoded value is a `Fixture`, and it compares the
 * key set of every level of both shapes, so a field added to one and not the
 * other fails `tsc`.
 *
 * The schema is narrower than the interface in exactly one place, deliberately:
 * a tool's `parameters` is `Record<string, unknown>` here, mirroring
 * `@smthrs/model`'s tool shape, and `Record<string, Json>` in the schema,
 * because a fixture is written to a file and read back.
 *
 * @category models
 * @since 0.0.0
 */
export interface Fixture {
  readonly calls: ReadonlyArray<RecordedCall>
}

// Every optional field below is `Schema.optional`, not `Schema.optionalKey`.
// The structural shapes in `ModelLike` write their optional fields as
// `?: T | undefined`, because `@smthrs/model` does, and under
// `exactOptionalPropertyTypes` an `optionalKey` field types as `?: T`, which
// that value is not assignable to. The two shapes are one contract, so they
// state optionality the same way.
const eventSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text-start"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text-delta"), id: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text-end"), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("thinking-start"),
    id: Schema.String,
    signature: Schema.optional(Schema.String)
  }),
  Schema.Struct({ type: Schema.Literal("thinking-delta"), id: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking-end"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tool-call-start"), id: Schema.String, name: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tool-call-delta"), id: Schema.String, arguments: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool-call-end"),
    id: Schema.String,
    arguments: Schema.optional(Schema.String)
  }),
  Schema.Struct({
    type: Schema.Literal("tool-result"),
    id: Schema.String,
    output: Schema.String,
    isError: Schema.optional(Schema.Boolean)
  }),
  Schema.Struct({
    type: Schema.Literal("usage"),
    inputTokens: Schema.optional(Schema.Number),
    outputTokens: Schema.optional(Schema.Number),
    reasoningTokens: Schema.optional(Schema.Number),
    cachedInputTokens: Schema.optional(Schema.Number),
    cacheWriteTokens: Schema.optional(Schema.Number),
    totalTokens: Schema.optional(Schema.Number)
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: Schema.Int,
    code: Schema.String,
    delayMillis: Schema.Number
  }),
  Schema.Struct({
    type: Schema.Literal("settle"),
    stopReason: Schema.Literals(["stop", "length", "tool-calls", "content-filter", "error", "aborted", "unknown"]),
    responseId: Schema.optional(Schema.String),
    sessionId: Schema.optional(Schema.String),
    itemIds: Schema.optional(Schema.Array(Schema.String))
  })
])

const stopReasonSchema = Schema.Literals([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "aborted",
  "unknown"
])

const textPartSchema = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })

// The message, tool, and params shapes mirror `/model/ModelRequest`
// (read-only; see `ModelLike` for the structural contract), so an invalid
// fixture fails decoding instead of passing through as opaque JSON.
const messageSchema = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Array(textPartSchema)
  }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Array(Schema.Union([
      textPartSchema,
      Schema.Struct({
        type: Schema.Literal("thinking"),
        text: Schema.String,
        signature: Schema.optional(Schema.String)
      }),
      Schema.Struct({
        type: Schema.Literal("tool-call"),
        id: Schema.String,
        name: Schema.String,
        arguments: Schema.String
      })
    ])),
    stopReason: stopReasonSchema,
    responseId: Schema.optional(Schema.String),
    itemIds: Schema.optional(Schema.Array(Schema.String))
  }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    content: Schema.Array(Schema.Struct({
      type: Schema.Literal("tool-result"),
      toolCallId: Schema.String,
      content: Schema.String,
      addedToolNames: Schema.Array(Schema.String)
    }))
  })
])

const toolSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Record(Schema.String, Schema.Json),
  deferred: Schema.optional(Schema.Boolean),
  loader: Schema.optional(Schema.Boolean)
})

const paramsSchema = Schema.Struct({
  maxTokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  topP: Schema.optional(Schema.Number),
  topK: Schema.optional(Schema.Number),
  stopSequences: Schema.optional(Schema.Array(Schema.String)),
  thinkingBudget: Schema.optional(Schema.Number),
  reasoningEffort: Schema.optional(Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"]))
})

const requestSchema = Schema.Struct({
  modelId: Schema.String,
  system: Schema.Array(textPartSchema),
  messages: Schema.Array(messageSchema),
  tools: Schema.Array(toolSchema),
  params: paramsSchema,
  toolChoice: Schema.optional(Schema.Literal("none")),
  serverTools: Schema.optional(Schema.Array(Schema.Struct({
    type: Schema.Literal("web_search"),
    allowedDomains: Schema.optionalKey(Schema.Array(Schema.String))
  })))
})

// The codes are exactly `/model/ModelError`'s `ModelErrorCode`. Permission and
// grant-store codes are `/capability/Permission`'s, and the model package never
// emits one as a provider failure.
const failureSchema = Schema.Struct({
  code: Schema.Literals([
    "invalid_request",
    "context_overflow",
    "no_route",
    "authentication",
    "rate_limited",
    "quota_exceeded",
    "out_of_credit",
    "content_policy",
    "provider_internal",
    "transport",
    "call_timeout",
    "invalid_provider_output",
    "unknown"
  ]),
  message: Schema.String,
  // A key path only, never a value: see `ModelErrorLike`.
  path: Schema.optional(Schema.String),
  retryAfterMillis: Schema.optional(Schema.Number),
  resetAtEpochMillis: Schema.optional(Schema.Number),
  resetSource: Schema.optional(Schema.String),
  quotaScope: Schema.optional(Schema.Literals(["model", "account"])),
  providerCode: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  httpStatus: Schema.optional(Schema.Number)
})

const recordedCallSchema = Schema.Struct({
  request: requestSchema,
  model: Schema.String,
  events: Schema.Array(eventSchema),
  failure: Schema.optional(failureSchema)
}).check(
  // `model` and `request.modelId` name the same thing, and a hand-written
  // fixture where they disagree replays two different ways for no stated
  // reason. `RecordedModel` matches by request SHAPE, with `modelId` erased,
  // and only then compares `model`: a request carrying `model` matches this
  // call's shape and replays a conversation recorded for another model, while
  // a request carrying `request.modelId` is rejected as a harness mismatch
  // against a model it was in fact recorded with. `CachedModel` keys on the
  // whole canonical request, `modelId` included, so the same fixture answers a
  // third way there.
  Schema.makeFilter(
    (call) =>
      call.model === call.request.modelId
        ? undefined
        : `a recorded call's model must be the model its request was made with; ` +
          `model is ${JSON.stringify(call.model)} and request.modelId is ${JSON.stringify(call.request.modelId)}`,
    { title: "recordedAgainstOneModel" }
  )
)

/**
 * The JSON schema for a recorded-model fixture. The nested request, message,
 * tool, and params shapes mirror `/model/ModelRequest` structurally (the
 * provider-neutral types are owned by `ModelLike`), so an invalid fixture
 * fails decoding. A call whose `model` disagrees with its own
 * `request.modelId` fails decoding too: see {@link RecordedCall}.
 *
 * This schema and the {@link Fixture} interface above are one contract, held
 * together by `test/FixtureSchema.test.ts`.
 *
 * @category schemas
 * @since 0.0.0
 */
export const Fixture = Schema.Struct({ calls: Schema.Array(recordedCallSchema) })

/**
 * Decodes a checked-in recorded-model fixture.
 *
 * @category decoders
 * @since 0.0.0
 */
export const decode = (input: unknown): Effect.Effect<Fixture, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(Fixture)(input)

const invalid = (path: string, reason: FixtureEncodingError["reason"]): never => {
  throw new FixtureEncodingError({ path, reason })
}

/**
 * How deep a recorded value may nest.
 *
 * A cycle is already detected by identity, but a genuinely deep value — a
 * thousand-level `parameters` object — still overflowed the stack, which is a
 * host error escaping a module whose failures are a closed code union.
 */
const maximumDepth = 128

/**
 * The canonical JSON encoding of a request, and its replay identity.
 *
 * Re-derived locally from `/model`'s `CanonicalJson.stringify` algorithm:
 * object keys sort recursively, array order is retained, and non-JSON values
 * are rejected with a typed {@link FixtureEncodingError} naming the offending
 * path.
 *
 * It returns the canonical encoding rather than a fixed-length hash, and the
 * name is the one historical wart in this module. A fixture cache selects the
 * recorded call to replay by this value, so a hash collision would replay
 * another conversation's response as this one's; the package owns no
 * synchronous cryptographic hash, and a non-cryptographic one buys shorter
 * keys at the cost of a wrong answer nothing would detect. The cost that made
 * the length matter — re-encoding every recorded call on every lookup — is
 * paid once per fixture instead: see {@link index}.
 *
 * @category encoding
 * @since 0.0.0
 */
export const canonicalRequestDigest = (request: ModelRequestLike): string =>
  JSON.stringify(canonicalize(recordedRequest(request)))

/**
 * A digest-keyed index over a fixture's recorded calls, computed once.
 *
 * Both model doubles used to call {@link canonicalRequestDigest} for the
 * incoming request AND for every call already in the fixture, on every model
 * invocation: O(n) full re-encodings of complete conversations per call, and
 * O(n squared) per run, with every intermediate string retained long enough to
 * compare. The index is memoized on the fixture object, so a hundred-turn
 * agent fixture encodes its calls once.
 *
 * The memo is keyed by object identity. `FixtureStore` replaces the whole
 * fixture on every append rather than mutating it, so a recorded call is
 * visible to the next lookup; a caller that instead mutates a fixture's `calls`
 * in place would read a stale index. That replacement is also why the index
 * alone was not enough while a run was still recording: every append made a
 * fixture this memo had never seen, and the rebuild re-encoded every call
 * already recorded. {@link recordedDigest} carries those encodings across the
 * append.
 *
 * @category encoding
 * @since 0.0.0
 */
export const index = (fixture: Fixture): ReadonlyMap<string, RecordedCall> => {
  const memoized = indexes.get(fixture)
  if (memoized !== undefined) return memoized
  const built = new Map<string, RecordedCall>()
  for (const call of fixture.calls) {
    const digest = recordedDigest(call.request)
    // First writer wins, matching the `find`-based lookup this replaces.
    if (!built.has(digest)) built.set(digest, call)
  }
  indexes.set(fixture, built)
  return built
}

const indexes = new WeakMap<Fixture, ReadonlyMap<string, RecordedCall>>()

/**
 * The canonical encoding of an already-recorded request, encoded once.
 *
 * Memoized on the request rather than on the fixture holding it, because the
 * fixture is not stable while a run records: `FixtureStore` publishes a new
 * fixture per append, so {@link index} missed on every recorded call and paid
 * to re-encode every earlier conversation again. That made recording a
 * hundred-turn agent through `CachedModel` cost the whole run's transcript
 * once per turn.
 *
 * A request is memoized only when it is frozen, which is what a store's own
 * copy of a recorded call is and what an arbitrary caller's fixture is not:
 * nothing stops a caller mutating a fixture it still owns between two lookups,
 * and a memo over that value would answer with an encoding of the request as
 * it used to be.
 */
const recordedDigest = (request: ModelRequestLike): string => {
  const memoized = digests.get(request)
  if (memoized !== undefined) return memoized
  const digest = canonicalRequestDigest(request)
  if (Object.isFrozen(request)) digests.set(request, digest)
  return digest
}

const digests = new WeakMap<ModelRequestLike, string>()

const optional = <K extends string, A>(key: K, value: A | undefined): { readonly [P in K]?: A } =>
  value === undefined ? {} : { [key]: value } as { readonly [P in K]?: A }

/**
 * Projects a request onto the plain JSON data a fixture stores.
 *
 * The production `ModelRequest` is a `Schema.Class` whose messages, tools, and
 * params are class instances. A recorder that stored one verbatim would write a
 * fixture whose shape depends on the class, and {@link canonicalRequestDigest}
 * rejects any value that is not a plain object. This copy keeps the recorded
 * request, the decoded fixture, and the digest input the same value. The
 * provider cache hints are not copied: they never reach the model, and
 * `cacheKey` is keyed to the run, so storing either would make a fixture miss
 * on the next run of the same conversation.
 *
 * @category encoding
 * @since 0.0.0
 */
export const recordedRequest = (request: ModelRequestLike): RecordedRequestLike => ({
  modelId: request.modelId,
  system: request.system.map((part) => ({ type: part.type, text: part.text })),
  messages: request.messages.map((message) => {
    switch (message.role) {
      case "user":
        return {
          role: message.role,
          content: message.content.map((part) => ({ type: part.type, text: part.text }))
        }
      case "assistant":
        return {
          role: message.role,
          content: message.content.map((part) => {
            switch (part.type) {
              case "text":
                return { type: part.type, text: part.text }
              case "thinking":
                return { type: part.type, text: part.text, ...optional("signature", part.signature) }
              case "tool-call":
                return {
                  type: part.type,
                  id: part.id,
                  name: part.name,
                  arguments: part.arguments
                }
            }
          }),
          stopReason: message.stopReason,
          ...optional("responseId", message.responseId),
          ...optional("itemIds", message.itemIds === undefined ? undefined : [...message.itemIds])
        }
      case "tool":
        return {
          role: message.role,
          content: message.content.map((part) => ({
            type: part.type,
            toolCallId: part.toolCallId,
            content: part.content,
            addedToolNames: [...part.addedToolNames]
          }))
        }
    }
  }),
  tools: request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // Deep-copied, not aliased. Passing the caller's object through meant a
    // harness that reused one tool array across turns and rewrote its schema
    // retroactively rewrote already-recorded entries on the next flush.
    parameters: snapshot(tool.parameters),
    ...optional("deferred", tool.deferred),
    ...optional("loader", tool.loader)
  })),
  params: {
    ...optional("maxTokens", request.params.maxTokens),
    ...optional("temperature", request.params.temperature),
    ...optional("topP", request.params.topP),
    ...optional("topK", request.params.topK),
    ...optional(
      "stopSequences",
      request.params.stopSequences === undefined ? undefined : [...request.params.stopSequences]
    ),
    ...optional("thinkingBudget", request.params.thinkingBudget),
    ...optional("reasoningEffort", request.params.reasoningEffort)
  },
  ...optional("toolChoice", request.toolChoice),
  ...optional(
    "serverTools",
    request.serverTools?.map((tool) => ({
      type: tool.type,
      ...(tool.allowedDomains === undefined ? {} : { allowedDomains: [...tool.allowedDomains] })
    }))
  )
})

const canonicalize = (value: unknown, path = "$", ancestors = new Set<object>(), depth = 0): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : invalid(path, "non-finite-number")
  if (depth >= maximumDepth) return invalid(path, "too-deep")
  if (typeof value !== "object" || value === null) return invalid(path, "unsupported-type")
  if (ancestors.has(value)) return invalid(path, "cycle")
  ancestors.add(value)
  try {
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (array && prototype !== Array.prototype) return invalid(path, "non-plain-object")
    if (!array && prototype !== Object.prototype && prototype !== null) return invalid(path, "non-plain-object")
    if (Object.getOwnPropertySymbols(value).length > 0) return invalid(path, "symbol-key")
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const field = (key: string, memberPath: string): unknown => {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !("value" in descriptor)) return invalid(memberPath, "unsupported-type")
      return canonicalize(descriptor.value, memberPath, ancestors, depth + 1)
    }
    if (array) {
      // JSON.stringify turns holes into null and drops every non-index member.
      // Reject both before encoding so the fixture key describes the same array
      // shape accepted by the model boundary.
      for (let index = 0; index < descriptors.length!.value; index++) {
        if (!Object.hasOwn(value, index)) return invalid(`${path}[${index}]`, "unsupported-type")
      }
      if (Object.getOwnPropertyNames(value).length !== descriptors.length!.value + 1) {
        return invalid(path, "unsupported-type")
      }
      const result: Array<unknown> = []
      for (let index = 0; index < descriptors.length!.value; index++) {
        result.push(field(String(index), `${path}[${index}]`))
      }
      return result
    }
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(descriptors).sort(compare)) {
      if (!descriptors[key]!.enumerable) continue
      Object.defineProperty(result, key, {
        value: field(key, `${path}.${key}`),
        enumerable: true,
        writable: true,
        configurable: true
      })
    }
    return result
  } catch (error) {
    if (error instanceof FixtureEncodingError) throw error
    return invalid(path, "unsupported-type")
  } finally {
    ancestors.delete(value)
  }
}
