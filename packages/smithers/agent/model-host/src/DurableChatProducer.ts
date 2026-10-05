/**
 * Commits model frames to the durable Go turn journal under a fenced grant.
 *
 * @since 1.0.0-rc.0
 */

import type * as Model from "@smthrs/model/Model"
import {
  AgentTurnCursorSchema,
  agentTurnJournalDigestInput,
  AgentTurnJournalReplySchema
} from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnCursor, AgentTurnJournalReply } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnFrame, FetchLike, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { Effect } from "effect"
import { apiReader, hostOwned, runHostTurn, sourceReader } from "./HostTools.ts"
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
  fetchImpl: FetchLike = fetch.bind(globalThis)
): Effect.Effect<void, Model.ModelFailure | ProducerError> => {
  const producer = new DurableChatProducer(callbackBaseUrl, grant, fetchImpl)
  const write = (frame: AgentTurnFrame) => producer.write(frame)
  return Effect.gen(function*() {
    yield* producer.providerStarted()
    if (hostOwned(grant.request)) {
      yield* runHostTurn(model, grant, options, write, {
        read: sourceReader(callbackBaseUrl, grant, fetchImpl),
        api: apiReader(callbackBaseUrl, grant, fetchImpl)
      })
      return
    }
    yield* runModelTurn(model, grant.request, options, write)
  })
}
