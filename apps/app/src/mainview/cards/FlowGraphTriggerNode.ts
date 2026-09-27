/*
 * A schedule on the plan's canvas: the pure half.
 *
 * A trigger is a Dispatcher registration, not a plan node (D-031). It has no
 * step key, it is never `built` or `clean`, and a manual re-run does not
 * re-fire it, so it carries its own state — `disabled` or `armed` — it joins
 * the plan by a UI-only `fires` edge, and it is excluded from every count the
 * plan card states. Nothing here touches React, the DOM or a seam.
 *
 * A trigger is a schedule registered on Smithers Cloud (D-043): every reading
 * below comes off the row it answered with and no field is completed into a
 * value the registry never stated.
 */
import type { Card } from "../state/AppState"
import type { PlanCardNode } from "./FlowGraph"

/** One registered schedule, exactly as the dispatcher card carries it. */
export type TriggerCardRow = Extract<Card, { kind: "trigger-list" }>["payload"]["triggers"][number]

/**
 * What a schedule is doing, in one word (D-031): `disabled` is the flag the
 * registry recorded (`enabled`) — a registration that is off does not fire,
 * whatever its cron reads — and everything else is `armed`.
 */
export type TriggerNodeState = "disabled" | "armed"

/** One trigger as the canvas draws it, with the row it was read from. */
export interface TriggerGraphNode {
  readonly id: string
  readonly state: TriggerNodeState
  readonly row: TriggerCardRow
}

/** One UI-only `fires` edge: this schedule starts that plan node. */
export interface TriggerFiresEdge {
  readonly id: string
  readonly from: string
  readonly to: string
}

/** The trigger half of a plan's graph. */
export interface TriggerGraphPart {
  readonly nodes: ReadonlyArray<TriggerGraphNode>
  readonly edges: ReadonlyArray<TriggerFiresEdge>
}

/** The canvas id of one trigger, namespaced so it can never collide with a plan node's id. */
export const triggerNodeId = (triggerId: string): string => `trigger:${triggerId}`

/** Whether a canvas id names a schedule rather than one of the plan's own nodes. */
export const isTriggerNodeId = (nodeId: string): boolean => nodeId.startsWith("trigger:")

/** @see TriggerNodeState */
export const triggerNodeState = (row: TriggerCardRow): TriggerNodeState =>
  row.enabled === false ? "disabled" : "armed"

/**
 * The schedules that fire one flow, and the edges from each of them into the
 * plan.
 *
 * The edge goes to every ROOT of the plan — the nodes that wait on nothing —
 * because that is what a fire actually starts. A plan with no nodes draws the
 * trigger and no edge rather than an edge into nothing.
 */
export const triggerGraph = (
  rows: ReadonlyArray<TriggerCardRow>,
  flowId: string,
  nodes: ReadonlyArray<PlanCardNode>
): TriggerGraphPart => {
  const matched = rows.filter((row) => row.flowId === flowId)
  const roots = nodes.filter((node) => node.dependsOn.length === 0)
  return {
    nodes: matched.map((row): TriggerGraphNode => ({ id: triggerNodeId(row.id), state: triggerNodeState(row), row })),
    edges: matched.flatMap((row) =>
      roots.map((node): TriggerFiresEdge => ({
        id: `${triggerNodeId(row.id)}->${node.id}`,
        from: triggerNodeId(row.id),
        to: node.id
      }))
    )
  }
}

/**
 * One upcoming fire, read in the zone the schedule declared and in UTC.
 *
 * `zoned` is present only when the schedule named a zone that is not UTC:
 * printing the same reading twice says nothing, and a zone the registry never
 * named is the scheduler's default, which is not this card's to guess.
 */
export interface TriggerFireTime {
  readonly at: number
  readonly zoned?: string
  readonly utc: string
}

const reading = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat([], { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(at))

/** The one next fire the registration states, read in its own zones; none when it states none. */
export const nextFireTimes = (row: TriggerCardRow): ReadonlyArray<TriggerFireTime> => {
  if (row.nextFireAt === undefined) return []
  const zone = row.timezone === undefined || row.timezone === "UTC" ? undefined : row.timezone
  return [{ at: row.nextFireAt, ...(zone === undefined ? {} : { zoned: reading(row.nextFireAt, zone) }), utc: reading(row.nextFireAt, "UTC") }]
}
