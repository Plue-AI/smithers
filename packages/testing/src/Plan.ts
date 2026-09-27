/**
 * Pure projection and presentation helpers for built plans.
 *
 * The graph is `@smthrs/flow`'s, the one graph builder, and the projection
 * reads exactly what its `GraphNode` carries. Keys are derived from each
 * node's draft material through `@smthrs/plan`'s step-key compiler: sealed
 * material gets a cross-run content key, every other tier gets a run-local
 * ordinal key. Plan projection is pure: it never touches Host, Model, or
 * Clock, and is expected to succeed under `TestLayers.poisoned`.
 *
 * @since 0.0.0
 */

import * as Digest from "@smthrs/core/Digest"
import type * as Flow from "@smthrs/flow/Flow"
import * as Graph from "@smthrs/flow/Graph"
import type * as Placement from "@smthrs/plan/Placement"
import type * as PlanPackage from "@smthrs/plan/Plan"
import * as StepKey from "@smthrs/plan/StepKey"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { compare } from "./internal/Structural.ts"
import type { PlanLike, PlanNodeLike, PlanPlacementLike } from "./PlanLike.ts"

/**
 * Compatibility alias for the plan assertion node shape.
 *
 * @deprecated Use PlanNodeLike from `@smthrs/testing/PlanLike`.
 *
 * @category models
 * @since 0.0.0
 */
export type Node = PlanNodeLike

/**
 * Compatibility alias for the plan assertion shape.
 *
 * @deprecated Use PlanLike from `@smthrs/testing/PlanLike`.
 *
 * @category models
 * @since 0.0.0
 */
export type Plan = PlanLike

/**
 * Options for graph-local key derivation.
 *
 * @category models
 * @since 0.0.0
 */
export interface KeysOptions {
  /** Run identity used for ordinal (non-sealed) keys. Defaults to `"plan"`. */
  readonly runId?: string | undefined
}

/**
 * Inputs needed to project a built graph into the testing assertion port.
 *
 * Keys are computed from each node's draft material by default. The `key`
 * resolver remains available only as a test override for fixtures that need
 * synthetic keys.
 *
 * @category models
 * @since 0.0.0
 */
export interface FromGraphOptions {
  /** Test-only override; omit to derive real keys from graph key material. */
  readonly key?: ((node: Graph.GraphNode) => string) | undefined
  /** Run identity used for ordinal (non-sealed) keys. Defaults to `"plan"`. */
  readonly runId?: string | undefined
  readonly envelope?: Record<string, unknown> | undefined
  readonly digest?: string | undefined
}

/**
 * Options accepted by {@link planOf}.
 *
 * @category models
 * @since 0.0.0
 */
export interface PlanOfOptions extends FromGraphOptions {
  readonly build?: Graph.BuildOptions | undefined
}

// A rendered value may carry what JSON cannot name: an undefined property, a
// function a body captured, a cycle a diagnostic payload built. Rendering is
// total, so each of those becomes an explicit tag and every object is rebuilt
// as a plain literal with sorted keys. It is a pure, deterministic
// normalization used for PRESENTATION only — key material reaches the step-key
// compiler untouched, exactly as `Plan.compile` hands it over.
const canonical = (value: unknown, seen: Set<object> = new Set()): unknown => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value
  }
  if (value === undefined) return null
  if (typeof value === "bigint") return { _tag: "BigInt", value: String(value) }
  if (typeof value === "symbol") return { _tag: "Symbol", value: value.description ?? null }
  if (typeof value === "function") return { _tag: "Function" }
  if (seen.has(value)) return { _tag: "Circular" }
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => canonical(item, seen))
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).sort(([left], [right]) => compare(left, right))) {
      if (item !== undefined) result[key] = canonical(item, seen)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

/**
 * Derives every node's step key from the graph's draft key material.
 *
 * Sealed material becomes a content key via `StepKey.fromKeyMaterial`, with
 * dependency references resolved to previously derived keys in the graph's own
 * dependency order. Every other tier becomes a run-local ordinal key.
 *
 * The material is handed over verbatim, so a sealed node's key here is the key
 * the persisted plan records. A non-sealed node's is not: `Plan.compile`
 * fingerprints every declaration with `StepKey.planIdentity`, which keys a
 * non-sealed tier in the `plan-declaration` namespace, while this helper keys
 * it as the run-local `ordinal` the engine dispatches under.
 *
 * A graph holding a fatal build refusal has no drafts and therefore no keys;
 * `Graph.drafts` raises that refusal rather than keying a truncated topology.
 *
 * Keys hash through the injected `Crypto` service; the synchronous crypto
 * service keeps plan projection pure and total under `TestLayers.poisoned`.
 *
 * @category constructors
 * @since 0.0.0
 */
export const keys = (graph: Graph.Graph, options: KeysOptions = {}): Record<string, string> => {
  const runId = options.runId ?? "plan"
  const digests: Record<string, string> = {}
  Graph.drafts(graph).forEach((draft, index) => {
    const material = draft.material
    digests[draft.id] = Effect.runSync(Digest.provideSync(
      material.kind === "sealed"
        ? StepKey.fromKeyMaterial(material, digests)
        : StepKey.ordinal({
          runId,
          parentScope: draft.id,
          ordinal: index,
          tier: material.kind
        })
    ))
  })
  return digests
}

// A declared path is a pattern string, a glob, a tree artifact, or a named
// filegroup. The pattern spelling is the one a reader recognizes; anything
// else renders as its canonical JSON so the projection stays total and drops
// nothing a declaration named.
const entryText = (entry: unknown): string => typeof entry === "string" ? entry : JSON.stringify(canonical(entry))

const declaredEffects = (declaration: PlanPackage.NodeEffects | undefined): ReadonlyArray<string> =>
  declaration === undefined ? [] : [
    ...declaration.reads.map((entry) => `read:${entryText(entry)}`),
    ...declaration.writes.map((entry) => `write:${entryText(entry)}`),
    ...(declaration.removes ?? []).map((entry) => `remove:${entryText(entry)}`)
  ].sort()

const placementProjection = (placement: Placement.Placement): PlanPlacementLike => {
  const { _tag, ...rest } = placement as { readonly _tag: string } & Record<string, unknown>
  return {
    tag: _tag,
    options: Object.fromEntries(
      Object.entries(rest)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => compare(left, right))
    )
  }
}

/**
 * Projects `@smthrs/flow`'s graph introspection API into a PlanLike.
 *
 * @category constructors
 * @since 0.0.0
 */
export const fromGraph = (graph: Graph.Graph, options: FromGraphOptions = {}): PlanLike => {
  const derived = options.key === undefined ? keys(graph, { runId: options.runId }) : undefined
  return {
    nodes: Graph.nodes(graph).map((node): PlanNodeLike => {
      // The draft's own effects are defaulted for a node that declared none;
      // the material carries the declaration only when there was one, which is
      // what keeps "undeclared" distinguishable from "declared empty".
      const declaration = node.draft.material.effects as PlanPackage.NodeEffects | undefined
      return {
        id: node.id,
        key: options.key === undefined ? derived![node.id]! : options.key(node),
        kind: node.kind,
        ...(node.placement === undefined
          ? {}
          : { placement: placementProjection(node.placement as Placement.Placement) }),
        effects: declaredEffects(declaration),
        ...(declaration === undefined ? {} : { mode: declaration.boundaryMode }),
        tier: node.draft.material.kind,
        sealed: node.draft.material.kind === "sealed"
      }
    }),
    edges: Graph.edges(graph).map(({ from, to }) => ({ from, to })),
    ...(options.envelope === undefined ? {} : { envelope: options.envelope }),
    ...(options.digest === undefined ? {} : { digest: options.digest })
  }
}

/**
 * Decodes flow payload through the flow's declared payload schema, then builds
 * and projects the plan. Un-defaulted input cannot reach a plan: the schema's
 * defaults are applied by construction before planning sees the value.
 *
 * Building and projecting are pure — this succeeds under
 * `TestLayers.poisoned` and only ever fails on schema decoding.
 *
 * @category constructors
 * @since 0.0.0
 */
export const planOf = <F extends Flow.Any>(
  flow: F,
  input: unknown,
  options: PlanOfOptions = {}
): Effect.Effect<PlanLike, Schema.SchemaError, F["payloadSchema"]["DecodingServices"]> =>
  Schema.decodeUnknownEffect(flow.payloadSchema)(input).pipe(
    Effect.map((decoded) => fromGraph(Graph.build(flow, decoded, options.build ?? {}), options))
  )

/**
 * Copies a built plan into a stable presentation order.
 *
 * Node ids, edge endpoints, keys, envelopes, and every other semantic field
 * are retained verbatim. This is intentionally not a graph traversal or a key
 * computation helper.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (plan: PlanLike): PlanLike => ({
  ...plan,
  nodes: plan.nodes
    .map((node) => ({ ...node, effects: [...node.effects].sort() }))
    .sort((left, right) => compare(left.id, right.id)),
  edges: [...plan.edges].sort((left, right) => compare(left.from, right.from) || compare(left.to, right.to))
})

const stable = (value: unknown): string => JSON.stringify(canonical(value))

/**
 * Renders a plan as a stable, line-oriented canonical string.
 *
 * Nodes and edges appear in the deterministic order of {@link make}; object
 * payloads render with sorted keys. Byte-identical output for semantically
 * identical plans makes this the substrate for snapshot assertions.
 *
 * @category formatting
 * @since 0.0.0
 */
export const render = (plan: PlanLike): string => {
  const ordered = make(plan)
  const lines: Array<string> = []
  if (ordered.digest !== undefined) lines.push(`digest ${ordered.digest}`)
  if (ordered.envelope !== undefined) lines.push(`envelope ${stable(ordered.envelope)}`)
  for (const item of ordered.nodes) {
    const parts = [`node ${item.id}`, `key=${item.key}`, `kind=${item.kind}`]
    if (item.placement !== undefined) {
      const options = Object.keys(item.placement.options).length === 0 ? "" : stable(item.placement.options)
      parts.push(`placement=${item.placement.tag}${options}`)
    }
    if (item.mode !== undefined) parts.push(`mode=${item.mode}`)
    parts.push(`tier=${item.tier}`)
    parts.push(`sealed=${item.sealed}`)
    parts.push(`effects=[${[...item.effects].sort().join(",")}]`)
    lines.push(parts.join(" "))
  }
  for (const value of ordered.edges) lines.push(`edge ${value.from} -> ${value.to}`)
  return lines.join("\n")
}

/**
 * Returns the built node with the supplied id, if present.
 *
 * @category getters
 * @since 0.0.0
 */
export const node = (plan: PlanLike, id: string): PlanNodeLike | undefined =>
  plan.nodes.find((candidate) => candidate.id === id)

/**
 * Renders an edge as a stable, readable pair.
 *
 * @category formatting
 * @since 0.0.0
 */
export const edge = (value: PlanLike["edges"][number]): string => `${value.from} -> ${value.to}`
