/**
 * Browser-safe client for replaying and following journal entries.
 *
 * @since 0.1.0
 */

import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcClientError from "effect/unstable/rpc/RpcClientError"
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import type { ShareCapability } from "./BranchProtocol.ts"
import * as Admission from "./internal/Admission.ts"
import { boundedText, causeCode, causeText } from "./internal/CauseText.ts"
import { boundedInt, positiveInt } from "./internal/PolicyOptions.ts"
import * as SnapshotBoundary from "./internal/SnapshotBoundary.ts"
import { SyncError, SyncGapError } from "./SyncError.ts"
import {
  covers,
  defaultMaxFrameBytes,
  duplicateCursorRunId,
  encodedByteLength,
  type EntriesFrame,
  Frame,
  maxReadLimit,
  maxSubscribeCredit,
  type Progress,
  protocolVersion,
  ReadResponse,
  RequestEnvelope,
  type Resync,
  RunCursor,
  type Scope,
  type Snapshot,
  type SnapshotRequest,
  type WorkspaceCursor
} from "./SyncProtocol.ts"
import { SyncRpcs } from "./SyncRpcs.ts"

/**
 * Frames one subscription round may carry before the follow replenishes it.
 *
 * A subscription's `credit` is a hard frame limit the server enforces with
 * `Stream.take`, so the number the client sends is the size of its window, not
 * a hint. At `credit: 1` the window closed after every single entry and the
 * follow resubscribed: following a run that emits a hundred entries cost a
 * hundred subscribe round trips, each of them a fresh cursor snapshot and a
 * fresh server-side fan-out. Replenishing 256 frames at a time makes the
 * round-trip cost proportional to the window rather than to the traffic, and
 * keeps it bounded — an unbounded window would hand the server one
 * never-closing subscription per follower.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultCredit = 256

/**
 * Entries one catch-up page asks for.
 *
 * Bootstrap is the replay half of replay-then-follow, so the page size is the
 * memory one catch-up costs and the granularity at which its cursor advances.
 * It matches {@link defaultCredit} and stays under
 * `SyncProtocol.maxReadLimit`, which is the ceiling the server enforces.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultBootstrapLimit = 256

/**
 * The policy one sync client runs every operation under.
 *
 * Both fields are validated by {@link makeWith} and {@link layerWith}, so a
 * value that is not a positive safe integer fails the constructor rather than
 * disabling the bound it configures.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  /**
   * Largest summed encoded-entry size one frame or bootstrap page may carry,
   * in bytes. Defaults to {@link defaultMaxFrameBytes}.
   */
  readonly maxFrameBytes?: number | undefined
  /**
   * Entries one catch-up page asks for. Defaults to
   * {@link defaultBootstrapLimit}, and may not exceed
   * `SyncProtocol.maxReadLimit`.
   */
  readonly bootstrapLimit?: number | undefined
}

/** The resolved, already-validated client policy. */
interface Resolved {
  readonly maxFrameBytes: number
  readonly bootstrapLimit: number
}

const defaults: Resolved = {
  maxFrameBytes: defaultMaxFrameBytes,
  bootstrapLimit: defaultBootstrapLimit
}

/**
 * Input accepted by a sync subscription.
 *
 * `capability` authorizes branch reads: following a shared branch's run
 * requires a capability that verifies for that branch on the server.
 *
 * `EApply` and `EResync` are the consumer's own failure types for `apply` and
 * `onResync`. The subscription fails with them unchanged, so an application
 * failure is never dressed as a transport or protocol {@link SyncError}.
 *
 * @category models
 * @since 0.1.0
 */
export interface SubscribeOptions<EApply = never, EResync = never> {
  readonly scope: Scope
  /**
   * Where this subscription starts, per run. The effective position is the
   * LATER of this and the client's matching progress map (applied when an
   * apply callback is present, delivered otherwise), so a caller
   * ahead of the shared view keeps its place and a caller behind it is
   * fast-forwarded. Rebuild from an earlier position with a fresh client.
   */
  readonly cursors: WorkspaceCursor
  readonly capability?: ShareCapability
  /**
   * Frames one subscription round may carry before the follow replenishes the
   * window. Defaults to {@link defaultCredit}, and must be a positive integer
   * no greater than `SyncProtocol.maxSubscribeCredit`.
   */
  readonly credit?: number | undefined
  /**
   * Applies one entry, and DEFINES what this subscription's cursor means.
   *
   * Without it the cursor advances as each entry is handed to the consumer,
   * so a consumer whose own application then fails has a cursor naming an
   * entry it never materialized. With it the cursor advances only after this
   * effect succeeds, and records it in `Progress.applied`. A failure here
   * fails the subscription with the entry unacknowledged, so the
   * next applying subscription delivers it again; the effect must
   * therefore be idempotent, because a redelivery is exactly what a retry is.
   */
  readonly apply?: ((entry: JournalEvent.Entry) => Effect.Effect<void, EApply>) | undefined
  /**
   * Restores state when the server refuses a cursor below a compaction floor.
   * Return the exact run and sequence actually restored, after applying it.
   *
   * The entries under the floor are deleted. Fetch an explicitly public
   * projection through `snapshot` or an authorized local source; a
   * projection has a real hole to fill. The returned sequence must cover the
   * requested floor; a newer snapshot resumes at its own sequence, not the
   * older floor. Missing handlers, failures, interruption, and invalid receipts
   * leave the cursor unmoved. There is no implicit skip of deleted history.
   *
   * Durable consumers must commit their restored state and durable cursor in
   * their own transaction and seed a fresh client from that cursor on restart.
   * This client's cursor is in memory, not an atomic cross-store transaction.
   * Recovery must be idempotent, including when a newer compaction requires
   * another restoration before the suffix can be read.
   */
  readonly onResync?: ((resync: Resync) => Effect.Effect<RunCursor, EResync>) | undefined
}

/**
 * Replicated journal subscription operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /** Fetches a public snapshot without applying state or advancing a cursor. */
  readonly snapshot: (request: SnapshotRequest) => Effect.Effect<Snapshot, SyncError>
  /** Replays then follows `options.scope`, also failing with the callbacks' own errors. */
  readonly subscribe: <EApply = never, EResync = never>(
    options: SubscribeOptions<EApply, EResync>
  ) => Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError | EApply | EResync>
  /**
   * Delivery and application positions. `delivered` is a transport bookmark
   * only; `applied` is what the `apply` and `onResync` callbacks acknowledged.
   */
  readonly progress: Effect.Effect<Progress>
}

/**
 * The browser-safe journal replication client.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export class SyncClient extends Context.Service<SyncClient, Service>()("@smthrs/sync/SyncClient") {}

/**
 * The client tag's former name, kept for one release.
 *
 * @deprecated Use {@link SyncClient}.
 * @category services
 * @since 0.1.0
 */
export const Sync = SyncClient

/**
 * The client tag's former name, kept for one release.
 *
 * @deprecated Use {@link SyncClient}.
 * @category services
 * @since 0.1.0
 */
export type Sync = SyncClient

/**
 * Constructs a closed sync stub, optionally overriding individual operations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  SyncClient.of({
    snapshot: () => Effect.fail(new SyncError({ code: "closed", message: "Sync client is closed" })),
    subscribe: () => Stream.fail(new SyncError({ code: "closed", message: "Sync client is closed" })),
    progress: Effect.succeed({ delivered: [], applied: [] }),
    ...overrides
  })

/**
 * Provides a closed sync stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<SyncClient> =>
  Layer.succeed(SyncClient, makeNoop(overrides))

type Client = RpcClient.RpcClient<RpcGroup.Rpcs<typeof SyncRpcs>, RpcClientError.RpcClientError>

const transportError = (cause: unknown): SyncError =>
  cause instanceof SyncError
    ? cause
    : cause instanceof RpcClientError.RpcClientError && cause.reason._tag === "RpcClientDefect"
    ? new SyncError({ code: "protocol_violation", message: "Sync RPC protocol failed", cause: causeCode(cause.reason) })
    : new SyncError({
      code: "transport_failed",
      // Bounded like `cause`. `message` is `Schema.String` and it is the
      // declared error schema of every RPC, so a host's own sentence must not
      // be able to be the largest thing this error carries.
      message: cause instanceof Error ? boundedText(cause.message) : "Sync RPC transport failed",
      cause: causeText(cause)
    })

/** Effect RPC decodes malformed peer values with orDie. Restore the sync
 * boundary's typed refusal without swallowing unrelated defects or interruption.
 */
const rpcCause = (cause: Cause.Cause<unknown>): Cause.Cause<SyncError> =>
  Cause.fromReasons(
    Cause.map(cause, transportError).reasons.map((reason) =>
      Cause.isDieReason(reason) && Schema.isSchemaError(reason.defect)
        ? Cause.makeFailReason(
          new SyncError({ code: "decode_failed", message: "Invalid sync RPC response", cause: "SchemaError" })
        )
          .annotate(Context.makeUnsafe(reason.annotations))
        : reason
    )
  )

type Cursors = Map<JournalEvent.RunId, RunCursor>

const cursorMap = (cursors: WorkspaceCursor): Cursors => new Map(cursors.map((cursor) => [cursor.runId, { ...cursor }]))

const canonicalCursors = (cursors: ReadonlyMap<JournalEvent.RunId, RunCursor>): WorkspaceCursor =>
  Array.from(cursors.values(), (cursor) => ({ ...cursor })).sort((left, right) =>
    // A Map has one value per key, so this comparator never receives equal
    // run IDs. `cursorMap` and the acknowledged cursor state both establish
    // that invariant before reaching this boundary.
    left.runId > right.runId ? 1 : -1
  )

/**
 * Advances the shared acknowledged view monotonically. A lagging subscription
 * commits what it just consumed, but it must never move the shared cursor
 * backward past another subscription's progress.
 */
const advance = (
  cursors: ReadonlyMap<JournalEvent.RunId, RunCursor>,
  runId: JournalEvent.RunId,
  throughSeq: JournalEvent.Seq,
  generation: number
): ReadonlyMap<JournalEvent.RunId, RunCursor> => {
  const current = cursors.get(runId)
  if (current !== undefined && current.afterSeq >= throughSeq) return cursors
  const next = new Map(cursors)
  next.set(runId, { runId, afterSeq: throughSeq, generation })
  return next
}

/**
 * Live-follow reconnect policy: exponential backoff capped at five seconds,
 * the same shape as `RpcClient`'s own transport retry policy, and only for
 * transport failures — gaps, authorization refusals, server closes, and the
 * consumer's own callback failures propagate to the consumer.
 */
const reconnectPolicy = Schedule.min([
  Schedule.exponential(500, 1.5),
  Schedule.spaced(5000)
]).pipe(
  Schedule.while(({ input }: { readonly input: Cause.Cause<unknown> }) => isTransportCause(input))
)

const isTransportCause = (cause: Cause.Cause<unknown>): boolean => {
  const reason = cause.reasons[0]!
  return cause.reasons.length === 1 && Cause.isFailReason(reason) &&
    SyncError.is(reason.error) && reason.error.code === "transport_failed"
}

const lineageChanged = (runId: JournalEvent.RunId): SyncError =>
  new SyncError({
    code: "lineage_changed",
    message: `Run ${runId} was rewound; rebuild from its archive boundary with a fresh sync client`
  })

const entriesByteLength = (entries: ReadonlyArray<JournalEvent.Entry>): number =>
  entries.reduce((bytes, entry) => bytes + encodedByteLength(entry), 0)

const oversized = (bytes: number, maxFrameBytes: number): SyncError =>
  new SyncError({
    code: "frame_too_large",
    message: `Encoded entries of ${bytes} bytes exceed the ${maxFrameBytes}-byte frame ceiling`
  })

/**
 * The first internal inconsistency of a server frame, or `undefined` for a
 * consistent one.
 *
 * A schema-valid frame can still contradict itself: carry another run's
 * entry, repeat or reorder sequences, or carry an entry outside its own
 * declared covered interval. Applying one would corrupt the client's cursor
 * bookkeeping, so an inconsistent frame is refused as a protocol violation
 * before any entry is admitted or any cursor moves.
 */
const frameViolation = (frame: EntriesFrame): SyncError | undefined => {
  let previous = -1
  for (const entry of frame.entries) {
    if (entry.runId !== frame.runId) {
      return new SyncError({
        code: "protocol_violation",
        cause: "foreign_run",
        message: `Frame for run ${frame.runId} carried an entry for run ${entry.runId}`
      })
    }
    if (entry.seq <= previous) {
      return new SyncError({
        code: "protocol_violation",
        cause: "non_monotonic_sequence",
        message: `Frame entries must ascend strictly: sequence ${entry.seq} arrived after ${previous}`
      })
    }
    if (entry.seq < frame.fromSeq || frame.toSeq < entry.seq) {
      return new SyncError({
        code: "protocol_violation",
        cause: "invalid_frame_interval",
        message: `Entry ${entry.seq} lies outside the frame's covered interval ${frame.fromSeq}..${frame.toSeq}`
      })
    }
    previous = entry.seq
  }
  return undefined
}

/**
 * The first semantic inconsistency of a catch-up page, or `undefined` for a
 * consistent one.
 *
 * Every entry must belong to the requested scope, ascend strictly within its
 * run, and lie above the requested cursor. Every entry-bearing run must have
 * exactly one response cursor with an explicit generation matching the request.
 *
 * Strictly-above-the-cursor is also what makes an incomplete page CONVERGE: a
 * page that carries entries but moves no cursor would be re-read forever.
 */
const pageViolation = (
  scope: Scope,
  requested: ReadonlyMap<JournalEvent.RunId, RunCursor>,
  response: ReadResponse
): SyncError | undefined => {
  const violation = (message: string): SyncError =>
    new SyncError({ code: "protocol_violation", message, cause: "invalid_read_page" })
  const generations = new Set<JournalEvent.RunId>()
  for (const cursor of response.cursors) {
    generations.add(cursor.runId)
    if (cursor.generation === undefined) return violation("Read response lacks a generation")
    const previous = requested.get(cursor.runId)
    if (previous !== undefined && (previous.generation ?? 0) !== cursor.generation) {
      return lineageChanged(cursor.runId)
    }
  }
  const highest = new Map<JournalEvent.RunId, JournalEvent.Seq>()
  for (const entry of response.entries) {
    if (!covers(scope, entry.runId)) {
      return violation(`Read page carried an entry for run ${entry.runId}, which the request's scope excludes`)
    }
    const floor = requested.get(entry.runId)?.afterSeq
    if (floor !== undefined && entry.seq <= floor) {
      return violation(
        `Read page carried sequence ${entry.seq} for run ${entry.runId}, at or below the requested cursor ${floor}`
      )
    }
    const previous = highest.get(entry.runId)
    if (previous !== undefined && entry.seq <= previous) {
      return violation(
        `Read page entries for run ${entry.runId} must ascend strictly: sequence ${entry.seq} arrived after ${previous}`
      )
    }
    highest.set(entry.runId, entry.seq)
  }
  for (const runId of highest.keys()) {
    if (!generations.has(runId)) return violation(`Read page lacks a generation cursor for run ${runId}`)
  }
  const duplicate = duplicateCursorRunId(response.cursors)
  return duplicate === undefined ? undefined : violation(`Read page echoed run ${duplicate} more than once`)
}

/**
 * Projects a Sync RPC client into the local replication service.
 *
 * Delivered and applied cursors are separate per-service `Ref` maps: concurrent
 * subscriptions for one materialization share them, and each commit advances
 * its matching map monotonically. A
 * cursor advances in the same stream pull that admits each entry to the
 * consumer, or — when the caller supplies `SubscribeOptions.apply` — only
 * after that callback has applied the entry. Interrupted partial pages
 * therefore retain the last admitted entry rather than incorrectly
 * acknowledging the server's whole page.
 *
 * A frame or bootstrap page whose encoded entries exceed `maxFrameBytes` is
 * refused with `frame_too_large`. Out-of-scope entries, repeated or reordered
 * sequences, and missing response generations fail with `protocol_violation`
 * before delivery. Each entry-bearing run in a Read page must have exactly one
 * explicit generation cursor, and every entry must be above the requested
 * cursor. Live frames instead drop already-covered entries and deliver only
 * the suffix above the cursor. An incomplete bootstrap page with no entries
 * or a completed subscription window with no frames fails with
 * `protocol_violation` instead of reopening immediately.
 *
 * A live follow that loses its transport reconnects under
 * {@link reconnectPolicy}, resuming from the acknowledged cursors; the failure
 * cause is logged before the retry folds it. The follow spends a credit window
 * of {@link defaultCredit} frames per subscription round and replenishes it by
 * resubscribing from the cursors it has acknowledged. Already-covered entries
 * are not delivered again; the round-trip cost scales with credit windows.
 *
 * A `compacted` refusal fails closed unless `SubscribeOptions.onResync`
 * restores the missing prefix and returns its exact cursor. Snapshot fetching
 * never applies state or advances cursors. Only a validated receipt for the requested run at or
 * above its compaction floor advances the cursor before reading the suffix.
 *
 * A subscription's effective cursor per run is the LATER of the caller's and
 * the matching progress map: a caller that restored its own progress is never
 * regressed, and a caller asking for history this client already acknowledged
 * is fast-forwarded. Rebuild a projection from an earlier position with a
 * fresh client, whose acknowledged map is empty.
 *
 * This constructor carries the default policy, which is valid by
 * construction and so cannot fail. {@link makeWith} takes an explicit
 * {@link Options} and validates it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = ({ client }: { readonly client: Client }): Effect.Effect<Service> => service(client, defaults)

/**
 * Constructs the sync client under an explicit policy.
 *
 * Every option is validated here, once, so a client either exists under a
 * policy it can serve or never exists at all. Validating on each `subscribe`
 * and each `snapshot` instead accepted a `maxFrameBytes` of `NaN` at
 * construction and then refused every operation under it, which reported a
 * composition's mistake as a run-time failure of the follow. This mirrors
 * `SyncServer.makeLiveWith` and `BranchCommands.makeLiveWith`.
 *
 * `SubscribeOptions.credit` is a REQUEST count rather than a client policy, so
 * it is still checked where the request is built.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const makeWith = ({
  bootstrapLimit,
  client,
  maxFrameBytes
}: Options & { readonly client: Client }): Effect.Effect<Service, SyncError> =>
  Effect.flatMap(
    Effect.all({
      maxFrameBytes: positiveInt("SyncClient.Options.maxFrameBytes", maxFrameBytes, defaults.maxFrameBytes),
      bootstrapLimit: boundedInt(
        "SyncClient.Options.bootstrapLimit",
        bootstrapLimit,
        defaults.bootstrapLimit,
        maxReadLimit
      )
    }),
    (policy) => service(client, policy)
  )

const service = (client: Client, { bootstrapLimit, maxFrameBytes }: Resolved): Effect.Effect<Service> =>
  Effect.sync(() => {
    const delivered = Ref.makeUnsafe<ReadonlyMap<JournalEvent.RunId, RunCursor>>(new Map())
    const applied = Ref.makeUnsafe<ReadonlyMap<JournalEvent.RunId, RunCursor>>(new Map())

    const progress: Effect.Effect<Progress> = Effect.gen(function*() {
      return {
        delivered: canonicalCursors(yield* Ref.get(delivered)),
        applied: canonicalCursors(yield* Ref.get(applied))
      }
    })

    const snapshot = (input: SnapshotRequest): Effect.Effect<Snapshot, SyncError> =>
      Effect.gen(function*() {
        const request = yield* SnapshotBoundary.request(input)
        const supplied = yield* client["Sync.Snapshot"]({ ...request }).pipe(
          Effect.catchCause((cause) => Effect.failCause(rpcCause(cause)))
        )
        return yield* SnapshotBoundary.response(request, supplied, maxFrameBytes)
      })

    const subscribe = <EApply = never, EResync = never>(
      input: SubscribeOptions<EApply, EResync>
    ): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError | EApply | EResync> =>
      Stream.unwrap(Effect.gen(function*() {
        /** Every way this subscription fails: the wire's refusals and the consumer's own callback errors. */
        type Failure = SyncError | SyncGapError | EApply | EResync

        const options = {
          ...input,
          ...yield* Admission.decode(RequestEnvelope, input, "invalid_request")
        }
        // The client's own policy was checked once, by the constructor. What
        // is left is the count this REQUEST carries: the declared type says
        // `number`, and `NaN` disabled each comparison it appears in rather
        // than tightening it.
        const credit = yield* boundedInt(
          "SyncClient.SubscribeOptions.credit",
          options.credit,
          defaultCredit,
          maxSubscribeCredit
        )
        const cursor = cursorMap(options.cursors)
        // A previous delivery-only subscriber cannot skip work for an applying subscriber.
        // Rebuilding an independent projection requires a fresh client.
        for (const [runId, position] of yield* Ref.get(options.apply === undefined ? delivered : applied)) {
          const supplied = cursor.get(runId)
          if (supplied !== undefined && (supplied.generation ?? 0) !== position.generation) {
            return yield* Effect.fail(lineageChanged(runId))
          }
          if (supplied === undefined || supplied.afterSeq < position.afterSeq) cursor.set(runId, position)
        }

        const snapshot = (): WorkspaceCursor => canonicalCursors(cursor)

        const commit = (
          runId: JournalEvent.RunId,
          throughSeq: JournalEvent.Seq,
          generation: number,
          wasApplied: boolean
        ) =>
          Effect.gen(function*() {
            // Delivery and application have distinct cursors, but both are bound
            // to the same journal generation and advance without an interrupt gap.
            for (const view of wasApplied ? [delivered, applied] : [delivered]) {
              const previous = (yield* Ref.get(view)).get(runId)
              if (previous !== undefined && previous.generation !== generation) {
                return yield* Effect.fail(lineageChanged(runId))
              }
            }
            yield* Ref.update(delivered, (shared) => advance(shared, runId, throughSeq, generation))
            if (wasApplied) yield* Ref.update(applied, (shared) => advance(shared, runId, throughSeq, generation))
            cursor.set(runId, { runId, afterSeq: throughSeq, generation })
          }).pipe(Effect.uninterruptible)

        const applyEntry = options.apply

        /**
         * Hands one entry to the consumer and moves its cursor.
         *
         * With an `apply` callback the cursor moves only after the callback
         * succeeds, so a cursor names what the consumer materialized. Without
         * one it moves as the entry is admitted, which is the weaker promise
         * this client has always made and the one `RunCursor`'s JSDoc now
         * states.
         *
         * The position committed is SNAPSHOTTED before the callback runs.
         * `Entry` is a `Schema.Class`, and instances are not frozen, so
         * reading `entry.seq` again afterwards let the consumer's own callback
         * choose the cursor it was being handed an entry for.
         */
        const deliver = (
          runId: JournalEvent.RunId,
          entry: JournalEvent.Entry,
          generation: number
        ): Stream.Stream<JournalEvent.Entry, Failure> => {
          const through = entry.seq
          return Stream.concat(
            Stream.drain(Stream.fromEffect(
              applyEntry === undefined
                ? commit(runId, through, generation, false)
                : Effect.uninterruptibleMask((restore) =>
                  Effect.andThen(restore(applyEntry(entry)), commit(runId, through, generation, true))
                )
            )),
            Stream.succeed(entry)
          )
        }

        const batch = (frame: EntriesFrame): Stream.Stream<JournalEvent.Entry, Failure> => {
          if (frame.generation === undefined) {
            return Stream.fail(
              new SyncError({ code: "protocol_violation", message: "Entries frame lacks a generation" })
            )
          }
          if (!covers(options.scope, frame.runId)) {
            return Stream.fail(
              new SyncError({
                code: "protocol_violation",
                message: "Live frame is outside the subscription scope",
                cause: "foreign_run"
              })
            )
          }
          const frameBytes = entriesByteLength(frame.entries)
          if (frameBytes > maxFrameBytes) return Stream.fail(oversized(frameBytes, maxFrameBytes))
          const violation = frameViolation(frame)
          if (violation !== undefined) return Stream.fail(violation)
          const position = cursor.get(frame.runId)
          const generation = frame.generation
          if (position !== undefined && (position.generation ?? 0) !== generation) {
            return Stream.fail(lineageChanged(frame.runId))
          }
          const afterSeq: number = position?.afterSeq ?? -1
          // `fromSeq` is the start of the server-declared covered interval. It is
          // intentionally compared to the cursor, not to the first entry's seq:
          // dropped journal admissions legitimately leave holes inside that range.
          if (frame.fromSeq > afterSeq + 1) {
            return Stream.fail(
              new SyncGapError({
                runId: frame.runId,
                expectedFrom: (afterSeq + 1) as JournalEvent.Seq,
                receivedFrom: frame.fromSeq
              })
            )
          }
          if (frame.toSeq <= afterSeq) return Stream.empty

          const entries = frame.entries.filter((entry) => entry.seq > afterSeq)
          return Stream.flatMap(Stream.fromIterable(entries), (entry) => deliver(frame.runId, entry, generation))
        }

        const livePage = (onFrame: () => void): Stream.Stream<JournalEvent.Entry, Failure> =>
          Stream.unwrap(
            Effect.sync(() =>
              client["Sync.Subscribe"]({
                protocolVersion,
                scope: options.scope,
                cursors: snapshot(),
                credit,
                ...(options.capability === undefined ? {} : { capability: options.capability })
              })
            )
          ).pipe(
            Stream.catchCause((cause) => Stream.failCause(rpcCause(cause))),
            Stream.mapEffect((frame) => Admission.decode(Frame, frame)),
            Stream.mapEffect((frame): Effect.Effect<Frame, SyncError> =>
              frame._tag === "Entries"
                ? Effect.map(Admission.records(frame.entries), (entries) => ({ ...frame, entries }))
                : Effect.succeed(frame)
            ),
            Stream.flatMap((frame) => {
              onFrame()
              switch (frame._tag) {
                case "Entries":
                  return batch(frame)
                case "Closed":
                  return Stream.fail(new SyncError({ code: "closed", message: "Sync subscription closed" }))
                default:
                  return Stream.empty
              }
            })
          )

        const live = (): Stream.Stream<JournalEvent.Entry, Failure> =>
          Stream.unwrap(Effect.sync(() => {
            let receivedFrame = false
            return Stream.concat(
              livePage(() => {
                receivedFrame = true
              }),
              Stream.unwrap(Effect.sync(() =>
                receivedFrame ? live() : Stream.fail(
                  new SyncError({
                    code: "protocol_violation",
                    message: "Subscription window closed without frames"
                  })
                )
              ))
            )
          }))

        // The retry re-runs the whole follow from the acknowledged cursors,
        // and its schedule resets once entries flow again, so a long-lived
        // subscription pays the backoff only across consecutive failures.
        const follow = (): Stream.Stream<JournalEvent.Entry, Failure> =>
          live().pipe(
            Stream.tapCause((cause) =>
              isTransportCause(cause)
                ? Effect.logWarning("sync live follow transport failed; reconnecting with backoff", cause)
                : Effect.void
            ),
            // Schedule the complete cause so retry refusal cannot discard an
            // accompanying defect, interruption, or tracing annotation.
            Stream.catchCause((cause) => Stream.fail(cause)),
            Stream.retry(reconnectPolicy),
            Stream.catch((cause) => Stream.failCause(cause))
          )

        const bootstrap = (): Stream.Stream<JournalEvent.Entry, Failure> =>
          Stream.unwrap(
            // SUSPENDED, exactly as `livePage` is. Building the payload where
            // the recursive call is written snapshotted the cursors as page N
            // was mapped, before a single one of its entries had reached
            // `commit` — so read N+1 carried read N's request cursors and the
            // server correctly re-served the page it had just served. Every
            // catch-up page past the first arrived twice.
            Effect.suspend(() => {
              const requested = snapshot()
              return client["Sync.Read"]({
                protocolVersion,
                scope: options.scope,
                cursors: requested,
                limit: bootstrapLimit,
                ...(options.capability === undefined ? {} : { capability: options.capability })
              }).pipe(
                Effect.catchCause((cause) => Effect.failCause(rpcCause(cause))),
                Effect.flatMap((response) => Admission.decode(ReadResponse, response)),
                Effect.flatMap((response) =>
                  Effect.map(Admission.records(response.entries), (entries) => ({ ...response, entries }))
                ),
                Effect.map((response) => {
                  const pageBytes = entriesByteLength(response.entries)
                  if (pageBytes > maxFrameBytes) return Stream.fail(oversized(pageBytes, maxFrameBytes))
                  const violation = pageViolation(options.scope, cursorMap(requested), response)
                  if (violation !== undefined) return Stream.fail(violation)
                  const generations = new Map(response.cursors.map((cursor) => [cursor.runId, cursor.generation!]))
                  const page = Stream.flatMap(
                    Stream.fromIterable(response.entries),
                    (entry) =>
                      deliver(
                        entry.runId,
                        entry,
                        generations.get(entry.runId)!
                      )
                  )
                  if (response.done) return Stream.concat(page, follow())
                  if (response.entries.length === 0) {
                    // An incomplete page with no entries can never converge:
                    // the next read would carry the same cursors and receive
                    // the same page. Fail typed instead of spinning.
                    return Stream.fail(
                      new SyncError({
                        code: "protocol_violation",
                        message: "Bootstrap read reported more durable entries but returned an empty page"
                      })
                    )
                  }
                  return Stream.concat(page, bootstrap())
                })
              )
            })
          )

        /**
         * The checkpoint one failure says to resume from, or `undefined` when
         * the failure is not a recoverable compaction.
         *
         * A compaction whose checkpoint is at or below what this subscription
         * already covers cannot move it forward, so retrying would re-read the
         * same refusal forever. That is the same non-convergence rule the
         * empty incomplete bootstrap page is refused under, and it is why a
         * `compacted` failure carrying no {@link Resync} stays a failure
         * rather than becoming a silent stall.
         */
        const resyncTarget = (failure: Failure): Resync | undefined => {
          if (!SyncError.is(failure) || failure.code !== "compacted" || failure.resync === undefined) {
            return undefined
          }
          const covered: number = cursor.get(failure.resync.runId)?.afterSeq ?? -1
          return covered >= failure.resync.checkpointSeq ? undefined : failure.resync
        }

        const onResync = options.onResync

        const resynced = (): Stream.Stream<JournalEvent.Entry, Failure> =>
          Stream.catchCause(bootstrap(), (cause) => {
            const reason = cause.reasons[0]!
            if (cause.reasons.length !== 1 || !Cause.isFailReason(reason)) return Stream.failCause(cause)
            const failure = reason.error
            const resync = resyncTarget(failure)
            if (resync === undefined) return Stream.failCause(cause)
            if (!covers(options.scope, resync.runId)) {
              return Stream.fail(
                new SyncError({
                  code: "protocol_violation",
                  message: "Compaction target is outside the subscription scope"
                })
              )
            }
            if (onResync === undefined) return Stream.failCause(cause)
            // Snapshotted before the hook runs, for the reason `deliver`
            // snapshots: the hook is handed the value the commit is read from,
            // and re-reading it afterwards let a consumer move its own cursor
            // arbitrarily far forward from inside the callback.
            const runId = resync.runId
            const checkpointSeq = resync.checkpointSeq
            const refusedGeneration = resync.generation
            return Stream.unwrap(Effect.uninterruptibleMask((restore) =>
              Effect.gen(function*() {
                // Application remains interruptible. Once it returns success,
                // validation and the in-memory commit finish without an async
                // cancellation gap. Durable state/cursor atomicity belongs to
                // the consumer's own transaction, not to this mask.
                const receipt = yield* restore(onResync(resync))
                const restoredCursor = () =>
                  new SyncError({
                    code: "invalid_request",
                    message: "Recovery must return the restored run cursor at or above its compaction floor"
                  })
                // A receipt that omits its generation restored the floor's
                // history, which the refusal names. The previous cursor's
                // generation is no substitute: a fresh client has none,
                // and a rewind since then has replaced it.
                const captured = yield* Effect.try({
                  try: () => ({
                    runId: receipt.runId,
                    afterSeq: receipt.afterSeq,
                    generation: receipt.generation ?? refusedGeneration
                  }),
                  catch: restoredCursor
                })
                if (
                  !Schema.is(RunCursor)(captured) || captured.runId !== runId || captured.afterSeq < checkpointSeq
                ) {
                  return yield* Effect.fail(restoredCursor())
                }
                const applied = captured
                if (applied.generation === undefined) {
                  return yield* Effect.fail(
                    new SyncError({
                      code: "protocol_violation",
                      message: "Compaction refusal names no generation for a receipt that omits one"
                    })
                  )
                }
                yield* commit(applied.runId, applied.afterSeq, applied.generation, true)
                return resynced()
              })
            ))
          })

        return resynced()
      }))

    return SyncClient.of({ snapshot, subscribe, progress })
  })

/**
 * Provides the sync client from the active RPC protocol.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<SyncClient, never, RpcClient.Protocol> = Layer.effect(
  SyncClient,
  Effect.flatMap(RpcClient.make(SyncRpcs), (client) => make({ client }))
)

/**
 * Provides the sync client under an explicit policy. Fails with
 * `invalid_request` when an option is not a positive safe integer, so a bad
 * policy fails the composition rather than every operation under it.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerWith = (options: Options): Layer.Layer<SyncClient, SyncError, RpcClient.Protocol> =>
  Layer.effect(SyncClient, Effect.flatMap(RpcClient.make(SyncRpcs), (client) => makeWith({ ...options, client })))
