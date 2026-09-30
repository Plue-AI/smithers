import { modelPrices } from "./modelPrices.ts";

const MAX_BODY_BYTES = 48_000;
const FIELDS = new Set([
  "model",
  "max_tokens",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "metadata",
  "thinking",
  "output_config",
]);

function contentAllowed(content: unknown): boolean {
  if (typeof content === "string") return true;
  return (
    Array.isArray(content) &&
    content.every((block) => {
      if (!block || typeof block !== "object") return false;
      if (block.cache_control && block.cache_control.ttl && block.cache_control.ttl !== "5m") return false;
      switch (block.type) {
        case "text":
          return typeof block.text === "string";
        case "tool_use":
          return typeof block.name === "string";
        case "tool_result":
          return block.content === undefined || contentAllowed(block.content);
        case "thinking":
          return typeof block.thinking === "string";
        case "redacted_thinking":
          return typeof block.data === "string";
        default:
          return false;
      }
    })
  );
}

/** Bound a standard, text-only Messages call before reserving its worst-case bill. */
export async function priceRequest(request: Request): Promise<{ body: ArrayBuffer; model: string; costUsd: number }> {
  if (request.headers.has("anthropic-beta") || request.headers.has("content-encoding")) {
    throw new Error("beta and encoded requests have no supported price bound");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error("JSON body required");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error("request exceeds 48000 byte limit");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = new ArrayBuffer(bytes);
  const view = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !FIELDS.has(key))
  ) {
    throw new Error("unsupported Messages request fields");
  }
  if (typeof input.model !== "string") throw new Error("model is required");
  if (!Number.isSafeInteger(input.max_tokens) || input.max_tokens < 1 || input.max_tokens > 64_000) {
    throw new Error("max_tokens must be an integer between 1 and 64000");
  }
  if (
    !Array.isArray(input.messages) ||
    !input.messages.every((message: { content?: unknown }) => message && contentAllowed(message.content))
  ) {
    throw new Error("only text and local tool message content is supported");
  }
  if (input.system !== undefined && !contentAllowed(input.system)) throw new Error("unsupported system content");
  if (
    input.tools !== undefined &&
    (!Array.isArray(input.tools) ||
      !input.tools.every(
        (tool: { type?: unknown; cache_control?: { ttl?: string } }) =>
          tool &&
          (tool.type === undefined || tool.type === "custom") &&
          (!tool.cache_control?.ttl || tool.cache_control.ttl === "5m"),
      ))
  ) {
    throw new Error("only local tools with five-minute caching are supported");
  }
  // Text tokenization is bounded by UTF-8 bytes. Four tokens per serialized byte
  // plus 4096 covers message/tool framing and injected tool prompts. The bound
  // selects the long-context card when it reaches the model's threshold, so a
  // tiered model never reserves at the short-context rate. Reserve every input
  // token at the five-minute cache-write rate, even when it will be uncached or
  // a hit.
  const inputBound = bytes * 4 + 4096;
  const price = modelPrices(input.model, { promptTokens: inputBound });
  return {
    body,
    model: input.model,
    costUsd:
      (inputBound * Math.max(price.input, price.cacheWrite, price.cacheRead) + input.max_tokens * price.output) /
      1_000_000,
  };
}
