#!/usr/bin/env bun
/*
 * The loopback model provider: a real HTTP server on 127.0.0.1 that a host
 * under test reaches over TCP as a USER-SUPPLIED endpoint. It substitutes no
 * Smithers API. It speaks OpenAI Chat Completions SSE, Anthropic Messages SSE
 * and the Vercel gateway evaluation-model JSON protocol (PROVIDER_PATHS).
 *
 * There is no control channel. Behaviour is keyed by the requested model id
 * (PROVIDER_MODEL; any other id is 404; `echoes` streams the presented
 * credential back in nested fragments across three deltas, so a host that publishes provider
 * text unscrubbed is caught; `reads`, on Chat Completions, is the app agent asked
 * about a file: offered the `commands` tool and a question naming a path, it
 * calls files.read on that path, and handed a tool result it answers by quoting
 * it), a credential that is not byte-equal
 * to SMITHERS_MODEL_PROVIDER_KEY is 401, and "down" is a SIGTERM of this
 * process. GET /__journal is append-only evidence that holds a credential's
 * sha256 and never its value. Any session may launch its own copy through
 * model-provider-process.ts, or by hand:
 *
 *   SMITHERS_MODEL_PROVIDER_KEY=<16+ chars> [SMITHERS_MODEL_PROVIDER_PORT=0] \
 *   [SMITHERS_MODEL_PROVIDER_SLOW_MS=8000] bun e2e/real/support/model-provider.ts
 */
import { createHash, timingSafeEqual } from "node:crypto"
import {
  PROVIDER_CONFIDENCE, PROVIDER_ECHO_LEAD, PROVIDER_MODEL, PROVIDER_PATHS, PROVIDER_READ_LEAD, PROVIDER_REPLY, PROVIDER_RETRY_AFTER_SECONDS,
  type ProviderJournalEntry, type ProviderProtocol
} from "./model-provider-behaviors"

// Messages name the variable and never its value: stderr is a test artifact.
const accepted = process.env.SMITHERS_MODEL_PROVIDER_KEY ?? ""
if (accepted.length < 16) throw new Error("SMITHERS_MODEL_PROVIDER_KEY must carry the 16+ character credential this provider accepts.")
const port = Number(process.env.SMITHERS_MODEL_PROVIDER_PORT ?? "0")
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid SMITHERS_MODEL_PROVIDER_PORT: ${process.env.SMITHERS_MODEL_PROVIDER_PORT}`)
const slowMs = Number(process.env.SMITHERS_MODEL_PROVIDER_SLOW_MS ?? "8000")
if (!Number.isFinite(slowMs) || slowMs < 0) throw new Error(`Invalid SMITHERS_MODEL_PROVIDER_SLOW_MS: ${process.env.SMITHERS_MODEL_PROVIDER_SLOW_MS}`)

const journal: ProviderJournalEntry[] = []
const encoder = new TextEncoder()
const sha = (value: string): string => createHash("sha256").update(value).digest("hex")
// Both sides are hashed first, so the comparison is constant-time and length-blind.
const same = (left: string, right: string): boolean =>
  timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest())
const known = new Set<string>(Object.values(PROVIDER_MODEL))
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

const failure = (protocol: ProviderProtocol, status: number, type: string, message: string, headers?: Record<string, string>): Response =>
  protocol === "anthropic-messages"
    ? json(status, { type: "error", error: { type, message } }, headers)
    : json(status, { error: { message, type, code: type } }, headers)

const sse = (events: ReadonlyArray<{ readonly event?: string; readonly data: string }>): Response =>
  new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const item of events) {
        controller.enqueue(encoder.encode(`${item.event === undefined ? "" : `event: ${item.event}\n`}data: ${item.data}\n\n`))
        await Bun.sleep(5) // separate TCP writes: the client's incremental SSE decoder is exercised, not one buffered blob
      }
      controller.close()
    }
  }), { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })

// OpenAI's wire name for a streamed frame, joined because it has a flow name's shape and is none (lint/conformance LiteralPin).
const OPENAI_CHUNK_OBJECT = ["chat", "completion", "chunk"].join(".")

// api.openai.com order: deltas, the finish_reason chunk, then the choice-less usage chunk include_usage asks for.
const openaiStream = (modelId: string, includeUsage: boolean, reply: ReadonlyArray<string>): Response => {
  const chunk = (fields: object): string => JSON.stringify({
    id: "chatcmpl-loopback", object: OPENAI_CHUNK_OBJECT, created: Math.floor(Date.now() / 1000), model: modelId, ...fields
  })
  const choice = (delta: object, finish: string | null): string => chunk({ choices: [{ index: 0, delta, finish_reason: finish }] })
  return sse([
    ...reply.map((content, index) => ({ data: choice({ ...(index === 0 ? { role: "assistant" } : {}), content }, null) })),
    { data: choice({}, "stop") },
    ...(includeUsage ? [{ data: chunk({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) }] : []),
    { data: "[DONE]" }
  ])
}

/** One streamed call of the app agent's `commands` tool, ending the leg as OpenAI does: finish_reason tool_calls. */
const openaiToolCall = (modelId: string, call: { readonly name: string; readonly arguments: string }): Response => sse([
  { data: JSON.stringify({
    id: "chatcmpl-loopback", object: OPENAI_CHUNK_OBJECT, created: Math.floor(Date.now() / 1000), model: modelId,
    choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_loopback_read", type: "function", function: call }] }, finish_reason: "tool_calls" }]
  }) },
  { data: "[DONE]" }
])

/** A Chat Completions message's text, whether it is a string or text parts. */
const messageText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("") : ""
const FILE_PATH = /(?:[\w.-]+\/)*[\w-]+\.[A-Za-z0-9]+/

/**
 * `reads` on Chat Completions: the last tool result, quoted; else, offered
 * `commands` and asked about a path, a files.read call on it; else undefined,
 * so the ordinary reply streams.
 */
const readsAnswer = (modelId: string, body: Record<string, unknown>): Response | undefined => {
  const latest = (Array.isArray(body.messages) ? body.messages.filter(isRecord) : []).reverse()
  const result = latest.find((message) => message.role === "tool")
  if (result !== undefined) return openaiStream(modelId, false, [PROVIDER_READ_LEAD, messageText(result.content)])
  const offered = Array.isArray(body.tools) && body.tools.some((tool) => isRecord(tool) && isRecord(tool.function) && tool.function.name === "commands")
  const path = FILE_PATH.exec(messageText(latest.find((message) => message.role === "user")?.content))?.[0]
  return offered && path !== undefined
    ? openaiToolCall(modelId, { name: "commands", arguments: JSON.stringify({ action: "execute", name: "files.read", args: path }) })
    : undefined
}

const anthropicStream = (modelId: string, reply: ReadonlyArray<string>): Response => {
  const event = (type: string, fields: object) => ({ event: type, data: JSON.stringify({ type, ...fields }) })
  return sse([
    event("message_start", { message: { id: "msg_loopback", type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } } }),
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ...reply.map((text) => event("content_block_delta", { index: 0, delta: { type: "text_delta", text } })),
    event("content_block_stop", { index: 0 }),
    event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
    event("message_stop", {})
  ])
}

/** One raw answer per question: yes, the first choice, the top rung. */
const evaluate = (questions: Record<string, unknown>): Response => {
  const answers: Record<string, unknown> = {}
  const confidence: Record<string, number> = {}
  for (const [id, question] of Object.entries(questions)) {
    const { type, criteria } = isRecord(question) ? question : {}
    confidence[id] = PROVIDER_CONFIDENCE
    if (type === "choice") {
      const choice = Object.keys(isRecord(criteria) ? criteria : {})[0] ?? ""
      answers[id] = { type, choice, probabilities: { [choice]: PROVIDER_CONFIDENCE } }
    } else if (type === "score") answers[id] = { type, score: Math.max(0, (Array.isArray(criteria) ? criteria.length : 1) - 1) }
    else answers[id] = { type: "boolean", probability: PROVIDER_CONFIDENCE }
  }
  return json(200, { answers, usage: { inputTokens: 7, outputTokens: 1 }, providerMetadata: { typesafe: { confidence } } })
}

/** Answers the client cannot decode: a frame that is not JSON, or an answer missing its number. */
const garbled = (protocol: ProviderProtocol, questions: Record<string, unknown>): Response =>
  protocol === "evaluation"
    ? json(200, { answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "boolean" }])) })
    : sse([{ data: "{not json" }])

/** What a composed request asked, as evidence: never the credential, never the answer. */
const composed = (protocol: ProviderProtocol, body: Record<string, unknown> | null): Partial<ProviderJournalEntry> => {
  if (body === null) return {}
  if (protocol === "evaluation") return { ...(isRecord(body.questions) ? { questions: Object.keys(body.questions) } : {}), ...("state" in body ? { state: body.state } : {}) }
  const messages = Array.isArray(body.messages) ? body.messages : []
  // Anthropic carries the system prompt as a string or as blocks; OpenAI wires as a system or developer message.
  const system = typeof body.system === "string" ? body.system.length > 0 : Array.isArray(body.system) ? body.system.length > 0
    : messages.some((message) => isRecord(message) && (message.role === "system" || message.role === "developer"))
  const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : undefined
  return { system, ...(maxTokens === undefined ? {} : { maxTokens }), ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}) }
}

const bearer = (request: Request): string | null => /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? null
const PUBLIC_HEADERS = ["anthropic-version", "ai-gateway-protocol-version", "ai-gateway-auth-method", "ai-evaluation-model-specification-version", "ai-model-id"]

const serve = async (protocol: ProviderProtocol, request: Request): Promise<Response> => {
  const presented = protocol === "anthropic-messages" ? request.headers.get("x-api-key") : bearer(request)
  const parsed: unknown = await request.json().catch(() => null)
  const body = isRecord(parsed) ? parsed : null
  const modelId = protocol === "evaluation" ? request.headers.get("ai-model-id") ?? "" : typeof body?.model === "string" ? body.model : ""
  const authorized = presented !== null && same(presented, accepted)
  // Journaled when the answer is decided, so a slow answer is evidence before it waits.
  const record = (response: Response): Response => {
    journal.push({
      at: new Date().toISOString(), protocol, modelId, status: response.status, authorized,
      credentialSha256: presented === null ? null : sha(presented),
      headers: Object.fromEntries(PUBLIC_HEADERS.flatMap((name) => { const value = request.headers.get(name); return value === null ? [] : [[name, value]] })),
      ...composed(protocol, body)
    })
    return response
  }
  if (!authorized) return record(failure(protocol, 401, "authentication_error", "The credential was not accepted."))
  if (body === null) return record(failure(protocol, 400, "invalid_request_error", "The body is not a JSON object."))
  const questions = isRecord(body.questions) ? body.questions : null
  if (protocol === "evaluation" && (request.headers.get("ai-gateway-protocol-version") !== "0.0.1" || request.headers.get("ai-evaluation-model-specification-version") !== "4" || questions === null || !("state" in body))) {
    return record(failure(protocol, 400, "invalid_request_error", "Evaluation protocol headers or body are wrong."))
  }
  if (modelId === PROVIDER_MODEL.rateLimited) return record(failure(protocol, 429, "rate_limit_error", "Rate limited.", { "retry-after": String(PROVIDER_RETRY_AFTER_SECONDS) }))
  if (modelId === PROVIDER_MODEL.garbled) return record(garbled(protocol, questions ?? {}))
  if (!known.has(modelId)) return record(failure(protocol, 404, "not_found_error", `No model ${modelId}.`))
  // Removing the inner echo joins an outer echo after its prefix could have escaped.
  const cut = Math.ceil(presented.length / 2)
  const reply = modelId === PROVIDER_MODEL.echoes
    ? [`${PROVIDER_ECHO_LEAD}${presented.slice(0, cut).repeat(2)}`, presented.slice(cut), presented.slice(cut)] : PROVIDER_REPLY
  const read = protocol === "openai-chat" && modelId === PROVIDER_MODEL.reads ? readsAnswer(modelId, body) : undefined
  if (read !== undefined) return record(read)
  const answer = record(
    protocol === "evaluation" ? evaluate(questions ?? {})
      : protocol === "anthropic-messages" ? anthropicStream(modelId, reply)
      : openaiStream(modelId, isRecord(body.stream_options) && body.stream_options.include_usage === true, reply)
  )
  if (modelId === PROVIDER_MODEL.slow) await Bun.sleep(slowMs)
  return answer
}

const server = Bun.serve({
  hostname: process.env.SMITHERS_MODEL_PROVIDER_HOSTNAME === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
  port,
  idleTimeout: 60,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (request.method === "GET" && pathname === PROVIDER_PATHS.ready) return new Response(null, { status: 204 })
    if (request.method === "GET" && pathname === PROVIDER_PATHS.journal) return json(200, journal)
    if (request.method !== "POST") return new Response("not found", { status: 404 })
    if (pathname === PROVIDER_PATHS.openaiChat) return serve("openai-chat", request)
    if (pathname === PROVIDER_PATHS.anthropic) return serve("anthropic-messages", request)
    if (pathname === PROVIDER_PATHS.evaluation) return serve("evaluation", request)
    return new Response("not found", { status: 404 })
  }
})
console.log(JSON.stringify({ event: "ready", origin: `http://127.0.0.1:${server.port}`, port: server.port }))
// stop(true) settles only when a handler in flight returns, and a slow answer is still asleep: down is now, so nothing awaits it.
process.once("SIGTERM", () => { void server.stop(true); process.exit(0) })
await new Promise<never>(() => {})
