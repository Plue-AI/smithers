/** Durable merge recovery and generated identity, independent of dispatch.
 * @since 1.0.0
 */

import { KeyMaterial, Plan } from "@smthrs/plan"
import { Effect } from "effect"
import * as PlanMergeStore from "../PlanMergeStore.ts"

const invalid = (message: string, cause?: unknown) =>
  new PlanMergeStore.PlanMergeError({
    code: "corrupt_state",
    message,
    ...(cause === undefined ? {} : { cause })
  })
/** Chooses a free display ID; ownership comes from the durable decision, not this spelling.
 * @since 1.0.0
 * @category identity
 */
export const allocateId = (plan: Plan.Plan, nodeId: string): string => {
  const occupied = new Set(plan.nodes.map((node) => node.id))
  const base = `${nodeId}+merge`
  let candidate = base
  for (let suffix = 1; occupied.has(candidate); suffix++) candidate = `${base}#${suffix}`
  return candidate
}
/** The single declaration used both when appending and when recovering an extension.
 * @since 1.0.0
 * @category constructors
 */
export const draft = (node: Plan.PlanNode, mergeId: string, winners: ReadonlyArray<string>): Plan.NodeDraft => ({
  id: mergeId,
  kind: "merge",
  material: {
    version: KeyMaterial.version,
    kind: node.material.kind,
    body: { merge: { stopped: node.id, winners } },
    inputs: winners.map((id) => ({ _tag: "Pending", from: id })),
    layers: [],
    capabilities: []
  },
  effects: node.effects
})
/** Checks that an intent names a permissible stopped node and its actual conflict peers.
 * @since 1.0.0
 * @category validation
 */
export const validateIntent = (plan: Plan.Plan, intent: PlanMergeStore.Intent) =>
  Effect.gen(function*() {
    const node = plan.nodes.find((candidate) => candidate.id === intent.nodeId)
    if (
      node === undefined || node.key !== intent.nodeKey || node.material.kind === "irreversible" ||
      (node.runtime !== "stop-merge" && !node.conflicts.some((conflict) => conflict.runtime === "stop-merge")) ||
      intent.peers.some((id) => !node.conflicts.some((conflict) => conflict.with === id))
    ) {
      return yield* Effect.fail(invalid("merge intent does not match its approved stopped node"))
    }
    return node
  })
/** Recovers only recorded merge extensions, never unrelated/unapproved appended work.
 * @since 1.0.0
 * @category recovery
 */
export const recover = (candidate: Plan.Plan, decisions: ReadonlyArray<PlanMergeStore.Decision>) =>
  Effect.gen(function*() {
    const byGeneration = new Map(
      decisions.flatMap((decision) =>
        decision.completion === undefined ? [] : [[decision.completion.generation, decision] as const]
      )
    )
    let plan = candidate
    if (byGeneration.size > 0) {
      // Rebuild each prefix once. Re-verifying every complete prefix separately
      // would multiply the compiler's overlap work across a long merge history.
      plan = yield* Plan.verify({
        ...candidate,
        generation: 0,
        digest: candidate.baseDigest,
        nodes: candidate.nodes.filter((node) => node.generation === 0)
      })
        .pipe(Effect.mapError((cause) => invalid("merge recovery has an invalid approved base", cause)))
      const last = Math.max(candidate.generation, ...byGeneration.keys())
      if (last > Plan.maximumPlanNodes) return yield* Effect.fail(invalid("merge generation exceeds the plan limit"))
      for (let generation = 1; generation <= last; generation++) {
        const decision = byGeneration.get(generation)
        let drafts: ReadonlyArray<Plan.NodeDraft>
        if (decision?.completion !== undefined) {
          const stopped = yield* validateIntent(plan, decision.intent)
          if (decision.completion.parentDigest !== plan.digest) {
            return yield* Effect.fail(invalid("merge parent digest changed"))
          }
          drafts = [draft(stopped, decision.completion.mergeId, decision.completion.winners)]
        } else {
          drafts = candidate.nodes.filter((node) => node.generation === generation).map((node) => ({
            id: node.id,
            kind: node.kind,
            material: node.material,
            effects: node.effects,
            priority: node.priority,
            conflictStrategy: node.strategy,
            runtimeStrategy: node.runtime
          }))
          if (drafts.length === 0) {
            return yield* Effect.fail(invalid("merge recovery requires the approved intervening plan generations"))
          }
        }
        plan = yield* Plan.append(plan, drafts).pipe(
          Effect.mapError((cause) => invalid("stored merge extension cannot be reconstructed", cause))
        )
        if (
          decision?.completion !== undefined &&
          (plan.digest !== decision.completion.planDigest ||
            Plan.generationNodes(plan)[0]!.key !== decision.completion.mergeKey)
        ) {
          return yield* Effect.fail(invalid("merge decision does not identify its generated node"))
        }
        if (generation === candidate.generation && plan.digest !== candidate.digest) {
          return yield* Effect.fail(invalid("merge decisions disagree with the supplied plan"))
        }
      }
    }
    for (const decision of decisions) yield* validateIntent(plan, decision.intent)
    return plan
  })
