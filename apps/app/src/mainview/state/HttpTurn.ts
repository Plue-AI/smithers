import { Data } from "effect"
import { z } from "zod"
import { digest } from "@smthrs/core/Digest"
import { AgentTurnBatchSchema, AgentTurnCursorSchema, AgentTurnJournalRequestSchema, agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnBatch, AgentTurnCursor } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentChatMessage, AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { AppTransition, Card } from "./AppState"
import { CardPatchSchema, CardSchema } from "./AppState"
import { isRuntimeOwnedCard } from "./isRuntimeOwnedCard"
import { boundToolResult } from "@smthrs/rpc/AgentToolResult"
import { renderedAskTurnText, renderedRunTurnText, RUN_LAUNCH_COMMANDS } from "./RunClaims"

export const HTTP_MAX_TOOL_LEGS = 8
export class HttpTurnIntegrityError extends Data.TaggedError("HttpTurnIntegrityError")<{ readonly message: string }> {
  constructor(message = "The turn failed verification.") { super({ message }) }
}
export const HttpAskClassSchema = z.enum(["email", "local-files", "messaging", "push", "pr"])
const Identity = z.string().min(1).max(160)
export const HttpPendingCallSchema = z.object({ callId: Identity, name: z.string(), args: z.string() }).strict()
export const HttpTurnSchema = z.object({
  id: Identity, turnId: Identity, owner: z.string().nullable().optional(), legId: Identity,
  status: z.enum(["active", "complete", "failed", "cancelled", "ambiguous"]),
  receivedText: z.boolean(), runLaunch: z.string().optional(), askClass: HttpAskClassSchema.optional(), claimBuffer: z.string(),
  createdAt: z.number().finite(), revision: z.number().int().nonnegative()
}).strict()
export type HttpTurn = z.infer<typeof HttpTurnSchema>
export const HttpTurnLegSchema = z.object({
  id: Identity, attemptId: Identity, turnId: Identity, ordinal: z.number().int().nonnegative(), journal: AgentTurnJournalRequestSchema,
  cursor: AgentTurnCursorSchema.optional(),
  status: z.enum(["prepared", "streaming", "tool-ready", "tool-executing", "tool-settled", "complete", "failed", "cancelled", "ambiguous"]),
  call: HttpPendingCallSchema.optional(), result: z.string().optional(), createdAt: z.number().finite()
}).strict().refine(row => row.id === row.journal.legId && (row.cursor === undefined ||
  (row.cursor.runId === row.turnId && row.cursor.legId === row.id)), { message: "HTTP leg identity mismatch" })
export type HttpTurnLeg = z.infer<typeof HttpTurnLegSchema>

/** Continuation input is derived from ordered, settled calls; it has no independent mutable array. */
export const httpToolItems = (legs: Iterable<HttpTurnLeg>, attemptId: string): AgentChatMessage[] => [...legs]
  .filter(leg => leg.attemptId === attemptId && leg.call !== undefined && leg.result !== undefined)
  .sort((a, b) => a.ordinal - b.ordinal).flatMap(leg => [
    { type: "function_call" as const, call_id: leg.call!.callId, name: leg.call!.name, arguments: leg.call!.args },
    { type: "function_call_output" as const, call_id: leg.call!.callId, output: boundToolResult(leg.result!).modelOutput }
  ])
export const httpToolLegCount = (legs: Iterable<HttpTurnLeg>, attemptId: string): number => [...legs]
  .filter(leg => leg.attemptId === attemptId && (leg.status === "tool-executing" || leg.result !== undefined)).length

/** Verify the entire batch before the first visible or hidden field can change. */
export const verifyHttpBatch = (turn: Pick<HttpTurn, "status" | "legId" | "id" | "turnId">, leg: Pick<HttpTurnLeg, "cursor" | "id" | "attemptId" | "status">, incoming: AgentTurnBatch): AgentTurnCursor | undefined => {
  const batch = AgentTurnBatchSchema.parse(incoming)
  const { hash, ...body } = batch
  const { hash: _incomingHash, ...incomingBody } = incoming
  const encoded = agentTurnJournalDigestInput("batch", body)
  if (encoded !== agentTurnJournalDigestInput("batch", incomingBody) || digest(encoded) !== hash) throw new HttpTurnIntegrityError("HTTP turn batch integrity failed")
  const cursor = leg.cursor
  if (turn.status !== "active" || turn.legId !== leg.id || leg.attemptId !== turn.id || batch.runId !== turn.turnId || batch.legId !== leg.id) {
    throw new HttpTurnIntegrityError("HTTP turn batch belongs to a different active leg")
  }
  // A live socket may arrive behind a read which already caught up. Older
  // self-consistent observations have no new facts and cannot move the cursor.
  if (cursor !== undefined && batch.batch < cursor.batch) return undefined
  if (cursor !== undefined && batch.batch === cursor.batch && batch.hash === cursor.hash &&
    batch.from + batch.frames.length - 1 === cursor.position) return undefined
  if (leg.status !== "streaming" || cursor === undefined || batch.batch !== cursor.batch + 1 || batch.from !== cursor.position + 1 ||
    batch.previousHash !== cursor.hash || batch.frames.some(frame => frame.runId !== turn.turnId) ||
    batch.frames.slice(0, -1).some(frame => frame.type === "done") || !Number.isSafeInteger(batch.from + batch.frames.length - 1)) throw new HttpTurnIntegrityError("HTTP turn batch does not extend the applied cursor")
  return { version: 1, runId: turn.turnId, legId: leg.id, batch: batch.batch, position: batch.from + batch.frames.length - 1, hash }
}

const SURFACE_CALLS = new Set(["author", "say", "card.show", "card.update"])
export interface HttpFrameView {
  readonly answer: string
  readonly card: (id: string) => Card | undefined
  readonly protectedCard: (id: string) => boolean
  readonly executedLegs: number
}
export interface HttpFrameProjection { readonly turn: HttpTurn; readonly leg: HttpTurnLeg; readonly transitions: AppTransition[] }

/** Shared claim settlement, including whitespace-only held answers. */
export const settleHttpClaims = (turn: HttpTurn, answer: string): { turn: HttpTurn; transitions: AppTransition[] } => {
  if (turn.runLaunch === undefined && turn.askClass === undefined) return { turn, transitions: [] }
  const whole = answer + turn.claimBuffer
  const next = { ...turn, runLaunch: undefined, askClass: undefined, claimBuffer: "" }
  if (whole.trim() === "") return { turn: { ...next, receivedText: false }, transitions: [] }
  const text = turn.runLaunch !== undefined ? renderedRunTurnText(turn.runLaunch, whole) : renderedAskTurnText(turn.askClass!, whole)
  return { turn: next, transitions: [{ type: "message.claim.substituted", actor: "system", turnId: turn.turnId, text }] }
}

/** A read-only account replay has no originating-device capability. */
export type HistoricalHttpLeg = Omit<HttpTurnLeg, "journal">
/** Derive semantic transcript/card facts plus the next hidden leg state from one frame. */
export function projectHttpFrame(prior: HttpTurn, priorLeg: HttpTurnLeg, frame: AgentTurnFrame, view: HttpFrameView): HttpFrameProjection
export function projectHttpFrame(prior: HttpTurn, priorLeg: HistoricalHttpLeg, frame: AgentTurnFrame, view: HttpFrameView): { readonly turn: HttpTurn; readonly leg: HistoricalHttpLeg; readonly transitions: AppTransition[] }
export function projectHttpFrame(prior: HttpTurn, priorLeg: HistoricalHttpLeg, frame: AgentTurnFrame, view: HttpFrameView) {
  let turn = { ...prior }, leg = { ...priorLeg }
  const transitions: AppTransition[] = []
  const act = (text: string): void => { transitions.push({ type: "message.tool.executed", actor: "smithers", turnId: turn.turnId, text }) }
  if (frame.type === "card") {
    if (!isRuntimeOwnedCard(frame.card) && !isRuntimeOwnedCard(view.card(frame.card.id)) && !view.protectedCard(frame.card.id)) {
      transitions.push({ type: "card.upsert", actor: "smithers", card: frame.card })
    }
  } else if (frame.type === "card.update") {
    const existing = view.card(frame.id), patch = CardPatchSchema.safeParse(frame.patch)
    if (existing !== undefined && !isRuntimeOwnedCard(existing) && !view.protectedCard(frame.id) && patch.success && patch.data.kind === existing.kind) {
      /* The card is spread as a plain record: TypeScript's arithmetic over the spread of every kind's payload exceeds its union limit. */
      const held = existing as unknown as Record<string, unknown> & { readonly id: string; readonly payload: Record<string, unknown> }
      const merged = CardSchema.safeParse({ ...held, ...patch.data, id: held.id,
        payload: patch.data.payload === undefined ? held.payload : { ...held.payload, ...patch.data.payload } })
      if (merged.success) transitions.push({ type: "card.updated", actor: "smithers", id: frame.id, patch: CardPatchSchema.parse(merged.data) })
    }
  } else if (frame.type === "tool_call") {
    const call = { callId: frame.call_id, name: frame.name, args: frame.arguments }
    if (leg.call !== undefined && JSON.stringify(leg.call) !== JSON.stringify(call)) throw new HttpTurnIntegrityError("HTTP leg contains conflicting tool calls")
    leg.call = call
  } else if (frame.type === "delta" && frame.text !== "") {
    if (frame.kind === "text") turn.receivedText = true
    if (frame.kind === "text" && (turn.runLaunch !== undefined || turn.askClass !== undefined)) turn.claimBuffer += frame.text
    else transitions.push({ type: "message.response.delta", actor: "smithers", turnId: turn.turnId, channel: frame.kind, delta: frame.text })
  } else if (frame.type === "link.authored") turn.receivedText = true
  else if (frame.type === "call.settled") {
    if (RUN_LAUNCH_COMMANDS.includes(frame.name)) turn.runLaunch = frame.name
    if (!SURFACE_CALLS.has(frame.name) && !frame.name.startsWith("sys/")) act(`Smithers ran /${frame.name}`)
  } else if (frame.type === "park" && frame.code !== "approval") transitions.push({ type: "message.appended", actor: "system",
    text: frame.code === "quota" ? "Smithers paused — this turn ran out of budget." : "Smithers paused — it is waiting on something outside this chat." })
  else if (frame.type === "gate.rejected") act("Smithers adjusted its approach")
  else if (frame.type === "steering.drained") act("Smithers picked up your note")
  else if (frame.type === "done") {
    if (frame.usage !== undefined) transitions.push({ type: "chat.usage.recorded", actor: "smithers", turnId: turn.turnId, usage: frame.usage })
    if (frame.error === undefined && frame.reason !== "cancelled" && frame.reason !== "tool_limit" && leg.call !== undefined && view.executedLegs < HTTP_MAX_TOOL_LEGS) {
      leg.status = "tool-ready"
    } else {
      const claims = settleHttpClaims(turn, view.answer); turn = claims.turn; transitions.push(...claims.transitions)
      if (frame.reason === "cancelled" && frame.error === undefined) {
        turn.status = "cancelled"; leg.status = "cancelled"
        transitions.push({ type: "message.response.cancelled", actor: "system", turnId: turn.turnId, detail: "That turn was stopped by the server." })
      } else {
        const error = frame.error ?? (frame.reason === "tool_limit" ? "Smithers Cloud stopped this turn at its tool-call limit."
          : leg.call !== undefined ? `I hit the tool-call limit for this turn (${HTTP_MAX_TOOL_LEGS}) — stopping here instead of looping.`
          : !turn.receivedText ? "Smithers Cloud returned an empty response." : undefined)
        turn.status = error === undefined ? "complete" : "failed"; leg.status = turn.status
        transitions.push(error === undefined ? { type: "message.response.completed", actor: "smithers", turnId: turn.turnId }
          : { type: "message.response.failed", actor: "system", turnId: turn.turnId, message: error })
      }
    }
  }
  return { turn, leg, transitions }
}
