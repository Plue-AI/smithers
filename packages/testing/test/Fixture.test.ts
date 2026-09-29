import { describe, expect, it } from "@effect/vitest"
import * as ProductionModelRequest from "@smthrs/model/ModelRequest"
import { Effect } from "effect"
import { canonicalRequestDigest, decode, index, recordedRequest } from "../src/Fixture.ts"
import type { RecordedCall } from "../src/Fixture.ts"
import type { ModelRequestLike } from "../src/ModelLike.ts"
import { FixtureEncodingError } from "../src/TestingError.ts"

const request = (overrides: Partial<ModelRequestLike> = {}): ModelRequestLike => ({
  modelId: "openai:gpt-5-mini",
  system: [{ type: "text", text: "You are a concise reviewer." }],
  messages: [{ role: "user", content: [{ type: "text", text: "Summarize PR 4821." }] }],
  tools: [],
  params: {},
  ...overrides
})

const call = (events: unknown): unknown => ({
  calls: [{ request: request(), model: "openai:gpt-5-mini", events }]
})

/**
 * A request whose every canonical encoding is counted.
 *
 * `recordedRequest` reads `modelId` exactly once per encoding, so an accessor
 * there counts how often a call is digested. The accessor survives freezing,
 * and reading it is what a store's own frozen copy of a request is: a value
 * nothing can change under the encoder.
 */
const counted = (overrides: Partial<ModelRequestLike> = {}): {
  readonly request: ModelRequestLike
  readonly encodings: () => number
} => {
  const projected = request(overrides)
  let encodings = 0
  return {
    request: {
      ...projected,
      get modelId() {
        encodings += 1
        return projected.modelId
      }
    },
    encodings: () => encodings
  }
}

const recordedCall = (request: ModelRequestLike): RecordedCall => ({
  request,
  model: "openai:gpt-5-mini",
  events: []
})

describe("Fixture", () => {
  it("ignores non-enumerable record properties instead of promoting them", () => {
    const parameters = Object.defineProperty({ type: "object" }, "hidden", {
      get: () => {
        throw new Error("hidden accessor ran")
      }
    })
    const input = request({ tools: [{ name: "schema", description: "schema", parameters }] })
    expect(JSON.parse(canonicalRequestDigest(input)).tools[0].parameters).toEqual({ type: "object" })
  })

  it.each([
    ["sparse array", () => new Array(1), "$.tools[0].parameters.value[0]"],
    ["revoked proxy", () => {
      const revoked = Proxy.revocable({}, {})
      revoked.revoke()
      return revoked.proxy
    }, "$.tools[0].parameters.value"]
  ])("rejects %s through the encoding error", (_name, make, path) => {
    const input = request({ tools: [{ name: "schema", description: "schema", parameters: { value: make() } }] })
    let failure: unknown
    try {
      canonicalRequestDigest(input)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(FixtureEncodingError)
    expect(failure).toMatchObject({ reason: "unsupported-type", path })
  })

  it("rejects arrays which JSON.stringify would reshape", () => {
    const rejects = (items: unknown, path: string, reason = "unsupported-type") => {
      const input = request({ tools: [{ name: "schema", description: "schema", parameters: { items } }] })
      let failure: unknown
      try {
        canonicalRequestDigest(input)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(FixtureEncodingError)
      expect(failure).toMatchObject({ reason, path })
    }

    rejects(Array(1), "$.tools[0].parameters.items[0]")
    rejects([1, , 3], "$.tools[0].parameters.items[1]")
    rejects(Object.assign([1], { [Symbol("hidden")]: 2 }), "$.tools[0].parameters.items", "symbol-key")
    rejects(Object.assign([1], { extra: 2 }), "$.tools[0].parameters.items")
    rejects(Object.defineProperty([1], "extra", { value: 2, enumerable: false }), "$.tools[0].parameters.items")

    const valid = request({ tools: [{ name: "schema", description: "schema", parameters: { items: [null] } }] })
    expect(JSON.parse(canonicalRequestDigest(valid)).tools[0].parameters.items).toEqual([null])
    rejects([undefined], "$.tools[0].parameters.items[0]")
  })

  it("rejects Array subclass instances", () => {
    const rejects = (items: unknown) => {
      const input = request({ tools: [{ name: "schema", description: "schema", parameters: { items } }] })
      let failure: unknown
      try {
        canonicalRequestDigest(input)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(FixtureEncodingError)
      expect(failure).toMatchObject({
        reason: "non-plain-object",
        path: "$.tools[0].parameters.items"
      })
    }

    class Wrapped extends Array<unknown> {}
    rejects(Wrapped.from([1, 2]))

    class Reshaped extends Array<unknown> {
      toJSON() {
        return "x"
      }
    }
    rejects(Reshaped.of(1))

    const speciesProto = Object.create(Array.prototype)
    Object.defineProperty(speciesProto, "constructor", {
      value: { [Symbol.species]: class extends Array<unknown> {} }
    })
    const speciesArray = Object.setPrototypeOf([1], speciesProto)
    expect(Array.isArray(speciesArray)).toBe(true)
    rejects(speciesArray)
  })

  it.effect("round-trips an own __proto__ tool parameter through snapshot, digest, and decode", () =>
    Effect.gen(function*() {
      const parameters = JSON.parse("{\"type\":\"object\",\"__proto__\":{\"type\":\"string\"}}")
      const input = request({ tools: [{ name: "schema", description: "schema", parameters }] })
      const recorded = recordedRequest(input)
      expect(Object.hasOwn(recorded.tools[0]!.parameters, "__proto__")).toBe(true)
      const digest = canonicalRequestDigest(recorded)
      const decoded = yield* decode({
        calls: [{ request: JSON.parse(digest), model: input.modelId, events: [] }]
      })
      const restored = decoded.calls[0]!.request
      expect(Object.hasOwn(restored.tools[0]!.parameters, "__proto__")).toBe(true)
      expect(Object.getPrototypeOf(restored.tools[0]!.parameters)).toBe(Object.prototype)
      expect(restored.tools[0]!.parameters).toEqual(parameters)
      expect(canonicalRequestDigest(restored)).toBe(digest)
    }))

  it.each([false, true])("rejects a throwing accessor with a typed encoding error (array: %s)", (array) => {
    let reads = 0
    const value = Object.defineProperty(array ? [] : {}, array ? "0" : "answer", {
      enumerable: true,
      get: () => {
        reads++
        throw new Error("accessor ran")
      }
    })
    const input = request({ tools: [{ name: "schema", description: "schema", parameters: { value } }] })
    const recorded = recordedRequest(input)
    expect(reads).toBe(0)
    let failure: unknown
    try {
      canonicalRequestDigest(recorded)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(FixtureEncodingError)
    expect(failure).toMatchObject({
      reason: "unsupported-type",
      path: `$.tools[0].parameters.value${array ? "[0]" : ".answer"}`
    })
    expect(reads).toBe(0)
  })

  it("encodes a frozen recorded request once across the fixtures an append publishes", () => {
    const first = counted({ messages: [{ role: "user", content: [{ type: "text", text: "First." }] }] })
    const second = counted({ messages: [{ role: "user", content: [{ type: "text", text: "Second." }] }] })
    const calls = [recordedCall(Object.freeze(first.request)), recordedCall(Object.freeze(second.request))]
    // Every append publishes a fixture the index memo has never seen, so this
    // is one recording run: one call, then two, then two read back.
    index({ calls: calls.slice(0, 1) })
    index({ calls })
    index({ calls })
    expect([first.encodings(), second.encodings()]).toEqual([1, 1])
  })

  it("re-encodes a request the caller can still mutate", () => {
    const owned: { -readonly [K in keyof ModelRequestLike]: ModelRequestLike[K] } = { ...request() }
    const call = recordedCall(owned)
    const before = canonicalRequestDigest(owned)
    expect(index({ calls: [call] }).has(before)).toBe(true)
    owned.system = [{ type: "text", text: "Rewritten." }]
    const after = canonicalRequestDigest(owned)
    expect(after).not.toBe(before)
    // A caller still owns this request, so the second fixture reads what the
    // request says now rather than a memo of what it used to say.
    expect(index({ calls: [call] }).has(after)).toBe(true)
  })

  it("carries toolChoice in the request digest", () => {
    expect(canonicalRequestDigest(request({ toolChoice: "none" })))
      .not.toBe(canonicalRequestDigest(request()))
  })

  it("carries server tools in the request digest and records them as given", () => {
    const searching = request({ serverTools: [{ type: "web_search", allowedDomains: ["smithers.sh"] }] })
    expect(canonicalRequestDigest(searching)).not.toBe(canonicalRequestDigest(request()))
    expect(canonicalRequestDigest(request({ serverTools: [{ type: "web_search" }] })))
      .not.toBe(canonicalRequestDigest(searching))
    expect(recordedRequest(request())).not.toHaveProperty("serverTools")
    expect(recordedRequest(searching).serverTools).toEqual([{ type: "web_search", allowedDomains: ["smithers.sh"] }])
    expect(recordedRequest(request({ serverTools: [{ type: "web_search" }] })).serverTools).toEqual([
      { type: "web_search" }
    ])
  })

  it("omits an absent toolChoice rather than recording it as null", () => {
    expect(recordedRequest(request())).not.toHaveProperty("toolChoice")
    expect(recordedRequest(request({ toolChoice: "none" })).toolChoice).toBe("none")
  })

  it("projects the production ModelRequest class onto plain data", () => {
    const production = ProductionModelRequest.ModelRequest.make({
      modelId: "openai:gpt-5-mini",
      system: [ProductionModelRequest.SystemPart.make({ text: "You are a concise reviewer." })],
      messages: [
        ProductionModelRequest.Message.user("Summarize PR 4821."),
        ProductionModelRequest.Message.assistant(
          [ProductionModelRequest.ToolCallPart.make({ id: "call_1", name: "balance", arguments: "{}" })],
          { stopReason: "tool-calls" }
        ),
        ProductionModelRequest.Message.tool(
          ProductionModelRequest.ToolResultPart.make({ toolCallId: "call_1", content: "0.42 ETH" })
        )
      ],
      tools: [
        ProductionModelRequest.ToolDefinition.make({
          name: "balance",
          description: "Reads a balance.",
          parameters: { type: "object" }
        })
      ],
      params: ProductionModelRequest.GenerationParams.make({ maxTokens: 256 }),
      toolChoice: "none"
    })
    const projected = recordedRequest(production)
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype)
    expect(projected.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    expect(projected.toolChoice).toBe("none")
    expect(canonicalRequestDigest(production)).toBe(canonicalRequestDigest(projected))
  })

  it("reports a 50,000-level tool schema through the typed depth error", () => {
    let parameters: Record<string, unknown> = { leaf: true }
    for (let depth = 0; depth < 50_000; depth++) parameters = { nested: parameters }

    let failure: unknown
    try {
      canonicalRequestDigest(request({
        tools: [{ name: "deep", description: "deep schema", parameters }]
      }))
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(FixtureEncodingError)
    expect(failure).toMatchObject({
      _tag: "FixtureEncodingError",
      code: "fixture_not_encodable",
      reason: "too-deep"
    })
  })

  it.effect("decodes a recorded toolChoice", () =>
    Effect.gen(function*() {
      const decoded = yield* decode({
        calls: [{ request: request({ toolChoice: "none" }), model: "openai:gpt-5-mini", events: [] }]
      })
      expect(decoded.calls[0]!.request.toolChoice).toBe("none")
    }))

  it.effect("decodes the tool-result and retry events", () =>
    Effect.gen(function*() {
      const events = [
        { type: "retry", attempt: 2, code: "transport", delayMillis: 500 },
        { type: "tool-result", id: "call_1", output: "0.42 ETH", isError: false },
        { type: "settle", stopReason: "tool-calls" }
      ]
      const decoded = yield* decode(call(events))
      expect(decoded.calls[0]!.events).toEqual(events)
    }))

  it.effect("decodes the context_overflow and call_timeout failure codes", () =>
    Effect.gen(function*() {
      for (const code of ["context_overflow", "call_timeout"]) {
        const decoded = yield* decode({
          calls: [{
            request: request(),
            model: "openai:gpt-5-mini",
            events: [],
            failure: { code, message: "the provider said so" }
          }]
        })
        expect(decoded.calls[0]!.failure?.code).toBe(code)
      }
    }))

  it.effect("rejects a failure code the model package never emits", () =>
    Effect.gen(function*() {
      const exit = yield* decode({
        calls: [{
          request: request(),
          model: "openai:gpt-5-mini",
          events: [],
          failure: { code: "permission_denied", message: "no grant" }
        }]
      }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }))
})
