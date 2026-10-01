/**
 * Native agent event and control payloads.
 *
 * @since 1.0.0
 */

import { z } from "zod"
import type { AgentRuntimeContext } from "./AgentContext.ts"
import type { AgentRoleId, CloudRoleId } from "./AgentRoles.ts"
import { CardPatchSchema, CardSchema } from "./Cards.ts"
import type { ModelBinding } from "./ConfiguredModel.ts"

/**
 * The fetch like contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

/*
 * The chat turn message contract, matching the landed chat worker
 * (flows/ui workers/chat/src/index.ts validateBody): plain role messages,
 * plus the function_call / function_call_output items a tool-loop
 * continuation turn carries.
 */
/**
 * The agent chat message contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentChatMessage =
  | { readonly role: "user" | "assistant"; readonly content: string }
  | {
    readonly type: "function_call"
    readonly call_id: string
    readonly name: string
    readonly arguments: string
  }
  | {
    readonly type: "function_call_output"
    readonly call_id: string
    readonly output: string
  }

/** The OpenAI JSON-schema function tool spec the chat worker passes upstream.
 * @since 1.0.0
 * @category models
 */
export interface AgentToolSpec {
  readonly type: "function"
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

/**
 * The start agent turn request contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface StartAgentTurnRequest {
  readonly runId: string
  /** Existing durable conversation branch; older hosts/turns remain per-run. */
  readonly conversationId?: string
  /** Stable per-leg identity and private replay capability, written locally before the POST. */
  readonly journal?: import("./AgentTurnJournal.ts").AgentTurnJournalRequest
  readonly messages: ReadonlyArray<AgentChatMessage>
  readonly instructions: string
  /** The tool specs offered this turn; the worker forwards them untouched. */
  readonly tools?: ReadonlyArray<AgentToolSpec>
  /**
   * The freshly-derived runtime context for THIS turn (AgentContext.ts). Hidden
   * context: it rides the wire to the server boundary, which renders it into the
   * upstream instructions — it is never persisted into the visible transcript.
   */
  readonly context?: AgentRuntimeContext
  /**
   * The model tier this turn asks for. A side turn that only has to pick the
   * next click (the recommender) asks for `cheap`; the conversation's own turns
   * leave it unset and get the deployment's default. The hint rides the wire
   * untouched; the serving side maps it to a configured model.
   */
  readonly tier?: "cheap" | "default"
  /**
   * What the turn is for. Unset (or "conversation") is the transcript's own
   * turn; "recommend" is the background next-step read, which a scripted or
   * stub seam must not treat as the conversation's next leg; "explain",
   * "librarian" and "flows" are the concierge's side turns.
   */
  readonly purpose?: "conversation" | "recommend" | "explain" | "librarian" | "flows"
  /**
   * The named role this turn asks to be answered by (AgentRoles.ts): the
   * conversation's own turns are the orchestrator's; `explain` asks for the
   * explainer. A cloud role (`librarian`, `flows`) is answered by the app
   * Worker itself on Cerebras and admits no tools. Otherwise a hint like
   * `tier`: the serving side maps it to a model or ignores it, and the
   * client never claims a model it was not told about.
   */
  readonly role?: AgentRoleId | CloudRoleId
  /**
   * The generation model a SEALED side turn asks to be answered on (seat
   * `explainer`, ConfiguredModel.ts). Unlike `tier` and `role` this is not a
   * hint: a serving side that cannot serve the binding refuses the turn, and
   * a turn carrying it plus tools is `tools_not_supported`. Never a fallback.
   */
  readonly model?: ModelBinding
}

/**
 * The start agent turn result contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type StartAgentTurnResult =
  | { readonly status: "started" }
  | { readonly status: "error"; readonly message: string; readonly refusal?: TurnRefusal }

/**
 * A turn the boundary refused BEFORE it reached a model, stated by code so a
 * client can branch on what happened rather than on the sentence. Today the
 * codes are sign-in (`401 sign_in_required`) and the turn ceiling
 * (`429 turn_rate_limited`, apps/server turnLimit.ts): `message` is the refusal
 * sentence the server wrote for a person, and `retryAt` is its ISO reset time
 * when the body carried one.
 *
 * @since 1.0.0
 * @category models
 */
export interface TurnRefusal {
  readonly code: "turn_rate_limited" | "sign_in_required" | "out_of_credit"
  readonly message: string
  readonly retryAt: string | null
}

/*
 * Why a turn's stream ended, per the chat tool-loop contract. `cancelled` is
 * the product Worker's own terminal reason: a server-side kill through
 * /api/agent/turn/cancel ends the turn's stream with it so the client renders
 * the kill honestly instead of watching the stream silently stop.
 */
/**
 * Validates agent turn done reason values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentTurnDoneReasonSchema = z.enum(["stop", "tool_call", "tool_limit", "cancelled"])

/*
 * The chain frame vocabulary (DESIGN.md §14). These schemas MIRROR the
 * `@smthrs/chain` journal event union — they never import it: @smthrs/rpc stays
 * runtime-free zod so the Worker and both bridges can speak the envelope
 * without pulling effect. On a chain turn `runId` is the lineage id.
 */

/** The chain's gate observations, plus the two execution-produced kinds.
 * @since 1.0.0
 * @category schemas
 */
export const ChainGateKindSchema = z.enum([
  "shape",
  "fuel",
  "catalog",
  "denied",
  "call_failed",
  "script_failed"
])

/** Why a lineage parked — the chain's suspension reason vocabulary.
 * @since 1.0.0
 * @category schemas
 */
export const ChainParkCodeSchema = z.enum(["approval", "event", "timer", "quota", "plugin"])

/** How a settled call resolved: executed live, cache hit, or replayed prefix.
 * @since 1.0.0
 * @category schemas
 */
export const ChainCallVerdictSchema = z.enum(["run", "hit", "replay"])

/** How a link ended: the three trampoline outcomes.
 * @since 1.0.0
 * @category schemas
 */
export const ChainLinkOutcomeSchema = z.enum(["done", "to", "park"])

/**
 * Token counts of the one model call a `done` frame ends. `inputTokens`
 * includes cached input, so `cachedInputTokens / inputTokens` is the cache hit
 * rate and `inputTokens` is the context the call consumed.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentTurnUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional()
})

/**
 * Token counts of one model call, as carried by a `done` frame.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentTurnUsage = z.infer<typeof AgentTurnUsageSchema>

/*
 * One frame of a streamed agent turn — the single contract the native Electrobun
 * bridge, the pure-web `/api/agent` boundary, and the Cloudflare Worker all speak.
 * `card` / `card.update` carry the structured surfaces (plan, approval, status)
 * the client renders from its store with zero UI change (DESIGN.md §5).
 * `tool_call` is the chat worker's tool-loop frame (Wave 3b): the client
 * executes it against the command registry and POSTs a continuation turn; it
 * retires with the client tool loop when the chain backend reaches parity.
 * The `link.*` / `call.*` / `gate.rejected` / `steering.drained` / `park`
 * family streams a chain turn (DESIGN.md §14): frames carry what live
 * rendering needs; the chainEvents journal remains the full evidence.
 */
/**
 * Validates agent turn frame values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentTurnFrameSchema = z.discriminatedUnion("type", [
  z.object({
    runId: z.string(),
    type: z.literal("delta"),
    kind: z.enum(["reasoning", "text"]),
    text: z.string()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("done"),
    reason: AgentTurnDoneReasonSchema.optional(),
    code: z.literal("credential_missing").optional(),
    error: z.string().optional(),
    usage: AgentTurnUsageSchema.optional()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("card"),
    card: CardSchema
  }),
  z.object({
    runId: z.string(),
    type: z.literal("card.update"),
    id: z.string(),
    patch: CardPatchSchema
  }),
  z.object({
    runId: z.string(),
    type: z.literal("tool_call"),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("link.authored"),
    link: z.number().int().nonnegative(),
    scriptDigest: z.string(),
    script: z.string()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("call.started"),
    link: z.number().int().nonnegative(),
    ordinal: z.number().int().nonnegative(),
    name: z.string()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("call.settled"),
    link: z.number().int().nonnegative(),
    ordinal: z.number().int().nonnegative(),
    name: z.string(),
    verdict: ChainCallVerdictSchema,
    resultDigest: z.string().optional()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("gate.rejected"),
    link: z.number().int().nonnegative(),
    kind: ChainGateKindSchema,
    message: z.string().optional()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("link.ended"),
    link: z.number().int().nonnegative(),
    outcome: ChainLinkOutcomeSchema
  }),
  z.object({
    runId: z.string(),
    type: z.literal("steering.drained"),
    link: z.number().int().nonnegative(),
    count: z.number().int().positive()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("park"),
    code: ChainParkCodeSchema,
    card: CardSchema.optional()
  })
])
/**
 * The decoded value accepted by {@link AgentTurnFrameSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentTurnFrame = z.infer<typeof AgentTurnFrameSchema>

/*
 * Frames carry card schemas whose fields default (`RunRecord.labels`,
 * `GraphNode.private`), so a value that merely validates is not yet an
 * `AgentTurnFrame`: forwarding the input under that type hands subscribers a
 * value missing fields the type declares required. Every boundary that
 * forwards a frame decodes it here and publishes the decoded value.
 */
/**
 * Decodes an agent turn frame, applying the schema defaults, or answers null.
 *
 * @since 1.0.0
 * @category conversions
 */
export const decodeAgentTurnFrame = (value: unknown): AgentTurnFrame | null => {
  const parsed = AgentTurnFrameSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
