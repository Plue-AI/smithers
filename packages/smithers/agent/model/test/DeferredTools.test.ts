import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as DeferredTools from "../src/DeferredTools.ts"
import {
  GenerationParams,
  Message,
  ModelRequest,
  SystemPart,
  ToolCallPart,
  ToolDefinition,
  ToolResultPart
} from "../src/ModelRequest.ts"
import * as OpenAIResponses from "../src/OpenAIResponses.ts"

const tool = (
  name: string,
  options: { readonly deferred?: boolean; readonly loader?: boolean; readonly metadata?: string } = {}
): ToolDefinition =>
  Object.assign(
    ToolDefinition.make({
      name,
      description: `${name} description`,
      parameters: { type: "object" },
      deferred: options.deferred,
      loader: options.loader
    }),
    options.metadata === undefined ? {} : { promptSnippet: options.metadata }
  )

const request = (tools: ReadonlyArray<ToolDefinition>, messages: ReadonlyArray<Message> = []): ModelRequest =>
  ModelRequest.make({ modelId: "model", system: [], messages, tools, params: {} })

describe("DeferredTools", () => {
  it("allowlists the documented Anthropic and OpenAI families", () => {
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-sonnet-4-5")).toBe(true)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-sonnet-4-5-20250929")).toBe(true)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-opus-4-5-20251101")).toBe(true)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-opus-4-6")).toBe(true)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-fable-5-1")).toBe(true)
    // Anthropic's model compatibility table lists Haiku 4.5 (fetched
    // 2026-09-01), so the alias and its dated id both answer true.
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-haiku-4-5")).toBe(true)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-haiku-4-5-20251001")).toBe(true)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "CLAUDE-OPUS-5")).toBe(true)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-sonnet-4-20250514")).toBe(false)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.4")).toBe(true)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.4-mini")).toBe(true)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.4-pro")).toBe(true)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.5")).toBe(true)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.6-sol")).toBe(true)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.6-terra")).toBe(true)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.6-luna")).toBe(true)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.4-nano")).toBe(false)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.5-pro")).toBe(false)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-6")).toBe(false)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-6-terra")).toBe(false)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.3")).toBe(false)
  })

  it("keeps both allowlists closed to unreleased, undocumented, and malformed ids", () => {
    // Native deferral changes the wire body, so an id nobody has verified
    // against the live backend lowers through the portable non-native path.
    // Every documented id answers true; every other shape answers false, even
    // one a version comparison would have accepted.
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-opus-5")).toBe(true)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-mythos-5-1")).toBe(true)
    // A future major, a future minor, and a future family.
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-sonnet-9-0")).toBe(false)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-opus-6")).toBe(false)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-opus-5-1")).toBe(false)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-legend-5")).toBe(false)
    // A date suffix the table does not list, and a dot-separated version the
    // old floor regex accepted.
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-sonnet-4-5-20991231")).toBe(false)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-fable-4.5")).toBe(false)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-sonnet-4-4")).toBe(false)
    // Sonnet 5 ships, but the compatibility table omits it (fetched
    // 2026-09-01), so it stays off until the table or a live probe says so.
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-sonnet-5")).toBe(false)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-haiku")).toBe(false)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-9.9-sol")).toBe(false)
  })

  it("deduplicates normalized names and preserves a tool used before its marker", () => {
    const late = tool("Late", { deferred: true })
    const messages = [
      Message.assistant({ type: "tool-call", id: "call", name: "late", arguments: "{}" }),
      Message.tool({ type: "tool-result", toolCallId: "call", content: "done", addedToolNames: ["LATE"] })
    ]
    const result = DeferredTools.resolve(request([tool("base"), late, tool(" late ")], messages), true)
    expect(result.immediate.map((entry) => entry.name)).toEqual(["base", "Late"])
    expect(result.deferred).toEqual([])
    expect(result.activatedNames).toEqual(["Late"])
  })

  it("keeps declared lazy tools deferred before their first activation marker", () => {
    const result = DeferredTools.resolve(
      request([tool("loader", { loader: true }), tool("late", { deferred: true })]),
      true
    )

    expect(result.immediate.map((entry) => entry.name)).toEqual(["loader"])
    expect(result.deferred.map((entry) => entry.name)).toEqual(["late"])
    expect(result.activatedNames).toEqual([])
  })

  it("keeps activations additive, loader tools immediate, and does not resurrect missing tools", () => {
    const messages = [
      Message.tool({ type: "tool-result", toolCallId: "one", content: "", addedToolNames: ["late"] }),
      Message.tool({ type: "tool-result", toolCallId: "two", content: "", addedToolNames: ["later", "removed"] })
    ]
    const result = DeferredTools.resolve(
      request([tool("loader", { loader: true }), tool("late"), tool("later")], messages),
      true
    )
    expect(result.immediate.map((entry) => entry.name)).toEqual(["loader"])
    expect(result.deferred.map((entry) => entry.name)).toEqual(["late", "later"])
    expect(result.activatedNames).toEqual(["late", "later"])
  })

  it("keeps a tool deferred when a later loader result repeats its post-use activation marker", () => {
    const messages = [
      Message.tool({ type: "tool-result", toolCallId: "load", content: "", addedToolNames: ["late"] }),
      Message.assistant({ type: "tool-call", id: "use", name: "late", arguments: "{}" }, {
        stopReason: "tool-calls"
      }),
      Message.tool({
        type: "tool-result",
        toolCallId: "load-again",
        content: "",
        addedToolNames: ["LATE"]
      })
    ]
    const result = DeferredTools.resolve(request([tool("loader", { loader: true }), tool("late")], messages), true)

    expect(result.immediate.map((entry) => entry.name)).toEqual(["loader"])
    expect(result.deferred.map((entry) => entry.name)).toEqual(["late"])
    expect(result.activatedNames).toEqual(["late"])
  })

  it("promotes all lazy tools if native loading leaves no immediate tool", () => {
    const messages = [Message.tool({ type: "tool-result", toolCallId: "one", content: "", addedToolNames: ["late"] })]
    const result = DeferredTools.resolve(request([tool("late")], messages), true)
    expect(result.immediate.map((entry) => entry.name)).toEqual(["late"])
    expect(result.deferred).toEqual([])
    expect(result.activatedNames).toEqual([])
  })

  it("uses the complete active list when native loading is unavailable", () => {
    const messages = [Message.tool({ type: "tool-result", toolCallId: "one", content: "", addedToolNames: ["late"] })]
    const result = DeferredTools.resolve(request([tool("base"), tool("late", { deferred: true })], messages), false)
    expect(result.immediate.map((entry) => entry.name)).toEqual(["base", "late"])
    expect(result.deferred).toEqual([])
  })

  it("omits inactive deferred definitions from the unsupported-model fallback", () => {
    const result = DeferredTools.resolve(
      request([tool("loader", { loader: true }), tool("late", { deferred: true })]),
      false
    )

    expect(result.immediate.map((entry) => entry.name)).toEqual(["loader"])
    expect(result.deferred).toEqual([])
  })

  it("records use and activation only from tool-call and tool-result parts", () => {
    // Each role carries a closed union of parts tagged by `type`, so text and
    // thinking parts naming a tool contribute to neither set.
    const messages = [
      Message.user("late"),
      Message.assistant([{ type: "text", text: "late" }, { type: "thinking", text: "late" }]),
      Message.tool({ type: "tool-result", toolCallId: "call", content: "late", addedToolNames: [] })
    ]
    const result = DeferredTools.resolve(
      request([tool("loader", { loader: true }), tool("late", { deferred: true })], messages),
      true
    )

    expect(result.immediate.map((entry) => entry.name)).toEqual(["loader"])
    expect(result.deferred.map((entry) => entry.name)).toEqual(["late"])
    expect(result.activatedNames).toEqual([])
  })

  it("resolves the empty request and drops blank tool names", () => {
    const empty = DeferredTools.resolve(request([]), true)
    expect(empty).toEqual({ immediate: [], deferred: [], activatedNames: [] })
    expect(DeferredTools.resolve(request([]), false)).toEqual({ immediate: [], deferred: [], activatedNames: [] })

    const blank = DeferredTools.resolve(request([tool("  "), tool("kept")]), true)
    expect(blank.immediate.map((entry) => entry.name)).toEqual(["kept"])
  })

  it("mixes the loader and deferred flags differently per mode", () => {
    const tools = [tool("search", { loader: true, deferred: true }), tool("plain")]

    // Native loading keeps a loader immediate even when it declares itself lazy,
    // because the loader is what the model calls to obtain the rest.
    expect(DeferredTools.resolve(request(tools), true).immediate.map((entry) => entry.name)).toEqual([
      "search",
      "plain"
    ])
    // Without native loading the `deferred` flag alone decides, so an
    // unactivated lazy loader is withheld exactly like any other lazy tool.
    expect(DeferredTools.resolve(request(tools), false).immediate.map((entry) => entry.name)).toEqual(["plain"])

    const activated = [
      Message.tool({ type: "tool-result", toolCallId: "one", content: "", addedToolNames: ["search"] })
    ]
    expect(DeferredTools.resolve(request(tools, activated), false).immediate.map((entry) => entry.name)).toEqual([
      "search",
      "plain"
    ])
  })

  it("strips prompt-affecting metadata from lazy entries", () => {
    const late = tool("late", { metadata: "must never reach a provider prefix" })
    const messages = [Message.tool({ type: "tool-result", toolCallId: "one", content: "", addedToolNames: ["late"] })]
    const result = DeferredTools.resolve(request([tool("base"), late], messages), true)
    expect(result.deferred[0]).toEqual({
      name: "late",
      description: "late description",
      parameters: { type: "object" },
      deferred: undefined,
      loader: undefined
    })
    expect(result.deferred[0]).not.toHaveProperty("promptSnippet")
  })
})

interface ProbeRecord {
  readonly model: string
  readonly mode: "native" | "control" | "ablate"
  readonly sent: { readonly tools: ReadonlyArray<string>; readonly input_types: ReadonlyArray<string> }
  readonly http: number
  readonly outcome: {
    readonly status: string
    readonly output: ReadonlyArray<{ readonly type: string; readonly name?: string }>
  }
}

// Live responses recorded 2026-09-24 against the ChatGPT-subscription backend.
// The fixture stays as recorded; its `gpt-6-astra` seat is the one now named
// `gpt-6.1-sol`, so the records are read under the current id.
const renamedSeats: Readonly<Record<string, string>> = { "gpt-6-astra": "gpt-6.1-sol" }
const probe = (JSON.parse(
  readFileSync(new URL("./fixtures/gpt6-deferred-probe.json", import.meta.url), "utf8")
) as { readonly records: ReadonlyArray<ProbeRecord> }).records.map((record) => ({
  ...record,
  model: renamedSeats[record.model] ?? record.model
}))

const called = (record: ProbeRecord): ReadonlyArray<string> =>
  record.outcome.output.filter((item) => item.type === "function_call").map((item) => item.name ?? "")

const provenNative = (model: string): boolean =>
  probe.some((record) =>
    record.model === model && record.mode === "native" && record.http === 200 &&
    record.outcome.status === "completed" && called(record).includes("get_weather")
  )

// The probe's request, lowered by the shipping protocol for `modelId`.
const probeRequest = (modelId: string): ModelRequest =>
  ModelRequest.make({
    modelId,
    system: [SystemPart.make({ text: "Use tools. Be terse." })],
    messages: [
      Message.user("Load the weather tool, then call get_weather for Paris."),
      Message.assistant(
        ToolCallPart.make({ id: "call_loader", name: "load_tools", arguments: "{\"query\":\"weather\"}" }),
        {
          stopReason: "tool-calls"
        }
      ),
      Message.tool(
        ToolResultPart.make({
          toolCallId: "call_loader",
          content: "loaded get_weather",
          addedToolNames: ["get_weather"]
        })
      )
    ],
    tools: [
      ToolDefinition.make({ name: "load_tools", description: "Load tools by query", parameters: {}, loader: true }),
      ToolDefinition.make({ name: "get_weather", description: "Current weather", parameters: {}, deferred: true })
    ],
    params: GenerationParams.make({ reasoningEffort: "low" })
  })

describe("GPT-6 deferred tools against the 2026-09-24 live probe", () => {
  const gpt6 = ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"] as const

  it("allowlists exactly the GPT-6 ids whose native probe called the deferred tool", () => {
    const probed = [...new Set(probe.map((record) => record.model))].sort()
    expect(probed).toEqual([...gpt6].sort())
    for (const model of probed) {
      expect(DeferredTools.supportsDeferred("openai-responses-chatgpt", model)).toBe(provenNative(model))
      expect(DeferredTools.supportsDeferred("openai-responses", model)).toBe(provenNative(model))
    }
    // GPT-5.x was never probed on the subscription backend.
    expect(DeferredTools.supportsDeferred("openai-responses-chatgpt", "gpt-5.6-sol")).toBe(false)
  })

  it("records a falsifying ablation: without the search items the loader is called again", () => {
    const ablated = probe.filter((record) => record.mode === "ablate")
    expect(ablated.length).toBeGreaterThan(0)
    for (const record of ablated) {
      expect(record.sent.tools).toEqual(["load_tools"])
      expect(called(record)).not.toContain("get_weather")
    }
  })

  it("lowers each GPT-6 seat on the ChatGPT route to the wire the probe sent", () => {
    for (const model of gpt6) {
      const body = Effect.runSync(OpenAIResponses.chatgptProtocol.body.from(probeRequest(model), { native: true }))
      const native = probe.find((record) => record.model === model && record.mode === "native")
      expect(OpenAIResponses.chatgptProtocol.supportsDeferred(model)).toBe(true)
      expect(body.tools?.map((entry) => entry.type === "function" ? entry.name : entry.type)).toEqual(
        native?.sent.tools
      )
      expect(body.input.map((item) => ("type" in item ? item.type : item.role))).toEqual(native?.sent.input_types)
    }
  })
})
