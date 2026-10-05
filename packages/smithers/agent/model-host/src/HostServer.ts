/**
 * Authenticated Fetch binding for the shared model turn host.
 *
 * @since 1.0.0-rc.0
 */

import type * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import { AgentTurnCursorSchema } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnFrame, FetchLike, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { Cause, Effect, Exit, Metric, Option } from "effect"
import { createHash, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { runDurableChatTurn } from "./DurableChatProducer.ts"
import type { DurableChatGrant } from "./DurableChatProducer.ts"
import type { ProducerError, ResolveFailed } from "./ModelHostError.ts"
import { StreamTooLarge } from "./ModelHostError.ts"
import { runModelTurn } from "./ModelTurnHost.ts"
import type { ModelTurnOptions } from "./ModelTurnHost.ts"

/** The model host wire protocol identifier.
 *
 * @category protocol
 * @since 1.0.0-rc.0
 */
export const MODEL_HOST_PROTOCOL = "smithers.chat-model-host/v1"
/** The authenticated model turn endpoint.
 *
 * @category protocol
 * @since 1.0.0-rc.0
 */
export const MODEL_HOST_TURN_PATH = "/v1/chat/turn"
/** The authenticated sealed model stream endpoint.
 *
 * @category protocol
 * @since 1.0.0-rc.0
 */
export const MODEL_HOST_STREAM_PATH = "/v1/model/stream"
/** The protocol identity endpoint.
 *
 * @category protocol
 * @since 1.0.0-rc.0
 */
export const MODEL_HOST_HEALTH_PATH = "/health"

const Identity = z.string().min(1).max(160)
const WireGrantSchema = z.object({
  turnId: z.string().min(1).max(160),
  ownerId: z.number().int().positive(),
  repositoryId: z.number().int().positive().optional(),
  runId: Identity,
  legId: Identity,
  generation: z.number().int().positive(),
  token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  cursor: AgentTurnCursorSchema,
  expiresAt: z.string().min(1).max(64),
  request: z.unknown(),
  producerBaseUrl: z.string().url(),
  source: z.object({ repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/).max(201) }).strict().optional(),
  api: z.object({ author: Identity }).strict().optional()
}).strict()

/**
 * The model and projection options resolved inside the trusted host.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ModelTurnResolution {
  readonly model: Model.Model
  readonly options: ModelTurnOptions
}

/** Resolves the owner's configured provider inside the trusted host process.
 * Provider credentials stay in this result and never cross the Go grant wire.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ModelTurnResolver = (grant: DurableChatGrant) => Effect.Effect<ModelTurnResolution, ResolveFailed>

/**
 * Dependencies for the authenticated model host request handler.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ModelTurnHandlerOptions {
  readonly authorization: string
  readonly callbackBaseUrl: string
  readonly resolve: ModelTurnResolver
  readonly fetchImpl?: FetchLike
}

const normalizedBaseUrl = (raw: string): string => {
  const value = new URL(raw)
  if (
    (value.protocol !== "http:" && value.protocol !== "https:") || value.username !== "" || value.password !== "" ||
    value.search !== "" || value.hash !== ""
  ) {
    throw new Error("invalid model host callback URL")
  }
  value.pathname = "/"
  return value.toString()
}

const turnRequest = (value: unknown): StartAgentTurnRequest | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const body = value as Record<string, unknown>
  if (typeof body.runId !== "string" || typeof body.instructions !== "string" || !Array.isArray(body.messages)) {
    return undefined
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) return undefined
  return value as StartAgentTurnRequest
}

const decodeGrant = (value: unknown, callbackBaseUrl: string): DurableChatGrant | undefined => {
  const parsed = WireGrantSchema.safeParse(value)
  if (!parsed.success) return undefined
  const wire = parsed.data
  const request = turnRequest(wire.request)
  let producerBaseUrl: string
  try {
    producerBaseUrl = normalizedBaseUrl(wire.producerBaseUrl)
  } catch {
    return undefined
  }
  if (
    request === undefined || request.runId !== wire.runId || wire.cursor.runId !== wire.runId ||
    wire.cursor.legId !== wire.legId || producerBaseUrl !== callbackBaseUrl ||
    !Number.isFinite(Date.parse(wire.expiresAt)) || Date.parse(wire.expiresAt) <= Date.now()
  ) return undefined
  return {
    turnId: wire.turnId,
    ownerId: wire.ownerId,
    ...(wire.repositoryId === undefined ? {} : { repositoryId: wire.repositoryId }),
    runId: wire.runId,
    legId: wire.legId,
    generation: wire.generation,
    token: wire.token,
    cursor: wire.cursor,
    expiresAt: wire.expiresAt,
    request,
    producerBaseUrl: callbackBaseUrl,
    ...(wire.source === undefined ? {} : { source: wire.source }),
    ...(wire.api === undefined ? {} : { api: wire.api })
  }
}

const streamRequest = (value: unknown): StartAgentTurnRequest | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const body = value as Record<string, unknown>
  if (typeof body.runId !== "string" || !Array.isArray(body.messages)) return undefined
  if (body.tools !== undefined && !Array.isArray(body.tools)) return undefined
  return {
    ...body,
    instructions: typeof body.instructions === "string" ? body.instructions : ""
  } as StartAgentTurnRequest
}

const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * Reads at most MAX_BODY_BYTES of the body as JSON. The byte count is taken
 * while streaming, so a chunked body with no content-length is cancelled at
 * the limit instead of being buffered whole.
 */
const boundedJson = async (request: Request): Promise<unknown | undefined> => {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (!Number.isFinite(length) || length < 0 || length > MAX_BODY_BYTES) return undefined
  if (request.body === null) return undefined
  try {
    const reader = request.body.getReader()
    const chunks: Array<Uint8Array> = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        return undefined
      }
      chunks.push(value)
    }
    if (size === 0) return undefined
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
  } catch {
    return undefined
  }
}

/** The most NDJSON bytes one sealed stream response holds; the Go reader caps at the same 16 MiB. */
const MAX_STREAM_BYTES = 16 * 1024 * 1024

/**
 * Failed model host turns by failure class.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export const turnFailures = Metric.counter("smithers_model_host_turn_failures", {
  description: "Model host turns that ended in a refusal, by failure class"
})

/**
 * Model host turn wall time in milliseconds, by outcome.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export const turnDuration = Metric.histogram("smithers_model_host_turn_duration_ms", {
  description: "Model host turn wall time in milliseconds, by outcome",
  boundaries: Metric.exponentialBoundaries({ start: 100, factor: 2, count: 12 })
})

/**
 * What a failed turn is: the failure class, its provider or producer status,
 * and the response code the caller sees. Never the cause text.
 */
interface TurnFailure {
  readonly failure: string
  readonly status?: number
  readonly code?: string
  readonly response: "turn_failed" | "provider_quota" | "cancelled"
}

const classify = (cause: Cause.Cause<ResolveFailed | ProducerError | Model.ModelFailure>): TurnFailure => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (error === undefined) {
    return Cause.hasInterruptsOnly(cause)
      ? { failure: "Interrupted", response: "cancelled" }
      : { failure: "Defect", response: "turn_failed" }
  }
  if (error instanceof ModelError) {
    return {
      failure: "ModelFailure",
      code: error.code,
      response: error.code === "rate_limited" || error.code === "quota_exceeded" ? "provider_quota" : "turn_failed"
    }
  }
  return {
    failure: error._tag,
    ...("status" in error ? { status: error.status } : {}),
    response: "turn_failed"
  }
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest()

/**
 * The bearer check every model host route runs: compares the presented
 * Authorization header with `Bearer <authorization>` in constant time. Equal
 * length SHA-256 digests keep the comparison from leaking a prefix match.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const bearerAuthorization = (authorization: string): (request: Request) => boolean => {
  const expected = digest(`Bearer ${authorization}`)
  return (request) => {
    const presented = request.headers.get("authorization")
    return presented !== null && timingSafeEqual(digest(presented), expected)
  }
}

/**
 * Creates the Fetch handler shared by the local executable and Plue service.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const createModelTurnHandler = (options: ModelTurnHandlerOptions): (request: Request) => Promise<Response> => {
  if (options.authorization.trim() === "") throw new Error("model host authorization is required")
  const callbackBaseUrl = normalizedBaseUrl(options.callbackBaseUrl)
  const authorized = bearerAuthorization(options.authorization)
  return async (request) => {
    const url = new URL(request.url)
    if (url.pathname === MODEL_HOST_HEALTH_PATH && request.method === "GET") {
      return Response.json({ protocol: MODEL_HOST_PROTOCOL })
    }
    if (url.pathname === MODEL_HOST_STREAM_PATH) {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
      if (!authorized(request)) {
        return Response.json({ status: "error", code: "forbidden" }, { status: 401 })
      }
      const body = streamRequest(await boundedJson(request))
      if (body === undefined) return Response.json({ status: "error", code: "request_invalid" }, { status: 400 })
      const wireBody = body as unknown as Record<string, unknown>
      const ownerId = typeof wireBody.ownerId === "number" && Number.isSafeInteger(wireBody.ownerId)
        ? wireBody.ownerId :
        0
      const grant: DurableChatGrant = {
        turnId: `model-stream-${body.runId}`,
        ownerId,
        runId: body.runId,
        legId: body.runId,
        generation: 1,
        token: "model_stream_model_stream_model_stream_1234",
        cursor: { version: 1, runId: body.runId, legId: body.runId, batch: 0, position: 0, hash: "0".repeat(64) },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        request: body,
        producerBaseUrl: callbackBaseUrl
      }
      try {
        const resolved = await Effect.runPromise(options.resolve(grant), { signal: request.signal })
        const encoder = new TextEncoder()
        const lines: Array<string> = []
        let size = 0
        await Effect.runPromise(
          runModelTurn(resolved.model, body, resolved.options, (frame: AgentTurnFrame) => {
            const line = `${JSON.stringify(frame)}\n`
            size += encoder.encode(line).byteLength
            if (size > MAX_STREAM_BYTES) return Effect.fail(new StreamTooLarge({ limitBytes: MAX_STREAM_BYTES }))
            lines.push(line)
            return Effect.void
          }),
          { signal: request.signal }
        )
        return new Response(lines.join(""), {
          status: 200,
          headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" }
        })
      } catch {
        return Response.json({ status: "error", code: "stream_failed" }, { status: 502 })
      }
    }
    if (url.pathname !== MODEL_HOST_TURN_PATH) return new Response("Not found", { status: 404 })
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
    if (!authorized(request)) {
      return Response.json({ status: "error", code: "forbidden" }, { status: 401 })
    }
    const grant = decodeGrant(await boundedJson(request), callbackBaseUrl)
    if (grant === undefined) return Response.json({ status: "error", code: "request_invalid" }, { status: 400 })
    const started = performance.now()
    const exit = await Effect.runPromiseExit(
      options.resolve(grant).pipe(
        Effect.flatMap(({ model, options: modelOptions }) =>
          runDurableChatTurn(model, grant, modelOptions, callbackBaseUrl, options.fetchImpl)
        )
      ),
      { signal: request.signal }
    )
    const elapsed = performance.now() - started
    if (Exit.isSuccess(exit)) {
      await Effect.runPromise(Metric.update(Metric.withAttributes(turnDuration, { outcome: "success" }), elapsed))
      return new Response(null, { status: 204 })
    }
    // Provider and transport causes can hold signed requests, so the log line
    // and the response carry the failure class and status codes only. The
    // durable Go boundary records the generic terminal receipt after this
    // refusal.
    const failed = classify(exit.cause)
    await Effect.runPromise(
      Effect.logError("model host turn failed").pipe(
        Effect.annotateLogs({
          failure: failed.failure,
          ...(failed.status === undefined ? {} : { status: failed.status }),
          ...(failed.code === undefined ? {} : { code: failed.code }),
          turnId: grant.turnId,
          runId: grant.runId,
          generation: grant.generation,
          elapsedMs: Math.round(elapsed)
        }),
        Effect.andThen(Metric.update(Metric.withAttributes(turnFailures, { failure: failed.failure }), 1)),
        Effect.andThen(Metric.update(Metric.withAttributes(turnDuration, { outcome: "failure" }), elapsed))
      )
    )
    return Response.json({ status: "error", code: failed.response }, { status: 502 })
  }
}
