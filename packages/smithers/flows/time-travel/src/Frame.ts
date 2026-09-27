/**
 * The coordinate system time travel addresses history with.
 *
 * Every time-travel operation names a point in a run's past as a `Frame` —
 * a lineage plus a journal sequence number — and every operation that creates
 * a new run from that point records a `LineageEdge` back to it. Together they
 * are the whole addressing scheme: a frame says *where*, an edge says *what
 * came from there*, and the two are what `docs/concepts/frames-and-lineage.md`
 * calls the lineage tree.
 *
 * A lineage is not a run. A fork or a continuation starts a new run but may
 * keep walking the same lineage, which is why `Frame` carries `lineageId`
 * rather than `runId`: the run that a frame belongs to is a property of the
 * lineage tree, not of the coordinate.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * A point in one lineage's history: the journal sequence number `seq` within
 * lineage `lineageId`.
 *
 * `seq` counts journal records, so frame `n` means "after the first `n`
 * records were durable". Frame `0` is the state before the run wrote
 * anything, which makes it the only frame that is always addressable.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Frame = Schema.Struct({
  lineageId: Schema.NonEmptyString,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
/**
 * The value form of {@link Frame}.
 *
 * @since 0.1.0
 * @category models
 */
export type Frame = typeof Frame.Type
/**
 * Why a child lineage exists, and therefore what its parent may still assume
 * about it.
 *
 * `child` is an ordinary nested run the parent spawned; `fork` is a
 * time-travel branch that copied a prefix of the parent's journal and now runs
 * alongside it; `continuation` is the parent carrying on under a new run id
 * after a rewind truncated it. Only `fork` produces two live runs sharing a
 * past, which is why rewind treats forked descendants differently from the
 * other two.
 *
 * @since 0.1.0
 * @category schemas
 */
export const LineageEdgeKind = Schema.Literals(["child", "fork", "continuation"])
/**
 * The value form of {@link LineageEdgeKind}.
 *
 * @since 0.1.0
 * @category models
 */
export type LineageEdgeKind = typeof LineageEdgeKind.Type
/**
 * One parent→child link in the lineage tree, anchored at the parent frame the
 * child branched from.
 *
 * `attached` distinguishes the two states a descendant can be in when its
 * parent rewinds past `parentSeq`: an attached child still depends on the
 * history being truncated and must be dealt with, a detached one has been cut
 * loose and survives the rewind as an independent run. It is the flag the
 * rewind's detached-child policy reads.
 *
 * @since 0.1.0
 * @category schemas
 */
export const LineageEdge = Schema.Struct({
  parentRunId: Schema.NonEmptyString,
  parentSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  childRunId: Schema.NonEmptyString,
  kind: LineageEdgeKind,
  attached: Schema.Boolean
})
/**
 * The value form of {@link LineageEdge}.
 *
 * @since 0.1.0
 * @category models
 */
export type LineageEdge = typeof LineageEdge.Type
/**
 * The journal event type marking a run as fork-created.
 *
 * A forked run says so on its own journal, so a cross-fork timeline can start from any child and walk back
 * without consulting the edge table. The record sits directly above the copied
 * prefix and carries `(parentRunId, forkJournalOffset)`.
 *
 * @since 0.1.0
 * @category constants
 */
export const forkCreatedEventType = "flows.time-travel.fork-created"
/**
 * The payload of a {@link forkCreatedEventType} record: which run this one was
 * forked from, and how much of that run's journal was copied.
 *
 * `forkJournalOffset` is the parent `seq` the fork was taken at, so the child's
 * own records begin at that offset — reading it back is how a forensic walk
 * maps a child sequence number onto the parent's timeline.
 *
 * @since 0.1.0
 * @category schemas
 */
export const ForkCreated = Schema.Struct({
  parentRunId: Schema.NonEmptyString,
  forkJournalOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  childRunId: Schema.NonEmptyString
})
/**
 * The value form of {@link ForkCreated}.
 *
 * @since 0.1.0
 * @category models
 */
export type ForkCreated = typeof ForkCreated.Type
