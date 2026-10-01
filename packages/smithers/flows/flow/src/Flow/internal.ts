/**
 * Private flow construction shared by declarations and action registration.
 *
 * @since 1.0.0
 * @private
 */

import { Sha256 } from "@smthrs/crypto"
import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ExecutionIdentityConflict } from "../FlowRuntime/ExecutionIdentityConflict.ts"
import { FlowRuntime } from "../FlowRuntime/FlowRuntime.ts"
import * as DeclarationSite from "../internal/DeclarationSite.ts"
import type * as RetryPolicy from "../RetryPolicy.ts"
import { CurrentExecutionIds } from "./ExecutionIds.ts"
import type { Any, AnyStructSchema, AnyWithProps, BodySuccess, DeclarationMetadata, Flow } from "./Flow.ts"
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
        model: this.model,
        effort: this.effort,
        system: this.system,
        chat: this.chat,
        flows: this.flows,
        prompt: this.prompt,
        action: this.action,
        payloadSchema: this.payloadSchema,
        successSchema: this.successSchema,
        errorSchema: this.errorSchema,
        annotations: Context.add(this.annotations, tag, value),
        body: this.body,
        idempotencyKey: this.idempotencyKey,
        suspendedRetryPolicy: this.suspendedRetryPolicy,
        maxRounds: this.maxRounds,
        deadline: this.deadline
      }),
      DeclarationSite.declaredAt(this)
    )
  },
  annotateMerge(this: AnyWithProps, context: Context.Context<any>) {
    return DeclarationSite.annotate(
      makeProto({
        _tag: this._tag,
        description: this.description,
        model: this.model,
        effort: this.effort,
        system: this.system,
        chat: this.chat,
        flows: this.flows,
        prompt: this.prompt,
        action: this.action,
        payloadSchema: this.payloadSchema,
        successSchema: this.successSchema,
        errorSchema: this.errorSchema,
        annotations: Context.merge(this.annotations, context),
        body: this.body,
        idempotencyKey: this.idempotencyKey,
        suspendedRetryPolicy: this.suspendedRetryPolicy,
        maxRounds: this.maxRounds,
        deadline: this.deadline
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
                }).pipe(Effect.catchCause((cause) => {
                  const reason = cause.reasons.length === 1 ? cause.reasons.find(Cause.isDieReason) : undefined
                  return reason?.defect instanceof ExecutionIdentityConflict
                    ? Effect.fail(reason.defect)
                    : Effect.failCause(cause)
                }))
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

/**
 * Builds the private prototype from normalized declaration data.
 *
 * @since 1.0.0
 * @private
 */
export const makeProto = <
  const Tag extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
>(
  options: DeclarationMetadata & {
    readonly _tag: Tag
    readonly description?: string | undefined
    readonly payloadSchema: Payload
    readonly successSchema: Success
    readonly errorSchema: Error
    readonly annotations: Context.Context<never>
    readonly body: (payload: Payload["Type"]) => Node.Node<BodySuccess<Success["Type"]>, Error["Type"], Requires>
    readonly prompt?: ((payload: Payload["Type"]) => string) | undefined
    readonly action?: Any["action"] | undefined
    readonly idempotencyKey?: ((payload: Payload["Type"]) => string) | undefined
    readonly suspendedRetryPolicy?: RetryPolicy.RetryPolicy | undefined
    readonly maxRounds?: number | undefined
    readonly deadline?: Duration.Duration | undefined
  }
): Flow<Tag, Payload, Success, Error, Requires> => {
  function Flow() {}
  Object.setPrototypeOf(Flow, Proto)
  Object.assign(Flow, options)
  return Flow as any
}
