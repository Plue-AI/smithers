// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Defines typed durable flow declarations.
 *
 * A `Flow` has a stable tag, schemas for payload, success, and failure, a
 * REQUIRED pure `body`, and an optional idempotency key used to derive
 * execution ids when the caller does not provide one. Flow definitions can be
 * executed, discarded, polled, interrupted, and resumed.
 *
 * The two nouns of `docs/concepts/flows-and-actions.md` divide the
 * surface here: an Action carries an implementation, attached separately as a
 * Layer; a Flow carries a body, and never opaque executable code. There is
 * therefore no handler to attach to a flow, and no `toLayer` on one to attach
 * it with.
 *
 * @since 0.1.0
 */

import type * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import type * as Cause from "effect/Cause"
import type * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type { PlannedPayload } from "../Action/Action.ts"
import type { CancelRequestFailed } from "../FlowRuntime/CancelRequestFailed.ts"
import type { FlowCycleDetected } from "../FlowRuntime/FlowCycleDetected.ts"
import type { FlowExecutionNotFound } from "../FlowRuntime/FlowExecutionNotFound.ts"
import type { FlowInstance, FlowRuntime } from "../FlowRuntime/index.ts"
import type * as RetryPolicy from "../RetryPolicy.ts"
import type { Outcome, To } from "./Outcome.ts"
import type { Result } from "./Result.ts"
import type { TypeId } from "./TypeId.ts"

/**
 * Values with which a flow body may settle one round.
 *
 * A plain decoded success completes the flow. A planned success is a symbolic
 * reference the graph resolves before settlement. An outcome either completes
 * explicitly, hands off to another round, or parks durably.
 *
 * @category models
 * @since 0.1.0
 */
export type BodySuccess<A> = A | Planned.Planned<A> | Outcome<A | Planned.Planned<A>, unknown>

/**
 * Durable flow definition with typed payload, success, and error schemas
 * plus operations for execution, polling, interruption, resumption, and
 * registration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Flow<
  Tag extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires = never
> {
  new(_: never): {}

  readonly [TypeId]: typeof TypeId
  readonly _tag: Tag
  /**
   * One sentence saying what this flow does, for a catalog that lists it.
   *
   * It is a plain literal rather than an annotation because a discovered
   * `flows/<name>/flow.ts` is read WITHOUT being imported: `@smthrs/registry`
   * tokenizes the declaration and takes the description from it, so a flow that
   * states one only in an annotation is listed with nothing to read.
   */
  readonly description?: string | undefined
  readonly payloadSchema: Payload
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly annotations: Context.Context<never>
  /**
   * The pure plan-time body that IS this flow's behavior.
   *
   * The payload is decoded real data and the returned node only describes
   * topology. It is a FIELD rather than an injectable layer because there is
   * exactly one of it, it is pure, and its digest enters the flow's content
   * identity, so a flow cannot plan one way under one wiring and another way
   * under another. Purity includes closure capture: the body must not read
   * mutable module state, clocks, random values, services, or environment
   * values captured outside `payload`; source-digest identity cannot observe
   * those aliases changing. Work that genuinely wants opaque code is an
   * Action.
   *
   * `Requires` is read off this node. A body that names an action names an
   * implementation it does not carry, and that obligation travels with the flow
   * until something executes it.
   */
  readonly body: (payload: Payload["Type"]) => Node.Node<BodySuccess<Success["Type"]>, Error["Type"], Requires>
  /**
   * Declares the stable key used when a caller supplies no execution id.
   *
   * The flow tag and returned key are JSON-tuple framed, then hashed as their
   * exact UTF-8 strings. No Unicode normalization is applied, and this preimage
   * encoding freezes at rc.0.
   */
  readonly idempotencyKey?: ((payload: Payload["Type"]) => string) | undefined
  /**
   * How long ONE CALLER keeps polling a suspended execution of this flow.
   *
   * It is a per-caller wall-clock budget, not a bound on the run. `execute`
   * re-drives a parked execution on this schedule and gives up when the
   * schedule is spent; the execution stays parked, and the next caller — a
   * second process, a sweep, a resume — starts a budget of its own. Nothing
   * about it is durable, and a spent budget cancels nothing.
   *
   * What bounds work durably is an action's own `RetryPolicy`: the engine
   * restores `maxAttempts` from the persisted attempt sequence and the
   * `expirationMs` origin from the first attempt's start time, so those
   * survive park, resume, and process death.
   */
  readonly suspendedRetryPolicy?: RetryPolicy.RetryPolicy | undefined
  /**
   * How many rounds one trampoline lineage started from this flow may open.
   *
   * The bound is a BUDGET, not loop detection: identical consecutive rounds
   * are legal, so `docs/concepts/trampoline-rounds.md` stops a runaway
   * lineage by counting rounds instead of comparing them. Absent means
   * unbounded, which is the right default for a lineage whose exit condition
   * is its own branch. Exceeding it terminates the lineage with a
   * {@link module:MaxRoundsExceeded.MaxRoundsExceeded} defect recorded in the
   * execution result; it is not a typed `execute` failure.
   */
  readonly maxRounds?: number | undefined
  /**
   * How long one execution of this flow may take, counted from its first
   * start.
   *
   * The start is journaled, so the bound survives park, resume and process
   * death: a restarted engine honors the original deadline. On expiry the
   * execution settles with a {@link module:DeadlineExceeded.DeadlineExceeded}
   * defect whether it was running or parked, and its attached children are
   * cancelled with it. Absent means unbounded.
   */
  readonly deadline?: Duration.Duration | undefined

  /**
   * Describes an inline call to this flow without executing it.
   *
   * The callee's steps join the caller's plan, so the callee's requirements are
   * the caller's: `Requires` propagates.
   */
  readonly call: (
    payload: PlannedPayload<Payload["~type.make.in"]>
  ) => Node.Node<Success["Type"], Error["Type"], Requires>

  /**
   * Describes an explicit child boundary: ONE node in the caller's plan, and a
   * real child execution when that node is driven.
   *
   * `.call()` splices this flow's body into the caller's plan, so every inner
   * step is visible and individually keyed. `.child()` is the other choice
   * `docs/concepts/flows-and-actions.md` gives: the callee keeps its
   * own execution, journal lineage, retry policy, and placement, and the caller
   * sees one leaf. It is also the way out of the two build refusals inline
   * expansion raises — a recursive `.call()` and a placement the caller cannot
   * satisfy.
   *
   * It is an execution boundary for requirements too, so `Requires` is DROPPED
   * rather than propagated: the child runs under its own driver, which provides
   * its own context, and the caller's plan holds one leaf naming it.
   */
  readonly child: (
    payload: PlannedPayload<Payload["~type.make.in"]>
  ) => Node.Node<Success["Type"], Error["Type"]>

  /**
   * Describes a serializable invocation for the next trampoline round.
   *
   * A handoff ends this execution and names the next one, so `Requires` is
   * DROPPED here as well. That is also what keeps a self-loop's type finite: a
   * body that hands off to its own flow would otherwise have to name its own
   * requirements inside them.
   */
  readonly to: (
    payload: PlannedPayload<Payload["~type.make.in"]>
  ) => Node.Node<To<Payload["Type"]>>

  /**
   * Add an annotation to the flow.
   */
  annotate<I, S>(
    key: Context.Key<I, S>,
    value: S
  ): Flow<Tag, Payload, Success, Error, Requires>

  /**
   * Merge multiple annotations into the flow.
   */
  annotateMerge<I>(
    annotations: Context.Context<I>
  ): Flow<Tag, Payload, Success, Error, Requires>

  /**
   * Execute the flow with the given payload.
   *
   * This is where `Requires` is collected. Planning is requirement-free by
   * design, so a body that names an action nobody implemented is a legal plan
   * right up to here; asking to RUN it is what makes the missing layer a
   * compile error rather than a run that dies partway through.
   *
   * Identity comes from the first source that has one: the `executionId`
   * option, the flow's declared `idempotencyKey`, then the ambient
   * `CurrentExecutionIds` source, whose default mints a fresh UUID. Equal
   * unkeyed payloads start independent executions. Retain the execution id or
   * opt into a derived source to reattach after a crash.
   *
   * A payload that fails the flow's own schema is a typed
   * `Schema.SchemaError` failure carrying the offending field path — caller
   * input is data, not programmer wiring, so it fails rather than dies.
   */
  readonly execute: <const Discard extends boolean = false>(
    payload: Payload["~type.make.in"],
    options?: {
      readonly discard?: Discard
      readonly executionId?: string | undefined
    }
  ) => Effect.Effect<
    Discard extends true ? string : Success["Type"],
    Schema.SchemaError | FlowCycleDetected | (Discard extends true ? never : Error["Type"]),
    | FlowRuntime
    | Crypto.Crypto
    | Requires
    | Payload["EncodingServices"]
    | Success["DecodingServices"]
    | Error["DecodingServices"]
  >

  /**
   * Starts a fresh execution and returns its id. Equal payloads start independent
   * executions; declared and ambient idempotency policies are intentionally bypassed.
   * Observe the execution with `poll`, or await it using `execute` with this id.
   */
  readonly start: (payload: Payload["~type.make.in"]) => Effect.Effect<
    string,
    Schema.SchemaError | FlowCycleDetected,
    | FlowRuntime
    | Crypto.Crypto
    | Requires
    | Payload["EncodingServices"]
    | Success["DecodingServices"]
    | Error["DecodingServices"]
  >

  /**
   * Starts or joins the execution identified by this flow tag and an explicit
   * caller key, returning its id. Reusing a key is an explicit retry/reattachment
   * decision. Existing persisted key encodings remain unchanged.
   */
  readonly ensure: (
    payload: Payload["~type.make.in"],
    options: { readonly key: string }
  ) => ReturnType<Flow<Tag, Payload, Success, Error, Requires>["start"]>

  /**
   * Poll the current status of a flow execution.
   *
   * `Option.none` means the execution is known and has not settled;
   * {@link FlowExecutionNotFound} means the runtime has no record of the
   * execution id at all.
   */
  readonly poll: (
    executionId: string
  ) => Effect.Effect<
    Option.Option<Result<Success["Type"], Error["Type"]>>,
    FlowExecutionNotFound,
    FlowRuntime | Success["DecodingServices"] | Error["DecodingServices"]
  >

  /**
   * Requests cancellation of the execution.
   *
   * This is not a pause operation. The engine interrupts active work while
   * preserving its normal cleanup, compensation, and child-flow semantics.
   * Calling `resume` does not undo the cancellation request.
   *
   * A durable engine records the cancellation request before it interrupts
   * anything, and reports {@link CancelRequestFailed} when that record could
   * not be written — the execution is then still running, so the caller sees
   * the storage failure instead of a false success. An in-memory engine has
   * nothing to record and never raises it.
   */
  readonly interrupt: (
    executionId: string
  ) => Effect.Effect<void, CancelRequestFailed, FlowRuntime>

  /**
   * Re-drives an execution that returned `Suspended` so it can replay its
   * durable history and continue after its awaited condition becomes ready.
   *
   * This does not resume an execution cancelled by `interrupt`, and it is not
   * needed for an execution that is already running or complete.
   *
   * It does NOT collect `Requires`, even though it re-drives the body. The
   * runtime captures the context a flow was REGISTERED under and merges it
   * beneath whatever a run supplies, so the implementations that made the first
   * round possible are the ones a re-driven round reaches; a resumer holding an
   * execution id is not the party that has them. `execute` remains the one
   * place a plan's requirements are asked for.
   */
  readonly resume: (
    executionId: string
  ) => Effect.Effect<void, never, FlowRuntime>

  /**
   * For the given payload, compute the execution ID `execute` would run under
   * when the caller names none.
   *
   * That is the flow's `idempotencyKey` when it declares one, and the ambient
   * `CurrentExecutionIds` source otherwise. It dies with `ExecutionIdRequired`
   * when the opt-in `derived` source cannot canonicalize the payload. The default
   * source mints a fresh UUID on each call; pass the returned id explicitly to
   * `execute` to select that invocation.
   *
   * A payload this flow's own schema refuses also dies as a defect here. This
   * differs from `execute`, which fails with a typed `Schema.SchemaError` for
   * the same caller input. A caller precomputing an id should validate the
   * payload first.
   */
  readonly executionId: (
    payload: Payload["~type.make.in"]
  ) => Effect.Effect<string, never, Crypto.Crypto | Payload["EncodingServices"]>

  /**
   * Runs an effect and registers how to undo its successful result if the
   * current round later exits unsuccessfully.
   *
   * If the effect itself fails, no rollback is registered. If both the effect
   * and the round succeed, the rollback is discarded. Otherwise the rollback
   * receives the effect's successful value and the round's failure cause when
   * the round's scope closes. Suspension keeps that scope open.
   *
   * A handoff completes the round successfully and discards its `withRollback` registrations.
   * A later round's failure cannot invoke those rollbacks. The engine does not
   * provide lineage-scoped compensation.
   *
   * This applies only to effects run directly inside the flow execution. It
   * does not attach rollback behavior to nested actions.
   */
  readonly withRollback: {
    <A, R2>(
      rollback: (
        value: A,
        cause: Cause.Cause<Error["Type"]>
      ) => Effect.Effect<void, never, R2>
    ): <E, R>(
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<
      A,
      E,
      R | R2 | FlowInstance | Scope.Scope
    >
    <A, E, R, R2>(
      effect: Effect.Effect<A, E, R>,
      rollback: (
        value: A,
        cause: Cause.Cause<Error["Type"]>
      ) => Effect.Effect<void, never, R2>
    ): Effect.Effect<
      A,
      E,
      R | R2 | FlowInstance | Scope.Scope
    >
  }
}

/**
 * Schema constraint for flow payload schemas that expose struct fields.
 *
 * @category schemas
 * @since 0.1.0
 */
export interface AnyStructSchema extends Schema.Top {
  readonly fields: Schema.Struct.Fields
}

/**
 * Type-level marker for services associated with a specific flow
 * execution tag.
 *
 * @category models
 * @since 0.1.0
 */
export interface Execution<Tag extends string> {
  readonly _: unique symbol
  readonly _tag: Tag
}

/**
 * Type-erased flow shape for APIs that operate on flows without
 * preserving their specific payload, success, or error types.
 *
 * @category models
 * @since 0.1.0
 */
export interface Any {
  new(_: never): {}

  readonly [TypeId]: typeof TypeId
  readonly _tag: string
  readonly description?: string | undefined
  readonly executionId: (payload: any) => Effect.Effect<string, never, any>
  readonly payloadSchema: AnyStructSchema
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly annotations: Context.Context<never>
  readonly body: (payload: any) => Node.Node<unknown, unknown, any>
  readonly idempotencyKey?: ((payload: any) => string) | undefined
  readonly suspendedRetryPolicy?: RetryPolicy.RetryPolicy | undefined
  readonly maxRounds?: number | undefined
  readonly deadline?: Duration.Duration | undefined
}

/**
 * Type-erased flow shape that also exposes executable operations needed by
 * flow proxy and engine helpers.
 *
 * @category models
 * @since 0.1.0
 */
export interface AnyWithProps extends Any {
  readonly payloadSchema: AnyStructSchema
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly execute: (
    payload: any,
    options?: {
      readonly discard?: boolean
      readonly executionId?: string | undefined
    }
  ) => Effect.Effect<any, any, any>
  /**
   * Re-drives a durably suspended execution; it does not undo cancellation.
   */
  readonly resume: (
    executionId: string
  ) => Effect.Effect<void, never, FlowRuntime>
}

/**
 * Extracts the payload schema from a `Flow`.
 *
 * @category models
 * @since 0.1.0
 */
export type PayloadSchema<W> = W extends Flow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Requires
> ? _Payload
  : never

/**
 * Extracts the requirement channel of a `Flow`: the action implementations
 * its body names and does not carry.
 *
 * @category models
 * @since 0.1.0
 */
export type Requirements<W> = W extends Flow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Requires
> ? _Requires
  : never

/**
 * Computes the schema services required by clients that execute or poll
 * flows.
 *
 * @category models
 * @since 0.1.0
 */
export type RequirementsClient<Flows extends Any> = Flows extends Flow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Requires
> ?
    | _Payload["EncodingServices"]
    | _Success["DecodingServices"]
    | _Error["DecodingServices"]
  : never

/**
 * Computes the schema services required by handlers that decode flow
 * payloads and encode flow results.
 *
 * @category models
 * @since 0.1.0
 */
export type RequirementsHandler<Flows extends Any> = Flows extends Flow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Requires
> ?
    | _Payload["DecodingServices"]
    | _Payload["EncodingServices"]
    | _Success["DecodingServices"]
    | _Success["EncodingServices"]
    | _Error["DecodingServices"]
    | _Error["EncodingServices"]
  : never
