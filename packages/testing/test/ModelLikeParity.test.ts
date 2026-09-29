/**
 * The structural copies in `ModelLike` are pinned to the production contracts
 * they mirror.
 *
 * The module used to justify the copy by claiming this package does not depend
 * on `@smthrs/model`. It does, and `CachedModel` and `RecordingModel` import it
 * directly, so the record side and the replay side could drift apart with
 * nothing holding them together.
 *
 * A single production-to-local assignment is not that guard. Structural
 * assignability accepts extra properties, so a request field or an event field
 * added upstream stays assignable to the copy that never grew it, and
 * `FixtureSchema.test.ts` compares the local schema to the local interface, so
 * it passes too when both copies omit the same new field. The projection in
 * `recordedRequest` enumerates properties one by one, so the field would then
 * be dropped from every fixture written, silently.
 *
 * What follows is the complete comparison: the key set of every level of the
 * production request, every member of every union it contains, every member of
 * the event union, and the error's schema fields. Three differences are
 * deliberate and are exempted by name, once each: `Schema.Class` machinery on
 * `ModelError`, the optional `_tag` a fixture does not store, and the JSON
 * narrowing on a tool's `parameters`. A round-trip vector then carries every
 * optional field through `recordedRequest`, so a field the copies do have but
 * the projection forgets fails here too. The one field set the projection
 * drops on purpose, `ProviderCacheHint`, is dropped by name and asserted below.
 */
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { describe, expect, it } from "vitest"
import { canonicalRequestDigest, recordedRequest } from "../src/Fixture.ts"
import {
  type ModelErrorLike,
  modelErrorTag,
  type ModelEventLike,
  type ModelRequestLike,
  type ProviderCacheHint
} from "../src/ModelLike.ts"

/** Mutual assignability, which is what makes an added field visible. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** One member of a discriminated union, selected by its tag. */
type Member<U, K extends PropertyKey, V> = Extract<U, { readonly [P in K]: V }>

/** Both key sets, at one level of both shapes. */
type Keys<A, B> = Exact<keyof A, keyof B>

/**
 * Every optional field present and defined.
 *
 * The round-trip vectors below are typed by this, so a field added to
 * `ModelRequestLike` cannot be carried by a vector that quietly omits it: the
 * vector stops compiling until it is populated, and the projection comparison
 * then has something to notice.
 */
type Complete<T> = { readonly [K in keyof T]-?: Exclude<T[K], undefined> }

// ---------------------------------------------------------------------------
// The request, level by level.
// ---------------------------------------------------------------------------

type ProductionRequest = ModelRequest.ModelRequest
type ProductionMessage = ProductionRequest["messages"][number]
type LocalMessage = ModelRequestLike["messages"][number]

const _requestKeys: Keys<ProductionRequest, ModelRequestLike> = true
const _systemKeys: Keys<ProductionRequest["system"][number], ModelRequestLike["system"][number]> = true
const _toolChoice: Exact<ProductionRequest["toolChoice"], ModelRequestLike["toolChoice"]> = true
const _serverToolKeys: Keys<
  NonNullable<ProductionRequest["serverTools"]>[number],
  NonNullable<ModelRequestLike["serverTools"]>[number]
> = true
const _paramsKeys: Keys<ProductionRequest["params"], ModelRequestLike["params"]> = true
const _reasoningEfforts: Exact<
  NonNullable<ProductionRequest["params"]["reasoningEffort"]>,
  NonNullable<ModelRequestLike["params"]["reasoningEffort"]>
> = true
const _toolKeys: Keys<ProductionRequest["tools"][number], ModelRequestLike["tools"][number]> = true

// Exemption 1 of 3: a tool's `parameters` is `JsonObject` upstream and
// `Record<string, unknown>` here, because a subject that implements `ModelLike`
// holds a schema it has not proved is JSON. The widening is one-directional on
// purpose, so it is asserted as an assignment rather than as `Exact`. The
// fixture schema narrows it back to JSON; `FixtureSchema.test.ts` proves that.
const _toolParameters: ModelRequestLike["tools"][number]["parameters"] =
  {} as ProductionRequest["tools"][number]["parameters"]

// The union membership before the members' fields: a role present upstream and
// not here is a request the copy cannot describe at all.
const _messageRoles: Exact<ProductionMessage["role"], LocalMessage["role"]> = true

type ProductionUser = Member<ProductionMessage, "role", "user">
type LocalUser = Member<LocalMessage, "role", "user">
const _userKeys: Keys<ProductionUser, LocalUser> = true
const _userPartKeys: Keys<ProductionUser["content"][number], LocalUser["content"][number]> = true

type ProductionAssistant = Member<ProductionMessage, "role", "assistant">
type LocalAssistant = Member<LocalMessage, "role", "assistant">
const _assistantKeys: Keys<ProductionAssistant, LocalAssistant> = true
const _stopReasons: Exact<ProductionAssistant["stopReason"], LocalAssistant["stopReason"]> = true

type ProductionPart = ProductionAssistant["content"][number]
type LocalPart = LocalAssistant["content"][number]
const _partTypes: Exact<ProductionPart["type"], LocalPart["type"]> = true
const _textPartKeys: Keys<Member<ProductionPart, "type", "text">, Member<LocalPart, "type", "text">> = true
const _thinkingPartKeys: Keys<Member<ProductionPart, "type", "thinking">, Member<LocalPart, "type", "thinking">> = true
const _toolCallPartKeys: Keys<Member<ProductionPart, "type", "tool-call">, Member<LocalPart, "type", "tool-call">> =
  true

type ProductionTool = Member<ProductionMessage, "role", "tool">
type LocalTool = Member<LocalMessage, "role", "tool">
const _toolMessageKeys: Keys<ProductionTool, LocalTool> = true
const _toolResultKeys: Keys<ProductionTool["content"][number], LocalTool["content"][number]> = true

// ---------------------------------------------------------------------------
// The event union, member by member.
// ---------------------------------------------------------------------------

type ProductionEvent = ModelEvent.ModelEvent
const _eventTypes: Exact<ProductionEvent["type"], ModelEventLike["type"]> = true

type EventKeys<T extends ModelEventLike["type"]> = Keys<
  Member<ProductionEvent, "type", T>,
  Member<ModelEventLike, "type", T>
>
const _textStart: EventKeys<"text-start"> = true
const _textDelta: EventKeys<"text-delta"> = true
const _textEnd: EventKeys<"text-end"> = true
const _thinkingStart: EventKeys<"thinking-start"> = true
const _thinkingDelta: EventKeys<"thinking-delta"> = true
const _thinkingEnd: EventKeys<"thinking-end"> = true
const _toolCallStart: EventKeys<"tool-call-start"> = true
const _toolCallDelta: EventKeys<"tool-call-delta"> = true
const _toolCallEnd: EventKeys<"tool-call-end"> = true
const _toolResult: EventKeys<"tool-result"> = true
const _usage: EventKeys<"usage"> = true
const _retry: EventKeys<"retry"> = true
const _settle: EventKeys<"settle"> = true
const _settleStopReasons: Exact<
  Member<ProductionEvent, "type", "settle">["stopReason"],
  Member<ModelEventLike, "type", "settle">["stopReason"]
> = true

// ---------------------------------------------------------------------------
// The error.
// ---------------------------------------------------------------------------

// Exemption 2 of 3: `ModelError` is a `Schema.TaggedError`, so `keyof` its
// instance carries `Error` and `Effect` machinery — `stack`, `pipe`, the
// `retryable` getter, `~effect/*` brands and symbol keys. The schema's own
// field set is the shape a fixture stores, so that is what is compared, which
// states the exemption once instead of as a list of member names that would
// itself go stale.
type ProductionErrorField = keyof typeof ModelError["fields"]

// Exemption 3 of 3: a fixture stores a refusal's fields and not its `_tag`;
// `RecordedModel` stamps the tag back on so a consumer that classifies a
// provider refusal still recognizes it. Everything else has to match.
const _errorKeys: Exact<Exclude<ProductionErrorField, "_tag">, Exclude<keyof ModelErrorLike, "_tag">> = true
const _errorCodes: Exact<ModelError["code"], ModelErrorLike["code"]> = true
const _errorTag: Exact<ModelError["_tag"], NonNullable<ModelErrorLike["_tag"]>> = true

// ---------------------------------------------------------------------------
// The guard rejecting a deliberately extended shape, so none of the above is
// vacuously true.
// ---------------------------------------------------------------------------

const _rejectsAnAddedRequestField: Keys<ModelRequestLike & { readonly promptCacheKey: string }, ProductionRequest> =
  false
const _rejectsAnAddedParamsField: Keys<
  ModelRequestLike["params"] & { readonly seed: number },
  ProductionRequest["params"]
> = false
const _rejectsAnAddedEventField: Keys<
  Member<ModelEventLike, "type", "settle"> & { readonly modelVersion: string },
  Member<ProductionEvent, "type", "settle">
> = false
const _rejectsAnAddedErrorField: Exact<
  Exclude<ProductionErrorField, "_tag">,
  Exclude<keyof ModelErrorLike, "_tag"> | "providerRegion"
> = false

// ---------------------------------------------------------------------------
// Round-trip vectors: every optional field populated, so the projection has to
// carry each one.
// ---------------------------------------------------------------------------

const completeParams: Complete<ModelRequestLike["params"]> = {
  maxTokens: 1024,
  temperature: 0.2,
  topP: 0.9,
  topK: 40,
  stopSequences: ["\n\nHuman:"],
  thinkingBudget: 2048,
  reasoningEffort: "high"
}

// Typed by the production tool, whose `parameters` is the narrow JSON shape the
// constructor accepts, then pinned back against the copy so neither side can
// grow a field alone.
const completeTool: Complete<ProductionRequest["tools"][number]> = {
  name: "review",
  description: "Review a diff.",
  parameters: { type: "object", properties: { diff: { type: "string" } } },
  deferred: true,
  loader: false
}
const _completeToolMirrorsTheCopy: Complete<ModelRequestLike["tools"][number]> = completeTool

const completeThinkingPart: Complete<Member<LocalPart, "type", "thinking">> = {
  type: "thinking",
  text: "The diff only touches tests.",
  signature: "sig_1"
}

const completeAssistantOptions: Complete<Omit<LocalAssistant, "role" | "content">> = {
  stopReason: "tool-calls",
  responseId: "resp_1",
  itemIds: ["item_1"]
}

const completeToolResult: Complete<LocalTool["content"][number]> = {
  type: "tool-result",
  toolCallId: "call_1",
  content: "3 files reviewed.",
  addedToolNames: ["apply"]
}

/**
 * The provider cache hints, populated. `ModelRequestLike` carries them, and the
 * projection drops exactly these, so a fixture and its replay digest do not
 * depend on the run that recorded them.
 */
const completeCacheHints: Complete<Pick<ModelRequestLike, ProviderCacheHint>> = {
  cacheKey: "run_1",
  cacheBoundary: 3
}

const completeProductionRequest = ModelRequest.ModelRequest.make({
  modelId: "openai:gpt-5-mini",
  system: [ModelRequest.SystemPart.make({ text: "You are a concise reviewer." })],
  messages: [
    ModelRequest.Message.user("Summarize PR 4821."),
    ModelRequest.Message.assistant([
      ModelRequest.TextPart.make({ text: "Reading the diff." }),
      ModelRequest.ThinkingPart.make(completeThinkingPart),
      ModelRequest.ToolCallPart.make({ id: "call_1", name: "review", arguments: "{\"diff\":\"...\"}" })
    ], completeAssistantOptions),
    ModelRequest.Message.tool(ModelRequest.ToolResultPart.make(completeToolResult))
  ],
  tools: [ModelRequest.ToolDefinition.make(completeTool)],
  params: ModelRequest.GenerationParams.make(completeParams),
  toolChoice: "none",
  ...completeCacheHints
})

/**
 * The own key set and values of a value, with class prototypes erased.
 *
 * A production request is a tree of `Schema.Class` instances and its projection
 * is plain data, so they are compared as data. Key order is normalized because
 * the projection writes optional fields last.
 */
const plain = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(plain)
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, plain(record[key])]))
}

/** The fully populated request as data, less the fields a fixture never stores. */
const { cacheBoundary: _cacheBoundary, cacheKey: _cacheKey, ...modelFacingRequest } = plain(
  completeProductionRequest
) as Record<string, unknown>

// Compile-time: a production value must be usable where the structural copy is
// expected. Kept alongside the key comparisons above, which is what makes an
// added field fail rather than pass by structural assignability.
const productionRequest: ModelRequestLike = ModelRequest.ModelRequest.make({
  modelId: "openai:gpt-5-mini",
  system: [ModelRequest.SystemPart.make({ text: "You are a concise reviewer." })],
  messages: [ModelRequest.Message.user("Summarize PR 4821.")],
  tools: [],
  params: ModelRequest.GenerationParams.make({ temperature: 0 })
})

const productionEvents: ReadonlyArray<ModelEventLike> = [
  { type: "text-start", id: "text_1" },
  { type: "text-delta", id: "text_1", text: "ok" },
  { type: "settle", stopReason: "stop", responseId: "resp_1" }
] satisfies ReadonlyArray<ModelEvent.ModelEvent>

describe("ModelLike mirrors the production model contracts", () => {
  it("accepts a production request where the structural copy is expected", () => {
    expect(productionRequest.modelId).toBe("openai:gpt-5-mini")
    // `recordedRequest` is the projection every fixture stores; it must accept
    // the class instance and produce a plain record.
    const recorded = recordedRequest(productionRequest)
    expect(Object.getPrototypeOf(recorded)).toBe(Object.prototype)
    expect(canonicalRequestDigest(productionRequest)).toBe(canonicalRequestDigest(recorded))
  })

  it("accepts every production event shape", () => {
    expect(productionEvents).toHaveLength(3)
  })

  it("carries the tag a production model error is classified by", () => {
    const production = new ModelError({ code: "rate_limited", message: "429" })
    const structural: ModelErrorLike = {
      code: production.code,
      message: production.message
    }
    expect(structural.code).toBe("rate_limited")
    expect(production._tag).toBe(modelErrorTag)
  })

  it("wraps the production Model seam, which is why the copy is not a decoupling claim", () => {
    // `Model.make` is the production seam. The recorder wraps it, so the
    // dependency is real and the structural copy exists for fixture shape, not
    // to avoid the package.
    expect(Model.make({ stream: () => null as never }).stream).toBeTypeOf("function")
  })

  it("projects every field of a fully populated production request", () => {
    const projected = recordedRequest(completeProductionRequest)
    // Not a spot check: both sides are compared as complete data, so a field
    // the projection stops enumerating fails here even though the copy and the
    // production type still agree on it.
    expect(plain(projected)).toStrictEqual(modelFacingRequest)
  })

  it("drops the provider cache hints from the fixture and the replay digest", () => {
    const projected: Record<string, unknown> = { ...recordedRequest(completeProductionRequest) }
    expect(Object.keys(completeCacheHints).filter((key) => key in projected)).toStrictEqual([])
    const otherRun = { ...completeProductionRequest, cacheKey: "run_2", cacheBoundary: 1 }
    expect(canonicalRequestDigest(otherRun)).toBe(canonicalRequestDigest(completeProductionRequest))
  })

  it("notices a field the projection would have dropped or added", () => {
    const projected = { ...recordedRequest(completeProductionRequest) }
    const { toolChoice: _dropped, ...withoutToolChoice } = projected
    expect(plain(projected)).toStrictEqual(modelFacingRequest)
    expect(plain(withoutToolChoice)).not.toStrictEqual(modelFacingRequest)
    expect(plain({ ...projected, promptCacheKey: "k" })).not.toStrictEqual(modelFacingRequest)
    expect(plain({ ...projected, ...completeCacheHints })).not.toStrictEqual(modelFacingRequest)
  })
})
