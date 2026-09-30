/**
 * Replay-safe policy for native deferred provider tool loading.
 *
 * @since 0.1.0
 */

import type { ModelRequest, ToolDefinition } from "./ModelRequest.ts"

/**
 * Provider protocol ids with a native deferred-tool representation.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ProtocolId = "anthropic-messages" | "openai-responses" | "openai-responses-chatgpt"

/**
 * The immediate and lazy tool definitions derived from a sealed request.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Resolution {
  readonly immediate: ReadonlyArray<ToolDefinition>
  readonly deferred: ReadonlyArray<ToolDefinition>
  readonly activatedNames: ReadonlyArray<string>
}

const normalizedName = (name: string): string => name.trim().toLowerCase()

// Both providers are allowlists. Native deferral changes the wire body, so a
// model answers true only once its support is documented or verified against
// the live backend. Every other id, including a family or version released
// after this code, lowers through the portable non-native path until somebody
// adds it here: a version comparison would enable unverified wire behavior
// without a release, which is the one thing this predicate must never do.
//
// The Anthropic list mirrors the model compatibility table on
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
// (fetched 2026-09-01) plus the undated alias of each dated 4.5 id, which
// Anthropic serves for the same model. Sonnet 5 is absent from that table, so
// it is absent here; Opus 4.1 and earlier do not support the feature.
const ANTHROPIC_DEFERRED_MODELS = new Set([
  "claude-fable-5-1",
  "claude-mythos-5-1",
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001"
])

const isAnthropicDeferredModel = (modelId: string): boolean => ANTHROPIC_DEFERRED_MODELS.has(modelId.toLowerCase())

// Seeded from pi's generated model compatibility metadata. New families remain
// opt-in until their wire support is verified against the live backend.
//
// GPT-6: OpenAI's tool search guide says "only `gpt-5.4` and later models
// support `tool_search`" and uses GPT-6 models in its client-executed examples
// (https://developers.openai.com/api/docs/guides/tools-tool-search, fetched
// 2026-09-24). The same day a live probe sent this module's exact native body
// (a `defer_loading` function carried only by a client `tool_search_output`)
// to each GPT-6 id on the ChatGPT-subscription backend: every model answered
// HTTP 200 and called the deferred tool, and with the search items removed the
// model called the loader again instead. The api.openai.com probe could not
// run (the key had no credits), so the API-key entries rest on the guide. The
// recorded responses live in test/fixtures/gpt6-deferred-probe.json. That probe
// covered gpt-6-sol, gpt-6-astra and gpt-6-luna; gpt-6.1-sol is listed here on
// the guide alone and has never been probed on the ChatGPT backend.
const OPENAI_DEFERRED_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-pro",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-astra",
  "gpt-6-luna"
])

const isOpenAiDeferredModel = (modelId: string): boolean => OPENAI_DEFERRED_MODELS.has(modelId.toLowerCase())

// The ChatGPT-subscription backend has its own list: only ids probed live on
// that backend belong here (see the GPT-6 note above). GPT-5.x was never
// probed there, so it keeps the portable lowering on this route.
const CHATGPT_DEFERRED_MODELS = new Set([
  "gpt-6-sol",
  "gpt-6-astra",
  "gpt-6-luna"
])

const isChatGptDeferredModel = (modelId: string): boolean => CHATGPT_DEFERRED_MODELS.has(modelId.toLowerCase())

const uniqueTools = (tools: ReadonlyArray<ToolDefinition>): ReadonlyArray<ToolDefinition> => {
  const seen = new Set<string>()
  const result: Array<ToolDefinition> = []
  for (const tool of tools) {
    const name = normalizedName(tool.name)
    if (name === "" || seen.has(name)) continue
    seen.add(name)
    result.push(tool)
  }
  return result
}

// Measured against pi's reference implementation: a lazy schema must not
// change the prompt prefix.
const lazyTool = (tool: ToolDefinition): ToolDefinition => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
  deferred: tool.deferred,
  loader: tool.loader
})

/**
 * Reports whether a protocol and model pair supports pi's native deferred
 * tool-loading wire representation.
 *
 * Each protocol answers from an explicit allowlist, matched case-insensitively.
 * An id absent from its provider's list answers false, including a family or
 * version released after this code, because native deferral changes the wire
 * body and an unverified body must not be enabled without a release. Such a
 * model still receives every tool through the portable non-native lowering.
 *
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const supportsDeferred = (protocolId: ProtocolId, modelId: string): boolean =>
  protocolId === "anthropic-messages"
    ? isAnthropicDeferredModel(modelId)
    : protocolId === "openai-responses-chatgpt"
    ? isChatGptDeferredModel(modelId)
    : isOpenAiDeferredModel(modelId)

/**
 * Resolves immediate and deferred tools from declared `deferred` annotations
 * and the chronological transcript only. Unsupported models receive
 * non-deferred definitions plus additively activated lazy definitions. No
 * process-local activation state is consulted, so replay produces the
 * identical tool partition.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const resolve = (request: ModelRequest, native: boolean): Resolution => {
  const tools = uniqueTools(request.tools)
  const known = new Map(tools.map((tool) => [normalizedName(tool.name), tool] as const))
  const used = new Set<string>()
  const usedBeforeActivation = new Set<string>()
  const activated = new Set<string>()
  // One chronological pass over the typed transcript. `messages` is a closed
  // union of the user, assistant, and tool roles whose parts are a closed union
  // on `type`, so a call can only reach `used` through an assistant `tool-call`
  // part and an activation only through a `tool-result` part.
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type === "tool-call") {
        used.add(normalizedName(part.name))
        continue
      }
      if (part.type !== "tool-result") continue
      for (const name of part.addedToolNames) {
        const normalized = normalizedName(name)
        if (!known.has(normalized)) continue
        if (!activated.has(normalized) && used.has(normalized)) usedBeforeActivation.add(normalized)
        activated.add(normalized)
      }
    }
  }

  if (!native) {
    return {
      immediate: tools.filter((tool) => {
        const name = normalizedName(tool.name)
        return tool.deferred !== true || activated.has(name) || usedBeforeActivation.has(name)
      }),
      deferred: [],
      activatedNames: tools.filter((tool) => activated.has(normalizedName(tool.name))).map((tool) => tool.name)
    }
  }

  const immediate: Array<ToolDefinition> = []
  const deferred: Array<ToolDefinition> = []
  for (const tool of tools) {
    const name = normalizedName(tool.name)
    const lazy = tool.deferred === true || activated.has(name)
    if (tool.loader === true || !lazy || usedBeforeActivation.has(name)) {
      immediate.push(tool)
    } else {
      deferred.push(lazyTool(tool))
    }
  }
  if (immediate.length === 0) {
    return { immediate: deferred, deferred: [], activatedNames: [] }
  }
  return {
    immediate,
    deferred,
    activatedNames: tools.filter((tool) => activated.has(normalizedName(tool.name))).map((tool) => tool.name)
  }
}
