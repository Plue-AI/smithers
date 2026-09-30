/**
 * `Fixture` is exported twice under one name: a hand-written interface and a
 * `Schema.Struct`. `decode`'s signature resolves to the interface, so the
 * compiler only ever checks the one direction that signature happens to use,
 * and the two shapes were free to drift while staying assignable that way.
 * These are the checks that hold them together, in the same compile-time form
 * `ModelLikeParity` uses for the model contracts.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, type Schema } from "effect"
import { decode, Fixture, type RecordedCall } from "../src/Fixture.ts"
import type { ModelEventLike, ModelRequestLike, RecordedRequestLike } from "../src/ModelLike.ts"

type Decoded = Schema.Schema.Type<typeof Fixture>
type DecodedCall = Decoded["calls"][number]

// The direction `decode`'s own signature claims: what the schema produces is a
// `Fixture`. A field the schema stopped producing, or a type it widened, fails
// `tsc` rather than this run.
const _schemaSatisfiesInterface: Fixture = {} as Decoded

// The whole-value reverse direction is deliberately false, in exactly one
// place. `tools[].parameters` is `Record<string, unknown>` on the interface,
// because `ModelRequestLike` mirrors `@smthrs/model`'s tool shape, and
// `Record<string, Json>` in the schema, because a fixture is written to a file
// and read back. The narrowing is the point, and the run below proves it is
// real rather than accidental.
//
// Everything else has to match, so the key sets are compared level by level: a
// field added to one side and not the other fails `tsc` here, which is the
// drift the single forward assignment could not see.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** One member of a discriminated union, selected by its tag. */
type Member<U, K extends PropertyKey, V> = Extract<U, { readonly [P in K]: V }>

/** Both key sets, at one level of both shapes. */
type Keys<A, B> = Exact<keyof A, keyof B>

const _fixtureKeys: Keys<Decoded, Fixture> = true
const _callKeys: Keys<DecodedCall, RecordedCall> = true
const _requestKeys: Keys<DecodedCall["request"], RecordedRequestLike> = true
const _paramsKeys: Keys<DecodedCall["request"]["params"], ModelRequestLike["params"]> = true
const _toolKeys: Keys<DecodedCall["request"]["tools"][number], ModelRequestLike["tools"][number]> = true

// The levels below the request's own key set. `tools` and `params` alone left
// system blocks, every message role, every content part, every event member,
// and the recorded failure free to drift: they are separate `Schema.Struct`s
// in the schema and separate members of a union in the interface, and neither
// the forward assignment nor a top-level key comparison reaches them.
type DecodedRequest = DecodedCall["request"]
type DecodedMessage = DecodedRequest["messages"][number]
type Message = ModelRequestLike["messages"][number]

const _systemKeys: Keys<DecodedRequest["system"][number], ModelRequestLike["system"][number]> = true
const _toolChoice: Exact<DecodedRequest["toolChoice"], ModelRequestLike["toolChoice"]> = true

// The union membership itself, before the members' fields: a role or an event
// type present on one side and not the other is the drift that would make a
// fixture decode into a value the replay vocabulary cannot describe.
const _messageRoles: Exact<DecodedMessage["role"], Message["role"]> = true

type DecodedUser = Member<DecodedMessage, "role", "user">
type User = Member<Message, "role", "user">
const _userKeys: Keys<DecodedUser, User> = true
const _userPartKeys: Keys<DecodedUser["content"][number], User["content"][number]> = true

type DecodedAssistant = Member<DecodedMessage, "role", "assistant">
type Assistant = Member<Message, "role", "assistant">
const _assistantKeys: Keys<DecodedAssistant, Assistant> = true
const _stopReasons: Exact<DecodedAssistant["stopReason"], Assistant["stopReason"]> = true

type DecodedPart = DecodedAssistant["content"][number]
type Part = Assistant["content"][number]
const _partTypes: Exact<DecodedPart["type"], Part["type"]> = true
const _textPartKeys: Keys<Member<DecodedPart, "type", "text">, Member<Part, "type", "text">> = true
const _thinkingPartKeys: Keys<Member<DecodedPart, "type", "thinking">, Member<Part, "type", "thinking">> = true
const _toolCallPartKeys: Keys<Member<DecodedPart, "type", "tool-call">, Member<Part, "type", "tool-call">> = true

type DecodedTool = Member<DecodedMessage, "role", "tool">
type Tool = Member<Message, "role", "tool">
const _toolMessageKeys: Keys<DecodedTool, Tool> = true
const _toolResultKeys: Keys<DecodedTool["content"][number], Tool["content"][number]> = true

type DecodedEvent = DecodedCall["events"][number]
type Event = RecordedCall["events"][number]
const _eventTypes: Exact<DecodedEvent["type"], Event["type"]> = true
type EventKeys<T extends Event["type"]> = Keys<Member<DecodedEvent, "type", T>, Member<Event, "type", T>>
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
  Member<DecodedEvent, "type", "settle">["stopReason"],
  Member<Event, "type", "settle">["stopReason"]
> = true

// The recorded failure is the schema's second deliberate narrowing. A fixture
// stores a refusal's fields and not its `_tag`; `RecordedModel` stamps the tag
// back on so a consumer that classifies a provider refusal still recognizes
// it. Every other field, and the whole closed code union, must match.
type DecodedFailure = NonNullable<DecodedCall["failure"]>
type Failure = NonNullable<RecordedCall["failure"]>
const _failureKeys: Exact<keyof DecodedFailure, Exclude<keyof Failure, "_tag">> = true
const _failureCodes: Exact<DecodedFailure["code"], Failure["code"]> = true

// The key comparisons above are between two local shapes, so they hold whether
// or not either one still mirrors `@smthrs/model`; `ModelLikeParity.test.ts` is
// what pins them to production. What they cannot see either way is a field both
// shapes declare that the schema then refuses to decode, so a recorded failure
// with every optional field populated goes through the decoder below.
//
// `Complete` is why that vector cannot go stale: a field added to
// `ModelErrorLike` stops this object compiling until it is carried.
type Complete<T> = { readonly [K in keyof T]-?: Exclude<T[K], undefined> }
const completeFailure: Complete<Omit<Failure, "_tag">> = {
  code: "invalid_request",
  message: "thinking.budget_tokens must be at least 1024",
  path: "$.thinking.budget_tokens",
  retryAfterMillis: 250,
  resetAtEpochMillis: 1_757_000_000_000,
  resetSource: "retry-after",
  quotaScope: "account",
  providerCode: "invalid_request_error",
  requestId: "req_1",
  httpStatus: 400
}

const request = (modelId: string): ModelRequestLike => ({
  modelId,
  system: [{ type: "text", text: "You are a concise reviewer." }],
  messages: [{ role: "user", content: [{ type: "text", text: "Summarize PR 4821." }] }],
  tools: [],
  params: {}
})

const fixture = (model: string, modelId: string): unknown => ({
  calls: [{ request: request(modelId), model, events: [] }]
})

describe("the Fixture interface and the Fixture schema are one contract", () => {
  it("decodes into a value the interface accepts", () =>
    Effect.runPromise(Effect.gen(function*() {
      const decoded = yield* decode(fixture("openai:gpt-5-mini", "openai:gpt-5-mini"))
      // Not a cast: `decoded` is typed by the interface, and reading a
      // `RecordedCall` field off it is what proves the decode produced one.
      const call: RecordedCall = decoded.calls[0]!
      expect(call.model).toBe("openai:gpt-5-mini")
      expect(call.request.modelId).toBe("openai:gpt-5-mini")
    })))

  it.effect("decodes a recorded failure with every optional field populated", () =>
    Effect.gen(function*() {
      const call = {
        request: request("openai:gpt-5-mini"),
        model: "openai:gpt-5-mini",
        events: [],
        failure: completeFailure
      }
      const decoded = yield* decode({ calls: [call] })
      const failure = decoded.calls[0]?.failure
      // Field by field, not `toBeDefined`: a field the schema silently dropped
      // would leave a fixture that replays a refusal the recorder captured more
      // of than the replay hands back.
      expect(failure).toStrictEqual(completeFailure)
    }))

  it.effect("decodes a usage event with every optional field populated, costUsd included", () =>
    Effect.gen(function*() {
      const usage: Complete<Omit<Member<ModelEventLike, "type", "usage">, "type">> = {
        inputTokens: 24,
        outputTokens: 9,
        reasoningTokens: 3,
        cachedInputTokens: 8,
        cacheWriteTokens: 2,
        totalTokens: 33,
        costUsd: 0.0125
      }
      const call = {
        request: request("openai:gpt-5-mini"),
        model: "openai:gpt-5-mini",
        events: [{ type: "usage", ...usage }]
      }
      const decoded = yield* decode({ calls: [call] })
      expect(decoded.calls[0]?.events).toStrictEqual([{ type: "usage", ...usage }])
    }))

  it.effect("rejects a call whose model disagrees with its own request.modelId", () =>
    Effect.gen(function*() {
      const exit = yield* decode(fixture("anthropic:claude-sonnet-4", "openai:gpt-5-mini")).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      // The message names both values, because the fixture author has to know
      // which of the two to change.
      const rendered = String(exit.cause)
      expect(rendered).toContain("anthropic:claude-sonnet-4")
      expect(rendered).toContain("openai:gpt-5-mini")
    }))

  it.effect("rejects a tool whose parameters are not JSON, which is the one place the schema is narrower", () =>
    Effect.gen(function*() {
      const tool = { name: "review", description: "Review a diff.", parameters: { validate: () => true } }
      const call = {
        request: { ...request("openai:gpt-5-mini"), tools: [tool] },
        model: "openai:gpt-5-mini",
        events: []
      }
      const exit = yield* decode({ calls: [call] }).pipe(Effect.exit)
      // The interface would accept this value: `parameters` is
      // `Record<string, unknown>` there. A fixture is a file, so the schema
      // refuses it, and that refusal is what the missing reverse assignment
      // above stands for.
      expect(exit._tag).toBe("Failure")
    }))
})
