/**
 * Rebuildable scheduler indexes. Only verified, append-only plan nodes enter
 * here; durable plans, observations and attempts remain authoritative.
 *
 * @since 1.0.0
 */

import type { Plan, Scheduling } from "@smthrs/plan"
import type { Outcome } from "../PlanScheduler.ts"

/** Mutable coordinator state; dispatch fibers own only attempt-local progress.
 * @since 1.0.0
 * @category models
 */
export interface NodeState {
  status: "pending" | "running" | "settled"
  outcome: Outcome
  attempts: number
  rebases: number
  waited: number
  dispatchKey: string
}

/** Counts explicit graph work, not host time or VM-internal allocations.
 * `allocations` counts new containers and records, including frontier copies
 * and candidate records. Collection backing storage and sort internals are
 * not observable here. Admission policy work is owned by Scheduling.
 * @since 1.0.0
 * @category diagnostics
 */
export interface Work {
  nodes: number
  edges: number
  allocations: number
  membership: number
}

interface Vertex {
  readonly node: Plan.PlanNode
  readonly index: number
  readonly state: NodeState
  readonly dependencies: Set<Vertex>
  readonly dependents: Set<Vertex>
  unresolved: number
  blocked: number
  propagated: Outcome | undefined
}

const work = (): Work => ({ nodes: 0, edges: 0, allocations: 0, membership: 0 })
const blocks = (outcome: Outcome): boolean => outcome !== "built" && outcome !== "clean"

/** Run-local adjacency, readiness, membership and work counters.
 *
 * A provisional outcome is staged while reconciliation reads the journal.
 * Only `reconcile` publishes it to dependents. A later verdict can change an
 * outcome's blocking contribution, but never decrement indegree twice.
 *
 * @since 1.0.0
 * @category models
 */
export interface RuntimeGraph {
  readonly states: ReadonlyMap<string, NodeState>
  readonly remaining: number
  readonly cost: {
    readonly update: Work
    readonly settlement: Work
    readonly frontier: Work
    readonly admission: Work
    readonly reachability: Work
  }
  /** Adds only the newly admitted suffix, synchronously after its durable commit. */
  readonly append: (nodes: ReadonlyArray<Plan.PlanNode>) => void
  readonly stage: (nodeId: string, outcome: Outcome) => void
  readonly reconcile: () => void
  /** Declaration-ordered snapshots preserve passive-settlement wave ordering. */
  readonly blocked: () => ReadonlyArray<Plan.PlanNode>
  readonly ready: () => ReadonlyArray<Plan.PlanNode>
  readonly candidates: (ready: ReadonlyArray<Plan.PlanNode>) => ReadonlyArray<Scheduling.Candidate>
  readonly start: (nodeId: string) => void
  /** Discovered edges affect readiness only, never declared file versions. */
  readonly reorder: (nodeId: string, owners: ReadonlyArray<string>) => void
  /** Visits declared ancestors once per query, including a not-yet-admitted suffix node. */
  readonly visitAncestors: (node: Plan.PlanNode, visit: (node: Plan.PlanNode) => void) => void
}

/** Builds one private graph per run/resume. Recovery stages durable settlements
 * before the first admission; ordinary attempt replay still verifies content.
 * @since 1.0.0
 * @category constructors
 */
export const make = (nodes: ReadonlyArray<Plan.PlanNode>): RuntimeGraph => {
  const vertices = new Map<string, Vertex>()
  const states = new Map<string, NodeState>()
  const ready = new Set<Vertex>()
  const blocked = new Set<Vertex>()
  const staged = new Set<Vertex>()
  const cost = { update: work(), settlement: work(), frontier: work(), admission: work(), reachability: work() }
  // The graph object, cost records, maps, sets and method closures have a
  // constant per-run footprint. Count the explicit containers/records.
  cost.update.allocations = 12
  let remaining = 0

  const refresh = (vertex: Vertex): void => {
    ready.delete(vertex)
    blocked.delete(vertex)
    if (vertex.state.status === "pending" && vertex.unresolved === 0) {
      if (vertex.blocked > 0) blocked.add(vertex)
      else ready.add(vertex)
    }
  }

  const edge = (target: Vertex, dependency: Vertex, count: Work): void => {
    count.edges++
    count.membership++
    if (target.dependencies.has(dependency)) return
    target.dependencies.add(dependency)
    dependency.dependents.add(target)
    if (dependency.propagated === undefined) target.unresolved++
    else if (blocks(dependency.propagated)) target.blocked++
  }

  const append = (suffix: ReadonlyArray<Plan.PlanNode>): void => {
    // Register the whole suffix first: declaration order need not be a
    // topological order. Verified generations never rewrite old vertices.
    for (const node of suffix) {
      const state: NodeState = {
        status: "pending",
        outcome: "skipped",
        attempts: 0,
        rebases: 0,
        waited: 0,
        dispatchKey: ""
      }
      const vertex: Vertex = {
        node,
        index: vertices.size,
        state,
        dependencies: new Set(),
        dependents: new Set(),
        unresolved: 0,
        blocked: 0,
        propagated: undefined
      }
      vertices.set(node.id, vertex)
      states.set(node.id, state)
      remaining++
      cost.update.nodes++
      cost.update.allocations += 4
    }
    for (const node of suffix) {
      const vertex = vertices.get(node.id)!
      cost.update.nodes++
      cost.update.membership++
      for (const dependency of node.dependsOn) {
        cost.update.membership++
        edge(vertex, vertices.get(dependency)!, cost.update)
      }
      refresh(vertex)
    }
  }

  const snapshot = (frontier: ReadonlySet<Vertex>): ReadonlyArray<Plan.PlanNode> => {
    cost.frontier.nodes += frontier.size
    cost.frontier.allocations += 2
    return [...frontier].sort((left, right) => left.index - right.index).map((vertex) => vertex.node)
  }

  append(nodes)
  return {
    states,
    get remaining() {
      return remaining
    },
    cost,
    append,
    stage: (nodeId, outcome) => {
      cost.settlement.nodes++
      cost.settlement.membership++
      const vertex = vertices.get(nodeId)!
      vertex.state.status = "settled"
      vertex.state.outcome = outcome
      staged.add(vertex)
    },
    reconcile: () => {
      for (const vertex of staged) {
        cost.settlement.nodes++
        const previous = vertex.propagated
        const outcome = vertex.state.outcome
        if (previous === outcome) continue
        if (previous === undefined) remaining--
        const delta = Number(blocks(outcome)) - Number(previous !== undefined && blocks(previous))
        vertex.propagated = outcome
        refresh(vertex)
        for (const dependent of vertex.dependents) {
          cost.settlement.edges++
          cost.settlement.nodes++
          if (previous === undefined) dependent.unresolved--
          dependent.blocked += delta
          refresh(dependent)
        }
      }
      staged.clear()
    },
    blocked: () => snapshot(blocked),
    ready: () => snapshot(ready),
    candidates: (frontier) => {
      cost.admission.allocations += 1 + frontier.length
      return frontier.map((node) => {
        cost.admission.nodes++
        cost.admission.membership++
        const vertex = vertices.get(node.id)!
        return { node, order: vertex.index, waited: vertex.state.waited }
      })
    },
    start: (nodeId) => {
      cost.admission.nodes++
      cost.admission.membership++
      const vertex = vertices.get(nodeId)!
      vertex.state.status = "running"
      ready.delete(vertex)
    },
    reorder: (nodeId, owners) => {
      const dependency = vertices.get(nodeId)!
      cost.update.membership++
      for (const owner of owners) {
        cost.update.nodes++
        cost.update.membership++
        const target = vertices.get(owner)
        if (target?.state.status !== "pending") continue
        edge(target, dependency, cost.update)
        refresh(target)
      }
    },
    visitAncestors: (node, visit) => {
      const seen = new Set<string>([node.id])
      const stack = [...node.dependsOn]
      cost.reachability.allocations += 2
      cost.reachability.edges += stack.length
      while (stack.length > 0) {
        const id = stack.pop()!
        cost.reachability.membership++
        if (seen.has(id)) continue
        seen.add(id)
        const predecessor = vertices.get(id)!.node
        cost.reachability.membership++
        cost.reachability.nodes++
        visit(predecessor)
        cost.reachability.edges += predecessor.dependsOn.length
        stack.push(...predecessor.dependsOn)
      }
    }
  }
}
