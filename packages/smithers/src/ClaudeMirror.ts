/**
 * The `smthrs claude ...` protocol the Claude Code plugin's `/workflows`
 * mirror consumes.
 *
 * The plugin does not read a database and does not know the control plane. It
 * runs one of these commands and relays the JSON, so this module is the whole
 * contract between them. {@link contract} is the wire-format major version the
 * plugin pins; bump it only when a response shape changes incompatibly.
 *
 * Two 0.x fields are gone in contract 2. `humanRequests` had no rc.0
 * counterpart — there is no question or answer RPC, and an approval parks the
 * run instead (the release policy) — and `continuedAs` described the
 * `continued` terminal status, which rc.0 does not have: a handoff round
 * settles `completed` with a lineage id (the release policy).
 *
 * Subscriptions exist because the mirror follows the runs *this* Claude
 * session started, not every run in the project. The registry never throws: a
 * missing or corrupt file degrades to no subscriptions, and writes are
 * temp-plus-rename with last-write-wins, because the next tick re-asserts a
 * lost upsert.
 *
 * @since 1.0.0
 */

import type { ControlSchema } from "@smthrs/control"
import { asRecord } from "@smthrs/gateway/Diagnosis"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as NodeOutput from "./NodeOutput.ts"
import * as Project from "./Project.ts"

/**
 * The wire-format major version the plugin pins.
 *
 * @category constants
 * @since 1.0.0
 */
export const contract = 2

/**
 * How long a subscription stays live without being re-asserted.
 *
 * @category constants
 * @since 1.0.0
 */
export const subscriptionTtlMs = 24 * 60 * 60 * 1000

/**
 * Where the per-project subscription registry lives.
 *
 * @category constructors
 * @since 1.0.0
 */
export const subscriptionsPath = (root: string): string =>
  join(Project.stateDirectory(root), "claude-mirror-subscriptions.json")

/**
 * One session's interest in one run.
 *
 * @category models
 * @since 1.0.0
 */
export interface Subscription {
  readonly runId: string
  readonly sessionId: string
  readonly updatedAtMs: number
}

/**
 * Reads the live subscriptions, dropping expired and malformed entries.
 *
 * @category getters
 * @since 1.0.0
 */
export const readSubscriptions = (root: string, now: number = Date.now()): ReadonlyArray<Subscription> => {
  const path = subscriptionsPath(root)
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    const entries = Array.isArray(parsed) ? parsed : []
    return entries.flatMap((entry) => {
      const record = asRecord(entry)
      const runId = record["runId"]
      const sessionId = record["sessionId"]
      const updatedAtMs = record["updatedAtMs"]
      if (typeof runId !== "string" || typeof sessionId !== "string" || typeof updatedAtMs !== "number") return []
      if (now - updatedAtMs > subscriptionTtlMs) return []
      return [{ runId, sessionId, updatedAtMs }]
    })
  } catch {
    return []
  }
}

/** Writes the registry atomically; a failed write is silence, never a throw. */
const writeSubscriptions = (root: string, entries: ReadonlyArray<Subscription>): void => {
  const path = subscriptionsPath(root)
  try {
    mkdirSync(Project.stateDirectory(root), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, "utf8")
    renameSync(temporary, path)
  } catch {
    // A registry that cannot be written degrades to no subscriptions, which
    // the monitor already handles. Failing the tick would be worse.
  }
}

/**
 * Records this session's interest in a run. Following a run *is* subscribing,
 * so every tick re-asserts.
 *
 * @category constructors
 * @since 1.0.0
 */
export const subscribe = (
  root: string,
  runId: string,
  sessionId: string,
  now: number = Date.now()
): ReadonlyArray<Subscription> => {
  const kept = readSubscriptions(root, now).filter((entry) => !(entry.runId === runId && entry.sessionId === sessionId))
  const entries = [...kept, { runId, sessionId, updatedAtMs: now }]
  writeSubscriptions(root, entries)
  return entries
}

/**
 * Drops this session's interest in a run.
 *
 * @category constructors
 * @since 1.0.0
 */
export const unsubscribe = (
  root: string,
  runId: string,
  sessionId: string,
  now: number = Date.now()
): ReadonlyArray<Subscription> => {
  const entries = readSubscriptions(root, now).filter((entry) =>
    !(entry.runId === runId && entry.sessionId === sessionId)
  )
  writeSubscriptions(root, entries)
  return entries
}

/**
 * One node as the mirror renders it.
 *
 * @category models
 * @since 1.0.0
 */
export interface MirrorNode {
  readonly nodeId: string
  readonly label: string
  readonly phase: string
  readonly kind: string
  readonly state: "pending" | "running" | "finished" | "failed"
}

/**
 * One complete mirror frame.
 *
 * @category models
 * @since 1.0.0
 */
export interface Frame {
  readonly contract: number
  readonly runId: string
  readonly status: ControlSchema.RunStatus | "unknown"
  readonly seq: number
  readonly phases: ReadonlyArray<{ readonly title: string }>
  readonly nodes: ReadonlyArray<MirrorNode>
  readonly changed: ReadonlyArray<string>
  readonly outputs: Readonly<Record<string, string>>
  readonly approvals: ReadonlyArray<{ readonly question: string | undefined; readonly approval: string | undefined }>
  readonly timedOut: boolean
}

/**
 * How much of one node's output a frame carries.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultMaxOutputChars = 2000

const ellipsis = "…"

/**
 * Cuts a value to at most `max` characters, counting code points.
 *
 * Slicing UTF-16 units split an astral character into a lone surrogate, and
 * the ellipsis was appended without being counted, so the result could exceed
 * the bound it exists to enforce. A bound of zero yields the empty string
 * rather than a bare ellipsis, which was itself one character over.
 */
const truncate = (value: string, max: number): string => {
  const points = [...value]
  if (points.length <= max) return value
  if (max <= 0) return ""
  return `${points.slice(0, max - 1).join("")}${ellipsis}`
}

const stateOf = (node: NodeOutput.Node): MirrorNode["state"] =>
  node.outcome === "pending" ? "running" : node.outcome === "failure" ? "failed" : "finished"

/**
 * Computes one mirror frame from a run's summary and events.
 *
 * `changed` is the set of nodes whose state moved after `afterSeq`, which is
 * what lets a blocking tick wake on real progress instead of on every model
 * token.
 *
 * @category constructors
 * @since 1.0.0
 */
export const frame = (
  runId: string,
  run: ControlSchema.RunSummary | undefined,
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  options: {
    readonly afterSeq?: number | undefined
    readonly maxOutputChars?: number | undefined
    readonly parked?: { readonly question: string | undefined; readonly approval: string | undefined } | undefined
    readonly timedOut?: boolean | undefined
  } = {}
): Frame => {
  const afterSeq = Math.max(0, Math.floor(options.afterSeq ?? 0))
  const maxOutputChars = Math.max(0, Math.floor(options.maxOutputChars ?? defaultMaxOutputChars))
  // One run-wide projection decides both the node list and the delta. Two
  // projections cannot: `project` numbers each flow's calls within the slice
  // it is given, so a second `bash` call in a filtered tail is `bash#1` there
  // and `bash#2` here, and matching the two by id reported the first call's
  // output as the thing that changed.
  const nodes = NodeOutput.project(events)
  const changed = new Set(
    nodes.filter((node) =>
      (node.startedSequence !== undefined && node.startedSequence > afterSeq) ||
      (node.settledSequence !== undefined && node.settledSequence > afterSeq)
    ).map((node) => node.nodeId)
  )
  const outputs: Record<string, string> = {}
  for (const node of nodes) {
    if (!changed.has(node.nodeId) || node.outcome === "pending") continue
    const value = typeof node.value === "string" ? node.value : JSON.stringify(node.value) ?? ""
    outputs[node.nodeId] = truncate(value, maxOutputChars)
  }
  const phase = run?.flowId ?? "Flow"
  return {
    contract,
    runId,
    status: run?.status ?? "unknown",
    seq: events.at(-1)?.sequence ?? afterSeq,
    phases: [{ title: phase }],
    nodes: nodes.map((node) => ({
      nodeId: node.nodeId,
      label: node.nodeId,
      phase,
      kind: node.flowName,
      state: stateOf(node)
    })),
    changed: [...changed],
    outputs,
    approvals: run?.status === "waiting-approval" && options.parked !== undefined ? [options.parked] : [],
    timedOut: options.timedOut === true
  }
}

/**
 * rc.0 run statuses that mean the run is over. `continued` is not one of them:
 * it does not exist in rc.0.
 *
 * @category constants
 * @since 1.0.0
 */
export const terminalStatuses: ReadonlyArray<string> = ["completed", "failed", "cancelled"]

/**
 * Whether a frame's run has settled, which is what stops a blocking tick.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isTerminal = (status: string): boolean => terminalStatuses.includes(status)

/**
 * One line of the monitor's NDJSON stream.
 *
 * @category models
 * @since 1.0.0
 */
export interface Transition {
  readonly runId: string
  readonly at: number
  readonly kind: string
  readonly status?: string | undefined
  readonly nodeId?: string | undefined
}

/**
 * The events the monitor reports, which is deliberately far short of every
 * event: a mirror that printed one line per model token would be unreadable
 * and would wake the plugin continuously.
 *
 * @category constants
 * @since 1.0.0
 */
export const notableKinds: ReadonlySet<string> = new Set([
  "control.run.accepted",
  "control.run.running",
  "control.run.parked",
  "control.run.waiting-approval",
  "control.run.completed",
  "control.run.failed",
  "control.run.cancelled",
  "control.approval.requested",
  "control.agent.cell-call-settled",
  "control.agent.resolved"
])

/**
 * Projects one event into a monitor line, or `undefined` when it is not
 * notable.
 *
 * @category constructors
 * @since 1.0.0
 */
export const transition = (event: ControlSchema.ControlEvent): Transition | undefined => {
  if (!notableKinds.has(event.kind)) return undefined
  const status = event.kind.startsWith("control.run.") ? event.kind.slice("control.run.".length) : undefined
  return {
    runId: event.runId ?? "",
    at: event.occurredAt,
    kind: event.kind,
    ...(status === undefined ? {} : { status })
  }
}
