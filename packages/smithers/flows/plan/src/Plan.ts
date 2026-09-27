/**
 * The plan: a node graph with every step key computed, inert until run.
 *
 * The way a plan is produced is a law: **planning performs no I/O**.
 * Everything in this module is therefore a pure function of declarations plus
 * the injected `Crypto` service: no filesystem, no clock, no network. A node's
 * key is a function of what it consumes, so an edited declaration re-keys that
 * node and everything downstream of it, and nothing else. That is the entire
 * invalidation mechanism. Invalidation is re-keying, which **rejects**
 * Skyframe's reverse-dependency index and invalidating node visitor outright
 * because content addressing subsumes them. Key invalidation never retains a
 * reverse-dependency index; annotation uses only a temporary reachability cache.
 *
 * Growth is append-only: {@link append} adds a pre-keyed subgraph to the same
 * plan and never rewrites a node already in it.
 *
 * @since 0.1.0
 */

import { DerivedKey, StoredKey } from "@smthrs/keys"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Inspectable from "effect/Inspectable"
import * as Schema from "effect/Schema"
import * as Effects from "./Effects.ts"
import * as FileSet from "./FileSet.ts"
import { GraphBuildError } from "./GraphBuildError.ts"
import * as Conflicts from "./internal/ConflictAnnotation.ts"
import { jsonMirror } from "./internal/JsonMirror.ts"
import * as KeyMaterial from "./KeyMaterial.ts"
import * as StepKey from "./StepKey.ts"

/**
 * What a node does to the world, declared. Paths only — measuring them is
 * run-time work, so a digest here would break the no-I/O law.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const NodeEffects = Schema.Struct({
  reads: Schema.Array(FileSet.ReadDeclaration),
  writes: Schema.Array(FileSet.Declaration),
  /**
   * Paths the node declares it will DELETE. A removal mutates the world exactly
   * as a write does, so {@link produces} folds the two together and both the
   * conflict pass and the reader-after-writer pass see them as one set.
   */
  removes: Schema.optional(Schema.Array(FileSet.Pattern)),
  boundaryMode: FileSet.BoundaryMode
})

/**
 * The value form of {@link NodeEffects}.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type NodeEffects = typeof NodeEffects.Type

/**
 * The plan-time write-conflict strategies of the effect taxonomy.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const PairStrategy = Effects.ConflictStrategy

/**
 * The value form of {@link PairStrategy}.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type PairStrategy = typeof PairStrategy.Type

/**
 * The runtime half of a conflict annotation: what the scheduler
 * does when the overlap the plan predicted actually bites, or when a
 * scheduled node's inputs are invalidated under it.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const RuntimeStrategy = Schema.Literals(["delay-rebase", "stop-merge"])

/**
 * The value form of {@link RuntimeStrategy}.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type RuntimeStrategy = typeof RuntimeStrategy.Type

/** @private */
const NodeKind = Schema.Literals(["step", "agent", "merge"])

/**
 * One resolved overlap between two writers that no dependency path already
 * orders. Conflict is a property of the PAIR, not of one declaration.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const ConflictAnnotation = Schema.Struct({
  with: Schema.NonEmptyString,
  paths: Schema.Array(Schema.String),
  strategy: PairStrategy,
  runtime: RuntimeStrategy
})

/**
 * The value form of {@link ConflictAnnotation}.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type ConflictAnnotation = typeof ConflictAnnotation.Type

/**
 * A keyed node of the plan.
 *
 * `dependsOn` is the *edge* set: material references, any ordering edge a
 * `serialize` verdict added, and the reader-after-writer edges that put a
 * node behind whoever produces the paths it reads. Ordering edges are
 * deliberately NOT part of the key — a node ordered behind another still
 * computes the same result, so re-keying it would throw away a legitimate
 * cache hit.
 *
 * `strategy` and `runtime` are this declaration's own preferences, recorded so
 * a later elaboration can resolve a pair against them without re-reading the
 * flow source.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const PlanNode = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: NodeKind,
  key: StoredKey,
  material: KeyMaterial.KeyMaterial,
  effects: NodeEffects,
  dependsOn: Schema.Array(Schema.NonEmptyString),
  conflicts: Schema.Array(ConflictAnnotation),
  strategy: PairStrategy,
  runtime: RuntimeStrategy,
  priority: Schema.Int,
  generation: Schema.Int
})

/**
 * The value form of {@link PlanNode}.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type PlanNode = typeof PlanNode.Type

/**
 * A plan: the whole keyed graph plus the digest an approval binds to.
 *
 * `nodes` follows material-dependency order within each generation. Inferred
 * edges can point to later entries; schedule from the complete `dependsOn`
 * graph, never by iterating the array alone.
 *
 * `baseDigest` is the digest at generation 0: what a human approved and what
 * a `RUNNING` run pins. `digest` advances with every appended elaboration.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const Plan = Schema.Struct({
  planId: Schema.NonEmptyString,
  flow: Schema.NonEmptyString,
  generation: Schema.Int,
  baseDigest: StoredKey,
  digest: StoredKey,
  nodes: Schema.Array(PlanNode)
})

/**
 * The value form of {@link Plan}.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Plan = typeof Plan.Type

/**
 * What a planner hands {@link compile}: a node without its key.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface NodeDraft {
  readonly id: string
  readonly material: KeyMaterial.KeyMaterial
  readonly effects: NodeEffects
  readonly kind?: PlanNode["kind"] | undefined
  readonly priority?: number | undefined
  /** This declaration's preferred plan-time verdict for a detected overlap. */
  readonly conflictStrategy?: PairStrategy | undefined
  /** This declaration's preferred runtime response. */
  readonly runtimeStrategy?: RuntimeStrategy | undefined
}

/**
 * A graph the compiler refuses.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export class PlanError extends Schema.TaggedError<PlanError>()("@smthrs/plan/PlanError", {
  code: Schema.Literals([
    "cycle",
    "unknown_dependency",
    "duplicate_node",
    "overlap_forbidden",
    "invalid_effects",
    "invalid_node",
    "invalid_plan",
    "graph_too_large"
  ]),
  message: Schema.String
}) {}

/**
 * Maximum number of nodes retained by one compiled plan.
 *
 * Effect analysis also has a yielding work budget, since a node ceiling alone
 * does not bound dense conflicts to practical work.
 *
 * @since 1.0.0
 * @category limits
 * @slop
 */
export const maximumPlanNodes = 10_000

/** @private */
const graphSizeError = (size: number): PlanError =>
  new PlanError({
    code: "graph_too_large",
    message: `A plan may contain at most ${maximumPlanNodes} nodes, received ${size}`
  })

/** @private */
type Ordered =
  | { readonly ok: true; readonly drafts: ReadonlyArray<NodeDraft> }
  | { readonly ok: false; readonly error: PlanError }

/**
 * Topologically orders drafts by their MATERIAL dependencies — the only edges
 * that exist before keys do.
 *
 * @private
 */
const topological = (drafts: ReadonlyArray<NodeDraft>, known: ReadonlySet<string>): Ordered => {
  const byId = new Map(drafts.map((draft) => [draft.id, draft]))
  const ordered: Array<NodeDraft> = []
  const state = new Map<string, "visiting" | "done">()
  interface Frame {
    readonly draft: NodeDraft
    readonly dependencies: ReadonlyArray<string>
    next: number
  }
  for (const draft of drafts) {
    if (state.get(draft.id) === "done") continue
    state.set(draft.id, "visiting")
    const stack: Array<Frame> = [{ draft, dependencies: KeyMaterial.dependencies(draft.material), next: 0 }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      if (frame.next === frame.dependencies.length) {
        state.set(frame.draft.id, "done")
        ordered.push(frame.draft)
        stack.pop()
        continue
      }
      const dependency = frame.dependencies[frame.next++]!
      if (known.has(dependency)) continue
      const next = byId.get(dependency)
      if (next === undefined) {
        return {
          ok: false,
          error: new PlanError({
            code: "unknown_dependency",
            message: `Node ${frame.draft.id} depends on unknown node ${dependency}`
          })
        }
      }
      const mark = state.get(next.id)
      if (mark === "done") continue
      if (mark === "visiting") {
        return {
          ok: false,
          error: new PlanError({ code: "cycle", message: `Plan cycle through node ${next.id}` })
        }
      }
      state.set(next.id, "visiting")
      stack.push({ draft: next, dependencies: KeyMaterial.dependencies(next.material), next: 0 })
    }
  }
  return { ok: true, drafts: ordered }
}

/**
 * Runs the conflict and reader-after-writer passes and records what they found
 * on every node outside `frozen`, whose rows an append never rewrites. A
 * refused graph fails as a `PlanError` carrying the pass's code and message.
 *
 * @private
 */
const annotate = (
  nodes: ReadonlyArray<PlanNode>,
  frozen: ReadonlySet<string>,
  replayGenerations = false
): Effect.Effect<ReadonlyArray<PlanNode>, PlanError> =>
  Conflicts.annotate(nodes, frozen.size, replayGenerations).pipe(
    Effect.mapError((refusal) => new PlanError(refusal)),
    Effect.map(({ conflicts, ordering }) =>
      nodes.map((node) => {
        if (frozen.has(node.id)) return node
        const added = ordering.get(node.id) ?? []
        return freezeNode({
          ...node,
          conflicts: conflicts.get(node.id) ?? [],
          dependsOn: added.length === 0 ? node.dependsOn : [...node.dependsOn, ...added]
        })
      })
    )
  )

/**
 * The single approval projection. Its node list is the complete reviewable and
 * behavior-bearing contract: id, kind, key, edges, conflict annotations,
 * declared effects, conflict strategy, runtime strategy, and priority.
 *
 * @private
 */
const approvalPayload = (
  planId: string,
  flow: string,
  nodes: ReadonlyArray<PlanNode>
) => ({
  body: { kind: "plan", planId, flow },
  inputs: {
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      key: node.key,
      dependsOn: node.dependsOn,
      conflicts: node.conflicts,
      effects: node.effects,
      strategy: node.strategy,
      runtime: node.runtime,
      priority: node.priority
    }))
  },
  layers: [],
  capabilities: {}
})

/**
 * The plan's digest: what an approval binds to. Deriving it only from
 * {@link approvalPayload} keeps the approved field list in one place.
 *
 * @private
 */
const digestOf = (
  planId: string,
  flow: string,
  nodes: ReadonlyArray<PlanNode>
): Effect.Effect<StepKey.StepKey, StepKey.KeyMaterialError | Schema.SchemaError, Crypto.Crypto> =>
  StepKey.content(approvalPayload(planId, flow, nodes))

/** @private */
const maximumDescriptionLength = 256

/** @private */
const describeValue = (value: unknown): string => {
  const rendered = typeof value === "string" ? JSON.stringify(value) : Inspectable.toStringUnknown(value, 0)
  return rendered.length > maximumDescriptionLength
    ? `${rendered.slice(0, maximumDescriptionLength - 3)}...`
    : rendered
}

/** @private */
const describeNodeId = (id: string): string => id.length > maximumDescriptionLength ? describeValue(id) : id

/** @private */
const validateIdentity = (planId: unknown, flow: unknown): PlanError | undefined => {
  if (typeof planId !== "string" || planId.length === 0) {
    return new PlanError({
      code: "invalid_node",
      message: `Plan option planId must be a non-empty string, received ${describeValue(planId)}`
    })
  }
  if (typeof flow !== "string" || flow.length === 0) {
    return new PlanError({
      code: "invalid_node",
      message: `Plan option flow must be a non-empty string, received ${describeValue(flow)}`
    })
  }
  return undefined
}

/** Whether `value` is a container this module may safely copy. */
const isSnapshotContainer = (value: unknown): value is object => {
  if (typeof value !== "object" || value === null) return false
  if (Array.isArray(value)) return true
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Creates an empty container with the source container's supported prototype. */
const emptySnapshot = (source: object): object =>
  Array.isArray(source) ? [] : Object.create(Object.getPrototypeOf(source)) as object

/**
 * Copies and freezes plain structural containers without interpreting them as
 * JSON. Shared references and cycles point at one cloned container through
 * `memo`; every other value passes through by reference and remains unfrozen.
 * In particular, this does not probe a `Planned` proxy. `validateDrafts`
 * creates the inert material mirror inside the Effect while retaining that
 * proxy, so the canonical serializer still reaches and refuses it.
 */
const snapshot = <A extends object>(value: A): A => {
  const root = emptySnapshot(value)
  const memo = new WeakMap<object, object>([[value, root]])
  const pending: Array<{ readonly source: object; readonly target: object }> = [{ source: value, target: root }]
  const created = [root]

  while (pending.length > 0) {
    const { source, target } = pending.pop()!
    for (const key of Reflect.ownKeys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key)!
      if ("value" in descriptor && isSnapshotContainer(descriptor.value)) {
        let child = memo.get(descriptor.value)
        if (child === undefined) {
          child = emptySnapshot(descriptor.value)
          memo.set(descriptor.value, child)
          pending.push({ source: descriptor.value, target: child })
          created.push(child)
        }
        descriptor.value = child
      }
      Object.defineProperty(target, key, descriptor)
    }
  }

  for (const container of created) Object.freeze(container)
  return root as A
}

/** Freezes one node built by this module while retaining its material snapshot. */
const freezeNode = (node: PlanNode): PlanNode =>
  Object.freeze({
    ...node,
    dependsOn: Object.freeze([...node.dependsOn]),
    conflicts: Object.freeze(
      node.conflicts.map((conflict) => Object.freeze({ ...conflict, paths: Object.freeze([...conflict.paths]) }))
    )
  })

/** Plans whose complete immutable snapshot was created by this module. */
const frozenPlans = new WeakSet<Plan>()

/** Freezes the plan envelope and its newly built node list. */
const freezePlan = (plan: Plan): Plan => {
  const frozen = Object.freeze({ ...plan, nodes: Object.freeze([...plan.nodes]) })
  frozenPlans.add(frozen)
  return frozen
}

/**
 * Validates the runtime-only parts of `NodeDraft` without replacing effect
 * admission. Effect 4 Struct decoding strips excess properties and copies its
 * schema arrays. The decoded effect declaration replaces any caller-supplied
 * `material.effects`, and every accepted draft receives one deeply frozen JSON
 * mirror for both storage and hashing.
 *
 * @private
 */
const validateDrafts = (
  drafts: ReadonlyArray<NodeDraft>
): Effect.Effect<ReadonlyArray<NodeDraft>, PlanError> =>
  Effect.forEach(drafts, (draft) =>
    Effect.gen(function*() {
      if (typeof draft.id !== "string" || draft.id.length === 0) {
        return yield* Effect.fail(
          new PlanError({
            code: "invalid_node",
            message: `Node id must be a non-empty string, received ${describeValue(draft.id)}`
          })
        )
      }
      const nodeId = describeNodeId(draft.id)
      if (draft.priority !== undefined && !Number.isSafeInteger(draft.priority)) {
        return yield* Effect.fail(
          new PlanError({
            code: "invalid_node",
            message: `Node ${nodeId} priority must be a safe integer, received ${describeValue(draft.priority)}`
          })
        )
      }
      if (draft.kind !== undefined && !Schema.is(NodeKind)(draft.kind)) {
        return yield* Effect.fail(
          new PlanError({
            code: "invalid_node",
            message: `Node ${nodeId} kind must be step, agent, or merge, received ${describeValue(draft.kind)}`
          })
        )
      }
      if (draft.conflictStrategy !== undefined && !Schema.is(PairStrategy)(draft.conflictStrategy)) {
        return yield* Effect.fail(
          new PlanError({
            code: "invalid_node",
            message: `Node ${nodeId} conflictStrategy must be serialize, lane, or fail, received ${
              describeValue(draft.conflictStrategy)
            }`
          })
        )
      }
      if (draft.runtimeStrategy !== undefined && !Schema.is(RuntimeStrategy)(draft.runtimeStrategy)) {
        return yield* Effect.fail(
          new PlanError({
            code: "invalid_node",
            message: `Node ${nodeId} runtimeStrategy must be delay-rebase or stop-merge, received ${
              describeValue(draft.runtimeStrategy)
            }`
          })
        )
      }
      const decodedMaterial = yield* Schema.decodeUnknownEffect(KeyMaterial.KeyMaterial)(draft.material).pipe(
        Effect.mapError((cause) =>
          new PlanError({
            code: "invalid_node",
            message: `Node ${nodeId} has invalid material: ${cause.message}`
          })
        )
      )
      const decodedEffects = yield* Schema.decodeUnknownEffect(NodeEffects)(draft.effects).pipe(
        Effect.mapError((cause) =>
          new PlanError({
            code: "invalid_node",
            message: `Node ${nodeId} has invalid effects: ${cause.message}`
          })
        )
      )
      let material: KeyMaterial.KeyMaterial
      try {
        material = snapshot(
          jsonMirror({ ...decodedMaterial, effects: decodedEffects }, (planned) => planned) as KeyMaterial.KeyMaterial
        )
      } catch (cause) {
        const path = cause instanceof GraphBuildError ? cause.path : []
        return yield* Effect.fail(
          new PlanError({
            code: "invalid_node",
            message: `Node ${nodeId} has invalid material payload at ${["$", ...path].join(".")}`
          })
        )
      }
      return Object.freeze({
        ...draft,
        material,
        effects: material.effects as NodeEffects
      })
    }))

/**
 * The effects schema admits each individual declaration in `validateDrafts`.
 * This pass enforces the cross-field invariant that one path cannot be both a
 * write and a removal.
 *
 * @private
 */
const validateEffects = (id: string, effects: NodeEffects): PlanError | undefined => {
  const removes = effects.removes ?? []
  const writes = FileSet.expand(effects.writes)
  for (const removal of removes) {
    if (writes.some((entry) => FileSet.overlaps(entry, removal))) {
      return new PlanError({
        code: "invalid_effects",
        message: `Node ${id} declares ${removal} as both a write and a removal`
      })
    }
  }
  return undefined
}

/** @private */
const keyNodes = (
  drafts: ReadonlyArray<NodeDraft>,
  existing: ReadonlyArray<PlanNode>,
  generation: number
): Effect.Effect<
  ReadonlyArray<PlanNode>,
  PlanError | StepKey.KeyMaterialError | Schema.SchemaError,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const digests: Record<string, string> = Object.create(null) as Record<string, string>
    const known = new Set<string>()
    for (const node of existing) {
      Object.defineProperty(digests, node.id, {
        configurable: true,
        enumerable: true,
        value: node.key,
        writable: true
      })
      known.add(node.id)
    }
    for (const draft of drafts) {
      if (known.has(draft.id)) {
        return yield* Effect.fail(
          new PlanError({ code: "duplicate_node", message: `Node ${draft.id} is already in the plan` })
        )
      }
      known.add(draft.id)
    }
    const sorted = topological(drafts, new Set(existing.map((node) => node.id)))
    if (!sorted.ok) return yield* Effect.fail(sorted.error)
    const keyed: Array<PlanNode> = []
    for (const draft of sorted.drafts) {
      const invalid = validateEffects(draft.id, draft.effects)
      if (invalid !== undefined) return yield* Effect.fail(invalid)
      const key = yield* StepKey.planIdentity(draft.material, digests)
      Object.defineProperty(digests, draft.id, {
        configurable: true,
        enumerable: true,
        value: key,
        writable: true
      })
      keyed.push(freezeNode({
        id: draft.id,
        kind: draft.kind ?? "step",
        key,
        material: draft.material,
        effects: draft.effects,
        dependsOn: KeyMaterial.dependencies(draft.material),
        conflicts: [],
        strategy: draft.conflictStrategy ?? "serialize",
        runtime: draft.runtimeStrategy ?? "delay-rebase",
        priority: draft.priority ?? 0,
        generation
      }))
    }
    return keyed
  })

/**
 * Compiles drafts into a plan: material-dependency order, dependency-digest
 * substitution, overlap annotation, and the plan digest. No I/O.
 * Inferred edges extend `dependsOn` without reordering the node array.
 *
 * Traversal uses explicit stacks. Because the conflict and reader/writer
 * passes consider a quadratic number of node pairs, plans are bounded by
 * {@link maximumPlanNodes} and fail with `graph_too_large` above that limit
 * or the effect-analysis work budget. Analysis yields periodically.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const compile = (options: {
  readonly planId: string
  readonly flow: string
  readonly nodes: ReadonlyArray<NodeDraft>
}): Effect.Effect<Plan, PlanError | StepKey.KeyMaterialError | Schema.SchemaError, Crypto.Crypto> => {
  const captured = snapshot(options)
  return Effect.gen(function*() {
    const invalidIdentity = validateIdentity(captured.planId, captured.flow)
    if (invalidIdentity !== undefined) return yield* Effect.fail(invalidIdentity)
    if (captured.nodes.length > maximumPlanNodes) return yield* Effect.fail(graphSizeError(captured.nodes.length))
    const drafts = yield* validateDrafts(captured.nodes)
    const keyed = yield* keyNodes(drafts, [], 0)
    const nodes = yield* annotate(keyed, new Set())
    const digest = yield* digestOf(captured.planId, captured.flow, nodes)
    return freezePlan({
      planId: captured.planId,
      flow: captured.flow,
      generation: 0,
      baseDigest: digest,
      digest,
      nodes
    })
  })
}

/**
 * Appends an elaborated subgraph to an existing plan.
 *
 * The plan GROWS; it is never invalidated. Nodes already in it keep their id,
 * key, edges, and generation byte for byte, and the new nodes arrive pre-keyed
 * against them, so a `hit` shows instantly. New nodes retain their material
 * dependency order; scheduling must honor their complete `dependsOn` graph.
 * Re-ordering after a reconciliation happens by re-keying *future* steps,
 * never by rewriting history.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const append = (
  plan: Plan,
  drafts: ReadonlyArray<NodeDraft>
): Effect.Effect<Plan, PlanError | StepKey.KeyMaterialError | Schema.SchemaError, Crypto.Crypto> => {
  const candidate = frozenPlans.has(plan) ? plan : snapshot(plan)
  const capturedDrafts = snapshot(drafts)
  return Effect.gen(function*() {
    const invalidIdentity = validateIdentity(candidate.planId, candidate.flow)
    if (invalidIdentity !== undefined) return yield* Effect.fail(invalidIdentity)
    const capturedPlan = yield* verify(candidate)
    const nextSize = capturedPlan.nodes.length + capturedDrafts.length
    if (nextSize > maximumPlanNodes) return yield* Effect.fail(graphSizeError(nextSize))
    const validated = yield* validateDrafts(capturedDrafts)
    if (validated.length === 0) {
      return yield* Effect.fail(
        new PlanError({
          code: "invalid_node",
          message: `Plan ${capturedPlan.planId} append requires at least one draft`
        })
      )
    }
    const generation = capturedPlan.generation + 1
    const keyed = yield* keyNodes(validated, capturedPlan.nodes, generation)
    const nodes = yield* annotate(
      [...capturedPlan.nodes, ...keyed],
      new Set(capturedPlan.nodes.map((node) => node.id))
    )
    const digest = yield* digestOf(capturedPlan.planId, capturedPlan.flow, nodes)
    return freezePlan({ ...capturedPlan, generation, digest, nodes })
  })
}

/**
 * Verifies an imported plan against the same key and topology rules as the
 * compiler. Valid compiler-owned immutable values need no second compilation.
 *
 * Generation boundaries are replayed when reconstructing conflict annotations:
 * an append may annotate new nodes, but cannot rewrite an earlier generation.
 * Recorded material-dependency order is verified without sorting inferred edges.
 * Keys and approval digests retain their existing format. The returned snapshot
 * is immutable; later caller mutation cannot change the verified value.
 *
 * @since 1.0.0
 * @category validation
 */
export const verify = (
  input: unknown
): Effect.Effect<Plan, PlanError | StepKey.KeyMaterialError | Schema.SchemaError, Crypto.Crypto> =>
  Effect.gen(function*() {
    if (typeof input === "object" && input !== null && frozenPlans.has(input as Plan)) return input as Plan
    // Check the array ceiling before schema decoding copies its members.
    if (typeof input === "object" && input !== null && "nodes" in input && Array.isArray(input.nodes)) {
      if (input.nodes.length > maximumPlanNodes) return yield* Effect.fail(graphSizeError(input.nodes.length))
    }
    const decoded = yield* Schema.decodeUnknownEffect(Plan)(input)
    const invalid = (message: string) => new PlanError({ code: "invalid_plan", message })
    if (
      !Number.isSafeInteger(decoded.generation) || decoded.generation < 0 || decoded.generation > decoded.nodes.length
    ) {
      return yield* Effect.fail(
        invalid("Plan generation must be a non-negative safe integer with a nonempty appended generation")
      )
    }
    const generations = new Map<string, number>()
    let previous = 0
    for (const node of decoded.nodes) {
      if (!Number.isSafeInteger(node.generation) || node.generation < previous || node.generation > previous + 1) {
        return yield* Effect.fail(invalid(`Node ${node.id} has an invalid or out-of-order generation`))
      }
      generations.set(node.id, node.generation)
      previous = node.generation
    }
    if (previous !== decoded.generation) {
      return yield* Effect.fail(invalid("Plan generation does not match its newest nodes"))
    }
    for (const node of decoded.nodes) {
      for (const dependency of KeyMaterial.dependencies(node.material)) {
        const generation = generations.get(dependency)
        if (generation !== undefined && generation > node.generation) {
          return yield* Effect.fail(invalid(`Node ${node.id} refers to a future generation`))
        }
      }
    }
    const drafts = yield* validateDrafts(decoded.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      material: node.material,
      effects: node.effects,
      conflictStrategy: node.strategy,
      runtimeStrategy: node.runtime,
      priority: node.priority
    })))
    const keyed = (yield* keyNodes(drafts, [], 0)).map((node) =>
      freezeNode({ ...node, generation: generations.get(node.id)! })
    )
    // Replay boundaries within one annotation pass, retaining its expansion
    // map, candidate trie, inferred graph and reachability cache throughout.
    const nodes = yield* annotate(keyed, new Set(), true)
    const baseDigest = yield* digestOf(decoded.planId, decoded.flow, nodes.filter((node) => node.generation === 0))
    const digest = decoded.generation === 0 ? baseDigest : yield* digestOf(decoded.planId, decoded.flow, nodes)
    if (decoded.baseDigest !== baseDigest || decoded.digest !== digest) {
      return yield* Effect.fail(invalid("Plan approval digest does not match its compiled content"))
    }
    // Compare the complete node contract, including material and generation,
    // rather than trusting the claimed keys or the approval projection alone.
    const hash = Schema.decodeUnknownEffect(DerivedKey)
    if ((yield* hash(decoded.nodes)) !== (yield* hash(nodes))) {
      return yield* Effect.fail(
        invalid("Plan nodes do not match their compiled keys, effects, ordering, or generations")
      )
    }
    return freezePlan({ ...decoded, nodes })
  })

/**
 * The nodes added by the newest generation: what {@link module:PlanStore}
 * appends and what the `subgraph-appended` journal record names.
 *
 * @since 0.1.0
 * @category accessors
 * @slop
 */
export const generationNodes = (plan: Plan): ReadonlyArray<PlanNode> =>
  plan.nodes.filter((node) => node.generation === plan.generation)

/**
 * Whether `input` is a compiler-owned immutable snapshot that already passed
 * {@link verify}: such values take verify's trusted fast path and need no
 * second schema validation.
 *
 * @since 1.0.0
 * @category guards
 * @slop
 */
export const isVerified = (input: unknown): input is Plan =>
  typeof input === "object" && input !== null && frozenPlans.has(input as Plan)

/**
 * The approval digest of every generation before the newest: the digest this
 * plan carried before its last append. {@link module:PlanStore}'s append
 * matches it against the stored envelope, so an append proves the recorded
 * plan's integrity from the already-verified prefix instead of decoding and
 * re-verifying every stored row.
 *
 * @since 1.0.0
 * @category accessors
 * @slop
 */
export const prefixDigest = (
  plan: Plan
): Effect.Effect<StepKey.StepKey, StepKey.KeyMaterialError | Schema.SchemaError, Crypto.Crypto> =>
  digestOf(plan.planId, plan.flow, plan.nodes.filter((node) => node.generation < plan.generation))
