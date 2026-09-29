/**
 * Graph building: a flow declaration plus a real payload, walked once into the
 * drafts a plan is compiled from.
 *
 * This is the plan phase of `docs/concepts/bodies-and-plans.md` and nothing
 * else — no I/O, no execution, no elaboration. {@link build} evaluates the
 * body with the REAL payload, because a body's own payload is data
 * (`docs/concepts/flows-and-actions.md`), and evaluates every
 * continuation and branch arm exactly once against a STRICT
 * {@link module:Planned.Planned} placeholder, because a step result does not
 * exist yet. A body that computes on a placeholder therefore fails here,
 * naming the node, rather than baking `NaN` into a plan.
 *
 * Fatal refusals stay fatal. Computing on a planned value throws its
 * `GraphBuildError` immediately, as does recursively expanding an inline
 * `.call()`, because either case makes the requested graph invalid. Recoverable
 * topology loss, such as a missing or invalid continuation, is reported in
 * {@link Graph.diagnostics} so the remaining graph can still be inspected.
 *
 * The walk is stack-safe by construction: topology and payloads are traversed
 * with explicit stacks, never native recursion, and each carries a nesting
 * bound. Topology past the bound is a typed `graph_too_deep` refusal, a
 * payload past it is `payload_too_deep`, and a payload containing itself is
 * `cyclic_payload` — all three fail loudly where unbounded recursion would
 * overflow the native stack without a typed error.
 *
 * Composition follows the same note: `Other.call(payload)` splices the
 * callee's body into this graph with the capabilities of the two declarations
 * intersected, and a flow that calls itself inline throws with the trampoline
 * (`docs/concepts/trampoline-rounds.md`) and the child boundary as the two
 * ways out. A callee whose declared placement the enclosing flow does not carry
 * throws for the same reason and names the same way out, because inline
 * expansion is the claim that these steps run in the caller's execution.
 * `Other.child(payload)` is that boundary: one leaf node here, its own
 * execution when the graph is driven. A branch expands BOTH arms, so the
 * exit condition and the handoff site are visible topology before anything
 * runs, and the predicate rides the branch's key material as a digest.
 *
 * What comes out is `@smthrs/plan` shaped: {@link Graph.drafts} feeds
 * `Plan.compile` and `Plan.append` unchanged, and the `Ref`/`Pending` inputs a
 * node's key material names are what the compiler turns into dependency
 * digests and the plan turns into edges. Structural node ids are derived only
 * from traversal positions and do not enter a plan draft's hashed value, so
 * editing a mapper re-keys exactly what reads it. The interpreter does use an
 * `ActionCall` id as durable dispatch-site material: it is the replay-stable
 * discriminator that keeps identical declarations at distinct graph
 * positions out of one arrival-ordered ordinal scope.
 *
 * Adapted from the agent repo's `@smthrs/core` `Graph.ts`. The lenient
 * placeholder, the model-shaped `Dynamic` node, the lane-merge elaboration,
 * and the conflict pass do not come across: the placeholder is strict here,
 * a model call is an ordinary action, and write overlap is resolved by
 * `Plan.compile`, which owns that verdict.
 *
 * @since 0.1.0
 */

import * as Capability from "@smthrs/capability/Capability"
import * as Effects from "@smthrs/plan/Effects"
import { GraphBuildError, isFatalDiagnostic } from "@smthrs/plan/GraphBuildError"
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Node from "@smthrs/plan/Node"
import type * as Plan from "@smthrs/plan/Plan"
import * as Planned from "@smthrs/plan/Planned"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Action from "./Action/Action.ts"
import { TypeId as ActionTypeId } from "./Action/TypeId.ts"
import * as Annotations from "./Flow/Annotations.ts"
import { capabilityCeilings } from "./Flow/CapabilityCeiling.ts"
import type * as Flow from "./Flow/Flow.ts"
import { TypeId as FlowTypeId } from "./Flow/TypeId.ts"
import * as DeclarationSite from "./internal/DeclarationSite.ts"
import { OutcomeNodeTypeId, OutcomeValueTypeId } from "./internal/OutcomeMarker.ts"

type OutcomeTag = "Done" | "To" | "Park"

/**
 * Why one node depends on another: `value` consumes a result, `continuation`
 * is the sequencing edge a builder or a branch arm records against the
 * upstream node it was evaluated with.
 *
 * @since 0.1.0
 * @category models
 */
export type EdgeReason = "value" | "continuation" | "failure"

/**
 * A dependency edge, pointing from the node that produces to the node that
 * consumes.
 *
 * @since 0.1.0
 * @category models
 */
export interface Edge {
  readonly from: string
  readonly to: string
  readonly reason: EdgeReason
}

/**
 * One observed node: its structural address, the AST variant it came from, and
 * the {@link module:Plan.NodeDraft} the plan is compiled from.
 *
 * `kind` is the authoring variant, not the plan's node kind — every draft a
 * graph produces is a plan `step`.
 *
 * @since 0.1.0
 * @category models
 */
export interface GraphNode {
  readonly id: string
  readonly kind: Node.Ast["_tag"]
  readonly dependencies: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
  readonly capabilityCeilings: ReadonlyArray<ReadonlyArray<string>>
  readonly placement: unknown
  readonly draft: Plan.NodeDraft
  /**
   * The authoring node this graph node was observed at.
   *
   * Key material digests a mapper, a predicate, and a callee's schemas; it
   * cannot carry them, because a digest is not a function. A driver that has
   * the real values in hand needs the functions themselves, so the AST rides
   * along: {@link module:Node.mapper}, {@link module:Node.predicate}, and the
   * member names of an `All` are read off it. The entry node a flow is entered
   * as is the call the graph synthesized, carrying the real payload rather than
   * the inert form an authored call records.
   */
  readonly ast: Node.Ast
  /**
   * What this node passes on, hydrated: real data where the author wrote data,
   * and a {@link module:Planned.Planned} placeholder where a step result goes.
   * It is the call payload of an `ActionCall` or a `FlowCall`, the value of a
   * `Succeed`, the error of a `Fail`, and `undefined` for every other variant,
   * which passes nothing of its own.
   */
  readonly payload: unknown
  /**
   * Where the declaration this node was observed at was written, when the
   * runtime's stack format says so.
   *
   * Provenance, never identity: it is carried on the declaration as a
   * non-enumerable property, so it is outside key material and a node keyed
   * with it is byte-identical to the same node keyed without it. A node with
   * no declaration to read — a map, a combination, an untagged succeed — has
   * none, and so does a declaration made inside the framework itself.
   */
  readonly declaredAt?: DeclarationSite.DeclaredAt | undefined
}

/**
 * What a pure per-node layer resolver is told. It is the identity of the
 * implementation a node would run against — hosts, services, permission
 * implementations — never a layer value or a runtime handle.
 *
 * @since 0.1.0
 * @category models
 */
export interface LayerRequest {
  readonly nodeId: string
  readonly kind: Node.Ast["_tag"]
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Annotations.Effects | undefined
  readonly placement: unknown
}

/**
 * The knobs {@link build} takes. `resolveLayers` is invoked once per node and
 * must be pure: planning performs no I/O, and a resolver that read the world
 * would make a plan a function of more than its declarations.
 *
 * @since 0.1.0
 * @category models
 */
export interface BuildOptions {
  readonly resolveLayers?: ((request: LayerRequest) => Iterable<string>) | undefined
  /**
   * `stable` refuses process-local flow bodies, mappers, predicates, and
   * continuation builders before drafts can be compiled or actions driven.
   * Declare every semantic capture with `Node.capture`; include an explicit
   * implementation version for imported behavior not represented by the
   * callback source. The default, `process-local`, supports inspection and
   * experimentation but does not promise reproducible plan identity.
   *
   * This validates callback identity only. Action implementations and resolved
   * layers still need their own semantic identity contract.
   */
  readonly callbackIdentity?: "stable" | "process-local" | undefined
  /**
   * The address the entry node is recorded under, `root` by default. A plan
   * grows by appending, and `Plan.append` refuses an id it already holds, so an
   * elaboration built for an existing plan names its own root.
   */
  readonly root?: string | undefined
}

/**
 * A built graph: the nodes in dependency order, the edges between them, and the
 * refusals that were recoverable enough to report rather than throw.
 *
 * DECIDED: the drafts are NOT a field here. They
 * are derived from `nodes`, and the derivation carries a refusal — a graph with
 * diagnostics is inspectable but not compilable — so {@link drafts} is the only
 * way to ask for them. A field beside the accessor was a second, silent answer
 * to the same question: reading `graph.drafts` handed back the truncated drafts
 * of an incomplete graph while `Graph.drafts(graph)` threw on it. Effect keeps
 * data interfaces plain and puts the policy in the accessor, so the field goes
 * rather than growing a getter that throws from inside a `readonly` record.
 *
 * @since 0.1.0
 * @category models
 */
export interface Graph {
  readonly nodes: ReadonlyArray<GraphNode>
  readonly edges: ReadonlyArray<Edge>
  readonly diagnostics: ReadonlyArray<GraphBuildError>
}

/**
 * The declared-action fields graph building reads. Only `Action.make`'s
 * declared form produces an `ActionCall`, so a call node's declaration is
 * one of these whenever the side table still holds it.
 *
 * @private
 */
interface ActionDeclaration {
  readonly name: string
  readonly implementationVersion?: string | undefined
  readonly payloadSchema: Schema.Top
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly tier: Action.Tier
  readonly nondeterministic: true | undefined
  readonly annotations: Context.Context<never>
}

/**
 * The inert record `Node`'s AST keeps where a planned placeholder was.
 *
 * @private
 */
interface PlannedRecord {
  readonly node: string
  readonly path: ReadonlyArray<string>
}

/**
 * What a node that declared nothing contributes: it claims no path either way,
 * so `expected` is the honest default.
 *
 * @private
 */
const emptyEffects: Plan.NodeEffects = { reads: [], writes: [], boundaryMode: "expected" }

/** @private */
const sorted = (values: Iterable<string>): ReadonlyArray<string> => [...new Set(values)].sort()

/** @private */
const flowDeclaration = (value: unknown): Flow.Any | undefined =>
  Predicate.hasProperty(value, FlowTypeId) ? value as unknown as Flow.Any : undefined

/** @private */
const actionDeclaration = (value: unknown): ActionDeclaration | undefined =>
  Predicate.hasProperty(value, ActionTypeId) ? value as unknown as ActionDeclaration : undefined

/** @private */
const declaredEffects = (annotations: Context.Context<never>): Annotations.Effects | undefined =>
  Option.getOrUndefined(Context.getOption(annotations, Annotations.EffectsDeclaration))

/** @private */
const declaredPlacement = (annotations: Context.Context<never>): unknown =>
  Option.getOrUndefined(Context.getOption(annotations, Annotations.Placement))

/** @private */
const declaredEnvelope = (annotations: Context.Context<never>): Effects.Declaration | undefined =>
  Option.getOrUndefined(Context.getOption(annotations, Annotations.EffectEnvelope))

/**
 * What an author reads when a declaration claimed more authority than the one
 * enclosing it granted. Each of the three states the claim, names the flow
 * whose envelope it escaped, and says the one thing that fixes it, because an
 * author who widened an envelope by accident needs the narrowing, not a
 * classification.
 *
 * @private
 */
const refusalMessage = (
  narrowed: Extract<Effects.NarrowResult, { readonly ok: false }>,
  site: { readonly id: string; readonly flow: string }
): string => {
  const at = `"${site.flow}" at "${site.id}"`
  switch (narrowed.code) {
    case "effect_outside_envelope":
      return `Flow ${at} declares ${narrowed.paths.length === 1 ? "a path" : "paths"} its caller's effect ` +
        `envelope does not cover: ${narrowed.paths.join(", ")}. Widen the caller's declared effects to cover ` +
        "them, or narrow this declaration to what the envelope already allows."
    case "effect_mode_widening":
      return `Flow ${at} declares an expected effect mode inside a hermetic envelope. A hermetic envelope is ` +
        "the claim that every effect beneath it is declared, so the callee has to declare a hermetic mode too."
    case "effect_tier_widening":
      return `Flow ${at} declares an effect tier its caller's envelope does not permit. A tier may only narrow ` +
        "from irreversible to compensable to sealed, so raise the caller's tier or lower this one."
  }
}

/**
 * The declaration identity that enters a call node's hashed body: what the
 * callee accepts and produces, so a schema change re-keys the call.
 *
 * The identity is JSON-Schema-SHAPED, and that is its stated limit. Two
 * schemas whose decoders disagree can serialize to the same document, because
 * an effect transformation carries behaviour a JSON Schema document does not
 * describe. Changing only a codec's behaviour therefore does NOT re-key the
 * call, and a cached or recorded result computed under the old codec is
 * replayed under the new one. No fingerprint can close this automatically:
 * effect codecs are not serializable, so the identity would have to be
 * author-supplied. Until a declaration carries one, an author who changes a
 * transformation and needs the call re-keyed renames the declaration.
 * `@smthrs/core` carries the same algorithm and the same limit.
 *
 * @private
 */
const schemaIdentity = (schema: Schema.Top): unknown => {
  const cached = schemaDocuments.get(schema)
  if (cached !== undefined) return cached
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  schemaDocuments.set(schema, document)
  return document
}

/**
 * One document per schema object. A document is a pure function of the
 * schema's AST and schemas are immutable, so every node and every build that
 * names the same declaration reuses the document rather than regenerating it.
 *
 * @private
 */
const schemaDocuments = new WeakMap<Schema.Top, unknown>()

/** @private */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

/**
 * The reference a value stands for, whether it is a live placeholder — a real
 * payload may carry one, naming a node an earlier generation already planned —
 * or the inert record an AST payload kept.
 *
 * @private
 */
const referenceOf = (value: unknown): PlannedRecord | undefined => {
  const live = Planned.reference(value)
  if (live !== undefined) return live
  return Node.plannedReference(value)
}

/** @private */
const outcomeTagOf = (ast: Node.Ast): OutcomeTag | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(ast, OutcomeNodeTypeId)
  if (descriptor === undefined || !("value" in descriptor)) return undefined
  const value = descriptor.value
  return value === "Done" || value === "To" || value === "Park" ? value : undefined
}

/**
 * Rebuilds the strict placeholder a reference names, so a spliced body sees
 * the same refusals an inline body does.
 *
 * @private
 */
const placeholder = (reference: PlannedRecord, node: string): unknown =>
  reference.path.reduce<unknown>(
    (value, key) => (value as Record<string, unknown>)[key],
    Planned.make<unknown>(node)
  )

/**
 * The nesting bound the build enforces on authored topology. The walk itself
 * is iterative and cannot overflow the native stack, so the bound is policy:
 * topology a thousand combinators deep is a generated artifact, and refusing
 * it with a typed `graph_too_deep` names the fix — `.child()` boundaries or
 * trampoline handoffs — where unbounded acceptance would only defer the
 * failure to whatever walks the plan next.
 *
 * It is EXPORTED so a composition that unrolls its own topology, as
 * `@smthrs/patterns` does for a bounded loop, refuses at the same number the
 * build enforces instead of restating it and drifting.
 *
 * @since 0.1.0
 * @category models
 */
export const maximumGraphDepth = 1_000

/**
 * The nesting bound the build enforces on payload data, for the same reason
 * {@link maximumGraphDepth} bounds topology: hydration, hashing, and reference
 * scanning walk iteratively, and the bound turns a pathologically deep payload
 * into a typed `payload_too_deep` refusal instead of an unbounded walk over
 * data a plan would have to hash and store level by level.
 *
 * @private
 */
const maximumPayloadDepth = 1_000

/**
 * How one payload walk behaves: where it is walking, for refusal attribution;
 * how a placeholder-like leaf resolves; and the member order of a plain
 * object.
 *
 * @private
 */
interface PayloadWalk {
  readonly at: string
  readonly resolve: (value: unknown) => { readonly value: unknown } | undefined
  readonly keysOf: (keys: ReadonlyArray<string>) => ReadonlyArray<string>
}

/**
 * One container being walked: the source, the copy being filled, and the
 * member position reached. `keys` is `undefined` for an
 * array, whose members are positional.
 *
 * @private
 */
interface PayloadFrame {
  readonly source: Record<string, unknown> | ReadonlyArray<unknown>
  readonly keys: ReadonlyArray<string> | undefined
  readonly members: ReadonlyArray<unknown>
  readonly output: Record<string, unknown> | Array<unknown>
  index: number
}

/** @private */
const container = (
  value: unknown,
  at: string
): Record<string, unknown> | ReadonlyArray<unknown> | undefined => {
  if (Array.isArray(value)) return value
  if (typeof value !== "object" || value === null) return undefined
  try {
    return isPlainObject(value) ? value : undefined
  } catch {
    throw new GraphBuildError({
      code: "invalid_payload",
      node: at,
      path: [],
      message: `Payload at "${at}" does not expose an inert object prototype.`
    })
  }
}

/**
 * Walks one payload with an explicit stack. Real recursion would let a deep
 * payload overflow the native stack instead of failing loudly, so depth is a
 * typed refusal here: a value already on the ancestor chain is
 * `cyclic_payload`, and nesting past {@link maximumPayloadDepth} is
 * `payload_too_deep`. Values that are neither placeholders nor plain data
 * pass through untraversed to the key canonicalizer, which is the one
 * component entitled to refuse them.
 *
 * Rebuilding writes members with a null-prototype target and
 * `defineProperty`, never `output[key] = …`: `__proto__` routes through
 * `Object.prototype`'s accessor, so an own `__proto__` field whose value is a
 * primitive would be silently DROPPED and one whose value is an object would
 * reparent the copy instead of being recorded on it. A payload may carry that
 * key — `JSON.parse` produces it as an own data property — and both outcomes
 * are wrong here: a hydrated payload would be planned and run with a field
 * its author wrote missing, and two payloads that differ only in that field
 * would hash to one key. `@smthrs/plan`'s AST cloner answers this the
 * same way.
 *
 * @private
 */
const walkPayload = (root: unknown, walk: PayloadWalk): unknown => {
  const resolvedRoot = walk.resolve(root)
  if (resolvedRoot !== undefined) return resolvedRoot.value
  const rootContainer = container(root, walk.at)
  if (rootContainer === undefined) return root
  const open = (source: Record<string, unknown> | ReadonlyArray<unknown>): PayloadFrame => {
    const descriptors = (() => {
      try {
        return Object.getOwnPropertyDescriptors(source)
      } catch {
        throw new GraphBuildError({
          code: "invalid_payload",
          node: walk.at,
          path: [],
          message: `Payload at "${walk.at}" does not expose inert own properties.`
        })
      }
    })()
    if (Array.isArray(source)) {
      const members = Array.from({ length: source.length }, (_, index) => {
        const descriptor = descriptors[String(index)]
        if (descriptor === undefined) return undefined
        if (!("value" in descriptor)) {
          throw new GraphBuildError({
            code: "invalid_payload",
            node: walk.at,
            path: [String(index)],
            message: `Payload at "${walk.at}" contains an accessor at index ${index}. Pass inert data.`
          })
        }
        return descriptor.value
      })
      return { source, keys: undefined, members, output: [], index: 0 }
    }
    const keys = walk.keysOf(
      Object.keys(descriptors).filter((key) => descriptors[key]?.enumerable === true)
    )
    const members = keys.map((key) => {
      const descriptor = descriptors[key]!
      if (!("value" in descriptor)) {
        throw new GraphBuildError({
          code: "invalid_payload",
          node: walk.at,
          path: [key],
          message: `Payload at "${walk.at}" contains accessor property "${key}". Pass inert data.`
        })
      }
      return descriptor.value
    })
    return {
      source,
      keys,
      members,
      output: Object.create(null) as Record<string, unknown>,
      index: 0
    }
  }
  const rootFrame = open(rootContainer)
  const frames: Array<PayloadFrame> = [rootFrame]
  const ancestors = new Set<object>([rootContainer])
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!
    if (frame.index >= frame.members.length) {
      frames.pop()
      ancestors.delete(frame.source)
      continue
    }
    const position = frame.index
    frame.index = position + 1
    const key = frame.keys?.[position]
    const member = frame.members[position]
    const place = (produced: unknown): void => {
      if (key === undefined) {
        const members = frame.output as Array<unknown>
        members.push(produced)
        return
      }
      Object.defineProperty(frame.output, key, {
        configurable: true,
        enumerable: true,
        value: produced,
        writable: true
      })
    }
    const resolved = walk.resolve(member)
    if (resolved !== undefined) {
      place(resolved.value)
      continue
    }
    const nested = container(member, walk.at)
    if (nested === undefined) {
      place(member)
      continue
    }
    if (ancestors.has(nested)) {
      throw new GraphBuildError({
        code: "cyclic_payload",
        node: walk.at,
        path: [],
        message: `Payload at "${walk.at}" contains itself, so no plan can hash or serialize it. Pass acyclic data.`
      })
    }
    if (frames.length >= maximumPayloadDepth) {
      throw new GraphBuildError({
        code: "payload_too_deep",
        node: walk.at,
        path: [],
        message: `Payload at "${walk.at}" nests more than ${maximumPayloadDepth} levels deep. ` +
          "Flatten the payload: a plan hashes and stores every level of it."
      })
    }
    const opened = open(nested)
    place(opened.output)
    ancestors.add(nested)
    frames.push(opened)
  }
  return rootFrame.output
}

/**
 * Turns an AST payload back into what a body must see: real data where the
 * caller wrote data, strict placeholders where it passed a step result. The
 * substitution rewrites a branch's own subject token to its upstream node, and
 * a catch's own subject token to the node it protects, which are those arms'
 * subjects by construction.
 *
 * @private
 */
const hydrate = (value: unknown, substitutions: ReadonlyMap<string, string>, at: string): unknown =>
  walkPayload(value, {
    at,
    keysOf: (keys) => keys,
    resolve: (member) => {
      const reference = referenceOf(member)
      return reference === undefined
        ? undefined
        : { value: placeholder(reference, substitutions.get(reference.node) ?? reference.node) }
    }
  })

/**
 * The hashed form of a payload: placeholders keep their property path and drop
 * the node they came from, because the node id is a lookup address and the
 * dependency itself is named by a separate `Ref`. The same walk collects every
 * upstream result the payload reads into `found`, in sorted-key order, so a
 * payload is canonicalized once rather than walked again for its references.
 *
 * @private
 */
const literal = (value: unknown, found: Array<PlannedRecord>, at: string): unknown =>
  walkPayload(value, {
    at,
    keysOf: (keys) => [...keys].sort(),
    resolve: (member) => {
      const reference = Planned.reference(member)
      if (reference === undefined) return undefined
      found.push(reference)
      return { value: { _tag: "PlannedInput", path: [...reference.path] } }
    }
  })

/**
 * Whether an inline call would place the callee somewhere the enclosing flow
 * cannot run it.
 *
 * A placement directive is opaque to this package — `Annotations.Placement` is
 * `Schema.Unknown`, and interpreting it is a scheduler's job — so the only
 * verdict available here is identity: the same directive is satisfiable, a
 * different one is not. The local comparison has the structural semantics of a
 * canonicalized literal without serializing it: arrays compare by length and
 * element, objects by their own enumerable keys independent of key order, and
 * primitives by `Object.is`. That makes `NaN` equal to itself and cheaply keeps
 * `-0` distinct from `0`. A visited-pair map terminates cyclic object graphs.
 *
 * Identity is claimed only over data the comparison can read inertly. Two
 * distinct objects are identical only when both are plain — an ordinary object
 * literal or a null-prototype object, or two arrays — and only through own data
 * properties: a `Date`, `Map`, `RegExp`, class instance, or function is
 * identical to itself by reference and to nothing else, and an accessor-backed
 * key is identical to nothing at all, because reading it would run author code
 * during graph building. Every one of those is a REFUSAL to prove identity, so
 * the call is pushed to an explicit `.child()` boundary rather than admitted
 * inline against a placement nobody checked. A `Proxy` over a plain object
 * still observes the key and descriptor reads; making the directive inert
 * before it is compared is the remaining half of that hardening.
 *
 * Identity over a CYCLIC directive is bisimulation: the visited-pair map makes
 * two directives identical when they unfold to the same infinite tree, so a
 * self-cycle and a two-node cycle of the same shape are the same directive.
 * Cycle lengths that share no factor pair off against each other for their
 * least common multiple of comparisons, which is what
 * {@link maxComparisonPairs} bounds.
 *
 * DECIDED: an enclosing flow that declares NO
 * placement is unconstrained and satisfies any callee, rather than satisfying
 * only a callee that declares none. Inline expansion runs the callee's steps in
 * the caller's execution, so the constraint that matters is the one the caller
 * already carries; refusing an undeclared caller would make `Flow.Placement`
 * mandatory on every flow in a call chain to keep `.call()` usable.
 *
 * @private
 */
const structuralIdentity = (left: unknown, right: unknown): boolean => {
  const pending: Array<readonly [unknown, unknown]> = [[left, right]]
  const visited = new WeakMap<object, WeakSet<object>>()
  let examined = 0
  try {
    while (pending.length > 0) {
      const [left, right] = pending.pop()!
      if (++examined > maxComparisonPairs) return false
      if (Object.is(left, right)) continue
      if (left !== Object(left)) return false
      if (right !== Object(right)) return false
      const leftObject = left as object
      const rightObject = right as object
      const leftIsArray = Array.isArray(leftObject)
      if (leftIsArray !== Array.isArray(rightObject)) return false
      if (
        leftIsArray && (leftObject as ReadonlyArray<unknown>).length !== (rightObject as ReadonlyArray<unknown>).length
      ) {
        return false
      }
      const seen = visited.get(leftObject) ?? new WeakSet<object>()
      if (seen.has(rightObject)) continue
      seen.add(rightObject)
      visited.set(leftObject, seen)
      if (!leftIsArray && !(isPlainObject(leftObject) && isPlainObject(rightObject))) return false
      const leftKeys = Reflect.ownKeys(leftObject).filter((key) =>
        Object.prototype.propertyIsEnumerable.call(leftObject, key)
      )
      const rightKeys = Reflect.ownKeys(rightObject).filter((key) =>
        Object.prototype.propertyIsEnumerable.call(rightObject, key)
      )
      if (leftKeys.length !== rightKeys.length) return false
      for (const key of leftKeys) {
        if (!Object.prototype.propertyIsEnumerable.call(rightObject, key)) return false
        // Descriptors rather than `Reflect.get`: a getter is author code, and
        // graph building must not run it.
        const leftMember = Object.getOwnPropertyDescriptor(leftObject, key)!
        const rightMember = Object.getOwnPropertyDescriptor(rightObject, key)!
        if (!("value" in leftMember) || !("value" in rightMember)) return false
        pending.push([leftMember.value, rightMember.value])
      }
    }
  } catch {
    // Every reflection above is a Proxy trap, and a trap is author code that
    // may throw. Graph building must not fail with whatever it threw, so an
    // unreadable directive gets the verdict every other one gets: identity is
    // not proved, and the call goes to an explicit `.child()` boundary.
    return false
  }
  return true
}

/**
 * The most value pairs one placement comparison examines before giving up.
 *
 * A directive is author data walked at planning time, so the comparison needs a
 * ceiling that does not depend on how large or how cyclic that data is.
 * Exhausting the ceiling is a refusal to prove identity, not a claim that the
 * two directives differ.
 *
 * @private
 */
const maxComparisonPairs = 100_000

/** @private */
const placementConflicts = (enclosing: unknown, callee: unknown): boolean =>
  enclosing !== undefined && callee !== undefined && !structuralIdentity(enclosing, callee)

/** The most characters one rendered placement contributes to a diagnostic. */
const maxPlacementChars = 240

/** How many levels of a placement a diagnostic renders before eliding. */
const maxPlacementDepth = 4

/**
 * How many members of one array or object a diagnostic renders.
 *
 * An array's cost is its LENGTH, not its member count: `new Array(100_000)` owns
 * no properties and still renders a hundred thousand separators without this
 * bound, so a directive a byte long becomes a diagnostic megabytes long.
 */
const maxPlacementMembers = 32

/**
 * A bounded, inert rendering of a placement directive, for the refusal that
 * names it.
 *
 * An author who declared two placements needs to see WHICH two the build
 * compared and how they differ, so the refusal prints both. The directive is
 * arbitrary author data, so this holds to exactly the discipline
 * {@link structuralIdentity} holds to: own enumerable data properties only,
 * never an accessor, plain objects and arrays walked and everything else named
 * by kind, under a depth bound, a cycle guard, and a length bound so a large
 * directive cannot become the whole message. Array indices are read as
 * descriptors rather than iterated, because iteration invokes an index getter;
 * a hole renders as `<hole>`. Both arrays and objects render at most
 * {@link maxPlacementMembers} members and mark the rest `<more>`, so the work
 * is bounded before the string is truncated rather than after. Object members
 * are sorted, so two directives that differ only in key order render
 * identically, matching the comparison that admitted them. It never throws.
 *
 * @private
 */
const renderPlacement = (value: unknown): string => {
  const render = (value: unknown, depth: number, seen: ReadonlyArray<object>): string => {
    if (typeof value === "string") return JSON.stringify(value)
    if (typeof value === "bigint") return `${value}n`
    if (Object(value) !== value) return String(value)
    const object = value as object
    if (seen.includes(object)) return "<cycle>"
    if (depth === maxPlacementDepth) return "<elided>"
    const nested = [...seen, object]
    if (Array.isArray(object)) {
      const length = (object as ReadonlyArray<unknown>).length
      const shown = Math.min(length, maxPlacementMembers)
      const members: Array<string> = []
      for (let index = 0; index < shown; index++) {
        // `Array.prototype.map` invokes an index getter, so indices are read as
        // descriptors here for the same reason keys are below.
        const member = Object.getOwnPropertyDescriptor(object, String(index))
        members.push(
          member === undefined
            ? "<hole>"
            : "value" in member
            ? render(member.value, depth + 1, nested)
            : "<accessor>"
        )
      }
      if (length > shown) members.push("<more>")
      return `[${members.join(",")}]`
    }
    if (!isPlainObject(object)) return Object.prototype.toString.call(object)
    const keys = Reflect.ownKeys(object)
      .filter((key) => Object.prototype.propertyIsEnumerable.call(object, key))
      .sort((left, right) => String(left).localeCompare(String(right)))
    // Select the bounded prefix before rendering values. Rendering every
    // member and slicing afterward still traverses the entire omitted forest.
    const members = keys.slice(0, maxPlacementMembers)
      .map((key) => {
        const member = Object.getOwnPropertyDescriptor(object, key)!
        const rendered = "value" in member ? render(member.value, depth + 1, nested) : "<accessor>"
        return `${String(key)}:${rendered}`
      })
      .sort()
    const shown = keys.length > maxPlacementMembers
      ? [...members, "<more>"]
      : members
    return `{${shown.join(",")}}`
  }

  try {
    const rendered = render(value, 0, [])
    return rendered.length <= maxPlacementChars
      ? rendered
      : `${rendered.slice(0, maxPlacementChars)} [${rendered.length - maxPlacementChars} characters dropped]`
  } catch {
    return "<unrenderable>"
  }
}

/**
 * The `Literal` a payload hashes as, followed by one `Ref` per distinct
 * upstream result it reads.
 *
 * @private
 */
const payloadInputs = (payload: unknown, at: string): ReadonlyArray<KeyMaterial.InputRef> => {
  const found: Array<PlannedRecord> = []
  const inputs: Array<KeyMaterial.InputRef> = [{ _tag: "Literal", value: literal(payload, found, at) }]
  const seen = new Set<string>()
  for (const reference of found) {
    const identity = JSON.stringify([reference.node, ...reference.path])
    if (seen.has(identity)) continue
    seen.add(identity)
    inputs.push({ _tag: "Ref", from: reference.node, path: [...reference.path] })
  }
  return inputs
}

/**
 * What one visit needs to know: where it is, how deeply it is nested, what it
 * may do, where it runs, which node the enclosing branch's subject stands
 * for, which flows are already being spliced, and the upstream node it
 * continues from.
 *
 * @private
 */
interface Visit {
  readonly ast: Node.Ast
  readonly id: string
  /**
   * How many visits enclose this one, checked against
   * {@link maximumGraphDepth}. The walk itself is an explicit operation stack
   * and cannot overflow, so the count exists to refuse pathological topology
   * with a typed error rather than accept it unbounded.
   */
  readonly depth: number
  readonly capabilities: ReadonlyArray<string>
  /**
   * The placement of the flow whose body this visit is inside, which an inline
   * call has to be satisfiable under.
   */
  readonly placement: unknown
  /**
   * The effect authority in force here: the nearest enclosing declaration that
   * was ACCEPTED, so a refused one does not widen what its siblings are checked
   * against. `undefined` means nothing above this node declared an envelope,
   * which is unconstrained rather than empty.
   */
  readonly envelope: Effects.Declaration | undefined
  /**
   * The scheduling priority in force here: the nearest enclosing node's, unless
   * this node states its own. It rides the walk rather than the AST because
   * inheritance is lexical — annotating a container prioritizes everything
   * beneath it that stayed silent.
   */
  readonly priority: number | undefined
  readonly substitutions: ReadonlyMap<string, string>
  readonly stack: ReadonlyArray<Flow.Any>
  readonly prerequisite: string | undefined
  /** Explicit andThen success barriers inherited by the entire subtree. */
  readonly barriers: ReadonlyArray<string>
}

/**
 * Builds the graph of a flow declaration, or of a bare node, by walking the
 * AST once.
 *
 * A flow is entered as a call to itself: the returned graph's `root` node is
 * that call, carrying the flow's declared effects, placement, and
 * capabilities, and its body spliced beneath it. Every flow has a body, so the
 * only inline call this leaves as a leaf is one whose declaration did not
 * survive serialization beside its AST.
 *
 * @since 0.1.0
 * @category constructors
 */
export const build = (
  flowOrNode: Flow.Any | Node.Any,
  payload?: unknown,
  options: BuildOptions = {}
): Graph => {
  const observed: Array<GraphNode> = []
  const observedIds = new Set<string>()
  const observedEdges: Array<Edge> = []
  const observedDiagnostics: Array<GraphBuildError> = []

  const observeIdentity = (node: string, field: string, identity: Node.FunctionIdentity | undefined): void => {
    if (
      options.callbackIdentity !== "stable" ||
      (identity !== undefined && identity.algorithm !== "sha256-source-ephemeral/v4")
    ) return
    observedDiagnostics.push(
      new GraphBuildError({
        code: "unstable_callback",
        node,
        path: [field],
        message:
          `Callback ${field} at "${node}" has ${identity === undefined ? "unavailable" : "process-local"} identity ` +
          "and cannot enter a stable graph. " +
          "Use Node.capture with every semantic capture, including the version of imported implementation behavior."
      })
    )
  }

  /**
   * The explicit walk stack. Every step is a thunk; expanding a node pushes
   * its steps in reverse so they pop in authoring order, which keeps the
   * observed nodes, edges, and diagnostics in exactly the order a recursive
   * walk would produce while making depth a data structure instead of native
   * stack frames a deep graph could exhaust.
   */
  const operations: Array<() => void> = []

  /** Stacks steps to run in the order written, ahead of everything stacked. */
  const sequence = (steps: ReadonlyArray<() => void>): void => {
    for (let index = steps.length - 1; index >= 0; index--) operations.push(steps[index]!)
  }

  const record = (entry: {
    readonly id: string
    readonly kind: Node.Ast["_tag"]
    readonly dependencies: ReadonlyArray<string>
    readonly capabilities: ReadonlyArray<string>
    readonly effects: Annotations.Effects | undefined
    readonly placement: unknown
    readonly priority: number | undefined
    readonly tier: KeyMaterial.KeyMaterial["kind"]
    readonly nondeterministic?: true | undefined
    readonly body: unknown
    readonly capabilityCeilings?: ReadonlyArray<ReadonlyArray<string>>
    readonly inputs: ReadonlyArray<KeyMaterial.InputRef>
    readonly ast: Node.Ast
    readonly payload: unknown
    readonly declaredAt?: DeclarationSite.DeclaredAt | undefined
  }): void => {
    if (observedIds.has(entry.id)) {
      throw new GraphBuildError({
        code: "duplicate_node",
        node: entry.id,
        path: [],
        message: `Node id "${entry.id}" is durable dispatch identity, so two nodes may not share one. ` +
          "Two structural addresses in this graph collided, most often because a Node.all member name " +
          "contains the separator a nested address also produces. Rename one of them."
      })
    }
    observedIds.add(entry.id)
    const material: KeyMaterial.KeyMaterial = {
      version: KeyMaterial.version,
      kind: entry.tier,
      body: entry.capabilityCeilings?.length
        ? { ...entry.body as object, capabilityCeilings: entry.capabilityCeilings }
        : entry.body,
      inputs: entry.inputs,
      layers: sorted(
        options.resolveLayers?.({
          nodeId: entry.id,
          kind: entry.kind,
          capabilities: entry.capabilities,
          effects: entry.effects,
          placement: entry.placement
        }) ?? []
      ),
      capabilities: entry.capabilities,
      ...(entry.nondeterministic === undefined ? {} : { nondeterministic: entry.nondeterministic }),
      ...(entry.effects === undefined ? {} : { effects: entry.effects }),
      ...(entry.placement === undefined ? {} : { placement: entry.placement })
    }
    observed.push({
      id: entry.id,
      kind: entry.kind,
      dependencies: entry.dependencies,
      capabilities: entry.capabilities,
      capabilityCeilings: entry.capabilityCeilings ?? [],
      placement: entry.placement,
      // Priority reaches the compiled plan through the draft and stays OUT of
      // `material`: it orders ready work without changing what the work
      // produces, so raising it must not re-key a step.
      draft: {
        id: entry.id,
        material,
        effects: entry.effects ?? emptyEffects,
        ...(entry.priority === undefined ? {} : { priority: entry.priority })
      },
      ast: entry.ast,
      payload: entry.payload,
      ...(entry.declaredAt === undefined ? {} : { declaredAt: entry.declaredAt })
    })
  }

  /**
   * An envelope is graph-owned and reaches every node it encloses as the same
   * object, so it is read into its prepared form once and each enclosed
   * declaration is checked against that: a wide envelope costs its size once
   * per build rather than once per node that narrows it.
   */
  const preparedEnvelopes = new Map<Effects.Declaration, Effects.PreparedEnvelope>()

  /**
   * Checks one declaration against the envelope enclosing it, recording the
   * refusal and answering whether the declaration may become the envelope for
   * what it encloses in turn. A refused declaration must NOT replace the last
   * accepted one: widening beneath it would then be measured against the very
   * claim that was just rejected.
   */
  const admitEnvelope = (
    enclosing: Effects.Declaration | undefined,
    declared: Effects.Declaration | undefined,
    site: { readonly id: string; readonly flow: string }
  ): Effects.Declaration | undefined => {
    if (declared === undefined) return enclosing
    if (enclosing === undefined) return declared
    let prepared = preparedEnvelopes.get(enclosing)
    if (prepared === undefined) {
      prepared = Effects.prepareEnvelope(enclosing)
      preparedEnvelopes.set(enclosing, prepared)
    }
    const narrowed = Effects.narrowPrepared(prepared, declared)
    if (narrowed.ok) return declared
    observedDiagnostics.push(
      new GraphBuildError({
        code: narrowed.code,
        node: site.id,
        path: [...narrowed.paths],
        message: refusalMessage(narrowed, site)
      })
    )
    return enclosing
  }

  /**
   * Expands the node a flow call becomes, shared by the entry point and by
   * every `FlowCall` in a body.
   */
  const coveredCapability = (stack: ReadonlyArray<Flow.Any>, text: string): boolean => {
    const groups = stack.flatMap((flow) => capabilityCeilings(flow.annotations))
    if (groups.length === 0) return true
    const candidate = Capability.parsePattern(text)
    if (Option.isNone(candidate)) return false
    return groups.every((group) =>
      group.some((text) => {
        const grant = Capability.parsePattern(text)
        return Option.isSome(grant) && Capability.subsumes(grant.value, candidate.value)
      })
    )
  }

  const expandFlowCall = (call: {
    readonly id: string
    readonly depth: number
    readonly ast: Node.Ast
    readonly flow: string
    readonly mode: Node.CallMode
    readonly declaration: Flow.Any | undefined
    readonly payload: unknown
    readonly capabilities: ReadonlyArray<string>
    /** The placement of the flow this call is written inside. */
    readonly placement: unknown
    /** The effect authority in force at this call, which the callee must narrow. */
    readonly envelope: Effects.Declaration | undefined
    /** The priority in force at this call, already including the call's own. */
    readonly priority: number | undefined
    readonly substitutions: ReadonlyMap<string, string>
    readonly stack: ReadonlyArray<Flow.Any>
    readonly barriers: ReadonlyArray<string>
    readonly dependencies: Array<string>
    readonly inputs: ReadonlyArray<KeyMaterial.InputRef>
  }): void => {
    const annotations = call.declaration?.annotations ?? Context.empty()
    const dependencies = call.dependencies
    const inputs: Array<KeyMaterial.InputRef> = [...payloadInputs(call.payload, call.id), ...call.inputs]
    const target = call.mode === "inline" ? call.declaration : undefined
    const ceiling = sorted(capabilityCeilings(annotations)[0] ?? call.capabilities)
    const placement = declaredPlacement(annotations)
    const envelope = declaredEnvelope(annotations)
    // The authority checks are recorded, not thrown: a graph whose callee
    // claimed too much is still worth inspecting, and the author needs every
    // over-claim in the composition at once rather than the first one.
    //
    // They run for EVERY call mode. An explicit `.child()` boundary and a
    // trampoline handoff give the callee its own execution, not its own
    // authority: whoever writes the call is still the one granting it, which is
    // the rule `@smthrs/core`'s graph applies to a call whose body it does not
    // splice.
    const calleeEnvelope = admitEnvelope(call.envelope, envelope, { id: call.id, flow: call.flow })
    const dropped = ceiling.filter((capability) => !coveredCapability(call.stack, capability))
    if (dropped.length > 0) {
      observedDiagnostics.push(
        new GraphBuildError({
          code: "capability_outside_grant",
          node: call.id,
          path: dropped,
          message: `Flow "${call.flow}" at "${call.id}" requires ${dropped.join(", ")}, which the calling flow ` +
            "does not provably grant. Execution intersects this declaration with every caller ceiling."
        })
      )
    }
    // The placement refusal precedes the recursion one only in position: an
    // inline call the caller cannot host is invalid whether or not the callee's
    // declaration survived to be spliced, because inline expansion is the claim
    // that these steps run in the caller's execution.
    if (call.mode === "inline" && placementConflicts(call.placement, placement)) {
      throw new GraphBuildError({
        code: "placement_requires_boundary",
        node: call.id,
        path: [],
        message: `Flow "${call.flow}" is called inline at "${call.id}", but its declared placement ` +
          `${renderPlacement(placement)} is not structurally identical to the enclosing flow's ` +
          `${renderPlacement(call.placement)}. An inline .call() runs in the caller's execution, so use ` +
          `${call.flow}.child(payload) to give it its own.`
      })
    }
    const recordCall = (): void => {
      const bodyIdentity = call.declaration === undefined ? undefined : Node.functionIdentity(call.declaration.body)
      observeIdentity(call.id, "body", bodyIdentity)
      record({
        id: call.id,
        kind: "FlowCall",
        dependencies,
        capabilities: call.capabilities,
        capabilityCeilings: [
          ...call.stack.flatMap((flow) => capabilityCeilings(flow.annotations)),
          ...capabilityCeilings(annotations)
        ],
        effects: declaredEffects(annotations),
        placement,
        priority: call.priority,
        // A declared envelope states how reversible the flow beneath it is, so
        // it is the call's tier. A flow that declared none keeps the sealed
        // default every call has always carried, which is what keeps every
        // existing flow's key exactly where it was.
        tier: envelope?.tier ?? "sealed",
        body: {
          _tag: "FlowCall",
          flow: call.flow,
          mode: call.mode,
          declaration: call.declaration === undefined ? undefined : {
            payload: schemaIdentity(call.declaration.payloadSchema),
            success: schemaIdentity(call.declaration.successSchema),
            error: schemaIdentity(call.declaration.errorSchema),
            capabilities: ceiling,
            // A spliced body re-keys this call through the `Ref` on the node it
            // produced. A call the graph keeps as a LEAF — an explicit boundary,
            // a handoff — has no such node, and its own digest is the only thing
            // an edited body can move.
            body: bodyIdentity
          }
        },
        inputs,
        ast: call.ast,
        payload: call.payload,
        declaredAt: DeclarationSite.declaredAt(call.declaration)
      })
    }
    if (target === undefined) {
      recordCall()
      return
    }
    if (call.stack.includes(target)) {
      throw new GraphBuildError({
        code: "recursion_requires_boundary",
        node: call.id,
        path: [],
        message: `Flow "${call.flow}" cannot call itself inline at "${call.id}". ` +
          `Use ${call.flow}.to(payload) to hand off to the next round, or .child(payload) for an explicit boundary.`
      })
    }
    const built = target.body(call.payload)
    const spliced = `${call.id}.flow`
    sequence([
      () =>
        expand({
          ast: built.ast,
          id: spliced,
          depth: call.depth + 1,
          capabilities: ceiling.filter((capability) => coveredCapability(call.stack, capability)),
          // Inside the spliced body the callee's own placement is the one to
          // satisfy; a callee that declared none keeps running under the
          // caller's.
          placement: placement ?? call.placement,
          envelope: calleeEnvelope,
          priority: call.priority,
          substitutions: call.substitutions,
          stack: [...call.stack, target],
          prerequisite: undefined,
          barriers: call.barriers
        }),
      () => {
        dependencies.push(spliced)
        observedEdges.push({ from: spliced, to: call.id, reason: "value" })
        inputs.push({ _tag: "Ref", from: spliced, path: [] })
      },
      recordCall
    ])
  }

  /**
   * The continuation of an `AndThen`, evaluated exactly once against the
   * placeholder standing for its upstream result. A continuation that is gone
   * — an AST that crossed a serialization boundary — or that answered with
   * something other than a node leaves the remainder out and says so, because
   * a graph missing that recoverable step is still worth inspecting. Computing
   * on the placeholder is a fatal build refusal and propagates unchanged.
   */
  const continuation = (
    ast: Extract<Node.Ast, { readonly _tag: "AndThen" }>,
    id: string,
    subject: string
  ): Node.Ast | undefined => {
    const builder = Node.continuation(ast)
    if (builder === undefined) {
      observedDiagnostics.push(
        new GraphBuildError({
          code: "invalid_continuation",
          node: id,
          path: [],
          message: `Node.bindPlanned at "${id}" no longer holds its continuation builder, so its continuation is ` +
            "missing from the graph. An AST that crossed a serialization boundary left that side table behind."
        })
      )
      return undefined
    }
    const built = builder(Planned.make<unknown>(subject))
    if (Node.isNode(built)) return built.ast
    observedDiagnostics.push(
      new GraphBuildError({
        code: "invalid_continuation",
        node: id,
        path: [],
        message: `Node.bindPlanned at "${id}" did not produce a Node, so its continuation is missing from the graph.`
      })
    )
    return undefined
  }

  const expand = (request: Visit): void => {
    if (request.depth > maximumGraphDepth) {
      throw new GraphBuildError({
        code: "graph_too_deep",
        node: request.id,
        path: [],
        message: `The graph nests more than ${maximumGraphDepth} levels deep. ` +
          "Split the flow with .child() boundaries or trampoline handoffs so one execution plans a bounded graph."
      })
    }
    const { ast, capabilities, depth, envelope, id, placement, stack, substitutions } = request
    // A node's own priority wins; otherwise it inherits the enclosing one.
    const priority = ast.priority ?? request.priority
    const dependencies: Array<string> = []
    const inputs: Array<KeyMaterial.InputRef> = []
    const depend = (from: string, reason: EdgeReason): void => {
      dependencies.push(from)
      observedEdges.push({ from, to: id, reason })
      inputs.push(reason === "continuation" ? { _tag: "Pending", from } : { _tag: "Ref", from, path: [] })
    }
    const child = (childAst: Node.Ast, childId: string, options: {
      readonly substitutions?: ReadonlyMap<string, string>
      readonly prerequisite?: string | undefined
      readonly barriers?: ReadonlyArray<string>
    } = {}): Visit => ({
      ast: childAst,
      id: childId,
      depth: depth + 1,
      capabilities,
      placement,
      envelope,
      priority,
      substitutions: options.substitutions ?? substitutions,
      stack,
      prerequisite: options.prerequisite,
      barriers: options.barriers ?? request.barriers
    })

    if (request.prerequisite !== undefined) depend(request.prerequisite, "continuation")
    for (const barrier of request.barriers) {
      if (barrier !== request.prerequisite) depend(barrier, "continuation")
    }

    switch (ast._tag) {
      case "FlowCall": {
        expandFlowCall({
          id,
          depth,
          ast,
          flow: ast.flow,
          mode: ast.mode,
          declaration: flowDeclaration(Node.declaration(ast)),
          payload: hydrate(ast.payload, substitutions, id),
          capabilities,
          placement,
          envelope,
          priority,
          substitutions,
          stack,
          barriers: request.barriers,
          dependencies,
          inputs
        })
        return
      }
      case "ActionCall": {
        const declared = actionDeclaration(Node.declaration(ast))
        const annotations = declared?.annotations ?? Context.empty()
        const payload = hydrate(ast.payload, substitutions, id)
        // An action is a leaf, so its declaration cannot become an envelope for
        // anything; it is only checked against the one it sits inside.
        admitEnvelope(envelope, declaredEnvelope(annotations), { id, flow: ast.action })
        // The ceiling the declaration named, read off its bag exactly as a
        // called flow's is. An action that named none keeps the enclosing grant
        // and adds nothing to its key, so every declaration written before the
        // literal existed keys exactly where it did.
        const ceiling = sorted(Context.get(annotations, Annotations.Capabilities))
        const dropped = ceiling.filter((capability) => !coveredCapability(stack, capability))
        if (dropped.length > 0) {
          observedDiagnostics.push(
            new GraphBuildError({
              code: "capability_outside_grant",
              node: id,
              path: dropped,
              message: `Action "${ast.action}" at "${id}" requires ${dropped.join(", ")}, which the calling ` +
                "flow does not provably grant. Execution intersects this declaration with every caller ceiling."
            })
          )
        }
        record({
          id,
          kind: ast._tag,
          dependencies,
          capabilities,
          capabilityCeilings: [
            ...stack.flatMap((flow) => capabilityCeilings(flow.annotations)),
            ...capabilityCeilings(annotations)
          ],
          effects: declaredEffects(annotations),
          placement: declaredPlacement(annotations),
          priority,
          tier: declared?.tier ?? "sealed",
          nondeterministic: declared?.nondeterministic,
          body: {
            _tag: "ActionCall",
            action: ast.action,
            tier: declared?.tier ?? "sealed",
            declaration: declared === undefined ? undefined : {
              payload: schemaIdentity(declared.payloadSchema),
              success: schemaIdentity(declared.successSchema),
              error: schemaIdentity(declared.errorSchema),
              ...(ceiling.length === 0 ? {} : { capabilities: ceiling }),
              ...(declared.implementationVersion === undefined
                ? {}
                : { implementationVersion: declared.implementationVersion })
            }
          },
          inputs: [...payloadInputs(payload, id), ...inputs],
          ast,
          payload,
          declaredAt: DeclarationSite.declaredAt(declared)
        })
        return
      }
      case "Succeed": {
        const value = hydrate(ast.value, substitutions, id)
        const outcome = outcomeTagOf(ast)
        if (outcome !== undefined) {
          const tag = typeof value === "object" && value !== null
            ? Object.getOwnPropertyDescriptor(value, "_tag")
            : undefined
          if (tag === undefined || !("value" in tag) || tag.value !== outcome) {
            throw new GraphBuildError({
              code: "invalid_payload",
              node: id,
              path: [],
              message: `Flow outcome node at "${id}" lost its ${outcome} payload.`
            })
          }
          Object.defineProperty(value, OutcomeValueTypeId, {
            configurable: false,
            enumerable: false,
            value: outcome,
            writable: false
          })
        }
        record({
          id,
          kind: ast._tag,
          dependencies,
          capabilities,
          effects: undefined,
          placement: undefined,
          priority,
          tier: "sealed",
          body: outcome === undefined ? { _tag: ast._tag } : { _tag: ast._tag, outcome },
          inputs: [...payloadInputs(value, id), ...inputs],
          ast,
          payload: value
        })
        return
      }
      case "Fail": {
        // A constant failure is a leaf exactly as `Succeed` is, and its error
        // is hydrated and keyed the same way: two different refusals are two
        // different steps, and one that reads an upstream result depends on it.
        const error = hydrate(ast.error, substitutions, id)
        record({
          id,
          kind: ast._tag,
          dependencies,
          capabilities,
          effects: undefined,
          placement: undefined,
          priority,
          tier: "sealed",
          body: { _tag: ast._tag },
          inputs: [...payloadInputs(error, id), ...inputs],
          ast,
          payload: error
        })
        return
      }
      case "All": {
        const members = Object.keys(ast.nodes)
        const steps: Array<() => void> = []
        for (const member of members) {
          // This durable address cannot be re-keyed here without coordinating
          // the plan and engine stores. The record-time duplicate check guards
          // arbitrary member names instead.
          const memberId = `${id}.all.${member}`
          steps.push(() => expand(child(ast.nodes[member]!, memberId)))
          steps.push(() => depend(memberId, "value"))
        }
        steps.push(() =>
          record({
            id,
            kind: ast._tag,
            dependencies,
            capabilities,
            effects: undefined,
            placement: undefined,
            priority,
            tier: "sealed",
            body: { _tag: ast._tag, members },
            inputs,
            ast,
            payload: undefined
          })
        )
        sequence(steps)
        return
      }
      case "Race": {
        // A join that settles early is expanded exactly as `All` is: every
        // member is topology the plan shows, and the interpreter decides at
        // run time which of them it waits for.
        const members = Object.keys(ast.nodes)
        const steps: Array<() => void> = []
        for (const member of members) {
          const memberId = `${id}.race.${member}`
          steps.push(() => expand(child(ast.nodes[member]!, memberId)))
          steps.push(() => depend(memberId, "value"))
        }
        steps.push(() =>
          record({
            id,
            kind: ast._tag,
            dependencies,
            capabilities,
            effects: undefined,
            placement: undefined,
            priority,
            tier: "sealed",
            body: { _tag: ast._tag, mode: ast.mode, count: ast.count, members },
            inputs,
            ast,
            payload: undefined
          })
        )
        sequence(steps)
        return
      }
      case "Map": {
        observeIdentity(id, "mapper", ast.mapper)
        const first = `${id}.map`
        sequence([
          () => expand(child(ast.first, first)),
          () => depend(first, "value"),
          () =>
            record({
              id,
              kind: ast._tag,
              dependencies,
              capabilities,
              effects: undefined,
              placement: undefined,
              priority,
              tier: "sealed",
              body: { _tag: ast._tag, mapper: ast.mapper },
              inputs,
              ast,
              payload: undefined
            })
        ])
        return
      }
      case "AndThen": {
        observeIdentity(id, "continuation", ast.continuation)
        const first = `${id}.andThen`
        sequence([
          () => expand(child(ast.first, first)),
          () => depend(first, "value"),
          () => {
            // The continuation builder runs only after the first subtree is
            // fully observed, exactly where the recursive walk evaluated it.
            const next = ast.next ?? continuation(ast, id, first)
            if (next === undefined) return
            const thenId = `${id}.then`
            sequence([
              () =>
                expand(child(next, thenId, {
                  prerequisite: first,
                  // Explicit andThen sequences every descendant, not only the
                  // result/join node. bindPlanned remains a dependency builder:
                  // independent members can run while a referenced producer runs.
                  // The first subtree already carries the outer barriers, so
                  // its success transitively gates every nested descendant.
                  barriers: ast.next === undefined ? request.barriers : [first]
                })),
              () => depend(thenId, "value")
            ])
          },
          () =>
            record({
              id,
              kind: ast._tag,
              dependencies,
              capabilities,
              effects: undefined,
              placement: undefined,
              priority,
              tier: "sealed",
              body: { _tag: ast._tag, continuation: ast.continuation, static: ast.next !== undefined },
              inputs,
              ast,
              payload: undefined
            })
        ])
        return
      }
      case "Branch": {
        observeIdentity(id, "predicate", ast.predicate)
        const first = `${id}.branch`
        // DECIDED: each Branch AST carries its own
        // subject token. An outer subject captured inside a nested arm must
        // retain the outer binding; one shared token silently rebound it to
        // the inner branch's subject.
        const arms = new Map([...substitutions, [ast.subject, first]])
        sequence([
          () => expand(child(ast.first, first)),
          () => depend(first, "value"),
          () => expand(child(ast.then, `${id}.then`, { substitutions: arms, prerequisite: first })),
          () => depend(`${id}.then`, "value"),
          () => expand(child(ast.else, `${id}.else`, { substitutions: arms, prerequisite: first })),
          () => depend(`${id}.else`, "value"),
          () =>
            record({
              id,
              kind: ast._tag,
              dependencies,
              capabilities,
              effects: undefined,
              placement: undefined,
              priority,
              tier: "sealed",
              body: { _tag: ast._tag, predicate: ast.predicate },
              inputs,
              ast,
              payload: undefined
            })
        ])
        return
      }
      case "Catch": {
        if (ast.filter !== undefined) observeIdentity(id, "filter", ast.filterIdentity)
        const protectedId = `${id}.protected`
        const failureId = `${id}.failure`
        // DECIDED: each Catch AST carries its own
        // subject token, exactly as each Branch does. An outer error captured
        // inside a nested failure arm must retain the outer binding; one shared
        // token silently rebound it to the inner catch's protected node.
        const recovery = new Map([...substitutions, [ast.subject, protectedId]])
        sequence([
          () => expand(child(ast.protected, protectedId)),
          () => depend(protectedId, "value"),
          () => expand(child(ast.failure, failureId, { substitutions: recovery, prerequisite: protectedId })),
          () => {
            dependencies.push(failureId)
            observedEdges.push({ from: protectedId, to: failureId, reason: "failure" })
            observedEdges.push({ from: failureId, to: id, reason: "value" })
            inputs.push({ _tag: "Ref", from: failureId, path: [] })
          },
          () =>
            record({
              id,
              kind: ast._tag,
              dependencies,
              capabilities,
              effects: undefined,
              placement: undefined,
              priority,
              tier: "sealed",
              body: { _tag: ast._tag, filter: ast.filter, filterIdentity: ast.filterIdentity },
              inputs,
              ast,
              payload: undefined
            })
        ])
        return
      }
    }
  }

  const declaration = flowDeclaration(flowOrNode)
  const root = options.root ?? "root"
  if (declaration === undefined) {
    expand({
      ast: (flowOrNode as Node.Any).ast,
      id: root,
      depth: 0,
      capabilities: [],
      placement: undefined,
      envelope: undefined,
      priority: undefined,
      substitutions: new Map(),
      stack: [],
      prerequisite: undefined,
      barriers: []
    })
  } else {
    const entry = hydrate(payload, new Map(), root)
    expandFlowCall({
      id: root,
      depth: 0,
      // The entry is a call to the flow itself that no author wrote, so its
      // AST is synthesized here rather than recorded by `Node.flowCall`, which
      // would replace a payload's non-JSON values with their plain-object
      // copies. What a body was planned with stays what the entry node shows.
      ast: { _tag: "FlowCall", flow: declaration._tag, mode: "inline", payload: entry },
      flow: declaration._tag,
      mode: "inline",
      declaration,
      payload: entry,
      capabilities: sorted(Context.get(declaration.annotations, Annotations.Capabilities)),
      // Nothing encloses the entry, so its own declared placement is what the
      // body it splices has to be satisfiable under, not a constraint on it.
      // Its declared envelope reads the same way: the entry is the top of the
      // authority chain, so it grants rather than narrows.
      placement: undefined,
      envelope: undefined,
      priority: undefined,
      substitutions: new Map(),
      stack: [],
      barriers: [],
      dependencies: [],
      inputs: []
    })
  }
  // The walk itself: pop until every stacked step has run. A refusal thrown
  // by any step propagates out of the build unchanged.
  while (operations.length > 0) operations.pop()!()

  return {
    nodes: observed,
    edges: observedEdges,
    diagnostics: observedDiagnostics
  }
}

/**
 * The observed nodes, children before the parents that consume them.
 *
 * @since 0.1.0
 * @category accessors
 */
export const nodes = (graph: Graph): ReadonlyArray<GraphNode> => graph.nodes

/**
 * The dependency edges, in the order they were observed.
 *
 * @since 0.1.0
 * @category accessors
 */
export const edges = (graph: Graph): ReadonlyArray<Edge> => graph.edges

/**
 * States that a file this runtime is about to evaluate holds bytes read from
 * another, so the declarations inside it are reported at the file an author
 * can open.
 *
 * A host that verifies a flow's source evaluates THE BYTES IT MEASURED, and
 * the only way to evaluate bytes here is to write them somewhere and import
 * that path: `@smthrs/registry` `Executable` writes them as a scratch sibling
 * of the entry and removes it when the load is over. Without this, every node
 * of an agent-authored flow names that scratch file, and a reader offered its
 * path is offered a file nothing holds (D-068).
 *
 * The loader states this BEFORE it imports, because a declaration captures its
 * site while the module is evaluated and never rewrites it. Both sides hold
 * the same module: a loaded flow is recognized by this package's own type id,
 * so a graph file resolving a second copy of `@smthrs/flow` is refused as not
 * a flow at all rather than registered with a site nothing corrected.
 *
 * @since 0.1.0
 * @category constructors
 */
export const evaluatedFrom = (evaluated: string, entry: string): void => DeclarationSite.evaluatedFrom(evaluated, entry)

/**
 * The drafts, in node order, ready for `Plan.compile` or `Plan.append`
 * unchanged.
 *
 * A graph with a FATAL diagnostic is inspectable but intentionally not
 * compilable: returning its partial drafts would turn missing topology into a
 * valid plan. This accessor therefore throws the first fatal build refusal, and
 * it is the ONLY way to reach the drafts. The built graph holds nodes, and a
 * draft is the node's own {@link GraphNode.draft}.
 *
 * An advisory refusal does not withhold the drafts. The one advisory code is
 * `capability_outside_grant`, where the callee runs with LESS authority than it
 * asked for: the author needs to see it, and the graph it describes is exactly
 * the graph that will run.
 *
 * @since 0.1.0
 * @category accessors
 */
export const drafts = (graph: Graph): ReadonlyArray<Plan.NodeDraft> => {
  const refusal = graph.diagnostics.find(isFatalDiagnostic)
  if (refusal !== undefined) throw refusal
  return graph.nodes.map((node) => node.draft)
}

/**
 * Recoverable topology issues recorded during the build, such as a missing
 * continuation builder or a continuation that did not produce a node. Fatal
 * refusals, including computing on a planned value and recursive inline
 * `.call()`, throw from {@link build} and never appear here.
 *
 * @since 0.1.0
 * @category accessors
 */
export const diagnostics = (graph: Graph): ReadonlyArray<GraphBuildError> => graph.diagnostics
