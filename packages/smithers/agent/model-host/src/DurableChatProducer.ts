/**
 * Commits model frames to the durable Go turn journal under a fenced grant.
 *
 * @since 1.0.0-rc.0
 */

import type * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import {
  AgentTurnCursorSchema,
  agentTurnJournalDigestInput,
  AgentTurnJournalReplySchema
} from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnCursor, AgentTurnJournalReply } from "@smthrs/rpc/AgentTurnJournal"
import { ContextPreflightInputSchema } from "@smthrs/rpc/ContextPreflight"
import type { ContextPreflightFrame, ContextPreflightInput, ContextPreflightResult } from "@smthrs/rpc/ContextPreflight"
import type { AgentTurnFrame, FetchLike, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { Effect } from "effect"
import { runContextPreflight } from "./ContextPreflight.ts"
import { apiReader, hostOwned, runHostTurn, sourceLister, sourceReader } from "./HostTools.ts"
import { CommitRefused, ProducerUnreachable, ProviderStartRefused, ReceiptMismatch } from "./ModelHostError.ts"
import type { ProducerError } from "./ModelHostError.ts"
import { runModelTurn } from "./ModelTurnHost.ts"
import type { ModelTurnOptions } from "./ModelTurnHost.ts"

/**
 * One short-lived capability for an already accepted chat turn.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface DurableChatGrant {
  readonly turnId: string
  readonly ownerId: number
  readonly repositoryId?: number
  readonly runId: string
  readonly legId: string
  readonly generation: number
  readonly token: string
  readonly cursor: AgentTurnCursor
  readonly expiresAt: string
  readonly request: StartAgentTurnRequest
  readonly producerBaseUrl: string
  /** The mirrored repository the turn's author may read; absent until Source is ready for them. */
  readonly source?: { readonly repository: string }
  /**
   * The install API the turn's commands may read as its author, whose login
   * their private cards are addressed to; absent unless the credential that
   * admitted the turn is its author's browser session.
   */
  readonly api?: { readonly author: string }
}

type CommitReply = Extract<AgentTurnJournalReply, { readonly status: "committed" | "duplicate" }>

const unreachable = (step: ProducerUnreachable["step"]) => (): ProducerUnreachable =>
  new ProducerUnreachable({ step, message: "chat producer request failed" })

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const invalidReceipt = () => new ReceiptMismatch({ message: "chat producer commit returned an invalid receipt" })

const commitReply = (response: Response): Effect.Effect<CommitReply, CommitRefused | ReceiptMismatch> =>
  response.ok
    ? Effect.tryPromise({ try: () => response.json() as Promise<unknown>, catch: invalidReceipt }).pipe(
      Effect.flatMap((body) => {
        const parsed = AgentTurnJournalReplySchema.safeParse(body)
        return parsed.success && (parsed.data.status === "committed" || parsed.data.status === "duplicate")
          ? Effect.succeed(parsed.data)
          : Effect.fail(invalidReceipt())
      })
    )
    : Effect.fail(
      new CommitRefused({ status: response.status, message: `chat producer commit refused (${response.status})` })
    )

/**
 * Writes exact, hash-checked batches for one producer generation.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export class DurableChatProducer {
  private cursor: AgentTurnCursor
  private readonly callbackBaseUrl: string
  private readonly grant: DurableChatGrant
  private readonly fetchImpl: FetchLike

  constructor(
    callbackBaseUrl: string,
    grant: DurableChatGrant,
    fetchImpl: FetchLike = fetch.bind(globalThis)
  ) {
    this.callbackBaseUrl = callbackBaseUrl
    this.grant = grant
    this.fetchImpl = fetchImpl
    this.cursor = AgentTurnCursorSchema.parse(grant.cursor)
  }

  providerStarted(): Effect.Effect<void, ProducerUnreachable | ProviderStartRefused> {
    const url = new URL("/internal/chat/provider-started", this.callbackBaseUrl)
    url.searchParams.set("turnId", this.grant.turnId)
    url.searchParams.set("generation", String(this.grant.generation))
    return Effect.tryPromise({
      try: (signal) =>
        this.fetchImpl(url, {
          method: "POST",
          signal,
          headers: { authorization: `Bearer ${this.grant.token}` }
        }),
      catch: unreachable("provider_started")
    }).pipe(
      Effect.flatMap((response) =>
        response.ok ? Effect.void : Effect.fail(
          new ProviderStartRefused({
            status: response.status,
            message: `chat provider start refused (${response.status})`
          })
        )
      )
    )
  }

  writePreflight(
    phase: "started" | "completed",
    result: ContextPreflightResult
  ): Effect.Effect<void, ProducerError | ModelError> {
    return Effect.gen({ self: this }, function*() {
      const pages: Array<ContextPreflightResult> = []
      let current: ContextPreflightResult = { ...result, candidates: [], context: [] }
      const frame: ContextPreflightFrame = {
        runId: this.grant.runId,
        type: "context.preflight",
        phase,
        page: { index: Number.MAX_SAFE_INTEGER - 1, total: Number.MAX_SAFE_INTEGER },
        result: current
      }
      const bytes = (value: unknown) => new TextEncoder().encode(agentTurnJournalDigestInput("batch", value)).byteLength
      // Canonical sizes use the journal's own encoding. Worst-case cursor
      // digits and per-item digest prefixes conservatively cover all overhead.
      const overhead = bytes({
        version: 1,
        runId: this.grant.runId,
        legId: this.grant.legId,
        batch: Number.MAX_SAFE_INTEGER,
        from: Number.MAX_SAFE_INTEGER,
        previousHash: this.cursor.hash,
        hash: this.cursor.hash,
        frames: [frame]
      })
      if (overhead > 96 * 1024) {
        return yield* Effect.fail(
          new ModelError({ code: "invalid_provider_output", message: "preflight metadata exceeds journal limit" })
        )
      }
      let size = overhead
      for (const field of ["candidates", "context"] as const) {
        for (const item of result[field]) {
          const cost = bytes(item) + 1
          if (overhead + cost > 96 * 1024) {
            return yield* Effect.fail(
              new ModelError({ code: "invalid_provider_output", message: "preflight item exceeds journal limit" })
            )
          }
          if (size + cost > 96 * 1024) {
            pages.push(current)
            current = { ...result, candidates: [], context: [] }
            size = overhead
          }
          current = { ...current, [field]: [...current[field], item] }
          size += cost
        }
      }
      pages.push(current)
      // Finish preparing every page before the first write. A refused page
      // cannot authorize provider start or the following answer request.
      for (const [index, value] of pages.entries()) {
        yield* this.write({
          runId: this.grant.runId,
          type: "context.preflight",
          phase,
          page: { index, total: pages.length },
          result: value
        })
      }
    })
  }

  write(frame: AgentTurnFrame): Effect.Effect<void, ProducerError> {
    const expected = this.cursor
    const body = JSON.stringify({
      turnId: this.grant.turnId,
      generation: this.grant.generation,
      expected,
      frames: [frame]
    })
    const invoke = Effect.tryPromise({
      try: (signal) =>
        this.fetchImpl(new URL("/internal/chat/commit", this.callbackBaseUrl), {
          method: "POST",
          signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${this.grant.token}` },
          body
        }),
      catch: unreachable("commit")
    }).pipe(Effect.flatMap(commitReply))
    return invoke.pipe(
      Effect.catch(() => invoke),
      Effect.flatMap((reply) =>
        Effect.tryPromise({
          try: async () => {
            const expectedHash = await sha256Hex(agentTurnJournalDigestInput("batch", {
              version: 1,
              runId: expected.runId,
              legId: expected.legId,
              batch: expected.batch + 1,
              from: expected.position + 1,
              previousHash: expected.hash,
              frames: [frame]
            }))
            if (
              reply.batch.runId !== expected.runId || reply.batch.legId !== expected.legId ||
              reply.batch.batch !== expected.batch + 1 || reply.batch.from !== expected.position + 1 ||
              reply.batch.previousHash !== expected.hash || reply.batch.hash !== expectedHash ||
              reply.cursor.hash !== reply.batch.hash ||
              reply.cursor.batch !== reply.batch.batch ||
              reply.cursor.position !== reply.batch.from + reply.batch.frames.length - 1
            ) {
              throw new Error("receipt mismatch")
            }
            this.cursor = reply.cursor
          },
          catch: () => new ReceiptMismatch({ message: "chat producer receipt did not extend the committed cursor" })
        })
      )
    )
  }
}

/**
 * Streams a turn and durably commits each projected frame. A renderer that
 * offers tools gets one model leg and runs its tool calls itself; a host-owned
 * turn runs its tool calls on the host until the model answers.
 *
 * @category runners
 * @since 1.0.0-rc.0
 */
export const runDurableChatTurn = (
  model: Model.Model,
  grant: DurableChatGrant,
  options: ModelTurnOptions,
  callbackBaseUrl: string = grant.producerBaseUrl,
  fetchImpl: FetchLike = fetch.bind(globalThis),
  preflight?: { readonly input: ContextPreflightInput; readonly model: Model.Model; readonly options: ModelTurnOptions }
): Effect.Effect<void, Model.ModelFailure | ProducerError> => {
  const producer = new DurableChatProducer(callbackBaseUrl, grant, fetchImpl)
  const write = (frame: AgentTurnFrame) => producer.write(frame)
  return Effect.gen(function*() {
    // Shared prompt admission must never degrade to a transcript-only answer
    // while the authorized host context provider is unavailable.
    if (grant.request.sharedConversation === true && preflight === undefined) {
      return yield* Effect.fail(
        new ModelError({ code: "invalid_provider_output", message: "shared conversation preflight is unavailable" })
      )
    }
    // Selected content is only supplied by the trusted provider; a renderer
    // cannot pass its own selection or private transcript through this path.
    const { selectedContext: _untrustedSelection, ...request } = grant.request
    let prepared: DurableChatGrant = { ...grant, request }
    if (preflight !== undefined) {
      const decoded = ContextPreflightInputSchema.safeParse(preflight.input)
      if (!decoded.success) {
        return yield* Effect.fail(
          new ModelError({ code: "invalid_provider_output", message: "context preflight input is invalid" })
        )
      }
      // Prove durable step writes before spending on either model. A failed
      // start receipt never permits the selector or answer request.
      yield* producer.writePreflight("started", {
        context: [],
        candidates: decoded.data.candidates.filter((candidate) =>
          !decoded.data.wikiOnly || candidate.item.kind === "page"
        ).map((candidate) => candidate.item),
        model: preflight.options.modelId,
        durationMs: 0
      })
      yield* producer.providerStarted()
      const answer = yield* runContextPreflight(decoded.data, preflight.model, preflight.options)
      yield* producer.writePreflight("completed", answer.result)
      prepared = {
        ...grant,
        request: { ...request, messages: answer.messages, selectedContext: answer.selectedContext }
      }
    }
    if (preflight === undefined) yield* producer.providerStarted()
    if (hostOwned(prepared.request)) {
      yield* runHostTurn(model, prepared, options, write, {
        read: sourceReader(callbackBaseUrl, grant, fetchImpl),
        list: sourceLister(callbackBaseUrl, grant, fetchImpl),
        api: apiReader(callbackBaseUrl, grant, fetchImpl)
      })
      return
    }
    yield* runModelTurn(model, prepared.request, options, write)
  })
}
