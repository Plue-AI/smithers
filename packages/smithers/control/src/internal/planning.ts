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
import type * as PersistedPlan from "@smthrs/plan/Plan"
import { Effect, Schema } from "effect"
import type { ApprovalTarget } from "../Control.ts"
import type {
  Envelope,
  FlowId,
  IdempotencyKey,
  PlanCard,
  PlanGraph,
  PlanNode,
  Receipt,
  RunId
} from "../ControlSchema.ts"

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
