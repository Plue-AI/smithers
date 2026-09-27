// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Constructs executable durable action values.
 *
 * @since 0.1.0
 */

import type * as Effects from "@smthrs/plan/Effects"
import * as Node from "@smthrs/plan/Node"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Effectable from "effect/Effectable"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import type * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type { Scope } from "effect/Scope"
import * as Flow from "../Flow/index.ts"
import { FlowInstance } from "../FlowRuntime/FlowInstance.ts"
import { FlowRuntime } from "../FlowRuntime/FlowRuntime.ts"
import { lowerDeclarations } from "../internal/Declarations.ts"
import * as DeclarationSite from "../internal/DeclarationSite.ts"
import type * as RetryPolicy from "../RetryPolicy.ts"
import type { Action, Declared, IdempotencyKey, Requirement, Tier } from "./Action.ts"
import { CurrentAttempt } from "./Context.ts"
import { FileBoundary } from "./FileBoundary.ts"
import { type Implementation, Implementations } from "./Implementations.ts"
import { ImplementationVersionMismatch } from "./ImplementationVersionMismatch.ts"
import type { InfraInterrupt } from "./InfraInterrupt.ts"
import { InfraInterruptRetriesExhausted } from "./InfraInterruptRetriesExhausted.ts"
import { TypeId } from "./TypeId.ts"

interface ExitSchemas {
  readonly exitSchema: Schema.Exit<any, any, any>
  readonly exitSchemaPartial: Schema.Exit<any, any, any>
}

// A declared action mints a fresh inline action per dispatch. Effect caches
// compiled parsers by AST identity, so the exit schemas are shared per
// (success, error) pair rather than rebuilt on every dispatch.
const exitSchemaCache = new WeakMap<object, WeakMap<object, ExitSchemas>>()

const exitSchemasFor = (
  success: Schema.Constraint,
  error: Schema.Constraint,
  successJson: Schema.Top,
  errorJson: Schema.Top
): ExitSchemas => {
  let byError = exitSchemaCache.get(success)
  if (byError === undefined) {
    byError = new WeakMap()
    exitSchemaCache.set(success, byError)
  }
  let cached = byError.get(error)
  if (cached === undefined) {
    cached = {
      exitSchema: Schema.Exit(successJson, errorJson, Schema.Defect()),
      exitSchemaPartial: Schema.Exit(successJson, errorJson, Schema.Unknown)
    }
    byError.set(error, cached)
  }
  return cached
}

/**
 * The options of a declared action, shared by {@link make}'s declared form and
 * {@link makeSystem}.
 */
interface DeclaredOptions<
  Payload extends Schema.Struct.Fields | Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top
> {
  readonly payload: Payload
  /**
   * Native declaration whose source location this reconstructed action retains.
   * A source with no recorded location preserves that absence. This affects
   * diagnostics only, never identity; calls still refer to the new declaration.
   */
  readonly declaredFrom?: object | undefined
  readonly implementationVersion?: string | undefined
  readonly success?: Success | undefined
  readonly error?: Error | undefined
  /**
   * The capability ceiling this action dispatches under, as string literals.
   *
   * It is the same ceiling {@link module:Flow/Annotations.Capabilities}
   * carries, and declaring it here is what makes it READABLE without importing
   * the module, exactly as `Flow.make`'s option is: a catalog projects a
   * discovered declaration's authority from the source text of this literal,
   * and an annotation built at run time is invisible to that projection.
   *
   * {@link module:Graph.build} records a `capability_outside_grant` refusal for
   * every capability named here that the calling flow does not hold. The
   * refusal is advisory, because the dispatch runs with the capability dropped.
   */
  readonly capabilities?: ReadonlyArray<string> | undefined
  /**
   * The effect envelope this action dispatches under, as a literal.
   *
   * It is the same declaration {@link module:Flow/Annotations.EffectEnvelope}
   * carries, declared here for the same reason `capabilities` is.
   *
   * An action is a leaf, so this envelope encloses nothing; it is checked
   * against the envelope the calling flow granted, and
   * {@link module:Graph.build} refuses a dispatch that reads or writes outside
   * that grant, loosens `hermetic` to `expected`, or raises the tier. `reads`
   * and `writes` are normalized to sorted, duplicate-free arrays.
   */
  readonly effects?: Effects.MakeOptions | undefined
  readonly tier?: Tier | undefined
  readonly idempotencyKey?:
    | IdempotencyKey
    | ((payload: (Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload)["Type"]) => IdempotencyKey)
    | undefined
  readonly nondeterministic?: true | undefined
  readonly retryPolicy?: RetryPolicy.RetryPolicy | undefined
  readonly interruptRetryPolicy?: Schedule.Schedule<any, unknown> | undefined
  readonly fileBoundary?:
    | FileBoundary
    | ((payload: (Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload)["Type"]) => FileBoundary)
    | undefined
  readonly annotations?: Context.Context<never> | undefined
}

/**
 * Creates a flow action from an effect, using the provided schemas to
 * encode successes and failures for durable execution.
 *
 * @category constructors
 * @since 0.1.0
 */
const makeInline = <
  R,
  Success extends Schema.Constraint = Schema.Void,
  Error extends Schema.Constraint = Schema.Never
>(options: {
  readonly name: string
  readonly implementationVersion?: string | undefined
  readonly success?: Success | undefined
  readonly error?: Error | undefined
  readonly execute: Effect.Effect<Success["Type"], Error["Type"], R>
  readonly tier?: Tier | undefined
  readonly idempotencyKey?: IdempotencyKey | undefined
  readonly nondeterministic?: true | undefined
  readonly metadata?: unknown
  readonly fileBoundary?: FileBoundary | undefined
  readonly interruptRetryPolicy?: Schedule.Schedule<any, unknown> | undefined
  readonly retryPolicy?: RetryPolicy.RetryPolicy | undefined
  readonly annotations?: Context.Context<never> | undefined
}): Action<Success, Error, Exclude<R, FlowInstance | FlowRuntime | Scope>> => {
  const implementationVersion = options.implementationVersion === undefined
    ? undefined
    : Schema.decodeUnknownSync(Schema.NonEmptyString)(options.implementationVersion)
  const successSchema = options.success ?? (Schema.Void as any as Success)
  const errorSchema = options.error ?? (Schema.Never as any as Error)
  const successSchemaJson = Schema.toCodecJson(successSchema)
  const errorSchemaJson = Schema.toCodecJson(errorSchema)
  const exitSchemas = exitSchemasFor(successSchema, errorSchema, successSchemaJson, errorSchemaJson)
  let execute!: Effect.Effect<Success["Type"], Error["Type"], any>
  const executeWithInfraRetry = retryInfraInterrupt(
    options.name,
    options.interruptRetryPolicy
  )(options.execute)
  const self: Action<Success, Error, Exclude<R, FlowInstance | FlowRuntime>> = {
    ...Effectable.Prototype<Action<Success, Error, R>>({
      label: "Action",
      evaluate(_) {
        return execute
      }
    }),
    [TypeId]: TypeId,
    name: options.name,
    implementationVersion,
    successSchema,
    errorSchema,
    exitSchema: exitSchemas.exitSchema,
    exitSchemaPartial: exitSchemas.exitSchemaPartial,
    annotations: options.annotations ?? Context.empty(),
    tier: options.tier ?? "sealed",
    idempotencyKey: options.idempotencyKey,
    nondeterministic: options.nondeterministic,
    metadata: options.fileBoundary === undefined ? options.metadata : FileBoundary.make(options.fileBoundary),
    fileBoundary: options.fileBoundary === undefined ? undefined : FileBoundary.make(options.fileBoundary),
    retryPolicy: options.retryPolicy,
    annotate(tag: Context.Key<any, any>, value: any) {
      return makeInline({
        ...options,
        annotations: Context.add(self.annotations, tag, value)
      })
    },
    annotateMerge(context: Context.Context<any>) {
      return makeInline({
        ...options,
        annotations: Context.merge(self.annotations, context)
      })
    },
    execute: executeWithInfraRetry,
    executeEncoded: Effect.matchEffect(executeWithInfraRetry, {
      onFailure: (error) => Effect.flatMap(Effect.orDie(Schema.encodeEffect(errorSchemaJson)(error)), Effect.fail),
      onSuccess: (value) => Effect.orDie(Schema.encodeEffect(successSchemaJson)(value))
    })
  } as any
  execute = makeExecute(self)
  return self
}

const makeDeclared = <
  const Tag extends string,
  Payload extends Schema.Struct.Fields | Flow.AnyStructSchema,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never
>(tag: Tag, options: DeclaredOptions<Payload, Success, Error>, site: DeclarationSite.DeclaredAt | undefined): Declared<
  Tag,
  Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload,
  Success,
  Error
> => {
  type PayloadSchema = Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload
  const payloadSchema = (Schema.isSchema(options.payload)
    ? options.payload
    : Schema.Struct(options.payload)) as PayloadSchema
  const implementationVersion = options.implementationVersion === undefined
    ? undefined
    : Schema.decodeUnknownSync(Schema.NonEmptyString)(options.implementationVersion)
  const successSchema = options.success ?? (Schema.Void as unknown as Success)
  const errorSchema = options.error ?? (Schema.Never as unknown as Error)
  const annotations = lowerDeclarations(options)
  // The literals are already in the bag above, so an annotated copy rebuilds
  // from options WITHOUT them: re-lowering would overwrite a `Capabilities` or
  // `EffectEnvelope` the caller annotated on top of the declared one.
  const lowered: DeclaredOptions<Payload, Success, Error> = {
    ...options,
    capabilities: undefined,
    effects: undefined
  }
  // The requirement this declaration mints for itself. Context keys are
  // compared by their string key, so re-minting one for an annotated copy of
  // this declaration names the same slot the original does.
  const requirement = Context.Service<Requirement<Tag>, Implementation>(
    `@smthrs/flow/Action/Requirement/${tag}`
  )
  const self: Declared<Tag, PayloadSchema, Success, Error> = {
    [TypeId]: TypeId,
    name: tag,
    implementationVersion,
    payloadSchema,
    successSchema,
    errorSchema,
    tier: options.tier ?? "sealed",
    idempotencyKey: options.idempotencyKey,
    nondeterministic: options.nondeterministic,
    retryPolicy: options.retryPolicy,
    fileBoundary: options.fileBoundary,
    annotations,
    requirement,
    annotate(key: Context.Key<any, any>, value: any) {
      return makeDeclared(tag, {
        ...lowered,
        annotations: Context.add(annotations, key, value)
      }, site)
    },
    annotateMerge(context: Context.Context<any>) {
      return makeDeclared(tag, {
        ...lowered,
        annotations: Context.merge(annotations, context)
      }, site)
    },
    call(payload) {
      return Node.actionCall<Success["Type"], Error["Type"]>(self, tag, payload)
    },
    toLayer(execute, registrationOptions) {
      if (registrationOptions?.implementationVersion !== implementationVersion) {
        throw new ImplementationVersionMismatch({
          actionName: tag,
          declaredVersion: implementationVersion ?? null,
          registeredVersion: registrationOptions?.implementationVersion ?? null,
          message: `Action "${tag}" requires its declared implementationVersion at registration.`
        })
      }
      // The flow form of this action: same tag, same schemas, and a body that
      // is the one call to it. Registering that flow is what lets a caller
      // `execute` the action as a durable execution of its own, and the body
      // says truthfully what such an execution does. It stays INTERNAL — a flow
      // carries a body and never a handler, so `Flow` has no `toLayer` for an
      // author to reach this seam with.
      //
      // `Flow.make` answers with `PayloadSchemaOf<PayloadSchema>`, which is
      // `PayloadSchema` itself for a payload that is already a schema rather
      // than a field record. The compiler defers that conditional while the
      // type parameter is unresolved, so the identity is asserted here.
      const registration = Flow.make(tag, {
        payload: payloadSchema,
        success: successSchema,
        error: errorSchema,
        annotations,
        body: (payload) => Node.actionCall<Success["Type"], Error["Type"]>(self, tag, payload)
      }) as unknown as Flow.Flow<Tag, PayloadSchema, Success, Error>
      const action = (payload: PayloadSchema["Type"]) =>
        makeInline({
          name: tag,
          implementationVersion,
          success: successSchema,
          error: errorSchema,
          tier: self.tier,
          idempotencyKey: typeof self.idempotencyKey === "function"
            ? self.idempotencyKey(payload)
            : self.idempotencyKey,
          nondeterministic: self.nondeterministic,
          retryPolicy: options.retryPolicy,
          interruptRetryPolicy: options.interruptRetryPolicy,
          fileBoundary: typeof options.fileBoundary === "function"
            ? options.fileBoundary(payload)
            : options.fileBoundary,
          annotations,
          execute: execute(payload)
        })
      // The implementation, provided under the requirement this declaration
      // minted. That is the compile-time half: a body that called this action
      // produced a node requiring the tag, and this layer is the only thing
      // that answers it, so a plan cannot reach `execute` without its code.
      //
      // The name-keyed table is the run-time half and stays exactly as it was.
      // A driver expanding a persisted plan has no types left to consult and
      // resolves by tag, so the same implementation is filed there when a
      // composition wired a table up. The table is optional on purpose: a
      // composition that only executes handlers registered directly with the
      // runtime has no use for it, and requiring it would change what every
      // existing `toLayer` call site must provide.
      const implement = Layer.effect(requirement)(Effect.gen(function*() {
        const services = yield* Effect.context<never>()
        // The captured context is what the runtime's own `register` captures
        // for the handler path: the services the implementation was wired with,
        // overridable by whatever the run provides on top of them.
        const provided = (payload: unknown) =>
          Effect.flatMap(
            // A driver assembles this payload from plan values rather than from
            // a typed call site, so the declaration validates it exactly as
            // `Flow.execute` validates a caller's. The cast is the erasure that
            // hands an unknown to the constructor; `makeEffect` is what decides
            // whether it was one.
            Effect.orDie(payloadSchema.makeEffect(payload as never)),
            (decoded) => action(decoded)
          ).pipe(Effect.updateContext((input) => Context.merge(services, input) as Context.Context<any>))
        const implementation: Implementation = {
          name: tag,
          ...(implementationVersion === undefined ? {} : { implementationVersion }),
          action: provided as Implementation["action"]
        }
        const table = yield* Effect.serviceOption(Implementations)
        if (Option.isSome(table)) yield* table.value.add(implementation, registrationOptions)
        return implementation
      }))
      return Layer.merge(
        Layer.effectDiscard(
          Effect.flatMap(FlowRuntime, (engine) => engine.register(registration, action))
        ),
        implement
      )
    }
  }
  return DeclarationSite.annotate(self, site)
}

/**
 * Creates either an inline executable action or a named action
 * declaration, selected by whether the first argument is a string.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: {
  <
    const Tag extends string,
    Payload extends Schema.Struct.Fields | Flow.AnyStructSchema,
    Success extends Schema.Top = Schema.Void,
    Error extends Schema.Top = Schema.Never
  >(tag: Tag, options: DeclaredOptions<Payload, Success, Error>): Declared<
    Tag,
    Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload,
    Success,
    Error
  >
  <
    R,
    Success extends Schema.Constraint = Schema.Void,
    Error extends Schema.Constraint = Schema.Never
  >(options: {
    readonly name: string
    readonly implementationVersion?: string | undefined
    readonly success?: Success | undefined
    readonly error?: Error | undefined
    readonly execute: Effect.Effect<Success["Type"], Error["Type"], R>
    readonly tier?: Tier | undefined
    readonly idempotencyKey?: IdempotencyKey | undefined
    readonly nondeterministic?: true | undefined
    readonly metadata?: unknown
    readonly fileBoundary?: FileBoundary | undefined
    readonly interruptRetryPolicy?: Schedule.Schedule<any, unknown> | undefined
    readonly retryPolicy?: RetryPolicy.RetryPolicy | undefined
    readonly annotations?: Context.Context<never> | undefined
  }): Action<Success, Error, Exclude<R, FlowInstance | FlowRuntime | Scope>>
} = ((first: string | Parameters<typeof makeInline>[0], second?: object) => {
  if (typeof first !== "string") return makeInline(first)
  const options = second as Parameters<typeof makeDeclared>[1]
  return makeDeclared(
    first,
    options,
    options.declaredFrom === undefined ? DeclarationSite.capture() : DeclarationSite.declaredAt(options.declaredFrom)
  )
}) as any

/**
 * Declares a SYSTEM action: one whose implementation ships with the engine
 * rather than with the composition that calls it.
 *
 * It is {@link make}'s declared form in every respect except the requirement.
 * A system declaration mints none, so `.call()` records a node that demands
 * nothing and a body using {@link module:Sleep} or {@link module:WaitFor} does
 * not push a layer obligation onto its callers. That is the whole difference,
 * and it is a deliberate hole in the compile-time enforcement: the engine owns
 * these implementations, so an author cannot be the one who forgot them.
 *
 * Everything else is unchanged — the layer still registers with the runtime and
 * still files itself in {@link module:Implementations.Implementations}, so a
 * driver resolves a system action by tag exactly like any other.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeSystem = <
  const Tag extends string,
  Payload extends Schema.Struct.Fields | Flow.AnyStructSchema,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never
>(tag: Tag, options: DeclaredOptions<Payload, Success, Error>): Declared<
  Tag,
  Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload,
  Success,
  Error,
  never
> =>
  // The erasure IS the declaration: the value still provides its requirement
  // from `toLayer`, and dropping it from `call` only means nothing asks for it.
  // Providing a service no one requires is always sound; the reverse would not
  // be, which is why this is the one place the channel is written off.
  makeDeclared(
    tag,
    options,
    options.declaredFrom === undefined ? DeclarationSite.capture() : DeclarationSite.declaredAt(options.declaredFrom)
  ) as unknown as Declared<
    Tag,
    Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload,
    Success,
    Error,
    never
  >

const isInfraInterrupt = (value: unknown): value is InfraInterrupt =>
  Predicate.isTagged("@smthrs/flow/InfraInterrupt")(value)

const retryInfraInterrupt = (
  name: string,
  policy: Schedule.Schedule<any, unknown> | undefined
) =>
<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  policy === undefined
    ? effect
    : Effect.suspend(() => {
      let attempts = 0
      return effect.pipe(
        // Each failed execution reaches this tap once, including the final
        // failure the schedule declines to retry, so this is the real attempt
        // count rather than an estimate derived from schedule shape.
        Effect.tapError((error) =>
          isInfraInterrupt(error)
            ? Effect.sync(() => void attempts++)
            : Effect.void
        ),
        Effect.retry({
          schedule: policy,
          while: isInfraInterrupt
        }),
        Effect.catch((error) =>
          isInfraInterrupt(error)
            ? Effect.die(
              new InfraInterruptRetriesExhausted({
                actionName: name,
                attempts,
                interrupt: error,
                message: `Action "${name}" infrastructure interrupt retry attempts exhausted after ` +
                  `${attempts} attempts.`
              })
            )
            : Effect.fail(error)
        )
      )
    })

// Untraced because action execution is retried in the flow hot path.
const makeExecute = Effect.fnUntraced(function*<
  R,
  Success extends Schema.Constraint = typeof Schema.Void,
  Error extends Schema.Constraint = typeof Schema.Never
>(action: Action<Success, Error, R>) {
  const engine = yield* FlowRuntime
  const instance = yield* FlowInstance
  const attempt = yield* CurrentAttempt
  yield* Effect.annotateCurrentSpan({
    executionId: instance.executionId,
    action: action.name,
    attempt,
    tier: action.tier
  })
  const result = yield* Flow.wrapActionResult(
    engine.actionExecute(action, attempt),
    (_) => _._tag === "Suspended"
  )
  // An action settles with an exit or with a suspension; a handoff is a
  // FLOW settlement, and the engine's action path never produces one. The
  // narrowing is written as "not complete" so the third result variant needs
  // no unreachable arm of its own.
  if (result._tag !== "Complete") {
    yield* Effect.annotateCurrentSpan({ outcome: "suspended" })
    return yield* Flow.suspend(instance)
  }
  yield* Effect.annotateCurrentSpan({ outcome: result.exit._tag === "Success" ? "success" : "failure" })
  return yield* result.exit
}, (effect) =>
  Effect.withSpan(effect, "Action.execute", {
    captureStackTrace: false
  }))
