/**
 * Stable, schema-backed control-plane failures.
 *
 * @since 0.1.0
 */

import { NotificationError } from "@smthrs/notifications/NotificationQueue"
import { Effect, Schema } from "effect"
import { FlowId, RunId } from "./ControlSchema.ts"

const constantCode = <const Code extends string>(code: Code) =>
  Schema.Literal(code).pipe(Schema.withConstructorDefault(Effect.succeed(code)))

/**
 * No run with this id exists.
 *
 * @category errors
 * @since 0.1.0
 */
export class RunNotFound extends Schema.TaggedError<RunNotFound>()("/control/RunNotFound", {
  code: constantCode("run_not_found"),
  runId: RunId
}) {}

/**
 * No plan with this id exists.
 *
 * @category errors
 * @since 0.1.0
 */
export class PlanNotFound extends Schema.TaggedError<PlanNotFound>()("/control/PlanNotFound", {
  code: constantCode("plan_not_found"),
  planId: Schema.String
}) {
  /**
   * The sentence an operator reads. Every renderer in the tree prints
   * `message`, so a refusal without one does not explain the next action.
   */
  override get message(): string {
    return `Plan ${this.planId} was not found. Create the plan again before approving or launching it.`
  }
}

/**
 * The plan was denied and cannot be launched.
 *
 * @category errors
 * @since 0.1.0
 */
export class PlanDenied extends Schema.TaggedError<PlanDenied>()("/control/PlanDenied", {
  code: constantCode("plan_denied"),
  planId: Schema.String
}) {
  /**
   * The sentence an operator reads. Every renderer in the tree prints
   * `message`, so a denial must state how to make a later launch possible.
   */
  override get message(): string {
    return `Plan ${this.planId} was denied and cannot be launched. Create and approve a new plan before running it.`
  }
}

/**
 * No flow with this id is registered.
 *
 * @category errors
 * @since 0.1.0
 */
export class FlowNotFound extends Schema.TaggedError<FlowNotFound>()("/control/FlowNotFound", {
  code: constantCode("flow_not_found"),
  flowId: FlowId
}) {}

/**
 * The submitted plan does not hash to the digest the caller declared, so
 * the control plane refuses to store it.
 *
 * @category errors
 * @since 0.1.0
 */
export class PlanDigestMismatch extends Schema.TaggedError<PlanDigestMismatch>()("/control/PlanDigestMismatch", {
  code: constantCode("plan_digest_mismatch"),
  planId: Schema.String,
  expected: Schema.String,
  actual: Schema.String
}) {}

/**
 * The plan's effect envelope differs from the one the caller declared.
 *
 * @category errors
 * @since 0.1.0
 */
export class EnvelopeMismatch extends Schema.TaggedError<EnvelopeMismatch>()("/control/EnvelopeMismatch", {
  code: constantCode("envelope_mismatch"),
  planId: Schema.String,
  expected: Schema.String,
  actual: Schema.String
}) {}

/**
 * The caller's claim on this run lapsed or was fenced by a newer owner.
 *
 * @category errors
 * @since 0.1.0
 */
export class ClaimLost extends Schema.TaggedError<ClaimLost>()("/control/ClaimLost", {
  code: constantCode("claim_lost"),
  runId: RunId
}) {}

/**
 * This request was already answered; a second answer is refused rather
 * than overwriting the first.
 *
 * @category errors
 * @since 0.1.0
 */
export class AlreadyResolved extends Schema.TaggedError<AlreadyResolved>()("/control/AlreadyResolved", {
  code: constantCode("already_resolved"),
  requestId: Schema.String
}) {}

/**
 * The request did not satisfy its schema or a stated precondition.
 *
 * @category errors
 * @since 0.1.0
 */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("/control/InvalidInput", {
  code: constantCode("invalid_input"),
  issue: Schema.String
}) {}

/**
 * The caller lacks a usable credential or authority for this operation.
 *
 * @category errors
 * @since 0.1.0
 */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("/control/Unauthorized", {
  code: constantCode("unauthorized"),
  message: Schema.String
}) {}

/**
 * The operation is not implemented in this deployment. `ticket` names the
 * issue that tracks it, per `Concepts/Tickets Not Exceptions.md`.
 *
 * @category errors
 * @since 0.1.0
 */
export class Unavailable extends Schema.TaggedError<Unavailable>()("/control/Unavailable", {
  code: constantCode("unavailable"),
  feature: Schema.String,
  ticket: Schema.String
}) {}

/**
 * The request failed before a declared control response reached the caller.
 *
 * `retryable` classifies only the transport phase. Connection failures and
 * HTTP 5xx responses are retryable; local encode failures, response decode
 * failures, and HTTP 4xx responses are not. A caller may resend a retryable
 * mutation only when its idempotency key makes replay safe. A keyless request
 * can have reached the server even when its response was lost.
 *
 * `message` is a fixed operator-facing sentence. `cause` retains the original
 * client failure for diagnostics without copying its raw text into output.
 *
 * @category errors
 * @since 0.1.0
 */
export class TransportError extends Schema.TaggedError<TransportError>()("/control/TransportError", {
  code: constantCode("transport_error"),
  message: Schema.String,
  retryable: Schema.Boolean,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * A control-plane store operation failed.
 *
 * @category errors
 * @since 0.1.0
 */
export class PersistenceError extends Schema.TaggedError<PersistenceError>()("/control/PersistenceError", {
  code: constantCode("persistence_failed"),
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * The executor refused or could not start the run.
 *
 * @category errors
 * @since 0.1.0
 */
export class LaunchFailed extends Schema.TaggedError<LaunchFailed>()("/control/LaunchFailed", {
  code: constantCode("launch_failed"),
  runId: RunId,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * A signal named a wait point the run does not have open.
 *
 * `Control.signal` completes the `WaitFor` deferred a run is parked on. A
 * signal whose name matches no open wait point completes nothing, and recording
 * it anyway would leave an operator watching a delivery that never lands, so it
 * is refused where it arrives.
 *
 * The signal's name is `waitName`, not `name`. A field spelled `name` on an
 * `Error` subclass shadows `Error.prototype.name`, which every renderer in the
 * tree reads: `smithers signal run-3 '{"name":"go"}'` against a timer-parked
 * run printed `go: ` to stderr and exited 1, because `bin.ts` reports
 * `${error.name}: ${error.message}` and this class had overwritten one and
 * defined neither (release validation, defect D3).
 *
 * @category errors
 * @since 0.1.0
 */
export class NoMatchingWait extends Schema.TaggedError<NoMatchingWait>()("/control/NoMatchingWait", {
  code: constantCode("no_matching_wait"),
  runId: RunId,
  waitName: Schema.String
}) {
  /**
   * The sentence an operator reads. Every other renderer in the tree prints
   * `message`, so a refusal with none is a refusal with no reason.
   */
  override get message(): string {
    return `no wait point named "${this.waitName}" is open on run ${this.runId}. ` +
      `Read \`smthrs runs show ${this.runId}\` to see what that run is waiting for.`
  }
}

/**
 * A credential write lost a race: the record moved on before this writer
 * committed, so the update is refused rather than silently overwriting the
 * winner.
 *
 * @since 0.1.0
 * @category errors
 */
export class CredentialConflict extends Schema.TaggedError<CredentialConflict>()("/control/CredentialConflict", {
  code: constantCode("credential_conflict"),
  id: Schema.String,
  expectedVersion: Schema.Number,
  actualVersion: Schema.Number
}) {}

/**
 * Every stable failure emitted by the control plane, as one schema.
 *
 * This is the single membership list. The exported union type is derived from
 * it and `ControlClient.isControlError` is `Schema.is` of it, so an error class
 * added here reaches both. Two hand-maintained lists drifted: `ControlError`
 * omitted `CredentialConflict` while the README documented it as a member, and
 * `isControlError` repeated the same thirteen names a second time.
 *
 * @since 0.1.0
 * @category errors
 */
export const ControlErrorSchema = Schema.Union([
  RunNotFound,
  PlanNotFound,
  PlanDenied,
  FlowNotFound,
  PlanDigestMismatch,
  EnvelopeMismatch,
  ClaimLost,
  AlreadyResolved,
  InvalidInput,
  Unauthorized,
  Unavailable,
  TransportError,
  PersistenceError,
  LaunchFailed,
  NoMatchingWait,
  CredentialConflict,
  NotificationError
])

/**
 * Every stable failure emitted by the control plane.
 *
 * @since 0.1.0
 * @category errors
 */
export type ControlError = typeof ControlErrorSchema.Type
