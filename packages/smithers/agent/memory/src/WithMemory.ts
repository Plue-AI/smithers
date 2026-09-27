/**
 * One memory policy applied to a whole flow tree.
 *
 * A delegated plan generates work the author never named, so the policy that
 * work runs under cannot be an argument threaded through every call. It is a
 * flow annotation instead: {@link withMemory} attaches the policy to a flow and
 * to every flow that flow declares, and the memory bindings in
 * `./Flows.ts` read it back when they resolve a namespace, a recall budget, or
 * whether a write is retained at all.
 *
 * The annotation takes no part in flow identity, so a policy never changes the
 * graph a flow plans. See https://memory.smithers.sh/reference/api/.
 *
 * @since 0.1.0
 */

import * as Annotations from "@smthrs/core/Annotations"
import * as Flow from "@smthrs/core/Flow"
import type * as DurableFlow from "@smthrs/flow/Flow"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { MemoryError } from "./MemoryError.ts"
import { BankName, MaxTokens } from "./Recall.ts"

/**
 * The memory policy a flow tree inherits: which namespace its memory lives in,
 * whether recall is refused (`recall: "none"`; absent, recall answers when
 * asked), the byte budget recall answers within, and whether writes are
 * retained.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Policy = Schema.Struct({
  banks: Schema.Array(BankName).check(Schema.isMinLength(1)),
  recall: Schema.optionalKey(Schema.Literal("none")),
  maxTokens: MaxTokens,
  retain: Schema.Literals(["on-complete", "never"])
})

/**
 * The memory policy a flow tree inherits.
 *
 * @category models
 * @since 0.1.0
 */
export type Policy = typeof Policy.Type

/**
 * Annotation key carrying the memory policy on a flow.
 *
 * @category annotations
 * @since 0.1.0
 */
export const MemoryPolicy = Context.Service<Policy>("flows/memory/Annotations/MemoryPolicy")

/**
 * A flow read as its full declaration. Every flow is one; `Flow.Any` is the
 * existential the patterns pass around, and it hides the fields a decorator
 * has to read.
 */
type Declaration = Flow.Flow<Schema.Top, Schema.Top, Schema.Top>

const declaration = (flow: Flow.Any): Declaration => flow as unknown as Declaration

/**
 * A `@smthrs/flow` declaration held with the annotating half `Flow.Any` states
 * no method for.
 *
 * `@smthrs/flow` carries its annotation bag as a field and its annotating
 * operation as a method, so the erased shape reads a bag it cannot add to.
 * This is the erased shape plus that method.
 *
 * @category models
 * @since 1.0.0
 */
export interface DurableDeclaration extends DurableFlow.Any {
  annotate<I, S>(key: Context.Key<I, S>, value: S): DurableDeclaration
}

/**
 * A declaration a memory policy attaches to.
 *
 * A `@smthrs/core` signature is one, and so is the `@smthrs/flow` flow a
 * pattern composes: `Trellis.make` answers one, and {@link module:MemoryTrellis}
 * annotates it. The two differ in what they declare BESIDE the annotation bag:
 * a signature carries the collaborator list a policy is inherited through, and
 * a composed flow carries none, reaching its collaborators by calling them.
 *
 * @category models
 * @since 1.0.0
 */
export type Declared = Flow.Any | DurableDeclaration

/**
 * Lists the collaborators a flow declares, callable flows and unresolved
 * registry names alike.
 *
 * It is the flow's own `flows` declaration, which is what a model filling in a
 * body is given and what a catalog lists. A flow that declares none reaches its
 * collaborators by calling them, and those calls are graph nodes rather than a
 * list, so this returns nothing for one. A `@smthrs/flow` flow declares no
 * list at all and is always that case.
 *
 * @category introspection
 * @since 0.1.0
 */
export const references = (flow: Declared): ReadonlyArray<Flow.Reference> => Flow.isFlow(flow) ? flow.flows ?? [] : []

/**
 * Lists the callable flows a flow declares. A name a registry has not resolved
 * yet is not one, so {@link references} is the wider view.
 *
 * @category introspection
 * @since 0.1.0
 */
export const children = (flow: Declared): ReadonlyArray<Flow.Any> =>
  references(flow).filter((reference): reference is Flow.Any => Flow.isFlow(reference))

/**
 * Reads the memory policy a flow carries, or `undefined` when it carries none.
 *
 * @category introspection
 * @since 0.1.0
 */
export const policyOf = (flow: Declared): Policy | undefined =>
  Option.getOrUndefined(Annotations.getOption(flow.annotations, MemoryPolicy))

const rebuild = (flow: Flow.Any, policy: Policy): Declaration => {
  const self = declaration(flow)
  const declared = references(flow)
  if (declared.length === 0) return self
  return Flow.withFlows(
    self,
    declared.map((reference) => Flow.isFlow(reference) ? attach(reference, policy) : reference)
  )
}

const attach = (flow: Flow.Any, policy: Policy): Flow.Any => Flow.annotate(rebuild(flow, policy), MemoryPolicy, policy)

const snapshot = (input: Policy): Policy => {
  let decoded: Policy
  try {
    decoded = Schema.decodeUnknownSync(Policy)(input)
  } catch {
    throw new MemoryError({
      code: "invalid_argument",
      message: "memory policy is invalid"
    })
  }
  return Object.freeze({
    ...decoded,
    banks: Object.freeze([...decoded.banks])
  })
}

/**
 * Returns a copy of `flow` carrying `policy`, with every flow it declares
 * carrying the same policy.
 *
 * The copy keeps the declaration's input and output schemas, so a host can
 * bind it: `FlowBinding.make` types the handler from `flow.input`, and an
 * answer of {@link Flow.Any} would leave nothing to type it from.
 *
 * The original flow is untouched, and every annotation the tree already carried
 * comes across: a placement, a lane, and any other key a host reads survive the
 * rebuild. A nested flow that already carries a policy is replaced by this one:
 * the tree a policy is applied to runs under exactly one policy, which is what
 * makes the inherited answer predictable.
 * The policy is decoded, detached, and deeply frozen before any annotation is
 * attached. Invalid policies throw a typed `MemoryError` at graph-build time.
 *
 * @category combinators
 * @since 0.1.0
 */
export function withMemory<Input extends Schema.Top, Output extends Schema.Top, Err extends Schema.Top>(
  flow: Flow.Flow<Input, Output, Err>,
  policy: Policy
): Flow.Flow<Input, Output, Err>

/**
 * Returns a copy of a flow held as the existential {@link Flow.Any} carrying
 * `policy`, with every flow it declares carrying the same policy.
 *
 * A pattern carries the flows it composes as `Flow.Any`, so this is the
 * signature `MemoryTrellis` reaches. It answers the same existential: a caller
 * that erased the schemas cannot get them back here.
 *
 * @category combinators
 * @since 0.1.0
 */
export function withMemory(flow: Flow.Any, policy: Policy): Flow.Any

/**
 * Returns a copy of a `@smthrs/flow` flow carrying `policy`.
 *
 * A composed flow is what a pattern answers: `Trellis.make` states a whole
 * topology as one `@smthrs/flow` declaration, and {@link module:MemoryTrellis}
 * puts the policy on top of it. Such a flow declares no collaborator list, so
 * there is no tree to inherit through here; the flows the pattern composed
 * carry the policy because they were scoped before they were composed.
 *
 * The copy keeps the tag and all three schemas, so it is still the flow the
 * pattern declared and plans the same graph node for node.
 *
 * @category combinators
 * @since 1.0.0
 */
export function withMemory<
  Tag extends string,
  Payload extends DurableFlow.AnyStructSchema,
  Success extends Schema.Top,
  Err extends Schema.Top,
  Requires
>(
  flow: DurableFlow.Flow<Tag, Payload, Success, Err, Requires>,
  policy: Policy
): DurableFlow.Flow<Tag, Payload, Success, Err, Requires>

export function withMemory(flow: Declared, policy: Policy): Declared {
  const attached = snapshot(policy)
  return Flow.isFlow(flow) ? attach(flow, attached) : flow.annotate(MemoryPolicy, attached)
}
