/**
 * The gateway's own remote procedures: the served read path, and the one
 * composite mutation a product client cannot assemble safely on its own.
 *
 * Control mutations are not re-declared here. `@smthrs/control` `ControlRpcs`
 * is the mutation contract and the gateway mounts it unchanged at `/rpc`, so
 * there is exactly one wire definition of `Plan`, `Run`, `Approve`, `Deny`,
 * `Cancel`, `Signal`, `Steer`, `Resume`, `List`, and `Watch`.
 *
 * The group shares `ControlRpcs.ControlAuth`, so one bearer credential
 * authenticates both mounts and one server-stamped principal is recorded for
 * whatever it authorizes.
 *
 * @since 1.0.0
 */

import { ControlError, ControlRpcs, ControlSchema } from "@smthrs/control"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GatewayError } from "./GatewayError.ts"
import * as GatewaySchema from "./GatewaySchema.ts"

/**
 * The decision a client submits for one approval.
 *
 * @since 1.0.0
 * @category models
 */
export const Decision = Schema.Literals(["approve", "deny"])

/**
 * The decision a client submits for one approval.
 *
 * @since 1.0.0
 * @category models
 */
export type Decision = typeof Decision.Type

/**
 * One approval decision, submitted with the exact payload the run published.
 *
 * @since 1.0.0
 * @category models
 */
export const SubmitApprovalInput = Schema.Struct({
  ...ControlSchema.ApprovalPayload.fields,
  decision: Decision,
  /**
   * The answer to a question, for a gate that asks one.
   *
   * Most gates are a grant: approve or deny, and the decision IS the payload.
   * A `HumanTask` gate asks for a value — prose, a choice, a JSON object — and
   * the decision alone answers nothing. Present exactly when the row being
   * submitted is one of those, in which case `target.requestId` names the wait
   * point and this is what is delivered to it. A denial carries no answer: the
   * question is refused, not answered.
   *
   * Additive on purpose: a client that never asks a person anything submits
   * exactly what it submitted before.
   */
  answer: Schema.optional(Schema.Json)
})

/**
 * One approval decision, submitted with the exact payload the run published.
 *
 * @since 1.0.0
 * @category models
 */
export type SubmitApprovalInput = typeof SubmitApprovalInput.Type

/**
 * What submitting an approval did.
 *
 * `decision` is the receipt for the grant or refusal. Control owns the
 * decision and its durable resume delegation as one domain command.
 *
 * @since 1.0.0
 * @category models
 */
export const SubmitApprovalOutput = Schema.Struct({
  decision: ControlSchema.Receipt
})

/**
 * What submitting an approval did.
 *
 * @since 1.0.0
 * @category models
 */
export type SubmitApprovalOutput = typeof SubmitApprovalOutput.Type

/**
 * The failures `Approval.Submit` can answer with: exactly the union
 * `@smthrs/control` `Control.approve`, `Control.deny`, and — for a gate that
 * asks a question — `Control.signal` declare, because the handler is a
 * transport adapter over those commands and adds no failure of its own. A
 * member none of them raises would be a recovery branch no client's code could
 * ever reach.
 *
 * `NoMatchingWait` is the one an answer adds: the question was answered after
 * the run moved on, or somebody else answered it first.
 */
const submitErrors = Schema.Union([
  ControlError.NoMatchingWait,
  ControlError.PlanDigestMismatch,
  ControlError.EnvelopeMismatch,
  ControlError.AlreadyResolved,
  ControlError.PlanNotFound,
  ControlError.RunNotFound,
  ControlError.InvalidInput,
  ControlError.Unauthorized,
  ControlError.PersistenceError,
  ControlError.Unavailable,
  ControlError.TransportError
])

/**
 * The gateway read path and the composite approval mutation.
 *
 * `Approval.Submit` is the transport form of Control's single decision
 * command. Control records the decision and durable resume delegation; the
 * gateway never composes a second mutation.
 *
 * @since 1.0.0
 * @category groups
 */
export const GatewayRpcs = RpcGroup.make(
  Rpc.make("Projection.Snapshot", {
    payload: Schema.Struct({
      selector: GatewaySchema.ProjectionSelector,
      after: Schema.optional(GatewaySchema.ProjectionCursor)
    }),
    success: GatewaySchema.ProjectionSnapshot,
    error: GatewayError
  }),
  Rpc.make("Projection.Subscribe", {
    payload: Schema.Struct({
      selector: GatewaySchema.ProjectionSelector,
      after: Schema.optional(GatewaySchema.ProjectionCursor)
    }),
    success: GatewaySchema.GatewayFrame,
    error: GatewayError,
    stream: true
  }),
  Rpc.make("Approval.Submit", {
    payload: SubmitApprovalInput,
    success: SubmitApprovalOutput,
    error: submitErrors
  })
).middleware(ControlRpcs.ControlAuth)
