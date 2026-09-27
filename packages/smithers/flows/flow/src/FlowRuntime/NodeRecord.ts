/**
 * What a driven graph tells its runtime about itself.
 *
 * The interpreter knows the whole plan before the first action runs, and it
 * knows when each node is scheduled and how each one settled. Nothing
 * downstream can derive those facts: an attempt record carries a step key and
 * no node id, so a monitor reading a journal can see the work and not the
 * graph it belongs to. These records are the missing half, and this module is
 * the only thing `@smthrs/flow` says about them — the port takes them, and an
 * engine with a journal is what turns them into durable records. A runtime
 * without one keeps its no-op and the interpreter is unchanged.
 *
 * Every record carries its own `sourceId`, and that is the replay-stability
 * contract: a resumed walk rebuilds the same graph and re-derives the same
 * ids, so a journal keyed by `(run, source, sequence)` collapses the second
 * observation onto the first row instead of recording the node twice.
 *
 * @since 1.0.0
 */

import type * as Plan from "@smthrs/plan/Plan"
import type { DeclaredAt } from "../internal/DeclarationSite.ts"

/**
 * One node of the graph a run was driven from.
 *
 * `tier` and `effects` are the declaration's own, and `dependsOn` is the
 * material dependency set the plan compiles edges from. `action` is the tag a
 * node dispatches, absent on every node that dispatches nothing. `declaredAt`
 * is provenance and never identity: it is outside key material by
 * construction, so adding it re-keys nothing.
 *
 * A node whose dependency list is wider than one page appears on several,
 * each carrying the next DISJOINT slice of `dependsOn` and everything else
 * unchanged. A reader assembles pages in order and unions `dependsOn` per id;
 * keeping only the last summary would read a thousand-way fan-in as a node
 * with two dependencies.
 *
 * @since 1.0.0
 * @category models
 */
export interface NodeSummary {
  readonly id: string
  readonly kind: string
  readonly dependsOn: ReadonlyArray<string>
  readonly tier: "sealed" | "compensable" | "irreversible"
  readonly action?: string | undefined
  readonly effects?: Plan.NodeEffects | undefined
  readonly declaredAt?: DeclaredAt | undefined
}

/**
 * One edge of the graph, with the reason the builder drew it.
 *
 * @since 1.0.0
 * @category models
 */
export interface EdgeSummary {
  readonly from: string
  readonly to: string
  readonly reason: "value" | "continuation" | "failure"
}

/**
 * How a node left the walk.
 *
 * `built` ran, `clean` was served entirely from durable records, `failed`
 * raised, and `skipped` is a node the walk never reached — an untaken branch
 * arm, or a dependent of something that failed.
 *
 * @since 1.0.0
 * @category models
 */
export type NodeOutcome = "built" | "clean" | "failed" | "skipped"

/**
 * The graph a run is about to be driven from, or one page of it.
 *
 * A large plan is paged rather than truncated: the first page is the plan
 * record and the rest are appended subgraphs, because a journal entry has a
 * byte bound and a projection that clips one loses nodes silently. Nothing
 * about one node has to fit one page — its summary, its dependency list and
 * the edges that end on it may each run onto the next — so a page's `nodes`
 * and `edges` are a SLICE of the graph and only the assembled pages are the
 * whole of it.
 *
 * @since 1.0.0
 * @category models
 */
export interface PlanRecorded {
  readonly _tag: "PlanRecorded"
  readonly sourceId: string
  readonly flow: string
  readonly generation: number
  readonly page: number
  readonly pages: number
  /** Every node of the whole graph, not of this page. */
  readonly nodeCount: number
  readonly nodes: ReadonlyArray<NodeSummary>
  readonly edges: ReadonlyArray<EdgeSummary>
}

/**
 * A page of a graph too large for one record.
 *
 * @since 1.0.0
 * @category models
 */
export interface SubgraphAppended {
  readonly _tag: "SubgraphAppended"
  readonly sourceId: string
  readonly flow: string
  readonly generation: number
  readonly page: number
  readonly pages: number
  readonly nodes: ReadonlyArray<NodeSummary>
  readonly edges: ReadonlyArray<EdgeSummary>
}

/**
 * A node the walk is about to compute.
 *
 * `attempt` is the walk's, and it is always 1: the interpreter settles each
 * node once. No step key digest rides here, because none exists yet — the
 * engine allocates a dispatch's ordinal when the dispatch happens, which is
 * after this record is written. The digests arrive on {@link NodeSettled}.
 *
 * @since 1.0.0
 * @category models
 */
export interface NodeScheduled {
  readonly _tag: "NodeScheduled"
  readonly sourceId: string
  readonly nodeId: string
  readonly kind: string
  readonly attempt: number
  readonly action?: string | undefined
}

/**
 * A node that reached an outcome.
 *
 * `attempts` is the highest durable attempt any of this node's dispatches ran
 * as, and 1 for a node that dispatched nothing. It is the engine's count, not
 * the walk's: the interpreter settles each node once, and a retry happens
 * underneath it inside one dispatch, so a node whose action failed and was
 * retried says two.
 *
 * `stepKeyDigests` names the dispatches this node drove, in the order they
 * were first reported and without repeats — a retried dispatch keeps one step
 * key, because the attempt is folded into no key. It is the join a monitor
 * could not make before: `flows.engine.attempt-started` carries a step key
 * digest and no node id, so an attempt row belongs to the node that claims
 * its digest. A node that dispatches nothing claims none, and a runtime that
 * derives no digests reports an empty list.
 *
 * `value` is what the node settled with — the success value for `built` and
 * `clean`, the typed failure for `failed` — handed over whole and unbounded.
 * It is NOT a summary: bounding and redacting it belongs to the writer that
 * knows where it is going, because a durable row has a byte budget and a
 * credential redactor and an in-memory monitor has neither.
 *
 * @since 1.0.0
 * @category models
 */
export interface NodeSettled {
  readonly _tag: "NodeSettled"
  readonly sourceId: string
  readonly nodeId: string
  readonly outcome: NodeOutcome
  readonly attempts: number
  readonly action?: string | undefined
  readonly stepKeyDigests: ReadonlyArray<string>
  readonly value?: unknown
}

/**
 * Everything a walk can tell its runtime.
 *
 * @since 1.0.0
 * @category models
 */
export type NodeRecord = PlanRecorded | SubgraphAppended | NodeScheduled | NodeSettled
