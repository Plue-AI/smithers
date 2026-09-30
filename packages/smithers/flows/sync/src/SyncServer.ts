/**
 * The workspace-side implementation of the sync read path.
 *
 * @since 0.1.0
 */

import { Journal } from "@smthrs/journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Stream from "effect/Stream"
import type * as Rpc from "effect/unstable/rpc/Rpc"
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import { type BranchId, branchOfRunId, type ShareCapability, type ShareClaims } from "./BranchProtocol.ts"
import * as BranchShare from "./BranchShare.ts"
import * as Admission from "./internal/Admission.ts"
import { causeCode } from "./internal/CauseText.ts"
import { journalErrorCode } from "./internal/JournalErrorCode.ts"
import { positiveInt, requestCount } from "./internal/PolicyOptions.ts"
import { requireVersion } from "./internal/ProtocolVersion.ts"
import * as SnapshotBoundary from "./internal/SnapshotBoundary.ts"
import * as RunCatalog from "./RunCatalog.ts"
import { SyncError } from "./SyncError.ts"
import * as SyncPrincipal from "./SyncPrincipal.ts"
import * as SyncProtocol from "./SyncProtocol.ts"
import { SyncRpcs } from "./SyncRpcs.ts"

/**
 * Sync read-path operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly snapshot: (request: SyncProtocol.SnapshotRequest) => Effect.Effect<SyncProtocol.Snapshot, SyncError>
  readonly read: (request: SyncProtocol.ReadRequest) => Effect.Effect<SyncProtocol.ServerReadResponse, SyncError>
  readonly subscribe: (request: SyncProtocol.SubscribeRequest) => Stream.Stream<SyncProtocol.ServerFrame, SyncError>
}

/**
 * The workspace sync server.
 *
 * @category services
 * @since 0.1.0
 */
export class SyncServer extends Context.Service<SyncServer, Service>()("@smthrs/sync/SyncServer") {}

/**
 * Explicit host opt-in for public projection snapshots. Never bind this to raw
 * Journal.latestCheckpoint: executable checkpoints are intentionally unredacted.
 * Providers must select the requested lineage/projection/version, retain a
 * snapshot covering compaction, and return a complete state through its sequence.
 * Run/branch read authorization occurs before this callback. Its output must be
 * safe for every reader authorized for that run; narrower data needs a separate
 * authorization boundary. Missing providers fail closed.
 * @category services
 * @since 1.0.0-rc.0
 */
export class SnapshotSource extends Context.Service<SnapshotSource, {
  readonly read: (request: SyncProtocol.SnapshotRequest) => Effect.Effect<SyncProtocol.Snapshot, SyncError>
}>()("@smthrs/sync/SnapshotSource") {}

/**
 * Constructs a closed sync server stub.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  SyncServer.of({
    snapshot: () => Effect.fail(new SyncError({ code: "not_found", message: "Public snapshots are unavailable" })),
    read: Effect.fn("SyncServer.read")(() => Effect.succeed({ entries: [], cursors: [], done: true })),
    subscribe: (): Stream.Stream<SyncProtocol.ServerFrame, SyncError> =>
      Stream.succeed<SyncProtocol.ServerFrame>({ _tag: "Closed", reason: "Sync server is unavailable" }),
    ...overrides
  })

/**
 * Provides a closed sync server stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<SyncServer> = Layer.succeed(SyncServer, makeNoop())

/**
 * Projects a journal failure onto the sync boundary.
 *
 * `compacted` is the one journal code that survives the crossing with its own
 * identity. Every other failure is a fault the follower can only report, but a
 * compacted read is a refusal with a documented resume point — the journal
 * hands back the run's compaction floor for exactly that — and flattening it
 * into `unknown` threw the floor away. The client retries only
 * `transport_failed`, so the subscription died and every resubscribe from the
 * same cursors died identically; because a whole-workspace subscription merges
 * per-run reads, one compacted run took down the workspace.
 *
 * The run id comes from the call site rather than the error because the
 * journal error carries only the sequence, and a workspace read fans out over
 * many runs: without it a follower could not tell which cursor to move. The
 * generation comes from the read's own fence for the same reason: a fresh
 * follower recovering a rewound run has no other way to learn it.
 */
const journalFailure = (runId: JournalEvent.RunId, generation?: number) => (cause: unknown): SyncError =>
  cause instanceof Journal.JournalError && cause.code === "compacted" && cause.checkpointSeq !== undefined
    ? new SyncError({
      code: "compacted",
      message: `Run ${runId} is compacted above the requested cursor`,
      cause: causeCode(cause),
      resync: { runId, checkpointSeq: cause.checkpointSeq, ...(generation === undefined ? {} : { generation }) }
    })
    : new SyncError({
      // Constant message, rendered cause. A follower may hold nothing but a
      // branch share link, and the journal's message is the SQLite driver's:
      // it routinely carries SQL text, table and column names, and constraint
      // identifiers. `decodeCapability` already refuses to be a parsing
      // oracle; this is the same rule for the read path. The CODE is a
      // different question from the message: a journal code this boundary
      // also declares crosses as that code, so a shut-down journal is not
      // reported as an unexplained fault.
      code: journalErrorCode(cause),
      message: `Journal read failed for run ${runId}`,
      cause: causeCode(cause)
    })

/** The one refusal a lapsed credential produces, wherever it is noticed. */
const expired = new SyncError({
  code: "unauthorized",
  message: "The capability authorizing this subscription has expired"
})

const cursorOf = (
  cursors: SyncProtocol.WorkspaceCursor,
  runId: JournalEvent.RunId
): JournalEvent.Seq | undefined => cursors.find((cursor) => cursor.runId === runId)?.afterSeq

/**
 * The one shape a live path emits: one entry, with the gap it closes.
 *
 * Every subscription frame carries exactly one entry, so `fromSeq` is not the
 * entry's own sequence — it is one past the last sequence this run SERVED,
 * which is how a follower learns that the journal skipped compacted or
 * filtered sequences instead of losing them. The run-scoped stream and the
 * workspace tail both emit it, so both build it here.
 */
const frameOf = (
  runId: JournalEvent.RunId,
  generation: number,
  previous: number,
  entry: JournalEvent.Entry
): SyncProtocol.ServerFrame => ({
  _tag: "Entries",
  runId,
  generation,
  fromSeq: (previous + 1) as JournalEvent.Seq,
  toSeq: entry.seq,
  entries: [entry]
})

/**
 * What one run's share did to a read page.
 *
 * `more` and `drained` describe the RUN: it has unserved entries left, or the
 * page took all of them. {@link PageStop} describes the PAGE and ends it.
 */
type ServeOutcome = { readonly _tag: "more" } | { readonly _tag: "drained" } | PageStop

/**
 * The two ways one run ends a read page: the page's byte budget was reached,
 * or a single entry alone outgrows the frame ceiling and no page can ever
 * carry it.
 */
type PageStop = { readonly _tag: "truncated" } | { readonly _tag: "oversized"; readonly bytes: number }

/**
 * Largest number of journal reads one workspace subscription keeps open at
 * once.
 *
 * A workspace subscription serves every run it covers, and every open read is
 * a cursor plus a page buffer. Without a bound the cost of one follower is the
 * size of the workspace: a thousand-run workspace opened a thousand journal
 * streams the moment a subscription started, whether or not the follower ever
 * read from them, and a follower that stalled held all of them. Sixty-four
 * bounds what one follower costs without bounding what it sees: the workspace
 * tail visits every covered run each round, so a run past the bound waits for
 * a slot for the length of one round rather than being starved.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultConcurrency = 64

/**
 * How long a workspace subscription waits before re-reading the runs it
 * covers, when nothing announces a change, in milliseconds.
 *
 * A workspace tail is a fan-in over many runs, and the runs another engine
 * process owns reach this process only through the database. rc.0 has no
 * cross-process wake, so the interval is the whole of the freshness policy for
 * them: a follower sees an entry within one interval of it being durable. A
 * second matches the rest of the rc.0 posture — the heartbeat sweep, the
 * cancel poll, and {@link RunCatalog.defaultPollIntervalMs}.
 *
 * It is not what an in-process append waits for. An entry this process commits
 * is published on `Journal.changes`, and a workspace subscription that covers
 * its run wakes the round on it, so a follower beside the writer sees it at
 * once rather than at the next tick. A run-scoped subscription is likewise
 * unaffected: it follows one journal stream directly and keeps that stream's
 * wake.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultTailIntervalMs = 1000

/**
 * Entries one workspace tail read pulls per run per round. A round reads at
 * most `concurrency` pages at once, so this is the page half of the memory one
 * follower costs; a run with more unserved entries than this wakes the next
 * round and is served by it, rather than holding its slot until it catches up.
 */
const tailBatchSize = 256

/**
 * Read-path policy.
 *
 * The default caps the encoded entries of one read page or one subscription
 * frame at 2 MiB, and the run streams one subscription holds open at
 * {@link defaultConcurrency}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * Largest summed encoded-entry size one read page or subscription frame may
   * carry, in bytes. Defaults to {@link SyncProtocol.defaultMaxFrameBytes}.
   */
  readonly maxFrameBytes?: number | undefined
  /**
   * Largest number of journal reads one workspace subscription keeps open at
   * once. Defaults to {@link defaultConcurrency}.
   */
  readonly concurrency?: number | undefined
  /**
   * How long a workspace subscription waits before re-reading every run it
   * covers, when nothing wakes it — no journal entry committed in this
   * process, no catalog announcement — in milliseconds, and the longest a
   * stream of local wakes may defer that catalog-wide round. Defaults to
   * {@link defaultTailIntervalMs}.
   */
  readonly tailIntervalMs?: number | undefined
}

/** The resolved, already-validated read-path policy. */
interface Resolved {
  readonly maxFrameBytes: number
  readonly concurrency: number
  readonly tailIntervalMs: number
}

const defaults: Resolved = {
  maxFrameBytes: SyncProtocol.defaultMaxFrameBytes,
  concurrency: defaultConcurrency,
  tailIntervalMs: defaultTailIntervalMs
}

/**
 * The read path over an already-validated policy.
 *
 * A read SHARES its page across the runs it covers and stops at the first of
 * three bounds: the request's `limit`, the frame ceiling, or the durable tail
 * of every covered run, which is the only case that reports `done: true`.
 * Every covered run takes a share of the budget before any run takes a second
 * helping, and what the shares leave unspent is offered back in run order, so
 * a run with a backlog still takes the larger part of a page but never all of
 * it. Filling in run order instead let a producer that stayed one page ahead
 * take every slot of every page: `done` never became true, so a bootstrapping
 * follower never reached the runs behind it and never reached the live follow
 * either. The frame ceiling is a page budget, not a verdict on the read:
 * entries are served until the next one would cross it, and the page then
 * reports `done: false` so the follower asks for the rest. Only a SINGLE
 * entry whose own encoded size exceeds the ceiling is refused with
 * `frame_too_large`, because no page can ever carry it.
 *
 * A workspace subscription's fan-out is bounded without bounding what it
 * serves. Each round reconciles the runs it covers against `RunCatalog.list`,
 * then reads ONE bounded page per run, at most `Options.concurrency` reads
 * open at once. A run with more waiting wakes the next round rather than
 * holding its slot, so no run is starved by a run that stays busy. A round
 * repeats on a journal entry committed in this process, on a catalog
 * announcement, on a run that reported more, or after
 * `Options.tailIntervalMs`. A wake for an entry committed in this process
 * reads only the runs that entry named; a round that re-lists the catalog
 * reads every covered run, so the bound caps what is open at once while a
 * round's work and the positions a follower keeps grow with the runs it
 * covers. The interval is the freshness policy for the runs another process
 * owns, not for the runs written beside the follower. A run-scoped
 * subscription follows that one run's journal stream directly and keeps its
 * in-process wake.
 *
 * Authorization is fail-closed along two boundaries, both consulted per
 * request:
 *
 * - Branch runs: a run whose id maps to a shared branch is visible only when
 *   the request's share capability verifies for that branch. An explicitly
 *   scoped branch read without one fails; a workspace listing excludes branch
 *   runs the caller's capability does not cover, so one share link never
 *   leaks another branch's log. Without a {@link BranchShare} in scope every
 *   branch run is closed.
 * - Non-branch runs: visible only to the workspace principal
 *   (`SyncPrincipal`), whose default is anonymous. A workspace-scoped
 *   request and a run-scoped request for a non-branch run are both refused
 *   for anonymous callers, so a connection with no credential — or with only
 *   a branch share link — can never read engine runs.
 *
 * A SUBSCRIPTION is additionally bounded in time: it ends with `unauthorized`
 * when the credential that opened it expires, because a stream authorized
 * once at open is otherwise the one thing a signed expiry cannot revoke.
 */
const makeWith = (
  { concurrency, maxFrameBytes, tailIntervalMs }: Resolved
): Effect.Effect<Service, never, Journal.Journal | RunCatalog.RunCatalog> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const catalog = yield* RunCatalog.RunCatalog
    const share = yield* Effect.serviceOption(BranchShare.BranchShare)
    const snapshots = yield* Effect.serviceOption(SnapshotSource)

    /**
     * Refuses ONE entry whose own encoded size outgrows the ceiling.
     *
     * This is the only shape the ceiling refuses. A single entry above it can
     * never be served in any page, so paging around it would spin; a page that
     * merely SUMS past it is ordinary traffic and is truncated instead (see
     * {@link read}).
     */
    const frameTooLarge = (bytes: number): Effect.Effect<never, SyncError> =>
      Effect.fail(
        new SyncError({
          code: "frame_too_large",
          message: `Encoded entries of ${bytes} bytes exceed the ${maxFrameBytes}-byte frame ceiling`
        })
      )

    /**
     * Chunk-level admission for the live path. Each subscription frame
     * carries one entry, so the per-frame ceiling is a per-entry ceiling —
     * but the check runs once per journal chunk, not once per entry, because
     * a per-element effect hop de-chunks the stream and multiplies the cost
     * of every downstream combinator on the hot follow path.
     */
    const guardEntryChunk = (chunk: ReadonlyArray<JournalEvent.Entry>): Effect.Effect<void, SyncError> => {
      for (const entry of chunk) {
        const bytes = SyncProtocol.encodedByteLength(entry)
        if (bytes > maxFrameBytes) return frameTooLarge(bytes)
      }
      return Effect.void
    }

    /**
     * The catalog's run set: deduplicated, then ordered.
     *
     * `RunCatalog` is a host seam whose `list` is typed `ReadonlyArray<RunId>`,
     * and an array is not a set. Both fan-out paths key a run's served
     * position by run id, so a run named twice is read twice from the same
     * position and its entries are served twice — inside one read page, and as
     * two concurrent tails emitting identical frames. This is the one place
     * that can rule it out for every path below, so it does.
     */
    const covered = Effect.map(catalog.list, (ids) => Array.from(new Set(ids)).sort())

    /**
     * The workspace principal's expiry, or a refusal.
     *
     * It answers with the expiry rather than with nothing because the two
     * questions have one answer: a request that may read the workspace may
     * read it until its credential stops authorizing. An in-process owner
     * presented no credential and answers `Infinity`.
     */
    const requireWorkspace: Effect.Effect<number, SyncError> = Effect.flatMap(
      Effect.service(SyncPrincipal.SyncPrincipal),
      (principal) =>
        SyncPrincipal.isWorkspace(principal) ? Effect.succeed(principal.expiresAtMs) : Effect.fail(
          new SyncError({
            code: "unauthorized",
            message: "Reading workspace runs requires an authenticated workspace principal"
          })
        )
    )

    /**
     * The verified claims a branch read is granted by, or `null` when the
     * request holds no capability for that branch. Only an `unauthorized`
     * refusal folds to `null`; an infrastructure fault (Web Crypto rejecting
     * the HMAC) propagates, so "the signer is broken" is never reported as
     * "not authorized".
     *
     * The CLAIMS are returned, not a boolean: `expiresAtMs` is what bounds a
     * subscription opened against this branch, and reducing the answer to
     * "yes" threw it away.
     */
    const branchClaims = (
      branchId: BranchId,
      capability: ShareCapability | undefined
    ): Effect.Effect<ShareClaims | null, SyncError> =>
      Option.isNone(share) || capability === undefined
        ? Effect.succeed(null)
        : share.value.verify(capability, { branchId, access: "read" }).pipe(
          Effect.map((claims): ShareClaims | null => claims),
          Effect.catch((error) => error.code === "unauthorized" ? Effect.succeed(null) : Effect.fail(error))
        )

    /**
     * When this request stops being allowed to follow one catalog-advertised
     * run, or `null` when it may not follow it at all.
     *
     * The answer is the EXPIRY, not a yes. A workspace subscription discovers
     * runs after it opens, and a branch run discovered then is admitted under
     * a capability whose expiry was not part of the subscription's deadline:
     * reducing this to a boolean let a branch found by reconciliation stream
     * for as long as the subscription lived, which is exactly the revocation
     * hole the deadline exists to close. A non-branch run answers `Infinity`
     * because the workspace principal's own expiry already bounds the
     * subscription.
     */
    const followUntil = (
      runId: JournalEvent.RunId,
      capability: ShareCapability | undefined
    ): Effect.Effect<number | null, SyncError> => {
      const branchId = branchOfRunId(runId)
      return branchId === null
        // A NON-branch run is admitted by the workspace principal, and only a
        // workspace-scoped subscription reaches here: `runIdsFor` refused the
        // request outright if the principal was anything else, and a
        // principal is fixed for the life of a request. Its expiry is already
        // the deadline this subscription opened with.
        ? Effect.succeed(Number.POSITIVE_INFINITY)
        : Effect.map(branchClaims(branchId, capability), (claims) => claims === null ? null : claims.expiresAtMs)
    }

    /**
     * The runs a request may observe, and when the credential that admits them
     * stops doing so. A run-scoped request the caller is not authorized for
     * fails outright — a scoped read must never silently answer with an empty
     * or partial view — and a workspace-scoped request is only answered for
     * the workspace principal at all.
     */
    const runIdsFor = (
      scope: SyncProtocol.Scope,
      capability: ShareCapability | undefined
    ): Effect.Effect<{ readonly runIds: ReadonlyArray<JournalEvent.RunId>; readonly expiresAtMs: number }, SyncError> =>
      scope._tag === "Run"
        ? Effect.gen(function*() {
          const branchId = branchOfRunId(scope.runId)
          if (branchId === null) {
            return { runIds: [scope.runId], expiresAtMs: yield* requireWorkspace }
          }
          const claims = yield* branchClaims(branchId, capability)
          if (claims === null) {
            return yield* Effect.fail(
              new SyncError({
                code: "unauthorized",
                message: "Reading a shared branch requires a valid share capability"
              })
            )
          }
          return { runIds: [scope.runId], expiresAtMs: claims.expiresAtMs }
        })
        : Effect.gen(function*() {
          // The soonest expiry of every credential this view rests on: the
          // workspace principal's, plus each branch capability that admitted
          // a branch run into it.
          let expiresAtMs = yield* requireWorkspace
          const runIds = yield* covered
          const visible: Array<JournalEvent.RunId> = []
          for (const runId of runIds) {
            const branchId = branchOfRunId(runId)
            if (branchId === null) {
              visible.push(runId)
              continue
            }
            const claims = yield* branchClaims(branchId, capability)
            if (claims === null) continue
            expiresAtMs = Math.min(expiresAtMs, claims.expiresAtMs)
            visible.push(runId)
          }
          return { runIds: visible, expiresAtMs }
        })

    /**
     * Refuses a cursor set that names one run twice.
     *
     * The read position came from the FIRST occurrence and the echoed response
     * state from the LAST, so a request carrying `[{r,0},{r,2}]` read after 0
     * and answered with 2: a follower that persisted the returned cursors, as
     * the protocol tells it to, skipped entries the page never carried. There
     * is no correct choice between the two readings, so neither is made.
     */
    const requireUniqueCursors = (cursors: SyncProtocol.WorkspaceCursor): Effect.Effect<void, SyncError> => {
      const duplicate = SyncProtocol.duplicateCursorRunId(cursors)
      return duplicate === undefined ? Effect.void : Effect.fail(
        new SyncError({
          code: "invalid_request",
          message: `Cursors name run ${duplicate} more than once`
        })
      )
    }

    // Compare around every durable read as well as while idle: a rewind can
    // happen in another process and can reuse every sequence in the next page.
    const generationOf = (runId: JournalEvent.RunId, expected?: number) =>
      Effect.gen(function*() {
        const current = journal.generation === undefined
          ? { generation: 0, afterSeq: -1 }
          : yield* journal.generation(runId).pipe(Effect.mapError(journalFailure(runId)))
        if (expected !== undefined && current.generation !== expected) {
          return yield* Effect.fail(
            new SyncError({
              code: "lineage_changed",
              message: `Run ${runId} was rewound; rebuild from the archive boundary`,
              rewind: { runId, ...current }
            })
          )
        }
        return current.generation
      })

    /**
     * One generation-fenced page of one run's unserved entries.
     *
     * This is the whole of the rewind invariant for both paged paths: the
     * generation is compared BEFORE the read, so a cursor from a superseded
     * lineage is refused rather than served, and again AFTER it, so a rewind
     * that lands mid-read cannot deliver the replacement history's sequences
     * as if they continued the old one. The two comparisons only mean
     * anything together, so they live in one place rather than at each call
     * site. The page read and the paged read (see {@link read} and the
     * workspace tail in {@link workspaceStream}) differ in nothing but the
     * page size and where they keep the expected generation.
     */
    const readPage = (
      runId: JournalEvent.RunId,
      after: JournalEvent.Seq | undefined,
      expectedGeneration: number | undefined,
      limit: number
    ): Effect.Effect<
      {
        readonly admitted: ReadonlyArray<JournalEvent.Entry>
        readonly generation: number
        readonly hasMore: boolean
      },
      SyncError
    > =>
      Effect.gen(function*() {
        const generation = yield* generationOf(runId, expectedGeneration)
        const page = yield* journal.entries({
          runId,
          ...(after === undefined ? {} : { after }),
          limit
        }).pipe(Effect.mapError(journalFailure(runId, generation)))
        yield* generationOf(runId, generation)
        const admitted = yield* Admission.entries(page.entries, runId, after ?? -1)
        return { admitted, generation, hasMore: page.hasMore }
      })

    const snapshot = (input: SyncProtocol.SnapshotRequest): Effect.Effect<SyncProtocol.Snapshot, SyncError> =>
      Effect.gen(function*() {
        const request = yield* SnapshotBoundary.request(input)
        const { expiresAtMs } = yield* runIdsFor({ _tag: "Run", runId: request.runId }, request.capability)
        if (expiresAtMs <= (yield* Clock.currentTimeMillis)) return yield* Effect.fail(expired)
        if (Option.isNone(snapshots)) {
          return yield* Effect.fail(new SyncError({ code: "not_found", message: "Public snapshots are unavailable" }))
        }
        const supplied = yield* Effect.suspend(() => snapshots.value.read({ ...request })).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.logWarning(
              "The public snapshot provider failed",
              cause
            ).pipe(Effect.andThen(Effect.fail(
              new SyncError({ code: "not_found", message: "Public snapshot is unavailable" })
            )))
          )
        )
        // A slow provider may finish after the credential that admitted it expires.
        if (expiresAtMs <= (yield* Clock.currentTimeMillis)) return yield* Effect.fail(expired)
        return yield* SnapshotBoundary.response(request, supplied, maxFrameBytes)
      })

    const read = (input: SyncProtocol.ReadRequest): Effect.Effect<SyncProtocol.ServerReadResponse, SyncError> =>
      Effect.gen(function*() {
        const request = {
          ...input,
          ...yield* Admission.decode(SyncProtocol.RequestEnvelope, input, "invalid_request")
        }
        yield* requireVersion(request.protocolVersion)
        yield* requireUniqueCursors(request.cursors)
        // The schema bounds `limit` at the wire; this bounds it again for an
        // in-process caller that constructed the request directly, so no path
        // reaches the journal with an unbounded page size. BOTH halves of that
        // bound are re-applied, not just the ceiling: clamping alone let a
        // `NaN` through — `Math.min` propagates it, `entries.length >= NaN` is
        // false so no loop ever stopped, and the value arrived at
        // `journal.entries` as the page size once per covered run — and let a
        // zero or a negative ask the journal for a page it cannot serve.
        // `subscribe` has floored `credit` since it was written; this is the
        // same floor on the same kind of value.
        const limit = yield* requestCount("A read's limit", request.limit, SyncProtocol.maxReadLimit)
        const { runIds } = yield* runIdsFor(request.scope, request.capability)
        const entries: Array<JournalEvent.Entry> = []
        const cursors = new Map(request.cursors.map((cursor) => [cursor.runId, cursor.afterSeq]))
        const generations = new Map(request.cursors.map((cursor) => [cursor.runId, cursor.generation ?? 0]))
        let frameBytes = 0
        // Runs that still had more when their share ran out, in the order the
        // page visited them. They get the budget the page did not spend.
        const behind: Array<JournalEvent.RunId> = []

        /**
         * Serves at most `cap` of one run's unserved entries into the page.
         *
         * The byte ceiling is a PAGE budget, not a verdict on the read. A run
         * whose next unserved entries sum past 2 MiB is ordinary — branch
         * commands are admitted individually up to 1 MiB, so three
         * 800 KB commands produce it — and failing the read for it wedged the
         * follower forever: `frame_too_large` is neither retried nor
         * retryable, and the client's next bootstrap carries the same cursors
         * and gets the same refusal. So the page stops at the budget and
         * reports `done: false`; only an entry that alone outgrows the
         * ceiling still refuses, because no page can ever carry it.
         */
        const serve = (runId: JournalEvent.RunId, cap: number): Effect.Effect<ServeOutcome, SyncError> =>
          Effect.gen(function*() {
            const after = cursors.get(runId)
            const { admitted, generation, hasMore } = yield* readPage(runId, after, generations.get(runId), cap)
            generations.set(runId, generation)
            for (const accepted of admitted) {
              const bytes = SyncProtocol.encodedByteLength(accepted)
              if (bytes > maxFrameBytes) return { _tag: "oversized", bytes }
              if (frameBytes + bytes > maxFrameBytes) return { _tag: "truncated" }
              frameBytes += bytes
              entries.push(accepted)
              // Cursors track what was SERVED, not what was read, so the next
              // page resumes at the first entry this one dropped: no entry is
              // skipped and none is served twice.
              cursors.set(runId, accepted.seq)
            }
            return hasMore ? { _tag: "more" } : { _tag: "drained" }
          })

        /**
         * Serves runs in the given order until one of them ends the page.
         *
         * Returns what ended it, or `undefined` when the pass reached the end
         * of its runs with the page still open. A full page ends the pass but
         * is not an outcome of any one run, so it reads as `undefined` too and
         * is answered by `entries.length` below.
         *
         * `more` collects the runs that still had entries left. It is an
         * argument rather than the return value because the second pass reads
         * the list the first one filled, and appending to the array being
         * iterated would serve a run twice in one page.
         */
        const pass = (
          runs: Iterable<JournalEvent.RunId>,
          cap: () => number,
          more: Array<JournalEvent.RunId>
        ): Effect.Effect<PageStop | undefined, SyncError> =>
          Effect.gen(function*() {
            for (const runId of runs) {
              if (entries.length >= limit) return undefined
              const outcome = yield* serve(runId, cap())
              if (outcome._tag === "more") more.push(runId)
              if (outcome._tag === "truncated" || outcome._tag === "oversized") return outcome
            }
            return undefined
          })

        // Serve the least advanced cursors first, with stable run-id ties.
        // A page may have fewer slots than runs, or exhaust its byte budget
        // mid-share. Restarting in catalog order then starved later runs on
        // EVERY page. Served cursors strictly advance; pending ones keep
        // their priority until reached. Empty runs spend no budget. This is
        // scheduling only, not a comparison of events across runs, and works
        // even when clients reorder cursors or requests hit another server.
        const pending = [...runIds].sort((left, right) => (cursors.get(left) ?? -1) - (cursors.get(right) ?? -1))
        const share = Math.max(1, Math.floor(limit / Math.max(runIds.length, 1)))
        const shares = yield* pass(pending, () => Math.min(share, limit - entries.length), behind)
        // The budget the shares did not spend, offered back in the same order.
        // What this pass leaves behind is discarded: one run reported more, so
        // the page is already unfinished however much of it this pass drains.
        const stop = shares ?? (yield* pass(behind, () => limit - entries.length, []))
        if (stop?._tag === "oversized") return yield* frameTooLarge(stop.bytes)
        return {
          entries,
          cursors: Array.from(cursors, ([runId, afterSeq]) => ({
            runId,
            afterSeq,
            generation: generations.get(runId)!
          })),
          // A run that reported more keeps the read unfinished even when the
          // second pass then drained it: the page is a snapshot of a journal
          // that is still being written, and only an untruncated pass over
          // runs that all reported drained can promise there is nothing left.
          done: stop === undefined && behind.length === 0 && entries.length < limit
        }
      })

    const runStream = (
      runId: JournalEvent.RunId,
      cursors: SyncProtocol.WorkspaceCursor
    ): Stream.Stream<SyncProtocol.ServerFrame, SyncError> =>
      Stream.unwrap(Effect.gen(function*() {
        const supplied = cursors.find((cursor) => cursor.runId === runId)
        const after = supplied?.afterSeq
        const generation = yield* generationOf(runId, supplied === undefined ? undefined : supplied.generation ?? 0)
        let admitted: number = after ?? -1
        const entries = journal.stream({ runId, ...(after === undefined ? {} : { afterSequence: after }) }).pipe(
          Stream.mapError(journalFailure(runId, generation)),
          Stream.chunks,
          Stream.mapEffect((chunk) =>
            Admission.entries(chunk, runId, admitted).pipe(
              Effect.tap(() => generationOf(runId, generation)),
              Effect.tap(guardEntryChunk),
              Effect.map((captured) => {
                for (const entry of captured) admitted = entry.seq
                return captured as readonly [JournalEvent.Entry, ...Array<JournalEvent.Entry>]
              })
            )
          ),
          Stream.flattenArray,
          Stream.mapAccum(
            () => after === undefined ? -1 : after,
            (previous, entry) => [entry.seq, [frameOf(runId, generation, previous, entry)]]
          )
        )
        if (journal.generation === undefined) return entries
        // Journal.stream can stay silent when its sequence cursor is beyond a
        // rewound head. Poll independently so even an idle follower fails typed.
        const guard = Stream.drain(Stream.fromEffectRepeat(
          generationOf(runId, generation).pipe(Effect.delay(tailIntervalMs))
        ))
        return Stream.merge(entries, guard, { haltStrategy: "either" })
      }))

    /**
     * The live tail of a whole workspace.
     *
     * A journal run stream is replay-then-follow: it never ends. One such
     * stream per run is therefore not something a bound can be put on and
     * still serve the workspace — a bounded `Stream.flatMap` over streams that
     * never end fills its slots with the first `concurrency` runs and no run
     * behind them is ever attached. The workspace tail inverts that. It reads
     * each covered run's unserved entries as a finite page walk, so the bound
     * limits how many reads are open at once. A catalog-wide round visits
     * every covered run; it runs at open, on a catalog announcement, and once
     * {@link defaultTailIntervalMs} has passed since the last one. A wake for
     * a journal entry committed in this process, or for a run whose page
     * reported more, reads only the runs marked dirty, so a spaced append
     * costs one read and not one per covered run. The bound is what is open
     * at once; a full round's work and the served positions grow with the
     * runs the subscription covers, and freshness of another process's writes
     * is a function of the interval.
     *
     * A run-scoped subscription does not go through here: it follows one
     * journal stream directly (see {@link runStream}) and keeps that stream's
     * in-process wake.
     */
    const workspaceStream = (
      covering: ReadonlyArray<JournalEvent.RunId>,
      openedUntil: number,
      request: SyncProtocol.SubscribeRequest
    ): Stream.Stream<SyncProtocol.ServerFrame, SyncError> =>
      Stream.unwrap(Effect.gen(function*() {
        // How far each run this subscription has ever covered was served.
        // A run the catalog stops naming keeps its position here and simply
        // stops being read: dropping the position instead would re-serve the
        // run's history from the request's own cursor if the catalog ever
        // named it again, which is the one thing this stream promises not to
        // do. The map is bounded by the runs one subscription sees, which is
        // what it has always been.
        const served = new Map<JournalEvent.RunId, JournalEvent.Seq | undefined>()
        const generations = new Map(request.cursors.map((cursor) => [cursor.runId, cursor.generation ?? 0]))
        // Runs the catalog names that this request may not read. Remembered so
        // one refusal costs one signature check for the life of the
        // subscription rather than one per round per run.
        const excluded = new Set<JournalEvent.RunId>()
        // The runs the NEXT round reads: the catalog's current list, minus
        // what this request may not read. `reconcile` is what moves it.
        let visible: ReadonlySet<JournalEvent.RunId> = new Set(covering)
        // The soonest expiry of every credential this subscription now rests
        // on. It only ever moves EARLIER: `runIdsFor` seeds it from the
        // credentials the request opened with, and `reconcile` lowers it when
        // it admits a branch run the catalog named later. Each round arms its
        // own deadline from this, so a capability discovered mid-subscription
        // bounds the frames it authorizes just as the opening ones do.
        let deadline = openedUntil
        // Runs with something known to be waiting: an entry committed in this
        // process, or a page that reported more. A wake for them reads THESE
        // runs and nothing else; the catalog-wide round is what the opening,
        // an announcement, and the interval pay for. A Set coalesces a burst
        // on one run into one read, and it only ever names covered runs, so
        // it is bounded by what `served` is bounded by.
        let dirty = new Set<JournalEvent.RunId>()
        // Set by an announcement: the next wake re-lists the catalog whatever
        // `dirty` holds, since the announced run is not covered yet.
        let announced = false
        // When the last catalog-wide round began. A wake that arrives once
        // the interval has elapsed since then runs a full round, so local
        // appends faster than the interval cannot defer reconciliation of
        // removals, generation changes, and other processes' writes forever.
        let reconciledAtMs = -Infinity
        // Published when `reconcile` lowers `deadline`, so the expiry
        // interrupt below re-arms at the earlier moment.
        const lowered = yield* PubSub.sliding<void>(1)
        const loweredSignal = yield* PubSub.subscribe(lowered)
        // Every caller establishes that the run has no position yet:
        // `covering` is a deduplicated list, and `reconcile` skips what it
        // already holds.
        const cover = (runId: JournalEvent.RunId): void => {
          served.set(runId, cursorOf(request.cursors, runId))
        }
        for (const runId of covering) cover(runId)

        // Sliding by one: a wake published while a round is running is
        // remembered, and never more than one round's worth of them.
        const wake = yield* PubSub.sliding<void>(1)
        const woken = yield* PubSub.subscribe(wake)

        /**
         * Re-reads the catalog and decides what the next round covers.
         *
         * Trusting the announcement feed alone broke in both directions.
         * A run created between `runIdsFor`'s list and the moment
         * `catalog.changes` is actually pulled is announced to nobody and
         * absent from the initial list, so it stayed invisible for the life
         * of the subscription; both catalogs publish through a SLIDING
         * PubSub, so a subscriber that fell behind lost an announcement
         * permanently. In the other direction nothing published a removal at
         * all, so a retention-collected run was queried once per interval
         * forever. The README already promised the fix: `list` is the
         * authoritative state and a subscriber that loses a notification
         * re-lists.
         */
        const reconcile = Effect.gen(function*() {
          // Deduplicated at the seam: a host catalog that names a run twice
          // would otherwise put two tails of it in one round, both reading
          // the same served position and emitting the same frames.
          const present = new Set(yield* catalog.list)
          for (const runId of excluded) {
            if (!present.has(runId)) excluded.delete(runId)
          }
          const next: Array<JournalEvent.RunId> = []
          for (const runId of present) {
            if (excluded.has(runId)) continue
            if (!served.has(runId)) {
              // An `unauthorized` run is skipped; a signer fault propagates,
              // so "the signer is broken" is never reported as "not
              // authorized".
              const until = yield* followUntil(runId, request.capability)
              if (until === null) {
                excluded.add(runId)
                continue
              }
              if (until < deadline) {
                deadline = until
                yield* PubSub.publish(lowered, undefined)
              }
              cover(runId)
            }
            next.push(runId)
          }
          // The deadline is not checked here: the interrupt below enforces
          // it, and re-arms whenever this round lowered it, so a round that
          // begins under a lapsed credential is ended before it emits.
          reconciledAtMs = yield* Clock.currentTimeMillis
          visible = new Set(next)
        })

        /**
         * One BOUNDED page of one run's unserved entries, as frames.
         *
         * A run with more waiting does not recurse here; it publishes a wake
         * and returns, so its `flatMap` slot is released and the next round
         * picks it up. Recursing held the slot for as long as the run stayed
         * behind, which meant `concurrency` sustained-hot runs pinned every
         * slot, the round never completed, and every run behind them was
         * never attached at all rather than merely delayed.
         */
        const tail = (runId: JournalEvent.RunId): Stream.Stream<SyncProtocol.ServerFrame, SyncError> =>
          Stream.unwrap(Effect.gen(function*() {
            const after = served.get(runId)
            const { admitted, generation, hasMore } = yield* readPage(
              runId,
              after,
              generations.get(runId),
              tailBatchSize
            )
            generations.set(runId, generation)
            yield* guardEntryChunk(admitted)
            const frames: Array<SyncProtocol.ServerFrame> = []
            let previous = after === undefined ? -1 : after
            for (const accepted of admitted) {
              frames.push(frameOf(runId, generation, previous, accepted))
              previous = accepted.seq
            }
            const last = admitted.at(-1)
            // An empty page ends the walk whatever the page claims, so a
            // journal that reports more without returning any cannot spin.
            if (last === undefined) return Stream.empty
            served.set(runId, last.seq)
            // A backlog costs another round, not another slot. The wake makes
            // that round start at once rather than at the next interval, and
            // it reads this run and the other dirty ones, not the workspace.
            if (hasMore) {
              dirty.add(runId)
              yield* PubSub.publish(wake, undefined)
            }
            return Stream.fromIterable(frames)
          }))

        /**
         * One pass over every covered run, `concurrency` reads open at most,
         * against the run set the catalog names right now. Anything marked
         * dirty is read by this pass, so the set starts over; a run marked
         * while the pass runs is remembered for the next wake.
         */
        const fullRound = Stream.unwrap(Effect.map(
          reconcile,
          () => {
            dirty = new Set()
            announced = false
            return Stream.flatMap(Stream.fromIterable(visible), tail, { concurrency })
          }
        ))

        /**
         * One pass over the dirty runs only, under the same bound. No catalog
         * read: a dirty run is by construction one this subscription already
         * covers, and a run the catalog has since dropped is skipped.
         */
        const dirtyRound = Stream.suspend(() => {
          const runs = dirty
          dirty = new Set()
          return Stream.flatMap(
            Stream.fromIterable(Array.from(runs).filter((runId) => visible.has(runId))),
            tail,
            { concurrency }
          )
        })

        /** Which pass a tick pays for. */
        const roundFor = (
          tick: "wake" | "interval"
        ): Effect.Effect<Stream.Stream<SyncProtocol.ServerFrame, SyncError>> =>
          Effect.map(
            Clock.currentTimeMillis,
            (nowMs) =>
              tick === "interval" || announced || nowMs - reconciledAtMs >= tailIntervalMs
                ? fullRound
                : dirtyRound
          )

        // An announcement is a WAKE and nothing else: the round that follows
        // reads the catalog itself and authorizes what it finds. Covering the
        // announced run here as well made the notification feed a second,
        // weaker source of truth — one that could never remove a run and that
        // lost a run permanently whenever its sliding feed overflowed.
        // Draining keeps this a control path that emits nothing.
        const announcements = Stream.drain(Stream.tap(
          catalog.changes,
          () =>
            Effect.suspend(() => {
              announced = true
              return PubSub.publish(wake, undefined)
            })
        ))

        // An entry committed in this process marks its run dirty and wakes
        // the pass that reads it. The interval is the freshness policy for
        // the runs another engine process owns, which reach this one only
        // through the database; it must not also be what a follower waits
        // for an entry written beside it. `Journal.changes` is one
        // process-wide sliding feed of every committed entry, so this costs
        // one subscription per workspace subscription — not one per run — and
        // the fan-out bound is unchanged. A run this subscription does not
        // cover is left to the announcement path, which covers it and wakes
        // the round itself. A wake the feed slides away under a burst costs
        // its entry at most one interval, which is what a write from another
        // process already waits.
        const commits = yield* journal.changes
        const appends = Stream.fromSubscription(commits).pipe(
          Stream.filter((entry) => served.has(entry.runId)),
          Stream.tap((entry) =>
            Effect.suspend(() => {
              dirty.add(entry.runId)
              return PubSub.publish(wake, undefined)
            })
          ),
          Stream.drain
        )

        const ticks = Stream.fromEffectRepeat(
          Effect.raceFirst(
            Effect.as(PubSub.take(woken), "wake" as const),
            Effect.as(Effect.sleep(tailIntervalMs), "interval" as const)
          )
        )

        // The deadline, enforced as it moves: sleeps until it and starts over
        // whenever `reconcile` lowers it, so a branch admitted after the
        // subscription opened ends the stream at ITS expiry — not one round
        // later, and not never, should a round stall in a journal read. An
        // in-process owner opens with no deadline and gains one only through
        // such an admission.
        const untilDeadline: Effect.Effect<never, SyncError> = Effect.gen(function*() {
          while (true) {
            const nowMs = yield* Clock.currentTimeMillis
            if (nowMs >= deadline) {
              return yield* Effect.fail(expired)
            }
            yield* Number.isFinite(deadline)
              ? Effect.raceFirst(Effect.sleep(deadline - nowMs), PubSub.take(loweredSignal))
              : PubSub.take(loweredSignal)
          }
        })

        return Stream.interruptWhen(
          Stream.merge(
            Stream.merge(
              Stream.concat(
                fullRound,
                Stream.flatMap(ticks, (tick) => Stream.unwrap(roundFor(tick)))
              ),
              announcements
            ),
            appends
          ),
          untilDeadline
        )
      }))

    /**
     * Ends a subscription when the credential that opened it stops
     * authorizing.
     *
     * Authorization is one-shot at open, and a journal follow never ends on
     * its own, so without this a holder of an expired capability kept reading
     * for as long as it declined to disconnect. The refusal is typed and
     * carries the same `unauthorized` code a fresh request would be refused
     * with. An in-process owner has no credential and therefore no deadline.
     * A workspace subscription's deadline moves as reconciliation admits
     * branches, so it arms its own (see {@link workspaceStream}); this is
     * the run-scoped subscription's.
     */
    const untilExpiry = (
      expiresAtMs: number,
      stream: Stream.Stream<SyncProtocol.ServerFrame, SyncError>
    ): Stream.Stream<SyncProtocol.ServerFrame, SyncError> =>
      Number.isFinite(expiresAtMs)
        ? Stream.interruptWhen(
          stream,
          Effect.flatMap(
            Clock.currentTimeMillis,
            (nowMs) => Effect.andThen(Effect.sleep(Math.max(expiresAtMs - nowMs, 0)), Effect.fail(expired))
          )
        )
        : stream

    const subscribe = (input: SyncProtocol.SubscribeRequest): Stream.Stream<SyncProtocol.ServerFrame, SyncError> =>
      Stream.unwrap(
        Effect.gen(function*() {
          const request = {
            ...input,
            ...yield* Admission.decode(SyncProtocol.RequestEnvelope, input, "invalid_request")
          }
          yield* requireVersion(request.protocolVersion)
          yield* requireUniqueCursors(request.cursors)
          // The schema bounds `credit` at the wire; this bounds it again for
          // an in-process caller that constructed the request directly.
          const credit = yield* requestCount(
            "A subscription's credit",
            request.credit,
            SyncProtocol.maxSubscribeCredit
          )
          const { expiresAtMs, runIds } = yield* runIdsFor(request.scope, request.capability)
          const frames = request.scope._tag === "Run"
            ? untilExpiry(expiresAtMs, runStream(request.scope.runId, request.cursors))
            : workspaceStream(runIds, expiresAtMs, request)
          return Stream.take(frames, credit)
        })
      )

    return SyncServer.of({ snapshot, read, subscribe })
  })

/**
 * Constructs the workspace sync server with default policy.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeLive: Effect.Effect<Service, never, Journal.Journal | RunCatalog.RunCatalog> = makeWith(defaults)

/**
 * Constructs the workspace sync server over a journal and a run catalog, under
 * an explicit policy.
 *
 * Every option is validated as a positive safe integer at construction, so a
 * policy fails loudly instead of quietly not existing: the TypeScript type
 * says `number`, and `maxFrameBytes: NaN` made every `bytes > maxFrameBytes`
 * comparison false, which disabled the ceiling it configured.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeLiveWith = (
  options: Options = {}
): Effect.Effect<Service, SyncError, Journal.Journal | RunCatalog.RunCatalog> =>
  Effect.flatMap(
    Effect.all({
      maxFrameBytes: positiveInt("SyncServer.Options.maxFrameBytes", options.maxFrameBytes, defaults.maxFrameBytes),
      concurrency: positiveInt("SyncServer.Options.concurrency", options.concurrency, defaults.concurrency),
      tailIntervalMs: positiveInt(
        "SyncServer.Options.tailIntervalMs",
        options.tailIntervalMs,
        defaults.tailIntervalMs
      )
    }),
    makeWith
  )

/**
 * Provides the workspace sync server.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<SyncServer, never, Journal.Journal | RunCatalog.RunCatalog> = Layer.effect(
  SyncServer,
  makeLive
)

/**
 * Provides the workspace sync server under an explicit policy. Fails with
 * `invalid_request` when an option is not a positive safe integer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWith = (
  options: Options
): Layer.Layer<SyncServer, SyncError, Journal.Journal | RunCatalog.RunCatalog> =>
  Layer.effect(SyncServer, makeLiveWith(options))

/**
 * Provides the sync RPC handlers over the sync server: a thin, honest
 * projection of {@link Service} onto the wire, mirroring
 * `BranchServer.layerHandlers`. Serving these handlers requires an
 * implementation of the group's `SyncAuth` middleware — `SyncAuth.layer` is
 * the production one — and without a middleware-installed principal every
 * request runs as anonymous and non-branch reads are refused.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHandlers: Layer.Layer<
  Rpc.ToHandler<RpcGroup.Rpcs<typeof SyncRpcs>>,
  never,
  SyncServer
> = SyncRpcs.toLayer(
  Effect.gen(function*() {
    const sync = yield* SyncServer
    return SyncRpcs.of({
      "Sync.Snapshot": (request) => sync.snapshot(request),
      "Sync.Read": (request) => sync.read(request),
      "Sync.Subscribe": (request) => sync.subscribe(request)
    })
  })
)
