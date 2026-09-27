/**
 * Wire schemas shared by the gateway read path, subscriptions, and singleton
 * lifecycle.
 *
 * @since 0.1.0
 */

import { ControlSchema } from "@smthrs/control"
import { Schema } from "effect"
import * as GatewayProjection from "./GatewayProjection.ts"

/**
 * Health response used to prove a singleton belongs to this workspace.
 *
 * @since 0.1.0
 * @category models
 */
export const GatewayHealth = Schema.Struct({
  workspaceHash: Schema.String,
  gatewayId: Schema.String,
  protocolVersion: Schema.String,
  capabilities: Schema.optionalKey(Schema.Array(Schema.String))
})

/**
 * Health response used for singleton identity probes.
 *
 * @since 0.1.0
 * @category models
 */
export type GatewayHealth = typeof GatewayHealth.Type

/**
 * A selector for a workspace-wide run list.
 *
 * @since 0.1.0
 * @category models
 */
export const WorkspaceRunsSelector = Schema.TaggedStruct("workspace-runs", {
  flowId: Schema.optionalKey(Schema.NonEmptyString)
})

/**
 * A selector for a workspace-wide run list.
 *
 * @since 0.1.0
 * @category models
 */
export type WorkspaceRunsSelector = typeof WorkspaceRunsSelector.Type

/**
 * A selector for one run's summary.
 *
 * @since 0.1.0
 * @category models
 */
export const RunSummarySelector = Schema.TaggedStruct("run-summary", { runId: Schema.String })

/**
 * A selector for one run's summary.
 *
 * @since 0.1.0
 * @category models
 */
export type RunSummarySelector = typeof RunSummarySelector.Type

/**
 * A selector for one run's ordered lifecycle events.
 *
 * @since 0.1.0
 * @category models
 */
export const RunEventsSelector = Schema.TaggedStruct("run-events", { runId: Schema.String })

/**
 * A selector for one run's ordered lifecycle events.
 *
 * @since 0.1.0
 * @category models
 */
export type RunEventsSelector = typeof RunEventsSelector.Type

/**
 * A selector for one run's transcript projection.
 *
 * @since 0.1.0
 * @category models
 */
export const TranscriptSelector = Schema.TaggedStruct("transcript", { runId: Schema.String })

/**
 * A selector for one run's transcript projection.
 *
 * @since 0.1.0
 * @category models
 */
export type TranscriptSelector = typeof TranscriptSelector.Type

/**
 * A selector for one run's flattened tree nodes.
 *
 * @since 0.1.0
 * @category models
 */
export const RunTreeSelector = Schema.TaggedStruct("run-tree", { runId: Schema.String })

/**
 * A selector for one run's flattened tree nodes.
 *
 * @since 0.1.0
 * @category models
 */
export type RunTreeSelector = typeof RunTreeSelector.Type

/**
 * A selector for approvals.
 *
 * Without `runId` it lists the workspace's pending gates, which is the
 * approvals inbox. With one it lists that run's gates including the decided
 * ones, which is what a run card renders: a gate a human already answered
 * still belongs on the card that asked.
 *
 * @since 0.1.0
 * @category models
 */
export const ApprovalsSelector = Schema.TaggedStruct("approvals", {
  runId: Schema.optional(Schema.String)
})

/**
 * A selector for approvals.
 *
 * @since 0.1.0
 * @category models
 */
export type ApprovalsSelector = typeof ApprovalsSelector.Type

/**
 * A selector for one node's output projection.
 *
 * @since 0.1.0
 * @category models
 */
export const NodeOutputSelector = Schema.TaggedStruct("node-output", {
  runId: Schema.String,
  nodeId: Schema.String
})

/**
 * A selector for one node's output projection.
 *
 * @since 0.1.0
 * @category models
 */
export type NodeOutputSelector = typeof NodeOutputSelector.Type

/**
 * A selector for one flow's measured node durations.
 *
 * This is the one projection that is neither a workspace listing nor scoped
 * to a run: it folds the history of one flow across the runs that executed
 * it, which is what makes it a prediction rather than a report.
 *
 * @since 0.1.0
 * @category models
 */
export const FlowDurationsSelector = Schema.TaggedStruct("flow-durations", {
  flowId: Schema.String
})

/**
 * A selector for one flow's measured node durations.
 *
 * @since 0.1.0
 * @category models
 */
export type FlowDurationsSelector = typeof FlowDurationsSelector.Type

/** A schema for a tagged selector, whose tag names its projection. */
interface SelectorSchema extends Schema.Top {
  readonly Type: { readonly _tag: string }
}

/** The shape of the served table: one selector paired with one row schema. */
type ServedTable = ReadonlyArray<readonly [SelectorSchema, Schema.Top]>

/**
 * The row schema each served selector answers with.
 *
 * This table is the selector-to-row pairing, and it exists once. The selector
 * union, the projection names, `rowSchemaFor`, `ProjectionSnapshot`,
 * `RowFrame`, and `DeltaFrame` all derive from it, so serving one more
 * projection is one more entry here rather than five mirrored lists that can
 * disagree with each other.
 */
const served = [
  [WorkspaceRunsSelector, GatewayProjection.RunSummaryRow],
  [RunSummarySelector, GatewayProjection.RunSummaryRow],
  [RunEventsSelector, ControlSchema.ControlEvent],
  [TranscriptSelector, GatewayProjection.TranscriptRow],
  [RunTreeSelector, GatewayProjection.RunTreeRow],
  [ApprovalsSelector, GatewayProjection.ApprovalRow],
  [NodeOutputSelector, GatewayProjection.NodeOutputRow],
  [FlowDurationsSelector, GatewayProjection.FlowDurationRow]
] as const satisfies ServedTable

/** The served table as the type every derivation below maps over. */
type Served = typeof served

/**
 * Maps the served table into a tuple whose members keep their own types.
 *
 * `Array.prototype.map` widens a tuple to an array of its element union, which
 * would collapse each derived union into an uncorrelated cross product of
 * every selector with every row. The mapped tuple type each caller names is
 * that correlation, and this restates it for the value.
 */
const overServed = <M>(map: (pair: Served[number]) => unknown): M => served.map(map) as unknown as M

/** The selector schema of each served pair, in table order. */
type SelectorsOf<T extends ServedTable> = { readonly [K in keyof T]: T[K][0] }

/** The projection name of each served pair, in table order. */
type NamesOf<T extends ServedTable> = { readonly [K in keyof T]: T[K][0]["Type"]["_tag"] }

/**
 * A projection selected for a snapshot or watch subscription.
 *
 * @since 0.1.0
 * @category models
 */
export const ProjectionSelector = Schema.Union(
  overServed<SelectorsOf<Served>>(([selector]) => selector)
)

/**
 * A projection selected for a snapshot or watch subscription.
 *
 * @since 0.1.0
 * @category models
 */
export type ProjectionSelector = typeof ProjectionSelector.Type

/**
 * Projection names served by the gateway read path.
 *
 * @since 0.1.0
 * @category models
 */
export const ProjectionName = Schema.Literals(
  overServed<NamesOf<Served>>(([selector]) => selector.fields._tag.schema.literal)
)

/**
 * A gateway projection name.
 *
 * @since 0.1.0
 * @category models
 */
export type ProjectionName = typeof ProjectionName.Type

/** Each served row schema, keyed by the name of the selector it answers. */
type RowSchemas = { readonly [P in Served[number] as P[0]["Type"]["_tag"]]: P[1] }

const rowSchemas = Object.fromEntries(
  served.map(([selector, row]) => [selector.fields._tag.schema.literal, row])
) as RowSchemas

/**
 * The row schema one selector answers with, so a client decodes a snapshot
 * instead of casting it.
 *
 * A literal selector keeps its own row schema: `rowSchemaFor({ _tag:
 * "approvals" })` decodes to `ApprovalRow`, not to the union of every row.
 *
 * @param selector the selector whose row schema the client needs
 * @since 1.0.0
 * @category schemas
 */
export const rowSchemaFor = <S extends ProjectionSelector>(selector: S): RowSchemas[S["_tag"]] =>
  rowSchemas[selector._tag] as RowSchemas[S["_tag"]]

/**
 * The row type one selector's projection is made of.
 *
 * @since 1.0.0
 * @category models
 */
export type RowOf<S extends ProjectionSelector> = RowSchemas[S["_tag"]]["Type"]

/**
 * A monotonic cursor for one projection and optional run scope.
 *
 * `runId` is null for workspace projections and records the source run for
 * per-run projections, even when a selector later gains more fields. Control
 * journal sequences belong to per-run partitions, so no workspace-wide
 * sequence exists. A workspace cursor therefore has value `0` and a null run,
 * and a workspace projection cannot resume from a cursor.
 *
 * @since 0.1.0
 * @category models
 */
export const ProjectionCursor = Schema.Struct({
  selector: ProjectionSelector,
  projection: ProjectionName,
  runId: Schema.NullOr(Schema.String),
  value: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
  ),
  offset: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
  )
})

/**
 * A monotonic projection cursor.
 *
 * @since 0.1.0
 * @category models
 */
export type ProjectionCursor = typeof ProjectionCursor.Type

/** One snapshot member: every row one selector projects, at one cursor. */
const snapshotMember = <S extends Schema.Top, R extends Schema.Top>(selector: S, row: R) =>
  Schema.Struct({ selector, cursor: ProjectionCursor, rows: Schema.Array(row) })

/** One row frame: a single row of one selector's projection. */
const rowMember = <S extends Schema.Top, R extends Schema.Top>(selector: S, row: R) =>
  Schema.TaggedStruct("row", { selector, cursor: ProjectionCursor, row })

/** One delta frame: the rows one selector's projection changed by. */
const deltaMember = <S extends Schema.Top, R extends Schema.Top>(selector: S, row: R) =>
  Schema.TaggedStruct("delta", { selector, cursor: ProjectionCursor, delta: Schema.Array(row) })

type SnapshotMembersOf<T extends ServedTable> = {
  readonly [K in keyof T]: ReturnType<typeof snapshotMember<T[K][0], T[K][1]>>
}

type RowMembersOf<T extends ServedTable> = {
  readonly [K in keyof T]: ReturnType<typeof rowMember<T[K][0], T[K][1]>>
}

type DeltaMembersOf<T extends ServedTable> = {
  readonly [K in keyof T]: ReturnType<typeof deltaMember<T[K][0], T[K][1]>>
}

/**
 * Every row one selector currently projects, and the cursor they were read
 * at. A client that follows the same selector from this cursor sees each
 * later change exactly once.
 *
 * @since 1.0.0
 * @category models
 */
export const ProjectionSnapshot = Schema.Union(
  overServed<SnapshotMembersOf<Served>>(([selector, row]) => snapshotMember(selector, row))
)

/**
 * A projection snapshot and the cursor it was read at.
 *
 * @since 1.0.0
 * @category models
 */
export type ProjectionSnapshot = typeof ProjectionSnapshot.Type

/**
 * The start of a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export const SnapshotStartFrame = Schema.TaggedStruct("snapshot-start", {
  selector: ProjectionSelector,
  cursor: ProjectionCursor
})

/**
 * The start of a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export type SnapshotStartFrame = typeof SnapshotStartFrame.Type

/**
 * A row emitted during a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export const RowFrame = Schema.Union(
  overServed<RowMembersOf<Served>>(([selector, row]) => rowMember(selector, row))
)

/**
 * A row emitted during a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export type RowFrame = typeof RowFrame.Type

/**
 * The end of a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export const SnapshotEndFrame = Schema.TaggedStruct("snapshot-end", {
  selector: ProjectionSelector,
  cursor: ProjectionCursor
})

/**
 * The end of a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export type SnapshotEndFrame = typeof SnapshotEndFrame.Type

/**
 * A projection mutation after snapshot completion.
 *
 * `delta` replaces the selector's rows, except for the two append-only
 * projections: a `run-events` delta carries the one event that arrived and a
 * `transcript` delta carries the rows that event contributed, and a client
 * appends those to the rows it already holds.
 *
 * @since 0.1.0
 * @category models
 */
export const DeltaFrame = Schema.Union(
  overServed<DeltaMembersOf<Served>>(([selector, row]) => deltaMember(selector, row))
)

/**
 * A projection mutation after snapshot completion.
 *
 * @since 0.1.0
 * @category models
 */
export type DeltaFrame = typeof DeltaFrame.Type

/**
 * A keepalive frame for an active subscription.
 *
 * @since 0.1.0
 * @category models
 */
export const HeartbeatFrame = Schema.TaggedStruct("heartbeat", { atMs: Schema.Number })

/**
 * A keepalive frame for an active subscription.
 *
 * @since 0.1.0
 * @category models
 */
export type HeartbeatFrame = typeof HeartbeatFrame.Type

/**
 * A frame sent by the gateway subscription protocol.
 *
 * @since 0.1.0
 * @category models
 */
export const GatewayFrame = Schema.Union([
  SnapshotStartFrame,
  ...RowFrame.members,
  SnapshotEndFrame,
  ...DeltaFrame.members,
  HeartbeatFrame
])

/**
 * A frame sent by the gateway subscription protocol.
 *
 * @since 0.1.0
 * @category models
 */
export type GatewayFrame = typeof GatewayFrame.Type

/**
 * The snapshot one selector answers with.
 *
 * A literal selector keeps its own rows: `SnapshotOf<ApprovalsSelector>` has
 * `ApprovalRow` rows, so a caller reads `requestId` without an assertion. A
 * selector union maps to the snapshot union, which is what a caller holding a
 * selector chosen at runtime still gets.
 *
 * @since 1.0.0
 * @category models
 */
export type SnapshotOf<S extends ProjectionSelector> = Extract<
  ProjectionSnapshot,
  { readonly selector: { readonly _tag: S["_tag"] } }
>

/**
 * The frames one selector's subscription emits.
 *
 * Snapshot brackets and keepalives carry no rows and belong to every
 * selector; the row and delta frames are the selector's own.
 *
 * @since 1.0.0
 * @category models
 */
export type FrameOf<S extends ProjectionSelector> =
  | SnapshotStartFrame
  | SnapshotEndFrame
  | HeartbeatFrame
  | Extract<RowFrame, { readonly selector: { readonly _tag: S["_tag"] } }>
  | Extract<DeltaFrame, { readonly selector: { readonly _tag: S["_tag"] } }>
