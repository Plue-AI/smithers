/**
 * The persistence contract time travel reads history through.
 *
 * `TimeTravelStore` is the only thing that knows how a run's past is stored.
 * It answers the two questions replay cannot answer on its own — what the
 * tier-2 anchors were at a frame, and what state and attempts existed there —
 * and it owns the three mutations time travel performs: writing the audit
 * trail of an in-flight rewind, truncating a run back to a frame, and creating
 * a fork off one. Everything else in the package is a policy layered over this
 * interface.
 *
 * Two implementations satisfy it: `MemoryTimeTravelStore` for tests and
 * browser use, and `SqlTimeTravelStore` for a durable database. They are held
 * to the same behaviour, so a run inspected under one must be inspected
 * identically under the other.
 *
 * `docs/concepts/frames-and-lineage.md` and `docs/concepts/derived-state.md`
 * describe the model this contract serves.
 *
 * @since 0.1.0
 */

import * as JournalEvent from "@smthrs/journal/JournalEvent"
import type { OwnerId } from "@smthrs/journal/OwnerId"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Frame, LineageEdge } from "./Frame.ts"
import { error, type TimeTravelError } from "./TimeTravelError.ts"
/**
 * The tier-2 anchor recorded at a frame: the jj pointer current when that seq
 * was journaled, and the plan digest in force.
 *
 * These two are exactly the things
 * replay cannot derive and the frame must therefore carry. `planDigest` is
 * optional because a run driven without a persisted plan has none — an absent
 * digest means "no plan was in force", never "the digest was lost".
 *
 * @since 0.1.0
 * @category models
 */
export const Snapshot = Schema.Struct({
  runId: Schema.NonEmptyString,
  frame: Frame,
  changeId: Schema.NonEmptyString,
  /**
   * The jj operation that recorded `changeId`, when the host reported one. A
   * whole-repository rewind restores it; an anchor without one supports only
   * a tree restore.
   */
  operationId: Schema.optionalKey(Schema.NonEmptyString),
  planDigest: Schema.optionalKey(Schema.NonEmptyString)
})
/**
 * The value form of {@link Snapshot}.
 *
 * @since 0.1.0
 * @category models
 */
export type Snapshot = typeof Snapshot.Type
/**
 * The attempt rows that existed at a frame, addressed the way
 * `flows_attempts` addresses them.
 *
 * A fork copies exactly this set rather than every attempt the parent ever
 * ran: an attempt that started after the frame is not part of the history the
 * child inherits.
 *
 * @since 0.1.0
 * @category models
 */
export const AttemptRef = Schema.Struct({
  stepKeyDigest: JournalEvent.Identifier,
  attempt: JournalEvent.NonNegativeQuantity
})
/**
 * The value form of {@link AttemptRef}.
 *
 * @since 0.1.0
 * @category models
 */
export type AttemptRef = typeof AttemptRef.Type
/**
 * A step result a fork replaces on its child: the attempt `stepKeyDigest`
 * names replays `result` instead of the value the parent recorded.
 *
 * `result` is the step's encoded success value, the form an attempt row keeps;
 * the child's replay decodes it under the step's declared success schema, so a
 * value the schema refuses fails the child at that step rather than passing.
 *
 * @since 1.0.0
 * @category models
 */
export const StepOverride = Schema.Struct({
  stepKeyDigest: JournalEvent.Identifier,
  result: Schema.Json
})
/**
 * The value form of {@link StepOverride}.
 *
 * @since 1.0.0
 * @category models
 */
export type StepOverride = typeof StepOverride.Type
/**
 * A run's descendants at a frame, split by whether they still depend on the
 * history under that frame.
 *
 * `attached` children are the ones a rewind must resolve — cancel them, detach
 * them, or refuse — because truncating the parent would cut history out from
 * under them. `detached` children have already been cut loose and are reported
 * only so the operation can say what it left running.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Descendants = Schema.Struct({ attached: Schema.Array(LineageEdge), detached: Schema.Array(LineageEdge) })
/**
 * The value form of {@link Descendants}.
 *
 * @since 0.1.0
 * @category models
 */
export type Descendants = typeof Descendants.Type
/**
 * The durable record of one rewind attempt, written before the rewind touches
 * anything and updated as it progresses.
 *
 * The audit row is what makes a rewind crash-safe: recovery reads back the
 * `in_progress` rows on layer build and either finishes or rolls back the
 * operation that owned each one. `rateLimit` and `detail` stay `Unknown`
 * because they are diagnostic payloads the store never interprets.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Audit = Schema.Struct({
  id: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  frame: Frame,
  status: Schema.Literals(["in_progress", "completed", "failed"]),
  rateLimit: Schema.optionalKey(Schema.Unknown),
  detail: Schema.optionalKey(Schema.Unknown)
})
/**
 * The value form of {@link Audit}.
 *
 * @since 0.1.0
 * @category models
 */
export type Audit = typeof Audit.Type
/**
 * The keys an open audit row may be advanced through.
 *
 * `Partial<Audit>` also accepted `id`, `runId`, and `frame`, and the two stores
 * disagreed about them: the memory store merged them, so patching `id` made the
 * audit unreachable by its original key, while the SQL store computed the same
 * merged object and then wrote only these three columns. Naming the patch is
 * what makes the two behavioural peers again, and a store refuses any other key
 * with `invalid` rather than accepting a write it will not perform.
 *
 * @since 0.1.0
 * @category schemas
 */
export const AuditPatch = Schema.Struct({
  status: Schema.optionalKey(Audit.fields.status),
  rateLimit: Schema.optionalKey(Schema.Unknown),
  detail: Schema.optionalKey(Schema.Unknown)
})
/**
 * The value form of {@link AuditPatch}.
 *
 * @since 0.1.0
 * @category models
 */
export type AuditPatch = typeof AuditPatch.Type
/**
 * The keys {@link AuditPatch} admits, in the order a store reports them.
 *
 * Derived from the schema so the two cannot drift: a hand-written copy would
 * refuse a key {@link AuditPatch} had just gained, and nothing in the type
 * checker would say so.
 *
 * @since 0.1.0
 * @category models
 */
export const auditPatchKeys: ReadonlyArray<keyof AuditPatch> = Object.keys(
  AuditPatch.fields
) as ReadonlyArray<keyof AuditPatch>

const admittedAuditPatchKeys = new Set<string>(auditPatchKeys)
/**
 * Refuses a patch carrying a key {@link AuditPatch} does not admit.
 *
 * The check is a runtime one because the offending caller is an untyped one:
 * a JSON surface, or a `Partial<Audit>` value that predates this contract.
 *
 * @since 0.1.0
 * @category validators
 */
export const validateAuditPatch = (patch: AuditPatch): Effect.Effect<AuditPatch, TimeTravelError> => {
  const unknown = Object.keys(patch).find((key) => !admittedAuditPatchKeys.has(key))
  if (unknown !== undefined) {
    return Effect.fail(error("invalid", `audit patch contains unknown key ${unknown}`))
  }
  return Schema.decodeUnknownEffect(AuditPatch)(patch).pipe(
    Effect.mapError((cause) =>
      error(
        "invalid",
        `invalid audit patch: status ${JSON.stringify(patch.status)} is not one of in_progress|completed|failed`,
        cause
      )
    )
  )
}
/**
 * The refusal both stores raise for a fork whose frame addresses no record.
 *
 * One message rather than two: the stores are behavioural peers, and a caller
 * that branches on the refusal must get the same answer from either.
 *
 * @since 0.1.0
 * @category constructors
 */
export const forkFrameMessage = (parentRunId: string, frame: Frame): string =>
  `frame ${frame.lineageId}@${frame.seq} is not a record of ${parentRunId}`
/**
 * Proof that one side effect was compensated during a rewind.
 *
 * A rewind reverts effects by calling their registered rollback handlers; each
 * handler returns an opaque receipt, and the receipt is persisted against the
 * audit row before the journal is truncated. That ordering is what lets
 * recovery tell an effect that was already rolled back from one that never
 * was, so a resumed rewind never compensates the same effect twice.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Receipt = Schema.Struct({
  id: Schema.NonEmptyString,
  auditId: Schema.NonEmptyString,
  effectId: Schema.NonEmptyString,
  receipt: Schema.Unknown
})
/**
 * The value form of {@link Receipt}.
 *
 * @since 0.1.0
 * @category models
 */
export type Receipt = typeof Receipt.Type
/**
 * What a truncation actually did: how many journal records it archived, and
 * which lineage edges it left pointing at history that no longer exists.
 *
 * Archiving is not deletion — the records move aside so a forensic reader can
 * still reach them across sequence reuse, keyed by `(runId, generation, seq)`.
 * The generation is read before truncation advances it. `orphaned` accounts
 * for descendants the operation detached rather than resolved.
 *
 * @since 0.1.0
 * @category schemas
 */
export const ArchiveResult = Schema.Struct({
  archived: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  orphaned: Schema.Array(LineageEdge)
})
/**
 * The value form of {@link ArchiveResult}.
 *
 * @since 0.1.0
 * @category models
 */
export type ArchiveResult = typeof ArchiveResult.Type
/**
 * What `createFork` commits: the child run and its lineage edge back to the
 * parent frame.
 *
 * The disclosure a fork carries is NOT here. A fork normalizes the boundary assessment to warnings — "this
 * effect may execute again on the child" — and that assessment runs above the
 * store, so the warnings belong to the operation's result rather than to the
 * row a store writes. A store returning this pair says nothing about them.
 *
 * @since 0.1.0
 * @category models
 */
export const Fork = Schema.Struct({
  runId: Schema.NonEmptyString,
  edge: LineageEdge
})
/**
 * The value form of {@link Fork}.
 *
 * @since 0.1.0
 * @category models
 */
export type Fork = typeof Fork.Type
/**
 * A fork id that has been minted and durably reserved, whose fork has not
 * committed yet.
 *
 * {@link Service.nextForkId} writes one so a caller can provision the child's
 * jj workspace under the id before any run exists. A fork that commits
 * consumes its intent. An intent whose fork never commits, because the process
 * died between provisioning and commit, is what
 * {@link Service.abandonForkIntents} hands back, so the lane it named can be
 * forgotten and the ordinal it took is never reused for a fresh lane.
 *
 * @since 0.1.0
 * @category schemas
 */
export const ForkIntent = Schema.Struct({
  childRunId: Schema.NonEmptyString,
  parentRunId: Schema.NonEmptyString,
  parentSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reservedAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
/**
 * The value form of {@link ForkIntent}.
 *
 * @since 0.1.0
 * @category models
 */
export type ForkIntent = typeof ForkIntent.Type
/**
 * The operations a time-travel state store must provide.
 *
 * The reads (`snapshotAt`, `stateAt`, `attemptsAt`, `descendants`) reconstruct
 * a frame's past; the audit trio (`writeAudit`, `updateAudit`,
 * `pendingAudits`) makes an in-flight rewind recoverable; and
 * `archiveAndTruncate` and `createFork` are the two mutations that change the
 * lineage tree, and `recordReceipt` writes one compensation receipt against an
 * open audit row without touching it. `nextForkId` sits beside them as the
 * one mint: it names and reserves the child a later `createFork` will write,
 * so a caller can provision that child's workspace before any run exists, and
 * `abandonForkIntents` returns the reservations whose fork never committed so
 * startup can forget the lanes they named.
 * Implement it with {@link make}, or stub it with {@link makeNoop}.
 *
 * @since 0.1.0
 * @category services
 */
export interface Service {
  readonly snapshotAt: (runId: string, frame: Frame) => Effect.Effect<Snapshot | undefined, TimeTravelError>
  /**
   * Records one tier-2 anchor. Written by the snapshot projector, which folds
   * the engine's `snapshot-identified` records; never by a caller.
   */
  readonly recordSnapshot: (snapshot: Snapshot) => Effect.Effect<void, TimeTravelError>
  /**
   * Records a batch of tier-2 anchors in one write. The snapshot projector
   * hands it one journal page's anchors at a time, so a page costs one
   * transaction on the SQL store rather than one per anchor.
   */
  readonly recordSnapshots: (snapshots: ReadonlyArray<Snapshot>) => Effect.Effect<void, TimeTravelError>
  /**
   * The last anchor recorded on each lineage of a run: the projector's resume
   * point. The highest `seq` among them is the run's anchored high-water mark,
   * and each anchor's `changeId` is the pointer a `carried` record on that
   * lineage resolves to. Empty for a run with no anchors.
   */
  readonly latestSnapshots: (runId: string) => Effect.Effect<ReadonlyArray<Snapshot>, TimeTravelError>
  /**
   * The run state AT a frame, derived by replaying the run-decision records up
   * to it — not read off the run row, whose `state_json` is the run's *latest*
   * state (`docs/concepts/derived-state.md`; Temporal's
   * `ndc/state_rebuilder.go`). Returns the encoded JSON, so the caller decides
   * what schema to read it under.
   */
  readonly stateAt: (runId: string, frame: Frame) => Effect.Effect<string | undefined, TimeTravelError>
  /**
   * The attempts that had been admitted at a frame, derived the same way from
   * the attempt lifecycle records.
   */
  readonly attemptsAt: (runId: string, frame: Frame) => Effect.Effect<ReadonlyArray<AttemptRef>, TimeTravelError>
  /**
   * The lineage edges hanging off this run at or after a frame, split into the
   * children a rewind must resolve and the ones already detached from it.
   */
  readonly descendants: (runId: string, frame: Frame) => Effect.Effect<Descendants, TimeTravelError>
  /**
   * Opens the audit trail for a rewind. Written before anything is
   * compensated or truncated, so a crash always leaves a row recovery can
   * find.
   */
  readonly writeAudit: (audit: Audit) => Effect.Effect<void, TimeTravelError>
  /**
   * Advances an open audit row — normally to `completed` or `failed`.
   *
   * The patch is an {@link AuditPatch}: an audit's identity is fixed when it is
   * written, so `id`, `runId`, and `frame` are refused with `invalid` rather
   * than applied by one store and dropped by the other.
   */
  readonly updateAudit: (id: string, patch: AuditPatch) => Effect.Effect<void, TimeTravelError>
  /**
   * Every audit row still `in_progress`: the rewinds a crash interrupted.
   * Recovery drains this on layer build.
   */
  readonly pendingAudits: () => Effect.Effect<ReadonlyArray<Audit>, TimeTravelError>
  /**
   * Truncates a run back to a frame, moving the records above it into the
   * archive rather than deleting them, and persisting the compensation
   * `receipts` that justified the truncation. Clears snapshot anchors above
   * the frame and every anchor belonging to archived attached children.
   *
   * The mutation is fenced on the caller's ownership of the run and every
   * non-terminal attached child. The commit re-checks `flows_runs` for
   * `owner`, and checks each attached child against `childOwners`, inside the
   * same transaction. A missing or terminal child needs no child fence; every
   * other child must have the exact owner supplied in `childOwners`, or the
   * whole mutation is refused with `fence_lost`.
   */
  readonly archiveAndTruncate: (
    runId: string,
    frame: Frame,
    receipts: ReadonlyArray<Receipt>,
    owner: OwnerId,
    childOwners?: ReadonlyMap<string, OwnerId> | undefined
  ) => Effect.Effect<ArchiveResult, TimeTravelError>
  /**
   * Whether the archive holds a record at `(runId, seq)` in any journal
   * generation. This check is generation-agnostic; recovery uses it only after
   * confirming the live suffix is empty. This is recovery's commit-point
   * evidence: an interrupted rewind whose live suffix is gone is
   * only "committed" if the suffix actually landed in the archive — an absence
   * on both sides is corruption to roll back, never success to assume.
   */
  readonly archivedAt: (runId: string, seq: number) => Effect.Effect<boolean, TimeTravelError>
  /**
   * Mints the run id the next fork off `(parentRunId, frame)` will carry and
   * durably reserves it as a {@link ForkIntent}, without creating a run.
   *
   * A fork provisions the child's workspace BEFORE it commits the child, and a
   * workspace named after the parent frame alone collides the moment one frame
   * is forked twice. Minting the id first is what lets the caller name the
   * lane after the child that will live in it, so the two identities are the
   * same identity.
   *
   * The id differs from every fork already committed off that frame AND from
   * every id minted before it, committed or not. The reservation is what makes
   * that true across a crash: a caller that provisioned a lane under one id
   * and died before committing retries under a fresh id, instead of asking jj
   * for a lane name its own leftover already holds.
   */
  readonly nextForkId: (parentRunId: string, frame: Frame) => Effect.Effect<string, TimeTravelError>
  /**
   * Hands back every {@link ForkIntent} reserved before `staleBeforeMs` whose
   * fork never committed, marking each so it is handed back exactly once.
   *
   * The intents stay counted for minting: the lane each one named may still
   * exist on disk, so its ordinal must never name a fresh lane. Startup
   * reclamation forgets the jj workspace each returned intent named.
   */
  readonly abandonForkIntents: (staleBeforeMs: number) => Effect.Effect<ReadonlyArray<ForkIntent>, TimeTravelError>
  /**
   * Branches a new run off `parentRunId` at a frame, copying the journal
   * prefix and the attempts that existed there, and recording the `fork`
   * lineage edge. The parent is untouched and keeps running.
   *
   * `childRunId` is the id {@link Service.nextForkId} minted for this fork.
   * Omitting it mints one inside the same transaction, which is what a caller
   * that provisions nothing beforehand wants.
   *
   * `override` replaces one copied step result in the same transaction. A step
   * with no successful attempt finished at the frame refuses the whole fork
   * with `not_found`, so nothing is committed.
   */
  readonly createFork: (
    parentRunId: string,
    frame: Frame,
    childRunId?: string,
    override?: StepOverride
  ) => Effect.Effect<Fork, TimeTravelError>
  /**
   * Persists one compensation receipt against its audit row, before the
   * journal range that effect belongs to is truncated.
   */
  readonly recordReceipt: (receipt: Receipt) => Effect.Effect<void, TimeTravelError>
}
/**
 * The service key for a {@link Service}. Inject it to read or mutate a run's
 * history; provide it with {@link layerNoop}, `MemoryTimeTravelStore.layer`,
 * or `SqlTimeTravelStore.layer`.
 *
 * @since 0.1.0
 * @category services
 */
export class TimeTravelStore extends Context.Service<TimeTravelStore, Service>()(
  "@smthrs/time-travel/TimeTravelStore"
) {}
/**
 * Brands a {@link Service} implementation as a `TimeTravelStore`, so a new
 * backend is written against the interface and checked at its definition site
 * rather than at the layer.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (implementation: Service): Service => TimeTravelStore.of(implementation)
const unavailable = <A>(method: string): Effect.Effect<A, TimeTravelError> =>
  Effect.fail(error("unknown", `${method} is unavailable`))
/**
 * A store whose every operation fails with an `unknown`-coded
 * {@link TimeTravelError}, except the ones `overrides` supplies.
 *
 * The failing default is deliberate: a test that stubs only the two methods it
 * exercises gets a named failure — not a silent success — the moment the code
 * under test reaches a third. Prefer `MemoryTimeTravelStore` when the test
 * actually needs a working store.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  TimeTravelStore.of({
    snapshotAt: () => unavailable("snapshotAt"),
    recordSnapshot: () => unavailable("recordSnapshot"),
    recordSnapshots: () => unavailable("recordSnapshots"),
    latestSnapshots: () => unavailable("latestSnapshots"),
    stateAt: () => unavailable("stateAt"),
    attemptsAt: () => unavailable("attemptsAt"),
    descendants: () => unavailable("descendants"),
    writeAudit: () => unavailable("writeAudit"),
    updateAudit: () => unavailable("updateAudit"),
    pendingAudits: () => unavailable("pendingAudits"),
    archiveAndTruncate: () => unavailable("archiveAndTruncate"),
    archivedAt: () => unavailable("archivedAt"),
    nextForkId: () => unavailable("nextForkId"),
    abandonForkIntents: () => unavailable("abandonForkIntents"),
    createFork: () => unavailable("createFork"),
    recordReceipt: () => unavailable("recordReceipt"),
    ...overrides
  })
/**
 * Provides {@link makeNoop} as a `TimeTravelStore` layer.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<TimeTravelStore> =>
  Layer.succeed(TimeTravelStore)(makeNoop(overrides))
