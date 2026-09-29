/**
 * Channel contracts and the in-memory channel coordinator.
 *
 * A channel verifies opaque transport data before it decodes or maps it. The
 * resulting request is then dispatched through the Control service; channels
 * do not acquire an execution path of their own.
 *
 * @since 0.1.0
 */

import * as Sha256 from "@smthrs/crypto/Sha256"
import { Clock, Context, Effect, Layer, Ref, type Schema, Semaphore } from "effect"
import { Control } from "./Control.ts"
import { type ControlError, InvalidInput, type Unauthorized, Unavailable } from "./ControlError.ts"
import { ControlRuntime } from "./ControlRuntime.ts"
import type { FlowId, IdempotencyKey, Receipt, RunId, RunSummary, SignalPayload } from "./ControlSchema.ts"
import { alreadyApplied } from "./internal/planning.ts"

/**
 * Opaque request data passed to a channel before decoding.
 *
 * @category models
 * @since 0.1.0
 */
export interface RawInbound {
  readonly body: Uint8Array
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly idempotencyKey: IdempotencyKey
}

/**
 * The channel mapping after a verified payload has been decoded.
 *
 * @category models
 * @since 0.1.0
 */
export type InboundResult =
  | { readonly _tag: "Start"; readonly flowId: FlowId; readonly input: unknown }
  | { readonly _tag: "Signal"; readonly runId: RunId; readonly signal: SignalPayload }

/**
 * A process-local per-channel delivery record. `messageId` identifies an existing
 * platform message, so a reconnect can update it instead of posting again.
 *
 * @category models
 * @since 0.1.0
 */
export interface Delivery {
  readonly cursor: string
  readonly messageId?: string | undefined
}

/**
 * A side-effect-free outbound projection. Network delivery belongs to the
 * transport adapter, which consumes this value after it is journaled.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeliveryProjection {
  readonly cursor: string
  readonly messageId?: string | undefined
  readonly operation: "post" | "edit" | "noop"
  readonly message: unknown
}

/**
 * A bidirectional platform adapter.
 *
 * `verify` must only inspect opaque bytes and headers. It always precedes
 * `decode`, preventing untrusted public requests from reaching planning.
 *
 * @category services
 * @since 0.1.0
 */
export interface Channel<A = unknown> {
  readonly name: string
  readonly schema: Schema.Schema<A>
  /**
   * Non-secret HTTP header names whose values change the decoded command.
   * Names are matched case-insensitively and folded into durable idempotency;
   * signature, authorization, and credential headers must not be declared.
   */
  readonly fingerprintHeaders?: ReadonlyArray<string> | undefined
  readonly verify: (raw: RawInbound) => Effect.Effect<void, Unauthorized>
  /** Deterministic, side-effect-free decoding; retries may evaluate it again. */
  readonly decode: (raw: RawInbound) => Effect.Effect<A, InvalidInput>
  /** Deterministic, side-effect-free mapping; retries may evaluate it again. */
  readonly map: (payload: A) => Effect.Effect<InboundResult, InvalidInput>
  readonly project: (run: RunSummary, delivery: Delivery | undefined) => DeliveryProjection
}

/**
 * A registered channel with its payload type hidden. Decoding and mapping stay
 * paired, so lookup never exposes a mapper accepting arbitrary unknown data.
 *
 * @category models
 * @since 1.0.0
 */
export interface RegisteredChannel extends Omit<Channel, "decode" | "map"> {
  readonly decodeAndMap: (raw: RawInbound) => Effect.Effect<InboundResult, InvalidInput>
}

const eraseChannel = <A>(channel: Channel<A>): RegisteredChannel => ({
  name: channel.name,
  schema: channel.schema,
  fingerprintHeaders: channel.fingerprintHeaders,
  verify: (raw) => channel.verify(raw),
  decodeAndMap: (raw) => Effect.flatMap(channel.decode(raw), (payload) => channel.map(payload)),
  project: (run, delivery) => channel.project(run, delivery)
})

/**
 * Arguments for ingesting one authenticated channel request.
 *
 * @category models
 * @since 0.1.0
 */
export interface IngestRequest {
  readonly channel: string
  readonly raw: RawInbound
}

/**
 * Arguments for projecting one run onto a channel.
 *
 * @category models
 * @since 0.1.0
 */
export interface ProjectRequest {
  readonly channel: string
  readonly run: RunSummary
}

/**
 * The channel coordinator.
 *
 * @category services
 * @since 0.1.0
 */
export interface Channels {
  readonly register: <A>(channel: Channel<A>) => Effect.Effect<void>
  readonly lookup: (name: string) => Effect.Effect<RegisteredChannel, Unavailable>
  readonly ingest: (request: IngestRequest) => Effect.Effect<Receipt, ControlError>
  readonly project: (request: ProjectRequest) => Effect.Effect<DeliveryProjection, Unavailable>
}

/**
 * Service tag for channel registration, ingestion, and pure projection.
 *
 * @category services
 * @since 0.1.0
 */
export const Channels: Context.Service<Channels, Channels> = Context.Service("/control/Channels")

const unavailable = (feature: string): Unavailable =>
  new Unavailable({
    feature,
    ticket: "control-channel-registry"
  })

const deliveryKey = (channel: string, run: RunSummary): string => `${channel.length}:${channel}:${run.runId}`

/** Collision-free control-plane key for one channel-owned external key. */
const scopedKey = (channel: string, key: IdempotencyKey): IdempotencyKey =>
  `channel:${channel.length}:${channel}:${key}`

const mutationKey = (channel: string, key: IdempotencyKey): IdempotencyKey =>
  `channel.ingest:${scopedKey(channel, key)}`

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get

class InboundBoundaryError extends TypeError {
  readonly issue: string
  constructor(issue: string) {
    super(issue)
    this.issue = issue
  }
}

const boundary = (issue: string): never => {
  throw new InboundBoundaryError(issue)
}

const plainRecord = (input: unknown, path: string): Record<PropertyKey, unknown> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return boundary(`${path}: must be a plain record`)
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    return boundary(`${path}: must have a plain prototype`)
  }
  return input as Record<PropertyKey, unknown>
}

const ownData = (input: Record<PropertyKey, unknown>, key: PropertyKey, path: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(input, key)
  if (descriptor === undefined || !("value" in descriptor)) return boundary(`${path}: must be an own data property`)
  return descriptor.value
}

const copyBody = (input: unknown): Uint8Array => {
  /* v8 ignore next 4 -- every host that has `Uint8Array` has its prototype accessors; the refusal exists so a host without them fails closed rather than reading a caller-owned buffer */
  if (
    typedArrayBuffer === undefined || typedArrayByteOffset === undefined ||
    typedArrayByteLength === undefined
  ) return boundary("raw.body: this host cannot inspect typed arrays")
  try {
    const buffer = Reflect.apply(typedArrayBuffer, input, []) as ArrayBufferLike
    const byteOffset = Reflect.apply(typedArrayByteOffset, input, []) as number
    const byteLength = Reflect.apply(typedArrayByteLength, input, []) as number
    const source = new Uint8Array(buffer, byteOffset, byteLength)
    const snapshot = new Uint8Array(byteLength)
    snapshot.set(source)
    return snapshot
  } catch {
    return boundary("raw.body: must be a Uint8Array")
  }
}

const snapshotHeaders = (input: unknown): Readonly<Record<string, string | undefined>> => {
  const record = plainRecord(input, "raw.headers")
  const snapshot = Object.create(null) as Record<string, string | undefined>
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") return boundary("raw.headers: symbol keys are not supported")
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return boundary(`raw.headers.${key}: must be an enumerable data property`)
    }
    if (descriptor.value !== undefined && typeof descriptor.value !== "string") {
      return boundary(`raw.headers.${key}: must be a string or undefined`)
    }
    const normalized = key.toLowerCase()
    if (Object.hasOwn(snapshot, normalized)) {
      return boundary(`raw.headers.${normalized}: duplicate case-insensitive name`)
    }
    snapshot[normalized] = descriptor.value as string | undefined
  }
  return Object.freeze(snapshot)
}

const snapshotRequest = (
  input: IngestRequest
): Effect.Effect<{ readonly channel: string; readonly raw: RawInbound }, InvalidInput> =>
  Effect.try({
    try: () => {
      const request = plainRecord(input, "request")
      const channel = ownData(request, "channel", "request.channel")
      const candidate = plainRecord(ownData(request, "raw", "request.raw"), "request.raw")
      const idempotencyKey = ownData(candidate, "idempotencyKey", "raw.idempotencyKey")
      if (typeof channel !== "string" || channel.length === 0) return boundary("request.channel: must be non-empty")
      if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
        return boundary("raw.idempotencyKey: must be non-empty")
      }
      return Object.freeze({
        channel,
        raw: Object.freeze({
          body: copyBody(ownData(candidate, "body", "raw.body")),
          headers: snapshotHeaders(ownData(candidate, "headers", "raw.headers")),
          idempotencyKey
        })
      })
    },
    catch: (cause) =>
      new InvalidInput({
        issue: cause instanceof InboundBoundaryError ? cause.issue : "channel request could not be inspected safely"
      })
  })

const normalizedFingerprintHeaders = (channel: RegisteredChannel): ReadonlyArray<string> =>
  Array.from(new Set((channel.fingerprintHeaders ?? []).map((name) => name.toLowerCase()))).sort()

/** Digests the body plus only the adapter-declared, non-secret semantic headers. */
const fingerprint = (
  body: Uint8Array,
  headers: Readonly<Record<string, string | undefined>>,
  names: ReadonlyArray<string>
): string => {
  const document = JSON.stringify([
    Sha256.digestSync(body),
    names.map((name) => [name, headers[name] ?? null])
  ])
  return `channel-ingress:v2:${Sha256.digestSync(new TextEncoder().encode(document))}`
}

const externalReceipt = (receipt: Receipt, key: IdempotencyKey): Receipt => {
  switch (receipt._tag) {
    case "Accepted":
    case "AlreadyApplied":
    case "Parked":
      return { ...receipt, receiptId: key }
    default:
      return receipt
  }
}

/** The slice of the control runtime's mutation store that inbound idempotency uses. */
interface InboundReceiptStore {
  readonly lookupMutation: (
    key: IdempotencyKey,
    fingerprint: string
  ) => Effect.Effect<Receipt | undefined, ControlError>
  readonly recordMutation: (
    key: IdempotencyKey,
    fingerprint: string,
    receipt: Receipt
  ) => Effect.Effect<void, ControlError>
}

/**
 * Builds an in-memory channel registry and delivery map over Control's durable
 * mutation store. Inbound idempotency therefore survives coordinator restarts;
 * only registration and outbound projection cursors are process-local.
 */
const makeWith = (runtime: InboundReceiptStore) =>
  Effect.gen(function*() {
    const channels = yield* Ref.make(new Map<string, RegisteredChannel>())
    const deliveries = new Map<string, Delivery>()
    // Live identities are never evicted. Terminal identities have a FIFO window
    // for reconnects; retaining one per historical run would grow without bound.
    const terminalDeliveries = new Set<string>()
    const maximumTerminalDeliveries = 1024
    const ingestion = yield* Semaphore.make(1)
    const control = yield* Control

    const lookup = Effect.fn("Channels.lookup")(
      function*(name: string): Effect.fn.Return<RegisteredChannel, Unavailable> {
        return yield* Effect.flatMap(Ref.get(channels), (registered) => {
          const channel = registered.get(name)
          return channel === undefined
            ? Effect.fail(unavailable(`channel "${name}" is not registered`))
            : Effect.succeed(channel)
        })
      }
    )

    return Channels.of({
      register: Effect.fn("Channels.register")(<A>(channel: Channel<A>) =>
        Ref.update(channels, (registered) => {
          const next = new Map(registered)
          next.set(channel.name, eraseChannel(channel))
          return next
        })
      ),
      lookup,
      ingest: Effect.fn("Channels.ingest")((request) =>
        Effect.flatMap(snapshotRequest(request), (snapshot) =>
          ingestion.withPermits(1)(Effect.gen(function*() {
            const channel = yield* lookup(snapshot.channel)
            const fingerprintHeaders = normalizedFingerprintHeaders(channel)
            const bodyFingerprint = fingerprint(snapshot.raw.body, snapshot.raw.headers, fingerprintHeaders)
            // This ordering is intentional: signature verification is the
            // amplification guard and must happen before decode or Control access.
            // The verifier receives its own body copy, so even a verifier that
            // edits bytes cannot change what the decoder sees after approval.
            yield* channel.verify({ ...snapshot.raw, body: copyBody(snapshot.raw.body) })
            const externalKey = snapshot.raw.idempotencyKey
            const durableKey = mutationKey(snapshot.channel, externalKey)
            const prior = yield* runtime.lookupMutation(durableKey, bodyFingerprint)
            if (prior !== undefined) return externalReceipt(prior, externalKey)

            const mapped = yield* channel.decodeAndMap(snapshot.raw)
            const key = scopedKey(snapshot.channel, externalKey)
            let receipt: Receipt
            if (mapped._tag === "Signal") {
              // The channel is the caller, not the local operator: a webhook
              // body names the run and wait, so a signal it maps to answers a
              // human wait only if the host delegates approval to this channel.
              receipt = yield* control.signal({
                runId: mapped.runId,
                signal: mapped.signal,
                idempotencyKey: key,
                principal: { id: snapshot.channel, kind: "channel", stampedAt: yield* Clock.currentTimeMillis }
              })
            } else {
              const plan = yield* control.plan({
                flowId: mapped.flowId,
                input: mapped.input,
                idempotencyKey: key
              })
              receipt = yield* control.run({
                _tag: "Plan",
                planId: plan.planId,
                digest: plan.digest,
                envelope: plan.envelope,
                idempotencyKey: key
              })
            }
            // A parked start has not launched. Leave ingress unsettled so a
            // redelivery can retry the same Control key after plan approval.
            if (receipt._tag !== "Conflict" && receipt._tag !== "Parked") {
              yield* runtime.recordMutation(durableKey, bodyFingerprint, receipt)
            }
            return externalReceipt(receipt, externalKey)
          })))
      ),
      project: Effect.fn("Channels.project")(function*(request) {
        const channel = yield* lookup(request.channel)
        const key = deliveryKey(request.channel, request.run)
        // Keep the read, projection and update synchronous so concurrent fibers
        // cannot project from the same stale delivery identity.
        return yield* Effect.sync(() => {
          const prior = deliveries.get(key)
          const projection = channel.project(request.run, prior)
          if (
            projection.operation !== "noop" &&
            (prior === undefined || prior.cursor !== projection.cursor || prior.messageId !== projection.messageId)
          ) {
            deliveries.set(key, { cursor: projection.cursor, messageId: projection.messageId })
          }
          if (deliveries.has(key)) {
            const status = request.run.status
            if (status === "completed" || status === "failed" || status === "cancelled") {
              terminalDeliveries.add(key)
              if (terminalDeliveries.size > maximumTerminalDeliveries) {
                // The set is nonempty because it just exceeded the limit.
                const oldest = terminalDeliveries.values().next().value!
                terminalDeliveries.delete(oldest)
                deliveries.delete(oldest)
              }
            } else {
              terminalDeliveries.delete(key)
            }
          }
          return projection
        })
      })
    })
  })

/**
 * Builds the coordinator over Control's durable mutation store.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = Effect.gen(function*() {
  const runtime = yield* ControlRuntime
  return yield* makeWith(runtime)
})

/**
 * Builds a process-local coordinator for adapter unit tests.
 *
 * Production hosts use {@link layer}; this constructor deliberately makes no
 * restart guarantee.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeMemory = Effect.gen(function*() {
  const records = yield* Ref.make(
    new Map<IdempotencyKey, {
      readonly fingerprint: string
      readonly receipt: Receipt
    }>()
  )
  return yield* makeWith({
    lookupMutation: (key, candidate) =>
      Ref.get(records).pipe(Effect.map((stored) => {
        const prior = stored.get(key)
        if (prior === undefined) return undefined
        return prior.fingerprint === candidate
          ? alreadyApplied(key, prior.receipt)
          : { _tag: "Conflict", message: `idempotency key ${key} was used for another mutation` }
      })),
    recordMutation: (key, candidate, receipt) =>
      Ref.update(records, (stored) => {
        const next = new Map(stored)
        next.set(key, { fingerprint: candidate, receipt })
        return next
      })
  })
})

/**
 * Channel layer with durable inbound receipts supplied by `ControlRuntime`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effect(Channels, make)

/**
 * Process-local channel layer for adapter unit tests only.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerMemory: Layer.Layer<Channels, never, Control> = Layer.effect(Channels, makeMemory)
