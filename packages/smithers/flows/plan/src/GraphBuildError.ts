/**
 * The refusals a plan-time build raises instead of producing a wrong plan.
 *
 * Every one of these fails LOUDLY at build time: a planned value that was computed on must not
 * bake `NaN` into a plan, an arm that returned something other than a node must
 * not silently vanish from the topology, and a recursive `.call()` must direct
 * the author to `.to()` or `.child()` rather than expanding forever. Each
 * failure therefore names the site (`node` plus the recorded property `path`)
 * and states the fix in `message`, because the author reading it is mid-body
 * and needs the correction, not a classification.
 *
 * The codes are a closed schema literal so a caller can switch on them, and so
 * a new refusal is a deliberate addition rather than a new free-form string.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * The stable code of a build refusal.
 *
 * `planned_value_computed` is a body computing on a step result;
 * `invalid_all_member` is a non-node handed to {@link module:Node.all};
 * `invalid_continuation` is a branch arm or continuation that did not return a
 * node; `recursion_requires_boundary` is a flow calling itself inline, which
 * has to become a trampoline handoff or an explicit child boundary;
 * `placement_requires_boundary` is an inline call whose callee declares a
 * placement the enclosing flow cannot satisfy, which has to become that same
 * explicit child boundary; `cyclic_payload` is a payload that contains itself,
 * which no plan could serialize or hash; `payload_too_deep` is a payload
 * nested past the build bound, which has to be flattened into shallower data;
 * `graph_too_deep` is authored topology nested past the build bound, which
 * has to be split with `.child()` boundaries or trampoline handoffs;
 * `duplicate_node` is two structural graph addresses resolving to one durable
 * node id;
 * `invalid_priority` is a scheduling priority that is not a safe integer,
 * which no ordering could compare; `invalid_payload` is a payload member that
 * cannot be captured as inert JSON without executing author code or losing
 * identity; `unstable_callback` is a function with process-local identity in a
 * graph that requires stable callbacks. Declare its complete inert captures
 * with `Node.capture`, including semantic implementation versions. The two
 * depth refusals exist because graph building walks with an explicit stack
 * and refuses at a bound, rather than recursing until the native stack
 * overflows without a typed error.
 *
 * The four effect-authority refusals are raised when a declaration claims more
 * than the declaration enclosing it granted:
 * `effect_outside_envelope` is a read or write path the envelope does not
 * cover, and it names those paths in `path`; `effect_mode_widening` is an
 * `expected` declaration inside a `hermetic` envelope; `effect_tier_widening`
 * is a tier less reversible than the envelope's; and
 * `capability_outside_grant` is a called flow or action requiring a capability
 * the caller does not hold, which names the dropped capabilities in `path`. The
 * first three are fatal by {@link isFatalDiagnostic}; the fourth is advisory,
 * because dropping a capability narrows authority rather than widening it.
 *
 * The last six are raised by `@smthrs/core`'s graph builder, which uses this
 * one error rather than a second class of its own. `write_conflict` is two work
 * nodes overlapping under `onConflict: "fail"`, and `node` names the first of
 * the pair while `Graph.conflicts` carries both; `missing_key_material` is a
 * node that reached key compilation without any; `dependency_cycle` is a
 * dependency set that cannot be ordered, and `node` names a node in the cycle;
 * `plan_too_large` is a node, edge, conflict, or effect-path limit crossed, and
 * `node` names the node whose admission crossed it; `payload_too_large` is a
 * plan value with more members than the bound, and `path` names the offending
 * value path; `invalid_node` is a malformed node AST. All six are fatal.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const GraphBuildErrorCode = Schema.Literals([
  "planned_value_computed",
  "invalid_all_member",
  "invalid_continuation",
  "recursion_requires_boundary",
  "placement_requires_boundary",
  "cyclic_payload",
  "payload_too_deep",
  "graph_too_deep",
  "duplicate_node",
  "invalid_priority",
  "invalid_payload",
  "unstable_callback",
  "effect_outside_envelope",
  "effect_mode_widening",
  "effect_tier_widening",
  "capability_outside_grant",
  "write_conflict",
  "missing_key_material",
  "dependency_cycle",
  "plan_too_large",
  "payload_too_large",
  "invalid_node"
])

/**
 * The value form of {@link GraphBuildErrorCode}.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type GraphBuildErrorCode = typeof GraphBuildErrorCode.Type

/**
 * A build the planner refuses, naming the site and the fix.
 *
 * `node` is the node reference the failure belongs to — a planned value's
 * origin node, an `all` member name, a branch arm, or the node whose admission
 * crossed a bound. `path` is the property path recorded on a planned value
 * before it was misused, the effect paths an over-claiming declaration named,
 * the capabilities a call lost, or the value path of an oversized payload; it
 * is empty for every other code.
 *
 * This is the ONE build refusal. `@smthrs/core`'s graph builder raised a second
 * `GraphBuildError` of its own, with `paths`, `nodeId` and `nodes` in place of
 * these fields, and the two code sets diverged instead of merging. A conflict's
 * second node is read from `Graph.conflicts`, which carries the pair.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export class GraphBuildError extends Schema.TaggedError<GraphBuildError>()("@smthrs/plan/GraphBuildError", {
  code: GraphBuildErrorCode,
  node: Schema.String,
  path: Schema.Array(Schema.String),
  message: Schema.String
}) {}

/**
 * The one advisory code. Everything else a build records blocks the drafts.
 *
 * A capability the caller does not grant is DROPPED, not granted: the callee
 * runs with less authority than it asked for, which is the safe direction. The
 * author still needs to know, because a flow that silently loses a capability
 * fails later at the action that needed it, so the build records the refusal
 * and lets the graph compile.
 */
const advisoryCodes: ReadonlySet<GraphBuildErrorCode> = new Set<GraphBuildErrorCode>(["capability_outside_grant"])

/**
 * Whether a recorded refusal blocks the drafts a plan is compiled from.
 *
 * A fatal refusal means the graph describes something no plan could execute as
 * written, so the drafts are withheld. An advisory one reports a narrowing the
 * author should see while the graph still compiles.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const isFatalDiagnostic = (diagnostic: GraphBuildError): boolean => !advisoryCodes.has(diagnostic.code)
