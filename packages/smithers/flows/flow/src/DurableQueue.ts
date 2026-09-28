// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Durable flow queues delegate work to persisted background workers and
 * resume the waiting flow with the worker result.
 *
 * A flow calls `process` to encode a payload, offer it to a named
 * `PersistedQueue`, attach a `DurableDeferred` token, and suspend. A worker
 * created with `makeWorker` or `worker` takes the item, runs the handler, and
 * records the handler's `Exit` through that token so the original flow can
 * continue with the typed success or error.
 *
 * @since 0.1.0
 */

import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Filter from "effect/Filter"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"
import * as PersistedQueue from "effect/unstable/persistence/PersistedQueue"
import * as Action from "./Action/index.ts"
import * as DurableDeferred from "./DurableDeferred.ts"
import { annotateWaiting, type FlowInstance, type FlowRuntime } from "./FlowRuntime/index.ts"

/**
 * Type-level identifier used to recognize `DurableQueue` values.
 *
 * @category type IDs
 * @since 0.1.0
 */
export type TypeId = "@smthrs/flow/DurableQueue"

/**
 * Runtime identifier attached to `DurableQueue` values.
 *
 * @category type IDs
 * @since 0.1.0
 */
export const TypeId: TypeId = "@smthrs/flow/DurableQueue"

/**
 * Durable flow queue definition containing a payload schema, idempotency
 * key, and deferred used to await worker results.
 *
 * @category models
 * @since 0.1.0
 */
export interface DurableQueue<
  Payload extends Schema.Top,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never
> {
  readonly [TypeId]: TypeId
  readonly name: string
  readonly payloadSchema: Payload
  readonly idempotencyKey: (payload: Payload["Type"]) => string
  readonly deferred: DurableDeferred.DurableDeferred<Success, Error>
}

/**
 * Creates a `DurableQueue` that waits for persisted items to finish processing
 * using a `DurableDeferred`.
 *
 * **Example** (Defining a durable queue with workers)
 *
 * ```ts
 * import { Action, DurableQueue, Flow, Interpreter } from "@smthrs/flow"
 * import { Effect, Layer, Schema } from "effect"
 *
 * // Define a DurableQueue that can be used to derive workers and offer items for
 * // processing.
 * const ApiQueue = DurableQueue.make({
 *   name: "ApiQueue",
 *   payload: {
 *     id: Schema.String
 *   },
 *   success: Schema.Void,
 *   error: Schema.Never,
 *   idempotencyKey(payload) {
 *     return payload.id
 *   }
 * })
 *
 * // Offering an item is work, so it is a declared Action: the declaration is
 * // pure data, and the implementation attaches separately.
 * const Offer = Action.make("MyFlow/offer", {
 *   payload: {
 *     id: Schema.String
 *   }
 * })
 *
 * const OfferLive = Offer.toLayer(
 *   Effect.fnUntraced(function*({ id }) {
 *     // Add an item to the DurableQueue defined above.
 *     //
 *     // When the worker has finished processing the item, the flow will
 *     // resume.
 *     //
 *     yield* DurableQueue.process(ApiQueue, { id })
 *
 *     yield* Effect.log("Flow succeeded!")
 *   })
 * )
 *
 * // The flow is the composite, and its body names the step it is made of.
 * const MyFlow = Flow.make("MyFlow", {
 *   payload: {
 *     id: Schema.String
 *   },
 *   idempotencyKey: ({ id }) => id,
 *   body: (payload) => Offer.call(payload)
 * })
 *
 * const MyFlowLayer = Layer.mergeAll(OfferLive, Interpreter.layer(MyFlow)).pipe(
 *   Layer.provideMerge(Action.layerImplementations)
 * )
 *
 * // Define a worker layer that can process items from the DurableQueue.
 * const ApiWorker = DurableQueue.worker(
 *   ApiQueue,
 *   Effect.fnUntraced(function*({ id }) {
 *     yield* Effect.log(`Worker processing API call with id: ${id}`)
 *   }),
 *   { concurrency: 5 } // Process up to 5 items concurrently
 * )
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <
  Payload extends Schema.Top | Schema.Struct.Fields,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never
>(options: {
  readonly name: string
  readonly payload: Payload
  readonly idempotencyKey: (
    payload: Payload extends Schema.Struct.Fields ? Schema.Struct.Type<Payload>
      : Payload["Type"]
  ) => string
  readonly success?: Success | undefined
  readonly error?: Error | undefined
}): DurableQueue<
  Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload,
  Success,
  Error
> => ({
  [TypeId]: TypeId,
  name: options.name,
  payloadSchema: Schema.isSchema(options.payload)
    ? options.payload
    : Schema.Struct(options.payload as any) as any,
  idempotencyKey: options.idempotencyKey as any,
  deferred: DurableDeferred.make(`DurableQueue/${options.name}`, {
    success: options.success,
    error: options.error
  })
})

const queueSchemas = new WeakMap<Schema.Top, Schema.Top>()

const getQueueSchema = <Payload extends Schema.Top>(
  payload: Payload
): Schema.Struct<{
  token: typeof DurableDeferred.Token
  payload: Payload
  traceId: typeof Schema.String
  spanId: typeof Schema.String
  sampled: typeof Schema.Boolean
}> => {
  let schema = queueSchemas.get(payload)
  if (!schema) {
    schema = Schema.Struct({
      token: DurableDeferred.Token,
      traceId: Schema.String,
      spanId: Schema.String,
      sampled: Schema.Boolean,
      payload
    })
    queueSchemas.set(payload, schema)
  }
  return schema as any
}

/**
 * Adds an item to the queue and waits for a worker to process it.
 *
 * `retrySchedule` controls retries when the persisted offer fails. The default
 * is unbounded, with exponential delays capped at one minute, so a transient
 * store outage does not lose the item. A caller-supplied schedule may exhaust;
 * its final offer failure becomes a defect to keep the public error channel
 * reserved for the worker's declared error.
 *
 * Payload construction also becomes a defect when `fields` does not satisfy
 * the queue's payload schema. The public error channel is the worker result,
 * not malformed caller input.
 *
 * @category processing
 * @since 0.1.0
 */
export const process: <
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top
>(
  self: DurableQueue<Payload, Success, Error>,
  payload: Payload["~type.make.in"],
  options?: {
    readonly retrySchedule?: Schedule.Schedule<any, PersistedQueue.PersistedQueueError> | undefined
  }
) => Effect.Effect<
  Success["Type"],
  Error["Type"],
  | FlowRuntime
  | FlowInstance
  | Crypto.Crypto
  | PersistedQueue.PersistedQueueFactory
  | Payload["EncodingServices"]
  | Payload["DecodingServices"]
  | Success["DecodingServices"]
  | Error["DecodingServices"]
> =
  // Untraced because queue offer is a worker hot path.
  Effect.fnUntraced(function*<
    Payload extends Schema.Top,
    Success extends Schema.Top,
    Error extends Schema.Top
  >(self: DurableQueue<Payload, Success, Error>, fields: Payload["~type.make.in"], options?: {
    readonly retrySchedule?: Schedule.Schedule<any, PersistedQueue.PersistedQueueError> | undefined
  }) {
    const payload = yield* self.payloadSchema.makeEffect(fields).pipe(
      Effect.mapError((issue) => new Schema.SchemaError(issue)),
      Effect.orDie
    )
    const queueName = `DurableQueue/${self.name}`
    const queue = yield* PersistedQueue.make({
      name: queueName,
      schema: getQueueSchema(self.payloadSchema)
    })
    const key = yield* Action.idempotencyKey(queueName, {
      parentScope: self.idempotencyKey(payload)
    })

    const deferred = DurableDeferred.make(`${self.deferred.name}/${key}`, {
      success: self.deferred.successSchema,
      error: self.deferred.errorSchema
    })
    const token = yield* DurableDeferred.token(deferred)

    yield* Effect.useSpan(`DurableQueue/${self.name}/process`, {
      attributes: { key }
    }, (span) =>
      queue.offer({
        token,
        payload,
        traceId: span.traceId,
        spanId: span.spanId,
        sampled: span.sampled
      } as any, { id: key }).pipe(
        Effect.tapCause(Effect.logWarning),
        Effect.catchTag("SchemaError", Effect.die),
        Effect.retry(options?.retrySchedule ?? defaultRetrySchedule),
        Effect.orDie,
        Effect.annotateLogs({
          package: "@smthrs/flow",
          module: "DurableQueue",
          fiber: "process",
          queueName: self.name
        })
      ))

    yield* annotateWaiting({ reason: "event", token })
    return yield* DurableDeferred.await(deferred)
  })

const maxDeferredNameExcerptChars = 128

/** Renders a bounded excerpt of a stored deferred name for a diagnostic. */
const deferredNameExcerpt = (name: string): string =>
  name.length <= maxDeferredNameExcerptChars
    ? name
    : `${name.slice(0, maxDeferredNameExcerptChars)} [${name.length - maxDeferredNameExcerptChars} characters dropped]`

const traceIdPattern = /^[0-9a-f]{32}$/
const spanIdPattern = /^[0-9a-f]{16}$/

/**
 * The offering span as the worker span's parent, when the stored ids have the
 * W3C trace-context shape every Effect and OpenTelemetry tracer writes. A
 * stored item is not trusted to splice arbitrary identifiers into a trace.
 */
const externalParent = (item: {
  readonly traceId: string
  readonly spanId: string
  readonly sampled: boolean
}): Tracer.ExternalSpan | undefined =>
  traceIdPattern.test(item.traceId) && spanIdPattern.test(item.spanId)
    ? Tracer.externalSpan({ traceId: item.traceId, spanId: item.spanId, sampled: item.sampled })
    : undefined

const defaultRetrySchedule = Schedule.min([
  Schedule.exponential(500, 1.5),
  Schedule.spaced("1 minute")
])

const makeWorkerEffect = Effect.fnUntraced(function*<
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R
>(
  self: DurableQueue<Payload, Success, Error>,
  f: (payload: Payload["Type"]) => Effect.Effect<Success["Type"], Error["Type"], R>,
  concurrency: number,
  maxAttempts: number
) {
  const queue = yield* PersistedQueue.make({
    name: `DurableQueue/${self.name}`,
    schema: getQueueSchema(self.payloadSchema),
    maxAttempts,
    // The worker owns the 500 ms retry pause below. Keep an upstream queue
    // default from introducing an additional backoff after an Effect upgrade.
    retrySchedule: Schedule.spaced(0)
  })

  const worker = Effect.suspend(() => {
    let completion:
      | { readonly token: DurableDeferred.Token; readonly id: string; readonly attempts: number }
      | undefined
    return queue.take((item_, metadata) => {
      const item = item_ as {
        readonly token: DurableDeferred.Token
        readonly payload: Payload["Type"]
        readonly traceId: string
        readonly spanId: string
        readonly sampled: boolean
      }
      return Effect.withSpan(
        Effect.gen(function*() {
          // Parse before running the handler. A malformed completion address
          // cannot strand a handler result that was already produced.
          const parsed = yield* DurableDeferred.TokenParsed.parse(item.token)
          // `process` offers each item under its key and addresses the
          // deferred `<queue deferred>/<key>`. Anything else in this queue
          // names a wait point the queue does not own (another queue's item,
          // a WaitFor gate, a human task), so completing it here would settle
          // a foreign wait under this queue's success schema.
          const expected = `${self.deferred.name}/${metadata.id}`
          if (parsed.deferredName !== expected) {
            return yield* new DurableDeferred.TokenInvalid({
              code: "deferred_mismatch",
              message: `The item "${metadata.id}" addresses the deferred "${
                deferredNameExcerpt(parsed.deferredName)
              }", not "${deferredNameExcerpt(expected)}".`
            })
          }
          const deferred = DurableDeferred.make(parsed.deferredName, {
            success: self.deferred.successSchema,
            error: self.deferred.errorSchema
          })
          let exit = yield* Effect.exit(f(item.payload))
          if (Exit.isFailure(exit)) {
            const [reasons, interrupts] = Arr.partition(
              exit.cause.reasons,
              Filter.fromPredicate(Cause.isInterruptReason)
            )
            // Match DurableDeferred.into: interruption alone is not a durable
            // outcome, and must leave the item available without an attempt.
            if (interrupts.length === exit.cause.reasons.length) {
              return yield* Effect.failCause(Cause.fromReasons<never>(interrupts))
            } else if (interrupts.length > 0) {
              exit = Exit.failCause(Cause.fromReasons(reasons))
            }
          }
          completion = { token: item.token, ...metadata }
          yield* DurableDeferred.done(deferred, {
            token: item.token,
            exit
          })
        }).pipe(
          Effect.catchTag("@smthrs/flow/DurableDeferred/TokenInvalid", (error) =>
            Effect.logError(
              `DurableQueue "${self.name}" could not complete an item because its token was invalid. ${error.message}`
            ))
        ),
        `DurableQueue/${self.name}/worker`,
        {
          captureStackTrace: false,
          parent: externalParent(item)
        }
      )
    }).pipe(
      Effect.tapCause((cause) => {
        if (!completion) return Effect.void
        return Effect.logError("DurableQueue failed to persist or acknowledge a handler result", cause).pipe(
          Effect.annotateLogs({
            token: completion.token,
            itemId: completion.id,
            attempt: completion.attempts,
            maxAttempts,
            exhausted: !Cause.hasInterrupts(cause) && completion.attempts >= maxAttempts
          })
        )
      })
    )
  }).pipe(
    // A persistently failing take would otherwise consume a core in a tight
    // loop while the queue store is unavailable.
    Effect.catchCause((cause) =>
      Effect.logWarning(cause).pipe(
        Effect.andThen(Effect.sleep(500))
      )
    ),
    Effect.forever,
    Effect.annotateLogs({
      package: "@smthrs/flow",
      module: "DurableQueue",
      fiber: "worker",
      queueName: self.name
    })
  )

  return yield* Effect.replicateEffect(worker, concurrency, { concurrency, discard: true }).pipe(
    Effect.andThen(Effect.never)
  )
})

/**
 * Create a worker effect that processes items from the durable queue.
 *
 * `concurrency` defaults to one and must be a positive safe integer. It is
 * checked before the persisted queue is opened. `maxAttempts` defaults to ten
 * and is passed to the persisted queue. Completion-write failures can rerun the
 * handler; side effects must be idempotent. Exhaustion leaves the flow waiting.
 *
 * @throws A `RangeError` when `concurrency` is not a positive safe integer.
 * @category worker
 * @since 0.1.0
 */
export const makeWorker: <
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R
>(
  self: DurableQueue<Payload, Success, Error>,
  f: (payload: Payload["Type"]) => Effect.Effect<Success["Type"], Error["Type"], R>,
  options?: {
    readonly concurrency?: number | undefined
    readonly maxAttempts?: number | undefined
  } | undefined
) => Effect.Effect<
  never,
  never,
  | FlowRuntime
  | PersistedQueue.PersistedQueueFactory
  | R
  | Payload["EncodingServices"]
  | Payload["DecodingServices"]
  | Success["EncodingServices"]
  | Error["EncodingServices"]
> = <
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R
>(
  self: DurableQueue<Payload, Success, Error>,
  f: (payload: Payload["Type"]) => Effect.Effect<Success["Type"], Error["Type"], R>,
  options?: {
    readonly concurrency?: number | undefined
    readonly maxAttempts?: number | undefined
  }
) => {
  const concurrency = options?.concurrency ?? 1
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError(
      `DurableQueue.makeWorker: concurrency must be a positive safe integer, and was ${concurrency}.`
    )
  }
  return makeWorkerEffect(self, f, concurrency, options?.maxAttempts ?? 10)
}

/**
 * Create a layer that runs workers for the durable queue.
 *
 * @category worker
 * @since 0.1.0
 */
export const worker: <
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R
>(
  self: DurableQueue<Payload, Success, Error>,
  f: (payload: Payload["Type"]) => Effect.Effect<Success["Type"], Error["Type"], R>,
  options?: {
    readonly concurrency?: number | undefined
    readonly maxAttempts?: number | undefined
  } | undefined
) => Layer.Layer<
  never,
  never,
  | FlowRuntime
  | PersistedQueue.PersistedQueueFactory
  | R
  | Payload["EncodingServices"]
  | Payload["DecodingServices"]
  | Success["EncodingServices"]
  | Error["EncodingServices"]
> = (self, f, options) => Layer.effectDiscard(Effect.forkScoped(makeWorker(self, f, options)))
