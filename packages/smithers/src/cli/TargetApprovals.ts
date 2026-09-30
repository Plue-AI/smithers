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
import { Control, ControlRuntime, type ControlSchema } from "@smthrs/control"
import { Effect, Schema } from "effect"
import * as CliError from "../CliError.ts"
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
export const grant = (request: Pick<TargetApprovalRequest, "label" | "digest">) =>
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

/**
 * One target revision waiting for an operator: the target's label, the
 * revision digest, and the exact payload `approvals approve` or
 * `approvals deny` takes.
 * @category models
 * @since 1.0.0
 */
export interface PendingTarget {
  readonly target: string
  readonly revision: string
  readonly approval: ControlSchema.ApprovalPayload
}

const TargetInput = Schema.Struct({ label: Schema.String, digest: Schema.String })
const isTargetInput = Schema.is(TargetInput)

/**
 * Every target revision the control plane holds pending, oldest first, read
 * through `Control.list` so a local store and a remote control plane answer
 * alike.
 * @category constructors
 * @since 1.0.0
 */
export const pending = Effect.gen(function*() {
  const control = yield* Control.Control
  const rows: Array<PendingTarget> = []
  let cursor: string | undefined
  do {
    const page = yield* control.list({
      _tag: "plans",
      filters: { flowId, decision: "pending" },
      ...(cursor === undefined ? {} : { cursor })
    })
    if (page._tag !== "plans") {
      return yield* new CliError.Refused({
        fault: "bug",
        code: "unexpected_listing",
        message: `A plan listing answered ${page._tag}`
      })
    }
    for (const item of page.items) {
      if (isTargetInput(item.input)) {
        rows.push({ target: item.input.label, revision: item.input.digest, approval: item.card.approval })
      }
    }
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return rows
})

/**
 * Approves a pending revision of `target` found through the control plane,
 * without the workspace: how a remote operator grants what a remote build
 * refused. `revision` picks one when several revisions of the target wait.
 * @category constructors
 * @since 1.0.0
 */
export const grantPending = (target: string, revision?: string | undefined) =>
  Effect.gen(function*() {
    const label = target.startsWith("//") || target.startsWith("@") ? target : `//${target}`
    const waiting = (yield* pending).filter((row) =>
      row.target === label && (revision === undefined || row.revision === revision)
    )
    if (waiting.length === 0) {
      return yield* new CliError.Refused({
        fault: "user",
        code: "approval_not_found",
        message: `No pending approval for ${label}${revision === undefined ? "" : ` at ${revision}`}`
      })
    }
    if (waiting.length > 1) {
      return yield* new CliError.UsageError({
        message: `${label} has ${waiting.length} pending revisions; pass --revision: ${
          waiting.map((row) => row.revision).join(", ")
        }`
      })
    }
    return yield* grant({ label, digest: waiting[0]!.revision })
  })
