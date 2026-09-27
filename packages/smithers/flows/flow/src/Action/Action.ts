// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Defines the schemas and interfaces of a durable action.
 *
 * @since 0.1.0
 */

import * as Effects from "@smthrs/plan/Effects"
import type * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import type * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type { Scope } from "effect/Scope"
import type { AnyStructSchema } from "../Flow/Flow.ts"
import type { FlowInstance, FlowRuntime } from "../FlowRuntime/index.ts"
import type * as RetryPolicy from "../RetryPolicy.ts"
import type { FileBoundary } from "./FileBoundary.ts"
import type { Implementation } from "./Implementations.ts"
import type { TypeId } from "./TypeId.ts"

/**
 * The durability and retry semantics of an action.
 *
 * The schema is `@smthrs/plan`'s `Effects.Tier`: an action's durability, a
 * declared envelope's ceiling and `KeyMaterial.kind` are the same three words,
 * and they are declared once.
 *
 * @category models
 * @since 0.1.0
 */
export const Tier = Effects.Tier

/**
 * The durability and retry semantics of an action.
 *
 * @category models
 * @since 0.1.0
 */
export type Tier = Effects.Tier

/**
 * Schema for caller-declared sealed action identity.
 *
 * @category models
 * @since 0.1.0
 */
export const IdempotencyKey = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.Json)
])

/**
 * Caller-declared sealed action identity.
 *
 * A string is namespaced by the action declaration. A JSON object is
 * caller-owned and remains stable across action renames. Runtime
 * environment and filesystem facts are always added by the engine. An explicit
 * implementation version is also separate engine key material; a caller-owned
 * object cannot mask it with a field of the same name.
 *
 * @category models
 * @since 0.1.0
 */
export type IdempotencyKey = typeof IdempotencyKey.Type

/**
 * Recursively permits planned references wherever a declared action payload
 * accepts a concrete value.
 *
 * @category models
 * @since 0.1.0
 */
export type PlannedPayload<T> =
  | Planned.Planned<T>
  | ([T] extends [ReadonlyArray<infer Value>] ? ReadonlyArray<PlannedPayload<Value>>
    : [T] extends [object] ? { readonly [Key in keyof T]: PlannedPayload<T[Key]> }
    : T)

/**
 * The requirement one declared action mints for itself, identified by its
 * tag.
 *
 * A declaration is data that travels everywhere and carries no code, so a body
 * that calls it names an implementation it does not hold. This type is that
 * "does not hold", stated to the compiler: `Charge.call(...)` produces a node
 * requiring `Requirement<"payments/Charge">`, `Charge.toLayer(...)` produces a
 * layer providing it, and `Flow.execute` is where the two have to meet. It is
 * phantom — nothing reads it, and nothing about planning, keying, or replay
 * changes with it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Requirement<Tag extends string> {
  readonly _: unique symbol
  readonly _tag: Tag
}

/**
 * A named action declaration whose implementation is supplied separately
 * through a layer and whose calls only add nodes to a plan.
 *
 * `Requires` is what `.call()` puts in the requirement channel of the node it
 * records. It is this action's own {@link Requirement} for an ordinary
 * declaration, and `never` for a system declaration the engine itself
 * implements ({@link module:make.makeSystem}).
 *
 * @category models
 * @since 0.1.0
 */
export interface Declared<
  Tag extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires = Requirement<Tag>
> {
  readonly [TypeId]: typeof TypeId
  readonly name: Tag
  /**
   * Semantic implementation identity. Changing it requires a newly planned
   * execution; it is not an in-place upgrade of a persisted run. Canonical
   * composition requires it for sealed actions with an idempotency key.
   * Invocation-scoped actions may omit it; low-level keyed legacy callers
   * retain their old handler-reuse contract when it is absent.
   */
  readonly implementationVersion: string | undefined
  readonly payloadSchema: Payload
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly tier: Tier
  readonly idempotencyKey: IdempotencyKey | ((payload: Payload["Type"]) => IdempotencyKey) | undefined
  /** Allows multiple legitimate sealed results to race under one cache key. */
  readonly nondeterministic: true | undefined
  /** Durable retry policy applied to every implementation invocation. */
  readonly retryPolicy: RetryPolicy.RetryPolicy | undefined
  /** Filesystem declaration, optionally derived from the decoded payload. */
  readonly fileBoundary: FileBoundary | ((payload: Payload["Type"]) => FileBoundary) | undefined
  readonly annotations: Context.Context<never>
  /**
   * The context key this declaration's implementation is provided under, and
   * the identity behind {@link Requirement}.
   *
   * `toLayer` provides it; a composition that would rather hand the runtime an
   * implementation directly can provide it itself with `Layer.succeed`. Its
   * string key is derived from the action tag, so two declarations of one tag
   * name one slot.
   */
  readonly requirement: Context.Service<Requirement<Tag>, Implementation>
  annotate<I, S>(key: Context.Key<I, S>, value: S): Declared<Tag, Payload, Success, Error, Requires>
  annotateMerge<I>(annotations: Context.Context<I>): Declared<Tag, Payload, Success, Error, Requires>
  readonly call: (
    payload: PlannedPayload<Payload["~type.make.in"]>
  ) => Node.Node<Success["Type"], Error["Type"], Requires>
  /**
   * Attaches the implementation and yields the layer that provides this
   * declaration's {@link Requirement}. A versioned declaration requires the
   * same `implementationVersion` here; a mismatch throws
   * `ImplementationVersionMismatch` before registration. The version must cover
   * handler semantics and semantic service/configuration changes, not merely a
   * package publication label. Source text is never inferred as that identity.
   *
   * Let inference name the returned layer's requirements. The requirement
   * channel is what a composition trusts: a layer type that under-declares it
   * still typechecks at `Effect.provide` and dies at runtime as a missing
   * service. A concrete hand annotation cannot lie — dropping a service from
   * it is a compile error — but a GENERIC one can: when the annotated
   * requirement union keeps a deferred member such as
   * `Output["DecodingServices"]` (constrained only as `unknown` through
   * `Schema.Top`), TypeScript lets that member absorb every concrete service
   * the annotation dropped, and the drop compiles. A wrapper that must
   * annotate — a public interface naming its layer's type, say — therefore
   * pins the set at a concrete instantiation, where the check works again:
   *
   * ```ts
   * // Wrapped.layer is the wrapper's hand-annotated toLayer result, held
   * // here with every schema argument concrete.
   * type Needed = Layer.Services<typeof Wrapped.layer>
   * expectTypeOf<Meter extends Needed ? true : false>().toEqualTypeOf<true>()
   * ```
   */
  readonly toLayer: <R>(
    execute: (payload: Payload["Type"]) => Effect.Effect<Success["Type"], Error["Type"], R>,
    options?: {
      readonly override?: boolean
      /** Must exactly match the declaration, including absence on legacy declarations. */
      readonly implementationVersion?: string | undefined
    }
  ) => Layer.Layer<
    Requires,
    never,
    | FlowRuntime
    | Exclude<R, FlowRuntime | FlowInstance | Scope>
    | Payload["DecodingServices"]
    | Payload["EncodingServices"]
    | Success["DecodingServices"]
    | Success["EncodingServices"]
    | Error["DecodingServices"]
    | Error["EncodingServices"]
  >
}

/**
 * Durable flow action that behaves as an `Effect` and records its name,
 * result schemas, annotations, and encoded execution form for the flow
 * engine.
 *
 * @category models
 * @since 0.1.0
 */
export interface Action<
  Success extends Schema.Constraint = Schema.Void,
  Error extends Schema.Constraint = Schema.Never,
  R = never
> extends
  Effect.Effect<
    Success["Type"],
    Error["Type"],
    | Success["DecodingServices"]
    | Error["DecodingServices"]
    | R
    | Crypto.Crypto
    | FlowRuntime
    | FlowInstance
  >
{
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly implementationVersion?: string | undefined
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly exitSchema: Schema.Exit<Success, Error, Schema.Defect>
  readonly exitSchemaPartial: Schema.Exit<Success, Error, Schema.Unknown>
  readonly annotations: Context.Context<never>
  readonly tier: Tier
  readonly idempotencyKey: IdempotencyKey | undefined
  /** Allows multiple legitimate sealed results to race under one cache key. */
  readonly nondeterministic: true | undefined
  readonly metadata: unknown
  /** Typed filesystem boundary used by the durable engine. */
  readonly fileBoundary: FileBoundary | undefined
  readonly retryPolicy: RetryPolicy.RetryPolicy | undefined
  annotate<I, S>(
    key: Context.Key<I, S>,
    value: S
  ): Action<Success, Error, R>
  annotateMerge<I>(
    annotations: Context.Context<I>
  ): Action<Success, Error, R>
  readonly execute: Effect.Effect<
    Success["Type"],
    Error["Type"],
    | Success["DecodingServices"]
    | Success["EncodingServices"]
    | Error["DecodingServices"]
    | Error["EncodingServices"]
    | R
    | Crypto.Crypto
    | Scope
    | FlowRuntime
    | FlowInstance
  >
  readonly executeEncoded: Effect.Effect<
    unknown,
    unknown,
    | Success["DecodingServices"]
    | Success["EncodingServices"]
    | Error["DecodingServices"]
    | Error["EncodingServices"]
    | R
    | Crypto.Crypto
    | Scope
    | FlowRuntime
    | FlowInstance
  >
}

/**
 * Type-erased action shape for APIs that only need the action identity,
 * name, annotations, and encoded execution.
 *
 * @category models
 * @since 0.1.0
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly implementationVersion?: string | undefined
  readonly executeEncoded: Effect.Effect<any, any, any>
  readonly annotations: Context.Context<never>
  readonly tier: Tier
  readonly idempotencyKey: IdempotencyKey | undefined
  readonly nondeterministic: true | undefined
  readonly metadata: unknown
  /** Typed filesystem boundary used by the durable engine. */
  readonly fileBoundary: FileBoundary | undefined
  readonly retryPolicy: RetryPolicy.RetryPolicy | undefined
}

/**
 * Type-erased action shape that also exposes success and error schemas for
 * derived flow APIs.
 *
 * @category models
 * @since 0.1.0
 */
export interface AnyWithProps {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly implementationVersion?: string | undefined
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly executeEncoded: Effect.Effect<any, any, any>
  readonly tier: Tier
  readonly idempotencyKey: IdempotencyKey | undefined
  readonly nondeterministic: true | undefined
  readonly metadata: unknown
  /** Typed filesystem boundary used by the durable engine. */
  readonly fileBoundary: FileBoundary | undefined
  readonly retryPolicy: RetryPolicy.RetryPolicy | undefined
}
