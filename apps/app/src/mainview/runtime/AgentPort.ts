import { Data } from "effect"
import type { AgentTurnFrame, StartAgentTurnRequest, StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"
import type { AgentTurnCursor, AgentTurnJournalDelivery, AgentTurnJournalReply, AgentTurnJournalRequest } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentConversationPage, AgentConversationReplay, AgentConversationReplayAccess } from "@smthrs/rpc/AgentTurnJournal"

export interface AgentJournalAccess { readonly runId: string; readonly journal: AgentTurnJournalRequest; readonly after?: AgentTurnCursor | null }
/** A readable response that cannot establish a trustworthy replay boundary. */
export class AgentJournalIntegrityError extends Data.TaggedError("AgentJournalIntegrityError")<{ readonly message: string }> {
  constructor(message = "The agent journal could not establish a replay boundary.") { super({ message }) }
}
export interface AgentJournalPort {
  /** Each delivery is acknowledged only after the subscriber's local commit. */
  readonly subscribe: (listener: (delivery: AgentTurnJournalDelivery) => Promise<void>) => () => void
  readonly read: (access: AgentJournalAccess) => Promise<AgentTurnJournalReply>
  readonly retire: (access: AgentJournalAccess) => Promise<void>
  /** Disconnect this browser without cancelling the accepted server computation. */
  readonly disconnect: (runId: string) => void
}

/**
 * The agent contract every host implements: the HTTP agent against the app
 * origin (native/WebAgent.ts) and the unavailable adapter a runtime without
 * an agent capability binds. It is host-neutral, so it lives beside the
 * runtime composition rather than in the Electrobun bridge.
 */
export interface AgentPort {
  readonly available: boolean
  readonly journal?: AgentJournalPort
  /** Read-only account recovery. It never admits model or tool execution. */
  readonly history?: {
    readonly list: (after?: string) => Promise<AgentConversationPage>
    readonly replay: (access: AgentConversationReplayAccess) => Promise<AgentConversationReplay>
  }
  readonly startTurn: (request: StartAgentTurnRequest) => Promise<StartAgentTurnResult>
  readonly cancelTurn: (runId: string) => Promise<void>
  /**
   * Mid-turn input (DESIGN.md §14): admit a message into the running turn's
   * steering queue, drained at the next link boundary. Absent on backends
   * without steering; callers treat undefined as "not steerable".
   */
  readonly steer?: (runId: string, text: string) => Promise<boolean>
  readonly subscribe: (listener: (frame: AgentTurnFrame) => void) => () => void
}
