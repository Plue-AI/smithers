import * as Effect from "effect/Effect"
import { routeRefusal } from "./Responses"
/**
 * The cloud roles: turns the Worker answers itself, on Cerebras.
 *
 * A turn body may name the role it wants answered by (`role`, AgentRoles.ts).
 * Most roles are hints the chat upstream maps to a model. A CLOUD role
 * (`librarian`, `flows`; CLOUD_AGENT_ROLES) is different: this Worker holds
 * the deployment's own Cerebras key, and these roles are all that spend it
 * (the composer pills and the front door are Jev's, with no Cerebras path at
 * all: src/recommend.ts), so the turn
 * is served here, on the free Cerebras seat, and never reaches the chat
 * upstream. That makes "the Librarian and the Flows agent run on Cerebras"
 * a fact this repository tests instead of a hint an upstream may ignore.
 *
 * What a cloud role turn is NOT: it carries no tools and no tool-loop
 * continuation items, because a Cerebras chat completion is one sealed
 * answer; a body that carries either is refused with 400, as the model relay
 * refuses tool-bearing author calls. It holds no cancel-registry entry: the
 * completion is one bounded call, so there is nothing a kill could interrupt
 * and a cancel answers an honest not-found. The router spends the same
 * ceilings before calling here that it spends on an upstream turn (the
 * login's, or the anonymous address and deployment buckets), so a visitor's
 * twenty questions a day are twenty whether Smithers or the Librarian
 * answers.
 *
 * The client going away is the fiber's interruption (src/Boundary.ts): it
 * aborts the provider call and the boundary answers 499, so nothing here
 * watches a signal.
 *
 * First cut: one non-streaming completion becomes one text delta and one
 * done frame, tagged with the body's runId like every other turn stream.
 * Translating the provider's SSE stream into deltas is a follow-up.
 */
import { composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import { AGENT_ROLE_ID, cloudRole, cloudRoleModelId, isCloudRoleId } from "@smthrs/rpc/AgentRoles"
import type { CloudRole } from "@smthrs/rpc/AgentRoles"
import type { AgentChatMessage, AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { ServerConfig } from "./Config"
import type { ServerConfigShape } from "./Config"
import type { Transport } from "./Http"
import { cerebrasChat } from "./recommend"
import type { CerebrasChatMessage } from "./recommend"

/** How long a cloud role completion gets, in ms. Cerebras answers in seconds; a side turn that takes longer has failed. */
export const CLOUD_ROLE_TIMEOUT_MS = 30_000
/** The most tokens one answer may carry: a few paragraphs with citations, not an essay. */
export const CLOUD_ROLE_MAX_TOKENS = 1024
/** Low, not zero: the answer is prose a person reads, not JSON a parser does. */
export const CLOUD_ROLE_TEMPERATURE = 0.2
/**
 * Low, not unset: the default Cerebras model reasons at `high` when the body
 * says nothing, and these are short answers off a supplied context, so an
 * unstated effort would spend the 1024-token budget thinking instead of
 * answering. Stated here so the cost does not move when the model does.
 */
export const CLOUD_ROLE_REASONING_EFFORT = "low" as const
/** The most characters a `purpose` hint may carry; longer is dropped, never refused. */
export const TURN_PURPOSE_MAX_CHARS = 200
/** The most characters a `role` hint may carry (AGENT_ROLE_ID allows 41); longer is dropped, never refused. */
export const TURN_ROLE_MAX_CHARS = 40

const TIERS: ReadonlyArray<string> = ["cheap", "default"]

/**
 * The three optional hints a turn body may carry, as this Worker reads them:
 * `tier` is one of the two named tiers; `purpose` and `role` are bounded
 * strings, wider than the client contract's unions on purpose, because a
 * client with a newer vocabulary than this Worker still gets its turn.
 */
export interface TurnHints {
  readonly tier?: "cheap" | "default"
  readonly purpose?: string
  readonly role?: string
}

/** A turn body after `turnHints` read it: the client contract with the hints bounded, not enumerated. */
export type TurnRequest = Omit<StartAgentTurnRequest, "tier" | "purpose" | "role"> & TurnHints

/**
 * The hints a turn body carries, read leniently: a `tier` that is not one
 * of the two named tiers, a `purpose` over 200 characters, or a `role` that
 * is not a role id of at most 40 characters is DROPPED, never refused. A
 * hint is advice about which model answers; a client with a newer vocabulary
 * than this Worker must still get its turn, on the default model.
 */
export const turnHints = (body: object): TurnHints => {
  const raw = body as { readonly tier?: unknown; readonly purpose?: unknown; readonly role?: unknown }
  const hints: { tier?: TurnHints["tier"]; purpose?: string; role?: string } = {}
  if (typeof raw.tier === "string" && TIERS.includes(raw.tier)) hints.tier = raw.tier as TurnHints["tier"]
  if (typeof raw.purpose === "string" && raw.purpose !== "" && raw.purpose.length <= TURN_PURPOSE_MAX_CHARS) {
    hints.purpose = raw.purpose
  }
  if (typeof raw.role === "string" && raw.role.length <= TURN_ROLE_MAX_CHARS && AGENT_ROLE_ID.test(raw.role)) {
    hints.role = raw.role
  }
  return hints
}

/** Whether this turn names a cloud role, which the Worker serves itself. */
export const isCloudRoleTurn = (body: TurnRequest): boolean =>
  body.role !== undefined && isCloudRoleId(body.role)

/** The model id the deployment serves a cloud role on: the configured override, else the table default. */
export const cloudRoleModel = (role: CloudRole, config: Pick<ServerConfigShape, "cerebrasModelLibrarian" | "cerebrasModelFlows">): string =>
  cloudRoleModelId(role, {
    CEREBRAS_MODEL_LIBRARIAN: config.cerebrasModelLibrarian,
    CEREBRAS_MODEL_FLOWS: config.cerebrasModelFlows
  })

const isPlainMessage = (message: AgentChatMessage): message is { readonly role: "user" | "assistant"; readonly content: string } =>
  "role" in message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string"

/**
 * The messages a cloud role reads: the composed instructions (the client's
 * text plus the hidden runtime context, rendered server-side exactly as the
 * upstream turn renders them) as the system message, then the transcript.
 * Undefined when the transcript carries a tool-loop item, which no cloud
 * role can continue.
 */
export const cloudRoleMessages = (body: TurnRequest): ReadonlyArray<CerebrasChatMessage> | undefined => {
  if (!body.messages.every(isPlainMessage)) return undefined
  return [
    { role: "system", content: composeAgentInstructions(body.instructions, body.context) },
    ...body.messages.map((message) => ({ role: message.role, content: message.content }))
  ]
}

/* This route's own refusal: the code names the status, and the caller's headers ride along. */
const refusal = routeRefusal

const ndjson = (frames: ReadonlyArray<AgentTurnFrame>, headers: Record<string, string>): Response =>
  new Response(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""), {
    status: 200,
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", ...headers }
  })

/**
 * Serve one cloud role turn. The caller has already parsed the body, seen
 * `isCloudRoleTurn`, and spent the ceilings. Order: the body's shape first (a
 * refusal there costs nothing), then the key, then the model. A failure is
 * JSON with the status that names it (503 no key, 429 the provider's own
 * limit, 502 the provider failed or is unreachable, 504 the deadline; the
 * client leaving interrupts the fiber and the boundary answers 499); a
 * success is the NDJSON turn stream every other turn answers with.
 */
export const handleCloudRoleTurn = (
  body: TurnRequest,
  headers: Record<string, string>
): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function*() {
    if (body.role === undefined || !isCloudRoleId(body.role)) {
      return refusal("request_invalid", "Not a cloud role turn.", headers)
    }
    const role = cloudRole(body.role)
    if (body.tools !== undefined && body.tools.length > 0) {
      return refusal(
        "tools_not_supported",
        `The ${role.label} answers one question at a time and runs no tools; send this turn without tools.`,
        headers
      )
    }
    const messages = cloudRoleMessages(body)
    if (messages === undefined) {
      return refusal(
        "tools_not_supported",
        `The ${role.label} runs no tools, so it cannot continue a tool call; send plain messages only.`,
        headers
      )
    }
    const config = yield* ServerConfig
    if (config.cerebrasApiKey === undefined) {
      return refusal("seam_not_configured", `The ${role.label} isn't available on this deployment.`, headers, {
        seam: role.label,
        cause: "CEREBRAS_API_KEY is unset"
      })
    }
    const model = cloudRoleModel(role, config)
    const answer = yield* cerebrasChat({
      model,
      messages,
      maxTokens: CLOUD_ROLE_MAX_TOKENS,
      temperature: CLOUD_ROLE_TEMPERATURE,
      reasoningEffort: CLOUD_ROLE_REASONING_EFFORT
    }, CLOUD_ROLE_TIMEOUT_MS)
    if (!answer.ok) {
      switch (answer.reason) {
        case "http":
          return answer.status === 429
            ? refusal("model_rate_limited", `The ${role.label}'s model service answered HTTP 429.`, headers)
            : refusal("upstream_refused", `The ${role.label}'s model service answered HTTP ${answer.status}.`, headers)
        case "empty":
          return refusal("model_no_answer", `The ${role.label}'s model service sent no answer.`, headers)
        case "timeout":
          return refusal(
            "upstream_timeout",
            `The ${role.label} did not answer within ${Math.round(CLOUD_ROLE_TIMEOUT_MS / 1000)}s.`,
            headers
          )
        case "unreachable":
          return refusal(
            "upstream_unreachable",
            `The ${role.label}'s model service can't be reached right now. Try again in a moment.`,
            headers,
            { seam: role.label, cause: answer.message }
          )
        case "out_of_credit":
          return refusal("out_of_credit", "Out of credit.", headers)
      }
    }
    const runId = body.runId
    if (answer.content.trim() === "") {
      return ndjson([{ runId, type: "done", reason: "stop", error: `The ${role.label} answered with no text.` }], headers)
    }
    return ndjson([
      { runId, type: "delta", kind: "text", text: answer.content },
      { runId, type: "done", reason: "stop" }
    ], headers)
  })
