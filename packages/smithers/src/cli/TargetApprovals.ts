/**
 * Durable approvals for build targets that declare `approval: "required"`.
 *
 * An approval is an ordinary control-plane plan approval: the reserved
 * `system/target` plan whose input names the target and the revision digest
 * the build planner computed. The build planner asks the project's control
 * database before such a target runs; granting goes through `Control.approve`,
 * so the host's approval authority, principal attribution and idempotency
 * apply unchanged.
 *
 * @since 1.0.0
 */

import type { TargetApprovalRequest, TargetApprovals } from "@smthrs/build-cli/PackageExec"
import { Control, ControlRuntime } from "@smthrs/control"
import { Effect } from "effect"
import * as NodeControl from "../NodeControl.ts"

/**
 * The reserved flow a target approval is planned against.
 * @category constants
 * @since 1.0.0
 */
export const flowId = "system/target"

/**
 * The plan request that names one target revision. The same request plans the
 * pending approval, grants it and checks it, so all three address one plan.
 * @category constructors
 * @since 1.0.0
 */
export const planInput = (request: Pick<TargetApprovalRequest, "label" | "digest">): Control.PlanInput => ({
  flowId,
  input: { label: request.label, digest: request.digest },
  idempotencyKey: `target:${request.label}:${request.digest}`
})

/**
 * Whether the control database under `root` records an approval of exactly
 * this revision. An unapproved revision is left as a pending plan the operator
 * can approve; a store that cannot be read rejects instead of answering.
 * @category constructors
 * @since 1.0.0
 */
export const decision = (request: TargetApprovalRequest) =>
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime.ControlRuntime
    const { card } = yield* runtime.plan(planInput(request))
    return (yield* runtime.getPlan(card.planId)).decision
  }).pipe(Effect.provide(NodeControl.engineDurable(request.root).runtime))

/**
 * The approval store the unified CLI hands the build planner.
 * @category constructors
 * @since 1.0.0
 */
export const store: TargetApprovals = {
  granted: (request) => Effect.runPromise(Effect.map(decision(request), (value) => value === "approved"))
}

/**
 * Approves one target revision through the control plane.
 * @category constructors
 * @since 1.0.0
 */
export const grant = (request: TargetApprovalRequest) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const card = yield* control.plan(planInput(request))
    const receipt = yield* control.approve({
      target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
      scope: "remembered",
      idempotencyKey: `approve:${card.planId}`
    })
    return { label: request.label, revision: request.digest, planId: card.planId, receipt: receipt._tag }
  })
