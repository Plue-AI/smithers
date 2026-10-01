/**
 * Versioned acceptance, replay and erasure contracts for durable chat output.
 *
 * @since 1.0.0
 */

import { canonicalize } from "@smthrs/canonical/Serializer"
import { z } from "zod"
import { AgentTurnFrameSchema } from "./NativeAgent.ts"

const Hash = z.string().regex(/^[0-9a-f]{64}$/)
const Position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const Identity = z.string().min(1).max(160)

/** A committed batch boundary, never a count of bytes received from a socket.
 * @since 1.0.0
 * @category schemas
 */
export const AgentTurnCursorSchema = z.object({
  version: z.literal(1),
  runId: Identity,
  legId: Identity,
  batch: Position,
  position: Position,
  hash: Hash
}).strict()

/** The browser applies a complete batch and its cursor in one local transaction.
 * @since 1.0.0
 * @category models
 */
export type AgentTurnCursor = z.infer<typeof AgentTurnCursorSchema>

/** Exact decoded output accepted by the producer, including the terminal frame.
 * @since 1.0.0
 * @category schemas
 */
export const AgentTurnBatchSchema = z.object({
  version: z.literal(1),
  runId: Identity,
  legId: Identity,
  batch: Position.positive(),
  from: Position.positive(),
  previousHash: Hash,
  frames: z.array(AgentTurnFrameSchema).min(1).max(256),
  hash: Hash
}).strict()

/** Replayable output and its integrity link to the previous accepted batch.
 * @since 1.0.0
 * @category models
 */
export type AgentTurnBatch = z.infer<typeof AgentTurnBatchSchema>

/** Private acceptance evidence; raw prompts, model context and access tokens are absent.
 * @since 1.0.0
 * @category schemas
 */
export const AgentTurnAcceptanceSchema = z.object({
  version: z.literal(1),
  runId: Identity,
  legId: Identity,
  ownerHash: Hash,
  accessHash: Hash,
  requestHash: Hash,
  writerHash: Hash,
  acceptedAt: z.number().finite(),
  hash: Hash
}).strict()

/** Private turn acceptance evidence. A retry cannot obtain the original writer capability.
 * @since 1.0.0
 * @category models
 */
export type AgentTurnAcceptance = z.infer<typeof AgentTurnAcceptanceSchema>

/** The sole visibility commit for an accepted prefix of output batches.
 * @since 1.0.0
 * @category schemas
 */
export const AgentTurnJournalHeadSchema = z.object({
  version: z.literal(1),
  acceptance: AgentTurnAcceptanceSchema,
  cursor: AgentTurnCursorSchema,
  bytes: Position,
  terminal: z.boolean(),
  hash: Hash
}).strict()

/** Operational head derived from acceptance plus the committed batch prefix.
 * @since 1.0.0
 * @category models
 */
export type AgentTurnJournalHead = z.infer<typeof AgentTurnJournalHeadSchema>

/** Content-free retirement; deletion can resume after a process dies during erasure.
 * @since 1.0.0
 * @category schemas
 */
export const AgentTurnRetirementSchema = z.object({
  version: z.literal(1),
  retired: z.literal(true),
  runId: Identity,
  legId: Identity,
  // Null means erasure won before acceptance; no prior fact is invented.
  ownerHash: Hash.nullable(),
  accessHash: Hash,
  acceptanceHash: Hash.nullable(),
  batches: Position,
  erasedBatches: Position,
  retiredAt: z.number().finite(),
  hash: Hash
}).strict()

/** A retired identity remains unavailable for inference even after its output is erased.
 * @since 1.0.0
 * @category models
 */
export type AgentTurnRetirement = z.infer<typeof AgentTurnRetirementSchema>

/** Internal requests between an authenticated host and its per-leg durable object.
 * @since 1.0.0
 * @category schemas
 */
export const AgentTurnJournalCommandSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("accept"),
    runId: Identity,
    legId: Identity,
    ownerHash: Hash,
    accessHash: Hash,
    requestHash: Hash,
    writerHash: Hash
  }).strict(),
  z.object({
    operation: z.literal("append"),
    writerHash: Hash,
    expected: AgentTurnCursorSchema,
    frames: z.array(AgentTurnFrameSchema).min(1).max(256)
  }).strict(),
  z.object({
    operation: z.literal("read"),
    ownerHash: Hash,
    accessHash: Hash,
    after: AgentTurnCursorSchema.nullable(),
    limit: z.number().int().min(1).max(16)
  }).strict(),
  z.object({ operation: z.literal("retire"), ownerHash: Hash, accessHash: Hash }).strict(),
  z.object({ operation: z.literal("erase"), runId: Identity, legId: Identity, accessHash: Hash }).strict()
])

/** The private producer protocol. A public caller never supplies an owner hash directly.
 * @since 1.0.0
 * @category models
 */
export type AgentTurnJournalCommand = z.infer<typeof AgentTurnJournalCommandSchema>

/** The read capability is persisted before the first POST and never put in a URL.
 * @since 1.0.0
 * @category schemas
 */
export const AgentTurnJournalRequestSchema = z.object({
  version: z.literal(1),
  legId: Identity,
  token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/)
}).strict()

/** Stable leg identity and its private replay capability.
 * @since 1.0.0
 * @category models
 */
export type AgentTurnJournalRequest = z.infer<typeof AgentTurnJournalRequestSchema>

const AgentTurnJournalErrorCodeSchema = z.enum([
  "request_invalid",
  "storage_failed",
  "not-found",
  "forbidden",
  "retired",
  "conflict",
  "cursor",
  "terminal",
  "limit",
  "corrupt"
])

/** Decoded private reply; private prompts/capabilities are not part of any reply.
 * @since 1.0.0
 * @category models
 */
export type AgentTurnJournalReply =
  | { status: "accepted" | "existing"; cursor: AgentTurnCursor; terminal: boolean }
  | { status: "committed" | "duplicate"; batch: AgentTurnBatch; cursor: AgentTurnCursor }
  | {
    status: "ok"
    after: AgentTurnCursor
    next: AgentTurnCursor
    head: AgentTurnCursor
    terminal: boolean
    more: boolean
    batches: AgentTurnBatch[]
  }
  | { status: "retired" }
  | { status: "error"; code: z.infer<typeof AgentTurnJournalErrorCodeSchema> }

/** Typed answers from the private journal boundary.
 * @since 1.0.0
 * @category schemas
 */
export const AgentTurnJournalReplySchema: z.ZodType<AgentTurnJournalReply> = z.union([
  z.object({ status: z.enum(["accepted", "existing"]), cursor: AgentTurnCursorSchema, terminal: z.boolean() }).strict(),
  z.object({ status: z.enum(["committed", "duplicate"]), batch: AgentTurnBatchSchema, cursor: AgentTurnCursorSchema })
    .strict(),
  z.object({
    status: z.literal("ok"),
    after: AgentTurnCursorSchema,
    next: AgentTurnCursorSchema,
    head: AgentTurnCursorSchema,
    terminal: z.boolean(),
    more: z.boolean(),
    batches: z.array(AgentTurnBatchSchema)
  }).strict(),
  z.object({ status: z.literal("retired") }).strict(),
  z.object({ status: z.literal("error"), code: AgentTurnJournalErrorCodeSchema }).strict()
])

/** Public resume/retirement payload; authenticated owner is supplied by the host.
 * @since 1.0.0
 * @category schemas
 */
export const AgentTurnJournalAccessSchema = z.object({
  runId: Identity,
  journal: AgentTurnJournalRequestSchema,
  after: AgentTurnCursorSchema.nullable().optional()
}).strict()

/** Delete-only authority survives sign-out without retaining a replay token.
 * The proof is SHA256(agentTurnJournalDigestInput("access", replayToken)).
 * It cannot authorize a read and can retire an identity before acceptance.
 * @since 1.0.0
 * @category schemas
 */
export const AgentTurnErasureSchema = z.object({
  runId: Identity,
  legId: Identity,
  retirementProof: Hash
}).strict()

/** Content-free references from committed public run cards, never tool results.
 * @since 1.0.0
 * @category schemas
 */
export const ConversationRunReferenceSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  runId: Identity,
  workspaceId: Identity.optional()
}).strict()

/** Account index pages can repeat a conversation across turn pages.
 * @since 1.0.0
 * @category schemas
 */
export const AgentConversationPageSchema = z.object({
  status: z.literal("ok"),
  conversations: z.array(
    z.object({
      id: Identity,
      turns: z.array(
        z.object({
          runId: Identity,
          legId: Identity,
          acceptedAt: z.number().finite(),
          terminal: z.boolean(),
          runLinks: z.array(ConversationRunReferenceSchema).max(64)
        }).strict()
      ).max(50)
    }).strict()
  ).max(50),
  next: z.string().min(1).max(512).nullable()
}).strict()
/** One bounded account conversation index page.
 * @since 1.0.0
 * @category models
 */
export type AgentConversationPage = z.infer<typeof AgentConversationPageSchema>
/** An identifier-only public run reference.
 * @since 1.0.0
 * @category models
 */
export type ConversationRunReference = z.infer<typeof ConversationRunReferenceSchema>

/** An account-scoped read cursor with no originating-device secret.
 * @since 1.0.0
 * @category schemas
 */
export const AgentConversationReplayAccessSchema = z.object({
  runId: Identity,
  legId: Identity,
  after: AgentTurnCursorSchema.nullable().optional()
}).strict()
/** The identity and optional cursor of a saved leg.
 * @since 1.0.0
 * @category models
 */
export type AgentConversationReplayAccess = z.infer<typeof AgentConversationReplayAccessSchema>

/** A visible user message plus the same committed output contract. No context or capabilities.
 * @since 1.0.0
 * @category schemas
 */
export const AgentConversationReplaySchema = z.object({
  status: z.literal("ok"),
  conversationId: Identity,
  userText: z.string().max(2 << 20),
  page: AgentTurnJournalReplySchema.refine((page) => page.status === "ok")
}).strict()
/** Verified committed output plus its visible conversation identity.
 * @since 1.0.0
 * @category models
 */
export type AgentConversationReplay = z.infer<typeof AgentConversationReplaySchema>

/** Minimal private erasure outbox entry; no transcript or read capability.
 * @since 1.0.0
 * @category models
 */
export type AgentTurnErasure = z.infer<typeof AgentTurnErasureSchema>

/** NDJSON delivered by the journal transport, distinct from legacy frame delivery.
 * @since 1.0.0
 * @category schemas
 */
export const AgentTurnJournalDeliverySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accepted"), cursor: AgentTurnCursorSchema }).strict(),
  z.object({ type: z.literal("batch"), batch: AgentTurnBatchSchema, cursor: AgentTurnCursorSchema }).strict(),
  z.object({ type: z.literal("caught-up"), cursor: AgentTurnCursorSchema, terminal: z.boolean() }).strict()
])

/** One accepted boundary, output batch, or catch-up observation on the transport.
 * @since 1.0.0
 * @category models
 */
export type AgentTurnJournalDelivery = z.infer<typeof AgentTurnJournalDeliverySchema>

/** Stable v1 digest input. Domain separation is part of the persisted contract.
 * @since 1.0.0
 * @category encoding
 */
export const agentTurnJournalDigestInput = (
  kind: "acceptance" | "batch" | "head" | "retirement" | "scope" | "owner" | "access" | "writer" | "request",
  value: unknown
): string => `smithers-agent-turn/${kind}/v1:${canonicalize(value)}`

/** A batch that does not extend the journal's accepted prefix: wrong run,
 * leg, batch number, position or previous hash, or frames after `done`.
 * @since 1.0.0
 * @category errors
 */
export class AgentTurnBatchRejected extends Error {
  readonly _tag = "AgentTurnBatchRejected"
  constructor() {
    super("The turn batch does not extend its accepted prefix.")
    this.name = "AgentTurnBatchRejected"
  }
}

/** Pure batch projection; hash verification is the caller's admission boundary.
 * @since 1.0.0
 * @category projections
 */
export const projectAgentTurnBatch = (
  previous: AgentTurnJournalHead,
  batch: AgentTurnBatch
): Omit<AgentTurnJournalHead, "hash"> => {
  const cursor = previous.cursor
  if (
    previous.terminal || batch.runId !== cursor.runId || batch.legId !== cursor.legId ||
    batch.batch !== cursor.batch + 1 || batch.from !== cursor.position + 1 || batch.previousHash !== cursor.hash ||
    batch.frames.some((frame) => frame.runId !== cursor.runId) ||
    batch.frames.slice(0, -1).some((frame) => frame.type === "done")
  ) {
    throw new AgentTurnBatchRejected()
  }
  const bytes = new TextEncoder().encode(canonicalize(batch)).byteLength
  return {
    version: 1,
    acceptance: previous.acceptance,
    cursor: { ...cursor, batch: batch.batch, position: cursor.position + batch.frames.length, hash: batch.hash },
    bytes: previous.bytes + bytes,
    terminal: batch.frames.at(-1)?.type === "done"
  }
}
