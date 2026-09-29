import type { AgentInvocation } from "./AgentInvocation"
import type { CommandIntent } from "../state/CommandIntent"
import type { CommandOutcome } from "./Commands"
import type { CommandGesture } from "./CommandGesture"

export interface CommandRequest {
  readonly name: string
  readonly actor: CommandIntent["actor"]
  readonly source: CommandIntent["source"]
  readonly invocation?: AgentInvocation
  readonly httpCall?: { readonly turnId: string; readonly callId: string; readonly attemptId?: string; readonly legId?: string }
}
export interface CommandReceipt {
  readonly id: string
  readonly actor: CommandIntent["actor"]
  readonly acceptedRevision: number
}
export interface PendingFieldInput {
  readonly field: string
  readonly value: string
}
export interface PendingFormInput extends PendingFieldInput { readonly cardId: string }
export interface PendingCommandInput { readonly clear: () => void }

export type CommandAcceptance =
  | { readonly receipt: CommandReceipt; readonly pendingInput?: PendingCommandInput }
  /**
   * `persistenceFailed` covers both "nothing durable happened" cases, and they
   * are not the same thing to a person. A superseded act — the controller,
   * account or turn moved on — states nothing, because "done" for work that was
   * thrown away is the silent-lie shape. A `writeRefused` act is the other one:
   * this BROWSER would not take the write, the person's act reached nothing,
   * and the control they used snapped back. That one is never silent.
   */
  | { readonly refusal: string; readonly persistenceFailed?: true; readonly writeRefused?: true }

/** Durable command records contain metadata only; optional human input is a private pending draft. */
export interface CommandLifecycle {
  /** Infrastructure refusal before gestures, state reads, or durable admission. */
  readonly before?: (request: CommandRequest, args?: string, named?: Record<string, unknown>) => CommandOutcome | undefined
  readonly reserveGesture?: (request: CommandRequest, args?: string, named?: Record<string, unknown>) => CommandGesture | undefined
  readonly accept: (request: CommandRequest, pendingFieldInput?: PendingFieldInput | PendingFormInput) => Promise<CommandAcceptance>
  readonly canExecute?: (receipt: CommandReceipt, request: CommandRequest) => boolean
  /** Whether this invocation still owns its durable diagnostics after an await. */
  readonly canPublish?: (receipt: CommandReceipt, request: CommandRequest) => boolean
  readonly settle: (receipt: CommandReceipt, outcome: CommandOutcome, retryableAuthorization?: boolean) => Promise<boolean>
}
