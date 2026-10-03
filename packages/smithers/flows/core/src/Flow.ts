/**
 * Schema-described flow signatures, and the combinators that decorate one.
 *
 * A signature is sugar over `@smthrs/flow`. `Flow.make` lowers what an author
 * declares onto the two values that package executes: an `Action.Declared`,
 * which is what a host supplies an implementation for through `toLayer`, and a
 * `Flow` whose body is one call to that action. A signature that declares its
 * own `body` keeps the body and needs no action. Either way the value carries
 * the metadata a catalog, a decorator, or a harness reads back, and
 * {@link Flow.call} records a node in `@smthrs/plan`'s one node model.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 0.0.0
 */

import { Action, Flow as Durable } from "@smthrs/flow"
import type * as Context from "effect/Context"
import { dual, identity } from "effect/Function"
import * as Option from "effect/Option"
import { type Pipeable, pipeArguments } from "effect/Pipeable"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Types from "effect/Types"
import * as Annotations from "./Annotations.ts"
import * as Effects from "./Effects.ts"
import * as Node from "./Node.ts"
import type * as Placement from "./Placement.ts"

/**
 * Runtime type identifier carried by flow values.
 *
 * @category type ids
 * @since 0.0.0
 * @slop
 */
export const TypeId: TypeId = "~flows/core/Flow"

/**
 * Type-level representation of the flow runtime type identifier.
 *
 * @category type ids
 * @since 0.0.0
 * @slop
 */
export type TypeId = "~flows/core/Flow"

/**
 * The name of a model seat a flow may run on.
 *
 * Seats are referred to by name, never by provider model id.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type Seat = string & {}

/**
 * A collaborator a flow declares: a flow value, or a registry name the harness
 * resolves before execution.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type Reference = Any | string

/**
 * The struct payload a declared `input` schema becomes.
 *
 * `@smthrs/flow` requires a struct payload, and a signature may declare any
 * schema, so a non-struct input travels as the one field `input`.
 * {@link Flow.call} takes the declared shape and wraps it, so an author never
 * writes the wrapper.
 *
 * @category models
 * @since 1.0.0
 */
export type Payload<I extends Schema.Top> =
  & (I extends Durable.AnyStructSchema ? I : Schema.Struct<{ readonly input: I }>)
  & Durable.AnyStructSchema

/**
 * A schema-described flow signature.
 *
 * The input schema is invariant because it participates in both decoding and
 * encoding. Output and error schemas are covariant.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Flow<
  I extends Schema.Top,
  O extends Schema.Top,
  Err extends Schema.Top = typeof Schema.Never,
  Requires = Action.Requirement<string>
> extends Pipeable {
  readonly [TypeId]: {
    readonly _Input: Types.Invariant<I>
    readonly _Output: Types.Covariant<O>
    readonly _Error: Types.Covariant<Err>
  }
  /** The declared name, which is the tag of the flow and of the action. */
  readonly name: string
  readonly description: string | undefined
  /** The input schema as DECLARED, before {@link Payload} wraps a non-struct. */
  readonly input: I
  readonly output: O
  readonly error: Err
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  /**
   * Advisory model seat metadata recorded on the flow.
   *
   * @since 0.1.0
   */
  readonly model: Seat | readonly [Seat, ...Array<Seat>] | undefined
  /**
   * Advisory collaborator metadata recorded on the flow.
   *
   * @since 0.1.0
   */
  readonly flows: ReadonlyArray<Reference> | undefined
  /**
   * Advisory prompt metadata recorded on the flow.
   *
   * @since 0.1.0
   */
  readonly prompt: string | undefined
  /**
   * The annotation bag the lowered flow and action carry, with the declared
   * `capabilities` and `effects` already in it.
   */
  readonly annotations: Context.Context<never>
  /**
   * The `@smthrs/flow` flow this signature IS, tagged with {@link Flow.name}.
   *
   * It is what `Graph.build`, an `Interpreter`, and a registry that checks
   * `@smthrs/flow`'s own type id are handed.
   */
  readonly flow: Durable.Flow<string, Payload<I>, O, Err, Requires>
  /**
   * The declared action a host implements with `toLayer`, on a signature that
   * declared no body. A signature with a body carries `undefined`: its body IS
   * the implementation.
   */
  readonly action: Action.Declared<string, Payload<I>, O, Err, Requires> | undefined
  /**
   * Records a call in the input schema's constructor shape, like the native
   * flow. In particular a class schema accepts its inert field data here.
   *
   * It never runs the body: graph construction evaluates pure bodies at plan
   * time.
   */
  readonly call: (input: I["~type.make.in"]) => Node.Node<O["Type"], Err["Type"], Requires>
}

/**
 * Marker-only existential type for heterogeneous collections of flows.
 *
 * It names every property a consumer outside this package reads off a
 * signature, so a decorator that holds one erased can still read what it
 * declares.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export interface Any {
  readonly [TypeId]: object
  readonly name: string
  readonly description: string | undefined
  readonly input: Schema.Top
  readonly output: Schema.Top
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly flows: ReadonlyArray<Reference> | undefined
  readonly annotations: Context.Context<never>
  readonly flow: Durable.Any
  readonly call: (input: never) => Node.Node<unknown, unknown, unknown>
}

/**
 * Extracts the decoded input type of a flow.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Input<F> = F extends { readonly input: infer I extends Schema.Top } ? I["Type"] : never

/**
 * Extracts the decoded output type of a flow.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Output<F> = F extends { readonly output: infer O extends Schema.Top } ? O["Type"] : never

/**
 * Extracts the decoded error type of a flow.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Error<F> = F extends { readonly error: infer Err extends Schema.Top } ? Err["Type"] : never

/**
 * Configures schemas, metadata, effects, and body for {@link make}.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface MakeOptions<
  I extends Schema.Top,
  O extends Schema.Top,
  Err extends Schema.Top,
  Requires
> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly input?: I | undefined
  readonly output?: O | undefined
  readonly error?: Err | undefined
  readonly capabilities?: ReadonlyArray<string> | undefined
  readonly effects?: Effects.Declaration | undefined
  readonly model?: Seat | readonly [Seat, ...Array<Seat>] | undefined
  readonly flows?: ReadonlyArray<Reference> | undefined
  readonly prompt?: string | undefined
  readonly body?:
    | ((
      input: Types.NoInfer<I["Type"]>
    ) => Node.Node<Types.NoInfer<O["Type"]>, Types.NoInfer<Err["Type"]>, Requires>)
    | undefined
}

/** Everything a signature is built from, with every default already applied. */
interface Options<
  I extends Schema.Top,
  O extends Schema.Top,
  Err extends Schema.Top,
  Requires
> {
  readonly name: string
  readonly description: string | undefined
  readonly input: I
  readonly output: O
  readonly error: Err
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly model: Seat | readonly [Seat, ...Array<Seat>] | undefined
  readonly flows: ReadonlyArray<Reference> | undefined
  readonly prompt: string | undefined
  /**
   * The annotations the AUTHOR supplied, before the declared `capabilities`
   * and `effects` are lowered onto them.
   *
   * A combinator rebuilds from these rather than from the lowered bag the
   * value exposes, so lowering a declaration twice cannot overwrite an
   * annotation a caller put on top of it.
   */
  readonly annotations: Context.Context<never>
  readonly body:
    | ((input: I["Type"]) => Node.Node<O["Type"], Err["Type"], Requires>)
    | undefined
  /** The original native declarations whose diagnostic source locations survive a rebuild. */
  readonly original?: { readonly flow: object; readonly action: object | undefined } | undefined
}

/** The options each built signature was built from, for the combinators. */
const built = new WeakMap<object, Options<Schema.Top, Schema.Top, Schema.Top, unknown>>()

const optionsOf = <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires>(
  self: Flow<I, O, Err, Requires>
): Options<I, O, Err, Requires> => built.get(self) as unknown as Options<I, O, Err, Requires>

/** Whether a schema is the struct `@smthrs/flow` requires of a payload. */
const isStruct = (schema: Schema.Top): schema is Durable.AnyStructSchema => Predicate.hasProperty(schema, "fields")

const payloadOf = <I extends Schema.Top>(input: I): Payload<I> =>
  (isStruct(input) ? input : Schema.Struct({ input })) as Payload<I>

/**
 * The tier a signature's action dispatches under.
 *
 * A declared envelope states it. A signature that declared none is
 * `irreversible`, the conservative default a harness already projects for this
 * case, and never `@smthrs/flow`'s own `sealed` default: a signature that did
 * not state its tier must not content-share another run's result.
 */
const tierOf = (effects: Effects.Declaration | undefined): Action.Tier => effects?.tier ?? "irreversible"

const build = <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires>(
  options: Options<I, O, Err, Requires>
): Flow<I, O, Err, Requires> => {
  const payload = payloadOf(options.input)
  const wrapped = isStruct(options.input)
  // Capabilities is a Context.Reference: getOption supplies its default even
  // when no value was annotated. Only an explicitly stored value overrides
  // the author's declaration.
  const annotatedCapabilities = options.annotations.mapUnsafe.has(Durable.Capabilities.key)
    ? Annotations.getOption(options.annotations, Durable.Capabilities)
    : Option.none<ReadonlyArray<string>>()
  const capabilities = Option.getOrElse(annotatedCapabilities, () => options.capabilities)
  const effects = Option.getOrElse(
    Annotations.getOption(options.annotations, Annotations.Effects),
    () => options.effects
  )
  const declared = {
    payload,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(capabilities.length === 0 && Option.isNone(annotatedCapabilities) ? {} : { capabilities }),
    ...(effects === undefined ? {} : { effects }),
    success: options.output,
    error: options.error,
    annotations: options.annotations
  }
  const body = options.body
  // A signature without a body IS the action a host implements later; the flow
  // beside it exists because a declared capability ceiling is read off a Flow,
  // and because a caller splices one node either way.
  const action = body === undefined
    ? Action.make(options.name, {
      ...declared,
      declaredFrom: options.original?.action,
      tier: tierOf(effects)
    }) as unknown as Action.Declared<
      string,
      Payload<I>,
      O,
      Err,
      Requires
    >
    : undefined
  type NativeBody = (payload: Payload<I>["Type"]) => Node.Node<O["Type"], Err["Type"], Requires>
  let nativeBody: NativeBody
  if (body === undefined) {
    nativeBody = (payloadValue) => action!.call(payloadValue as never)
  } else if (wrapped) {
    nativeBody = body
  } else {
    const adapter: NativeBody = (payloadValue) => body((payloadValue as { readonly input: I["Type"] }).input)
    const bodyIdentity = Node.functionIdentity(body)
    // The adapter adds no author behavior. A captured body already names all
    // of its semantics; carry that identity through the wrapping operation.
    // An uncaptured body must keep failing the native stable-callback policy.
    nativeBody = bodyIdentity.algorithm === "sha256-source-captures/v5"
      ? Node.capture({ body: bodyIdentity }, adapter)
      : adapter
  }
  const flow = Durable.make(options.name, {
    ...declared,
    declaredFrom: options.original?.flow,
    body: nativeBody
  }) as unknown as Durable.Flow<string, Payload<I>, O, Err, Requires>
  const self: Flow<I, O, Err, Requires> = {
    [TypeId]: {
      _Input: identity,
      _Output: identity,
      _Error: identity
    },
    name: options.name,
    description: options.description,
    input: options.input,
    output: options.output,
    error: options.error,
    capabilities,
    effects,
    model: options.model,
    flows: options.flows,
    prompt: options.prompt,
    annotations: flow.annotations,
    flow,
    action,
    call: (input: I["~type.make.in"]) => flow.call((wrapped ? input : { input }) as never),
    pipe() {
      // eslint-disable-next-line prefer-rest-params
      return pipeArguments(this, arguments)
    }
  }
  built.set(self, {
    ...options,
    original: options.original ?? { flow, action }
  })
  return self
}

/**
 * Returns `true` when a value is a flow signature.
 *
 * @category guards
 * @since 0.0.0
 * @slop
 */
export const isFlow = (value: unknown): value is Any => Predicate.hasProperty(value, TypeId)

/**
 * Creates a flow signature from one schema-first options object.
 *
 * A signature declares a `name`, which is the tag its flow and its action
 * carry. It is required: a tag is what a host binds an implementation to and
 * what a plan records, and a declaration loaded from a file takes the name its
 * loader derives from the path. `Flow.make` therefore throws `TypeError` on a
 * missing or empty one rather than minting an empty tag.
 *
 * With a `body`, the signature is that body: it plans as the nodes the body
 * returns. Without one, the signature is a declared action plus the flow that
 * calls it once, and a host attaches the implementation with
 * `flow.action.toLayer(...)`.
 *
 * @deprecated Use `Flow.make(tag, { payload, success, error, body })` from
 * `@smthrs/flow`. This compatibility adapter delegates to that constructor;
 * its `flow` property is the canonical executable declaration.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const make = <
  I extends Schema.Top = typeof Schema.Void,
  O extends Schema.Top = typeof Schema.Unknown,
  Err extends Schema.Top = typeof Schema.Never,
  Requires = Action.Requirement<string>
>(config: MakeOptions<I, O, Err, Requires>): Flow<I, O, Err, Requires> => {
  if (config.name === undefined || config.name.length === 0) {
    throw new TypeError(
      "Flow.make requires a name: it is the tag the flow, its action, and every plan that records a call carry"
    )
  }
  return build<I, O, Err, Requires>({
    name: config.name,
    description: config.description,
    input: (config.input ?? Schema.Void) as I,
    output: (config.output ?? Schema.Unknown) as O,
    error: (config.error ?? Schema.Never) as Err,
    capabilities: [...new Set(config.capabilities ?? [])].sort(),
    effects: config.effects,
    model: config.model,
    flows: config.flows === undefined ? undefined : [...config.flows],
    prompt: config.prompt,
    annotations: Annotations.empty,
    body: config.body
  })
}

/**
 * Places a flow within a host directive, returning a fresh flow.
 *
 * @category combinators
 * @since 0.0.0
 * @slop
 */
export const within: {
  (
    placement: Placement.Placement
  ): <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires>(
    self: Flow<I, O, Err, Requires>
  ) => Flow<I, O, Err, Requires>
  <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires>(
    self: Flow<I, O, Err, Requires>,
    placement: Placement.Placement
  ): Flow<I, O, Err, Requires>
} = dual(2, <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires>(
  self: Flow<I, O, Err, Requires>,
  placement: Placement.Placement
): Flow<I, O, Err, Requires> => {
  const options = optionsOf(self)
  return build({
    ...options,
    annotations: Annotations.add(options.annotations, Annotations.Placement, placement)
  })
})

/**
 * Attaches one typed annotation to a flow, returning a fresh flow.
 *
 * Annotations are metadata a host or a decorator reads. A custom key is
 * advisory, so a flow annotated with one plans the same graph as the flow it
 * was built from. The built-in {@link Annotations.Placement} and
 * {@link Annotations.Effects} keys are not advisory: `Graph.build` projects
 * both into node key material, so annotating with either changes the keys the
 * graph plans. {@link within} is the placement-shaped special case of this
 * combinator.
 *
 * @category combinators
 * @since 0.1.0
 */
export const annotate: {
  <Key, S>(
    key: Context.Key<Key, S>,
    value: S
  ): <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires>(
    self: Flow<I, O, Err, Requires>
  ) => Flow<I, O, Err, Requires>
  <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires, Key, S>(
    self: Flow<I, O, Err, Requires>,
    key: Context.Key<Key, S>,
    value: S
  ): Flow<I, O, Err, Requires>
} = dual(3, <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires, Key, S>(
  self: Flow<I, O, Err, Requires>,
  key: Context.Key<Key, S>,
  value: S
): Flow<I, O, Err, Requires> => {
  const options = optionsOf(self)
  return build({
    ...options,
    annotations: Annotations.add(options.annotations, key, value)
  })
})

/**
 * Replaces the collaborators a flow declares, returning a fresh flow.
 *
 * Everything else comes across unchanged: name, schemas, capabilities,
 * effects, body, and annotations. That is what lets a decorator rewrite a flow
 * tree without dropping the metadata a host reads back, such as a placement or
 * a lane.
 *
 * @category combinators
 * @since 0.1.0
 */
export const withFlows: {
  (
    flows: ReadonlyArray<Reference>
  ): <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires>(
    self: Flow<I, O, Err, Requires>
  ) => Flow<I, O, Err, Requires>
  <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires>(
    self: Flow<I, O, Err, Requires>,
    flows: ReadonlyArray<Reference>
  ): Flow<I, O, Err, Requires>
} = dual(2, <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires>(
  self: Flow<I, O, Err, Requires>,
  flows: ReadonlyArray<Reference>
): Flow<I, O, Err, Requires> =>
  build({
    ...optionsOf(self),
    flows: [...flows]
  }))
