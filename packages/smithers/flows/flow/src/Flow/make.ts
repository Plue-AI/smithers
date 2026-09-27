// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Constructs executable flow declarations from schema and policy data.
 *
 * @since 0.1.0
 */

import { Sha256 } from "@smthrs/crypto"
import type * as Effects from "@smthrs/plan/Effects"
import * as Node from "@smthrs/plan/Node"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { FlowRuntime } from "../FlowRuntime/FlowRuntime.ts"
import { lowerDeclarations } from "../internal/Declarations.ts"
import * as DeclarationSite from "../internal/DeclarationSite.ts"
import type * as RetryPolicy from "../RetryPolicy.ts"
import { CurrentExecutionIds } from "./ExecutionIds.ts"
import type { Any, AnyStructSchema, AnyWithProps, BodySuccess, Flow } from "./Flow.ts"
import type { To } from "./Outcome.ts"
import { withRollback } from "./Runtime.ts"
import { TypeId } from "./TypeId.ts"

/**
 * The identity of an invocation that named no `executionId`: the flow's own
 * declared key when it has one, and the ambient source otherwise.
 *
 * A declared key wins over the ambient source because it is the narrower
 * statement — this author said what makes two invocations of THIS flow the
 * same — where the source is the host's blanket answer for every flow it
 * drives.
 *
 * The tag and declared key are JSON-tuple framed before hashing. Their strings
 * are used exactly as given and encoded as UTF-8, with no Unicode
 * normalization. This preimage encoding freezes at rc.0.
 */
const makeExecutionIdFromPayload = (
  self: AnyWithProps,
  payload: unknown
): Effect.Effect<string, never, any> => {
  const idempotencyKey = self.idempotencyKey
  return idempotencyKey === undefined
    ? Effect.flatMap(CurrentExecutionIds, (source) => source.mint(self, payload))
    // The JSON tuple prevents delimiter splicing. This exact framing freezes at rc.0.
    : Schema.decodeUnknownEffect(Sha256)(JSON.stringify([self._tag, idempotencyKey(payload)])).pipe(Effect.orDie)
}

const resolveExecutionId = (
  self: AnyWithProps,
  payload: unknown,
  executionId: string | undefined
): Effect.Effect<string, never, any> =>
  executionId === undefined
    ? makeExecutionIdFromPayload(self, payload)
    : Effect.succeed(executionId)

const Proto = {
  [TypeId]: TypeId,
  annotate(this: AnyWithProps, tag: Context.Key<any, any>, value: any) {
    return DeclarationSite.annotate(
      makeProto({
        _tag: this._tag,
        description: this.description,
        payloadSchema: this.payloadSchema,
        successSchema: this.successSchema,
        errorSchema: this.errorSchema,
        annotations: Context.add(this.annotations, tag, value),
        body: this.body,
        idempotencyKey: this.idempotencyKey,
        suspendedRetryPolicy: this.suspendedRetryPolicy,
        maxRounds: this.maxRounds
      }),
      DeclarationSite.declaredAt(this)
    )
  },
  annotateMerge(this: AnyWithProps, context: Context.Context<any>) {
    return DeclarationSite.annotate(
      makeProto({
        _tag: this._tag,
        description: this.description,
        payloadSchema: this.payloadSchema,
        successSchema: this.successSchema,
        errorSchema: this.errorSchema,
        annotations: Context.merge(this.annotations, context),
        body: this.body,
        idempotencyKey: this.idempotencyKey,
        suspendedRetryPolicy: this.suspendedRetryPolicy,
        maxRounds: this.maxRounds
      }),
      DeclarationSite.declaredAt(this)
    )
  },
  call(this: AnyWithProps, payload: unknown) {
    return Node.flowCall(this, this._tag, "inline", payload)
  },
  child(this: AnyWithProps, payload: unknown) {
    return Node.flowCall(this, this._tag, "boundary", payload)
  },
  to(this: AnyWithProps, payload: unknown): Node.Node<To<unknown>> {
    return Node.flowCall(this, this._tag, "handoff", payload)
  },
  execute<const Discard extends boolean = false>(
    this: AnyWithProps,
    fields: any,
    opts?: {
      readonly discard?: Discard
      readonly executionId?: string | undefined
    } | undefined
  ) {
    // Caller input that fails the payload schema is data, not programmer
    // wiring, so it FAILS with the schema's typed `SchemaError` — carrying
    // the offending field path — instead of dying with the raw constructor
    // throw `payloadSchema.make` would produce.
    return this.payloadSchema.makeEffect(fields).pipe(
      Effect.mapError((issue) => new Schema.SchemaError(issue)),
      Effect.flatMap((payload) =>
        Effect.flatMap(
          resolveExecutionId(this, payload, opts?.executionId),
          (executionId) =>
            Effect.flatMap(FlowRuntime, (engine) =>
              Effect.andThen(
                Effect.annotateCurrentSpan({ executionId }),
                engine.execute(this as any, {
                  executionId,
                  payload,
                  discard: opts?.discard,
                  suspendedRetryPolicy: this.suspendedRetryPolicy
                })
              ))
        )
      )
    ).pipe(
      Effect.withSpan(
        `${this._tag}.execute`,
        {},
        { captureStackTrace: false }
      )
    ) as any
  },
  start(this: AnyWithProps, payload: unknown) {
    return Effect.flatMap(
      Crypto.Crypto,
      (crypto) =>
        Effect.flatMap(
          Effect.orDie(crypto.randomUUIDv4),
          (executionId) => this.execute(payload, { executionId, discard: true })
        )
    )
  },
  ensure(this: AnyWithProps, payload: unknown, options: { readonly key: string }) {
    return Schema.decodeUnknownEffect(Schema.String)(options.key).pipe(
      Effect.flatMap((key) => Effect.orDie(Schema.decodeUnknownEffect(Sha256)(JSON.stringify([this._tag, key])))),
      Effect.flatMap((executionId) => this.execute(payload, { executionId, discard: true }))
    )
  },
  poll(this: Flow<string, AnyStructSchema, Schema.Top, Schema.Top, any>, executionId: string) {
    return Effect.flatMap(FlowRuntime, (engine) => engine.poll(this, executionId)).pipe(
      Effect.withSpan(`${this._tag}.poll`, { attributes: { executionId } }, { captureStackTrace: false })
    )
  },
  interrupt(this: AnyWithProps, executionId: string) {
    return Effect.flatMap(FlowRuntime, (engine) => engine.interrupt(this, executionId)).pipe(
      Effect.withSpan(`${this._tag}.interrupt`, { attributes: { executionId } }, { captureStackTrace: false })
    )
  },
  resume(this: Flow<string, AnyStructSchema, Schema.Top, Schema.Top, any>, executionId: string) {
    return Effect.flatMap(FlowRuntime, (engine) => engine.resume(this, executionId)).pipe(
      Effect.withSpan(`${this._tag}.resume`, { attributes: { executionId } }, { captureStackTrace: false })
    )
  },
  executionId(this: AnyWithProps, payload: any) {
    return Effect.flatMap(
      // The channel stays never: precomputing callers must validate first, and an invalid payload dies here.
      Effect.orDie(this.payloadSchema.makeEffect(payload)),
      (payload) => makeExecutionIdFromPayload(this, payload)
    )
  },
  withRollback: ((...args: ReadonlyArray<any>) => (withRollback as any)(...args))
}

const makeProto = <
  const Tag extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
>(options: {
  readonly _tag: Tag
  readonly description?: string | undefined
  readonly payloadSchema: Payload
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly annotations: Context.Context<never>
  readonly body: (payload: Payload["Type"]) => Node.Node<BodySuccess<Success["Type"]>, Error["Type"], Requires>
  readonly idempotencyKey?: ((payload: Payload["Type"]) => string) | undefined
  readonly suspendedRetryPolicy?: RetryPolicy.RetryPolicy | undefined
  readonly maxRounds?: number | undefined
}): Flow<Tag, Payload, Success, Error, Requires> => {
  function Flow() {}
  Object.setPrototypeOf(Flow, Proto)
  Object.assign(Flow, options)
  return Flow as any
}

/**
 * The declaration data every flow takes beside its body.
 *
 * @private
 */
interface MakeOptions<
  Payload extends Schema.Struct.Fields | AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top
> {
  readonly payload: Payload
  /**
   * Native declaration whose source location this reconstructed flow retains.
   * A source with no recorded location preserves that absence. This affects
   * diagnostics only, never identity; the new flow keeps its own body and calls.
   */
  readonly declaredFrom?: object | undefined
  /**
   * One sentence saying what this flow does, read by a catalog that lists it.
   */
  readonly description?: string | undefined
  /**
   * The capability ceiling this flow's body runs under, as string literals.
   *
   * It is the same ceiling {@link Annotations.Capabilities} carries, and
   * declaring it here is what makes it READABLE without importing the module:
   * a catalog projects a discovered flow's authority from the declaration, and
   * an annotation built at run time is invisible to that projection.
   */
  readonly capabilities?: ReadonlyArray<string> | undefined
  /**
   * The effect envelope this flow's body runs under, as a literal.
   *
   * It is the same declaration {@link Annotations.EffectEnvelope} carries, and
   * declaring it here is what makes it READABLE without importing the module,
   * exactly as `capabilities` is: a catalog projects a discovered flow's
   * authority from the source text of this literal, and an annotation built at
   * run time is invisible to that projection.
   *
   * {@link module:Graph.build} refuses a composition beneath this flow that
   * reads or writes outside the envelope, loosens `hermetic` to `expected`, or
   * raises the tier. `reads` and `writes` are normalized to sorted,
   * duplicate-free arrays, so two spellings of one envelope are one envelope.
   */
  readonly effects?: Effects.MakeOptions | undefined
  /**
   * Whether a catalog may offer this flow to a model, as a literal. Defaults
   * to `true`.
   *
   * It is the same statement {@link Annotations.ModelInvocable} carries, and
   * declaring it here is what makes it READABLE without importing the module,
   * exactly as `capabilities` and `effects` are: a registry projects a
   * discovered flow's visibility from the source text of this literal onto the
   * descriptor it lists, and an annotation built at run time is invisible to
   * that projection.
   *
   * Declare `false` when the actions this flow's body calls are implemented by
   * one host only. The file is discoverable wherever it sits, so a catalog
   * elsewhere would otherwise teach an agent a call with no implementation to
   * reach.
   */
  readonly modelInvocable?: boolean | undefined
  readonly idempotencyKey?:
    | ((
      payload: Payload extends Schema.Struct.Fields ? Schema.Struct.Type<Payload>
        : Payload["Type"]
    ) => string)
    | undefined
  readonly success?: Success
  readonly error?: Error
  readonly suspendedRetryPolicy?: RetryPolicy.RetryPolicy | undefined
  /**
   * The round budget a trampoline lineage started from this flow runs under.
   */
  readonly maxRounds?: number | undefined
  readonly annotations?: Context.Context<never>
}

/**
 * The pure plan-time body, typed with the decoded payload.
 *
 * @private
 */
type Body<
  Payload extends Schema.Struct.Fields | AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
> = (
  payload: Payload extends Schema.Struct.Fields ? Schema.Struct.Type<Payload> : Payload["Type"]
) => Node.Node<BodySuccess<Success["Type"]>, Error["Type"], Requires>

/**
 * The payload schema a declaration's `payload` field stands for.
 *
 * @private
 */
type PayloadSchemaOf<Payload extends Schema.Struct.Fields | AnyStructSchema> = Payload extends Schema.Struct.Fields
  ? Schema.Struct<Payload>
  : Payload

/**
 * Whether a value is a flow this package made.
 *
 * The check is the runtime type id, not the shape: a host that loads a module
 * and finds a default export has to decide whether it holds a flow before it
 * reads anything off it, and a structural guess would accept a look-alike from
 * another flow model.
 *
 * @category predicates
 * @since 0.1.0
 */
export const isFlow = (value: unknown): value is Any => Predicate.hasProperty(value, TypeId)

/**
 * Creates a durable flow definition with schemas, annotations, a required pure
 * body, and either caller-selected execution IDs or opt-in deterministic IDs
 * derived from the flow tag and idempotency key.
 *
 * The `body` is the flow's one behavior, evaluated at plan time only. A flow
 * with nothing to plan is a category error under
 * `docs/concepts/flows-and-actions.md` — that work is an Action,
 * whose implementation attaches separately as a Layer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <
  const Tag extends string,
  Payload extends Schema.Struct.Fields | AnyStructSchema,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never,
  Requires = never
>(
  tag: Tag,
  options: MakeOptions<Payload, Success, Error> & { readonly body: Body<Payload, Success, Error, Requires> }
): Flow<Tag, PayloadSchemaOf<Payload>, Success, Error, Requires> => {
  // Invalid static configuration is a programmer error thrown at construction,
  // the same contract as effect's own `ExecutionPlan.make` (which throws on
  // `attempts <= 0`); `RangeError` matches effect's range-violation throws.
  if (
    options.maxRounds !== undefined &&
    (!Number.isSafeInteger(options.maxRounds) || options.maxRounds < 1)
  ) {
    throw new RangeError(`Flow.make: "${tag}" maxRounds must be a positive safe integer`)
  }
  // Captured here, where the stack still names the author's file, and carried
  // as a non-enumerable property so no digest can see it
  // (`internal/DeclarationSite.ts`).
  const site = options.declaredFrom === undefined
    ? DeclarationSite.capture()
    : DeclarationSite.declaredAt(options.declaredFrom)
  return DeclarationSite.annotate(
    makeProto<Tag, PayloadSchemaOf<Payload>, Success, Error, Requires>({
      _tag: tag,
      description: options.description,
      payloadSchema: (Schema.isSchema(options.payload)
        ? options.payload
        : Schema.Struct(options.payload as any)) as PayloadSchemaOf<Payload>,
      successSchema: options.success ?? (Schema.Void as any),
      errorSchema: options.error ?? (Schema.Never as any),
      annotations: lowerDeclarations(options),
      body: options.body as (
        payload: PayloadSchemaOf<Payload>["Type"]
      ) => Node.Node<BodySuccess<Success["Type"]>, Error["Type"], Requires>,
      idempotencyKey: options.idempotencyKey as any,
      suspendedRetryPolicy: options.suspendedRetryPolicy,
      maxRounds: options.maxRounds
    }),
    site
  )
}
