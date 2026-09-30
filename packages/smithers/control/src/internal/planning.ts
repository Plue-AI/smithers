/**
 * Plan construction shared by every `ControlRuntime` implementation.
 *
 * The plan digest is what an approval is bound to, so the memory runtime and
 * the durable runtime must compute it the same way or an approval taken on one
 * would not validate on the other. Keeping the construction here is what makes
 * that a compile-time fact rather than a convention.
 *
 * @since 0.1.0
 */

import { canonicalize } from "@smthrs/canonical"
import { Sha256 } from "@smthrs/crypto"
import * as Sha256Digest from "@smthrs/crypto/Sha256"
import type * as PersistedPlan from "@smthrs/plan/Plan"
import { Effect, Schema } from "effect"
import type { ApprovalTarget, PlanInput } from "../Control.ts"
import { CodeDrift } from "../ControlError.ts"
import type {
  Envelope,
  FlowId,
  IdempotencyKey,
  PlanCard,
  PlanGraph,
  PlanNode,
  Principal,
  Receipt,
  RunId,
  RunSummary
} from "../ControlSchema.ts"

/**
 * The drift between the code a run recorded and the code that would resume
 * it, or `undefined` when there is none. A run that recorded no digest (a flow
 * without one, or a row older than the field) is not checked for flow drift,
 * and one that recorded no engine version is not checked for engine drift.
 *
 * @since 1.0.0
 * @private
 */
export const codeDriftOf = (
  run: RunSummary,
  flow: { readonly executionDigest?: string | undefined } | undefined,
  engineVersion: string | undefined
): CodeDrift | undefined => {
  const flowDrift = run.executionDigest !== undefined && flow?.executionDigest !== run.executionDigest
  const engineDrift = run.engineVersion !== undefined && engineVersion !== undefined &&
    engineVersion !== run.engineVersion
  if (!flowDrift && !engineDrift) return undefined
  return new CodeDrift({
    runId: run.runId,
    flowId: run.flowId,
    ...(flowDrift ? { recorded: run.executionDigest } : {}),
    ...(flowDrift && flow?.executionDigest !== undefined ? { current: flow.executionDigest } : {}),
    ...(engineDrift ? { recordedEngine: run.engineVersion, currentEngine: engineVersion } : {})
  })
}

/**
 * The code identity a resume the operator allowed to drift records on the run,
 * so later checks compare against the code it now runs.
 *
 * @since 1.0.0
 * @private
 */
export const adoptedCode = (
  run: RunSummary,
  flow: { readonly executionDigest?: string | undefined } | undefined,
  engineVersion: string | undefined
): Pick<RunSummary, "executionDigest" | "engineVersion"> => ({
  executionDigest: flow?.executionDigest,
  engineVersion: engineVersion ?? run.engineVersion
})

/**
 * The envelope a flow with no declared capabilities carries.
 *
 * @since 0.1.0
 * @private
 */
export const emptyEnvelope: Envelope = {
  capabilities: [],
  flows: [],
  budget: {}
}

/**
 * Canonical bytes for a value.
 * Throws on a non-serializable value; every caller either wraps it in
 * `Effect.try` or has already validated the value.
 *
 * @since 0.1.0
 * @private
 */
export const canonical = (value: unknown): string => canonicalize(value)

/**
 * The durable key a caller's idempotency key is stored under.
 *
 * Namespaced by the effective actor: the submitted principal, or the runtime's
 * configured fallback when the caller named none. The principal's clock is
 * omitted, so an equal retry lands on the same key.
 *
 * @since 0.1.0
 * @private
 */
export const mutationKey = (
  operation: string,
  key: IdempotencyKey,
  principal: Pick<Principal, "id" | "kind">
): string =>
  `${operation}:actor:${Sha256Digest.digestSync(canonical({ id: principal.id, kind: principal.kind }))}:${key}`

/**
 * The content digest of a value's canonical bytes.
 *
 * @since 0.1.0
 * @private
 */
export const digest = (value: unknown) => Schema.decodeUnknownEffect(Sha256)(canonical(value)).pipe(Effect.orDie)

/**
 * Envelope equality by canonical bytes, not by reference or key order.
 *
 * @since 0.1.0
 * @private
 */
export const sameEnvelope = (left: Envelope, right: Envelope): boolean => canonical(left) === canonical(right)

/**
 * A flow's envelope with a planner's budget fields laid over its declared ones.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const budgeted = (envelope: Envelope, budget: Envelope["budget"] | undefined): Envelope =>
  budget === undefined ? envelope : { ...envelope, budget: { ...envelope.budget, ...budget } }

/**
 * What one plan request asks for, for idempotency: a key replayed with another
 * budget is another plan.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const planFingerprint = (input: PlanInput): string =>
  canonical({
    flowId: input.flowId,
    input: input.input,
    ...(input.budget === undefined ? {} : { budget: input.budget })
  })

/**
 * An accepted receipt, carrying a run id when one exists.
 *
 * @since 0.1.0
 * @private
 */
export const accepted = (receiptId: string, runId?: RunId): Receipt => {
  /* v8 ignore next 3 -- both runtimes call this from `launch`, which has the run it just started; the parameter stays optional for the receipt's shape rather than for a caller */
  return runId === undefined
    ? { _tag: "Accepted", receiptId }
    : { _tag: "Accepted", receiptId, runId }
}

/**
 * The receipt a replayed mutation returns, derived from the recorded one.
 *
 * @since 0.1.0
 * @private
 */
export const alreadyApplied = (key: IdempotencyKey, receipt: Receipt): Receipt => {
  const receiptId = receipt._tag === "Accepted" || receipt._tag === "AlreadyApplied" ? receipt.receiptId : key
  const runId = receipt._tag === "Accepted" || receipt._tag === "AlreadyApplied" || receipt._tag === "Terminal"
    ? receipt.runId
    : undefined
  return runId === undefined
    ? { _tag: "AlreadyApplied", receiptId }
    : { _tag: "AlreadyApplied", receiptId, runId }
}

/**
 * The plan inputs a card is derived from.
 *
 * @since 0.1.0
 * @private
 */
export interface PlanSource {
  readonly planId: string
  readonly flowId: FlowId
  readonly decodedInput: unknown
  readonly envelope: Envelope
  readonly deployClass: boolean
  readonly executionDigest?: string | undefined
  /** The persisted plan value and cache verdicts produced by the host. */
  readonly handoff?: {
    readonly plan: PersistedPlan.Plan
    readonly statuses?: Readonly<Record<string, PlanNode["status"]>> | undefined
    readonly graph?: PlanGraph | undefined
  } | undefined
  readonly idempotencyKey?: IdempotencyKey | undefined
}

/**
 * Builds the immutable plan card and the approval target bound to its digest.
 *
 * @since 0.1.0
 * @private
 */
export const planCard = (source: PlanSource) =>
  Effect.gen(function*() {
    const plan = source.handoff?.plan
    const nodes: ReadonlyArray<PlanNode> = plan === undefined
      ? []
      : plan.nodes.map((node) => ({
        ...node,
        status: source.handoff?.statuses?.[node.id] ?? "run"
      }))
    const planDigest = yield* digest({
      flowId: source.flowId,
      input: source.decodedInput,
      envelope: source.envelope,
      deployClass: source.deployClass,
      ...(source.executionDigest === undefined ? {} : { executionDigest: source.executionDigest }),
      // The persisted plan digest covers keys, edges, effects, conflicts,
      // priorities, and generations. Hashing only node keys loses executable
      // graph changes whose content keys legitimately stay stable.
      persistedPlan: plan?.digest ?? null
    })
    const target: ApprovalTarget = {
      _tag: "Plan",
      planId: source.planId,
      digest: planDigest,
      envelope: source.envelope
    }
    return {
      planId: source.planId,
      flowId: source.flowId,
      digest: planDigest,
      inputSummary: canonical(source.decodedInput),
      envelope: source.envelope,
      deployClass: source.deployClass,
      ...(source.executionDigest === undefined ? {} : { executionDigest: source.executionDigest }),
      ...(plan === undefined ? {} : { plan }),
      nodes,
      // Outside `digest` above on purpose: the edges are how a reader draws
      // the plan, not what the plan will do, so gaining them must not
      // invalidate an approval taken before the host reported them.
      ...(source.handoff?.graph === undefined ? {} : { graph: source.handoff.graph }),
      approval: {
        target,
        scope: "run" as const,
        idempotencyKey: source.idempotencyKey ?? `approve:${source.planId}`
      }
    } satisfies PlanCard
  })
