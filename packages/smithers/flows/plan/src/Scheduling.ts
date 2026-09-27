/**
 * Shared ready-work admission policy. This module decides priority, aging,
 * deterministic ties, and step/agent capacity. It does not decide which nodes
 * are ready, evaluate branches, launch effects, or own execution lifetimes.
 * Those decisions must use the compiled graph and the caller's activation
 * state before presenting candidates here.
 *
 * @since 1.0.0
 */

import type * as Plan from "./Plan.ts"

/**
 * Admission limits, independent of graph width and provider capacity.
 * Omitted limits are unbounded within JavaScript's safe-integer range.
 *
 * @since 1.0.0
 * @category models
 */
export interface Concurrency {
  readonly steps?: number | undefined
  readonly agents?: number | undefined
}

/**
 * Currently held permits. Every agent also holds a step permit.
 *
 * @since 1.0.0
 * @category models
 */
export interface Usage {
  readonly steps: number
  readonly agents: number
}

/**
 * The part of a plan node admission reads. Declared once here so the three
 * places that name it, {@link Candidate}, {@link Admission} and
 * {@link Policy.admit}, cannot drift apart.
 */
type Schedulable = Pick<Plan.PlanNode, "id" | "kind" | "priority">

/**
 * A ready node's scheduling state. `order` is its position in the compiled
 * plan, not arrival order. `waited` counts capacity-constrained admission
 * passes, not wall-clock time.
 *
 * @since 1.0.0
 * @category models
 */
export interface Candidate<N extends Schedulable = Plan.PlanNode> {
  readonly node: N
  readonly order: number
  readonly waited: number
}

/**
 * One admission decision. Deferred candidates carry their incremented age;
 * admitted candidates retain their age for dispatch diagnostics. No input is
 * mutated and neither array owns or freezes the caller's node values.
 *
 * @since 1.0.0
 * @category models
 */
export interface Admission<N extends Schedulable = Plan.PlanNode> {
  readonly admitted: ReadonlyArray<Candidate<N>>
  readonly deferred: ReadonlyArray<Candidate<N>>
  readonly agents: number
}

/**
 * Pure policy shared by execution coordinators.
 *
 * @since 1.0.0
 * @category models
 */
export interface Policy {
  readonly limits: Usage
  readonly admit: <N extends Schedulable>(
    ready: ReadonlyArray<Candidate<N>>,
    active: Usage
  ) => Admission<N>
}

const integer = (name: string, value: number, minimum: number): number => {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a ${minimum === 1 ? "positive" : "non-negative"} safe integer`)
  }
  return value
}

/**
 * Snapshots validated limits. Admission orders by declared priority plus age,
 * using exact integer arithmetic even when their sum exceeds MAX_SAFE_INTEGER.
 * Ties preserve compiled plan order. An agent blocked by its subset cap does
 * not prevent ordinary ready work from using spare step capacity.
 *
 * Invalid candidate/permit state is refused before any decision is returned.
 * At MAX_SAFE_INTEGER the age saturates; a bounded plan cannot require that
 * many capacity-constrained passes to drain finite work.
 *
 * @since 1.0.0
 * @category constructors
 */
export const make = (concurrency: Concurrency = {}): Policy => {
  const limits = Object.freeze({
    steps: integer("concurrency.steps", concurrency.steps ?? Number.MAX_SAFE_INTEGER, 1),
    agents: integer("concurrency.agents", concurrency.agents ?? Number.MAX_SAFE_INTEGER, 1)
  })
  const admit: Policy["admit"] = (ready, active) => {
    integer("active.steps", active.steps, 0)
    integer("active.agents", active.agents, 0)
    if (active.agents > active.steps) throw new RangeError("active.agents cannot exceed active.steps")
    const ids = new Set<string>()
    const positions = new Set<number>()
    const ranked = ready.map((candidate) => {
      const { node, order, waited } = candidate
      integer("candidate.order", order, 0)
      integer("candidate.waited", waited, 0)
      if (!Number.isSafeInteger(node.priority)) throw new RangeError("candidate.priority must be a safe integer")
      if (node.kind !== "step" && node.kind !== "agent" && node.kind !== "merge") {
        throw new RangeError("invalid candidate kind")
      }
      if (typeof node.id !== "string" || node.id === "" || ids.has(node.id)) {
        throw new RangeError("candidate ids must be non-empty and unique")
      }
      if (positions.has(order)) throw new RangeError("candidate plan positions must be unique")
      ids.add(node.id)
      positions.add(order)
      return { candidate, priority: BigInt(node.priority) + BigInt(waited) }
    })
    ranked.sort((left, right) =>
      left.priority === right.priority
        ? left.candidate.order - right.candidate.order
        : left.priority > right.priority
        ? -1
        : 1
    )
    const admitted: Array<typeof ready[number]> = []
    const deferred: Array<typeof ready[number]> = []
    let agents = 0
    for (const { candidate } of ranked) {
      const isAgent = candidate.node.kind === "agent"
      if (admitted.length >= limits.steps - active.steps || (isAgent && agents >= limits.agents - active.agents)) {
        deferred.push(Object.freeze({ ...candidate, waited: Math.min(Number.MAX_SAFE_INTEGER, candidate.waited + 1) }))
      } else {
        admitted.push(Object.freeze({ ...candidate }))
        if (isAgent) agents++
      }
    }
    return Object.freeze({ admitted: Object.freeze(admitted), deferred: Object.freeze(deferred), agents })
  }
  return Object.freeze({ limits, admit })
}
