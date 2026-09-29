/*
 * Take over (UX pass 2026-09-28, web): a person drives a run from its box's
 * terminal. A run whose seat is a wrapped Claude Code CLI journals the vendor
 * session that answered on every `control.agent.model-settled` row
 * (`sessionId`), so the terminal opens on that session with the vendor's own
 * resume line, and Release exits it so the seat carries on headless. A run
 * with no vendor session gets the box's shell.
 *
 * The resume line only reopens a session the host kept on disk
 * (`SMITHERS_HIJACKABLE=1`, packages/smithers ClaudeCode.ts `persistSession`).
 */
import type { Card } from "../state/AppState"
import type { JournalRecord } from "./RunTrace"

type RunCard = Extract<Card, { kind: "run-trace" }>

export interface HarnessSession {
  readonly vendor: "claude"
  readonly sessionId: string
  /** What the terminal types to open the session interactively. */
  readonly resume: string
  /** What it types to leave the vendor's own screen again. */
  readonly exit: string
}

const object = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined

/**
 * A session id is a single shell word that cannot read as an option; anything
 * else is never typed into a terminal.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** The newest vendor session the journal names, when the seat that answered is a wrapped Claude Code. */
export const harnessSessionOf = (journal: ReadonlyArray<JournalRecord>): HarnessSession | undefined => {
  let seat: string | undefined
  let found: HarnessSession | undefined
  for (const row of journal) {
    const payload = object(row.payload)
    if (row.kind === "control.agent.turn-opened" && typeof payload?.seat === "string") seat = payload.seat
    if (row.kind !== "control.agent.model-settled") continue
    const sessionId = payload?.sessionId
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId) || seat?.startsWith("claude-code:") !== true) continue
    found = { vendor: "claude", sessionId, resume: `claude --resume ${sessionId}`, exit: "/exit" }
  }
  return found
}

const LIVE_PHASES: ReadonlySet<string> = new Set(["launching", "running", "waiting-approval", "reconnecting", "quiet"])

/** Take over or Release, whichever this live run's state allows; nothing for a settled run or one with no box. */
export const takeoverAct = (card: RunCard): "take over" | "release" | undefined =>
  !LIVE_PHASES.has(card.payload.phase) ? undefined
    : card.payload.takeover !== undefined ? "release"
    : card.payload.workspaceId !== undefined ? "take over"
    : undefined
