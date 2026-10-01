/**
 * What a run is doing, folded from the events `runs show` already reads: the
 * executions its flow spawned, the actions each one is running, and when the
 * run last made progress.
 *
 * The engine starts every planned run as an `agent/run` execution, which runs
 * the approved plan through a `registry/entry/<digest>/<flow>` execution. Both
 * are wrappers around the operator's flow, so this view names the run by its
 * flow and folds the wrappers' work into that one row.
 *
 * @since 1.0.0
 */

import type { ControlSchema, Health } from "@smthrs/control"
import { type ReleaseCause, releaseCauseOf } from "@smthrs/engine-store/RunState"
import { statusRollup } from "@smthrs/gateway/GatewayProjection"
import * as Forensics from "../Forensics.ts"

/** The engine flow that executes an approved plan. */
const planWrapper = "agent/run"
/** The registry's entry execution: `registry/entry/<digest>/<flow>`. */
const entryWrapper = /^registry\/entry\/[0-9a-f]+\/(.+)$/

/**
 * Rows `runs show` prints before it reports the rest as omitted.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumExecutions = 20
/** Running actions printed for one execution. */
const maximumRunning = 3

const terminal: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])

/**
 * Event kinds that observe a run without advancing it: the status monitor's
 * periodic check and the gateway's watch keepalive.
 */
const observational: ReadonlySet<string> = new Set(["control.status.observed", "control.gateway.heartbeat"])

/**
 * One execution in a run's tree, as `runs show` prints it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Execution {
  readonly executionId: string
  readonly flowName: string
  readonly status: string
  /** The execution that spawned this one; the run's id for the run's own row. */
  readonly parent: string | null
  readonly round: number
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  /** Actions scheduled and not yet settled, newest last; null when none is. */
  readonly running: string | null
}

/**
 * The activity `runs show` adds to a run.
 *
 * @category models
 * @since 1.0.0
 */
export interface Activity {
  /** When the run last recorded progress; monitor checks do not count. */
  readonly lastProgressAt: number | undefined
  /** The run's own row first, then live executions, then the latest settled ones. */
  readonly executions: ReadonlyArray<Execution>
  /** Executions beyond {@link maximumExecutions}, all of them settled. */
  readonly omitted: number
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

const text = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined

const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null

/**
 * The name an operator gave the flow an engine execution runs.
 *
 * @param flowName the execution's engine flow name
 * @param runFlow the flow the run was started from
 * @category rendering
 * @since 1.0.0
 */
export const flowNameOf = (flowName: string, runFlow: string): string =>
  flowName === planWrapper ? runFlow : entryWrapper.exec(flowName)?.[1] ?? flowName

/**
 * A run's execution view with the plan wrapper named by the run's flow.
 *
 * @category rendering
 * @since 1.0.0
 */
export const presentView = <
  View extends { readonly root: { readonly flowName: string }; readonly current: { readonly flowName: string } }
>(
  view: View | undefined,
  runFlow: string
): View | undefined =>
  view === undefined ? undefined : {
    ...view,
    root: { ...view.root, flowName: flowNameOf(view.root.flowName, runFlow) },
    current: { ...view.current, flowName: flowNameOf(view.current.flowName, runFlow) }
  }

interface Folded {
  generation: number
  sequence: number
  flowName: string
  status: string
  parent: string | null
  round: number
  startedAtMs: number | null
  finishedAtMs: number | null
}

/**
 * Folds a run's events into its execution tree and latest progress.
 *
 * @param events the run's journal, in order
 * @param run the run's id and the flow it was started from
 * @category constructors
 * @since 1.0.0
 */
export const fold = (
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  run: { readonly runId: string; readonly flowId: string }
): Activity => {
  let lastProgressAt: number | undefined
  const executions = new Map<string, Folded>()
  // Scheduled and unsettled ActionCall nodes per execution, by node id.
  const running = new Map<string, Map<string, string>>()
  for (const event of events) {
    if (!observational.has(event.kind)) {
      lastProgressAt = lastProgressAt === undefined ? event.occurredAt : Math.max(lastProgressAt, event.occurredAt)
    }
    if (event.kind !== "control.engine.event") continue
    const envelope = record(event.payload)
    const executionId = text(envelope.executionId)
    if (executionId === undefined) continue
    const payload = record(envelope.payload)
    const nodeId = text(payload.nodeId)
    if (envelope.eventType === "flows.engine.node-scheduled" && nodeId !== undefined) {
      if (payload.kind !== "ActionCall") continue
      const nodes = running.get(executionId) ?? new Map<string, string>()
      nodes.set(nodeId, text(payload.action) ?? nodeId)
      running.set(executionId, nodes)
      continue
    }
    if (envelope.eventType === "flows.engine.node-settled" && nodeId !== undefined) {
      running.get(executionId)?.delete(nodeId)
      continue
    }
    const observation = record(record(payload.executionFact).observation)
    const observed = text(observation.executionId)
    const flowName = text(observation.flowName)
    const status = text(observation.status)
    if (observed !== executionId || flowName === undefined || status === undefined) continue
    const generation = number(envelope.generation) ?? 0
    const sequence = number(envelope.sequence) ?? 0
    const previous = executions.get(executionId)
    if (
      previous !== undefined &&
      (generation < previous.generation || generation === previous.generation && sequence < previous.sequence)
    ) continue
    executions.set(executionId, {
      generation,
      sequence,
      flowName,
      status,
      parent: text(observation.parentRunId) ?? null,
      round: number(observation.roundOrdinal) ?? 0,
      startedAtMs: number(observation.startedAtMs),
      finishedAtMs: number(observation.finishedAtMs)
    })
  }
  // The wrappers are the run itself: their ids resolve to the run's row.
  const wrappers = new Set(
    [...executions].filter(([id, fact]) =>
      id === run.runId || fact.flowName === planWrapper || entryWrapper.test(fact.flowName)
    ).map(([id]) => id)
  )
  const actions = (ids: Iterable<string>): string | null => {
    const names = [...ids].flatMap((id) => [...(running.get(id)?.values() ?? [])])
    if (names.length === 0) return null
    const shown = names.slice(-maximumRunning).join(" · ")
    return names.length > maximumRunning ? `${shown} · ${names.length - maximumRunning} more` : shown
  }
  const own = executions.get(run.runId)
  const head: Execution | undefined = own === undefined ? undefined : {
    executionId: run.runId,
    flowName: run.flowId,
    status: own.status,
    parent: null,
    round: own.round,
    startedAtMs: own.startedAtMs,
    finishedAtMs: own.finishedAtMs,
    running: terminal.has(own.status) ? null : actions(wrappers)
  }
  const children: Array<Execution> = []
  for (const [executionId, fact] of executions) {
    if (wrappers.has(executionId)) continue
    children.push({
      executionId,
      flowName: flowNameOf(fact.flowName, run.flowId),
      status: fact.status,
      parent: fact.parent === null || wrappers.has(fact.parent) ? run.runId : fact.parent,
      round: fact.round,
      startedAtMs: fact.startedAtMs,
      finishedAtMs: fact.finishedAtMs,
      running: terminal.has(fact.status) ? null : actions([executionId])
    })
  }
  const live = children.filter((row) => !terminal.has(row.status))
  const settled = children.filter((row) => terminal.has(row.status))
    .sort((left, right) => (right.finishedAtMs ?? 0) - (left.finishedAtMs ?? 0))
  const ordered = [...(head === undefined ? [] : [head]), ...live, ...settled]
  const shown = ordered.slice(0, Math.max(maximumExecutions, (head === undefined ? 0 : 1) + live.length))
  return {
    lastProgressAt,
    executions: shown,
    omitted: ordered.length - shown.length
  }
}

/**
 * What a recorded code drift means for resuming the run.
 *
 * @category rendering
 * @since 1.0.0
 */
export const driftVerdict = (drift: NonNullable<ControlSchema.RunSummary["codeDrift"]>): string =>
  drift.recorded !== undefined && drift.current === undefined
    ? "flow is no longer on disk; the run cannot resume"
    : drift.recorded !== undefined
    ? "flow changed since the run started; resume needs --allow-code-drift"
    : "engine changed since the run started; resume needs --allow-code-drift"

/**
 * Run decisions that record evidence about an execution without changing its
 * lifecycle, so they never supersede a release.
 */
const diagnosticDecisions: ReadonlySet<string> = new Set([
  "wake-scheduled",
  "claim-lost",
  "activation-lost",
  "steal-refused-owner-alive",
  "child-policy-applied",
  "lease-reconfirmed"
])

/**
 * One execution its owner released and nothing has re-driven since.
 *
 * @category models
 * @since 1.0.0
 */
export interface Released {
  readonly executionId: string
  readonly flowName: string
  /** Why the owner released it; absent on a decision recorded before causes were. */
  readonly cause?: ReleaseCause["kind"]
  /** How long the lease went unconfirmed, for a `lease-lapsed` release. */
  readonly unconfirmedMs?: number
}

/**
 * The executions whose latest lifecycle decision is `interrupt-released`, in
 * journal order, each with the cause its decision recorded.
 *
 * @param events the run's journal, in order
 * @param runFlow the flow the run was started from
 * @category constructors
 * @since 1.0.0
 */
export const released = (
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  runFlow: string
): ReadonlyArray<Released> => {
  const flows = new Map<string, string>()
  const latest = new Map<string, { readonly cause: ReleaseCause | undefined } | undefined>()
  for (const event of events) {
    if (event.kind !== "control.engine.event") continue
    const envelope = record(event.payload)
    const executionId = text(envelope.executionId)
    if (executionId === undefined || envelope.eventType !== "flows.engine.run-decision") continue
    const payload = record(envelope.payload)
    const flowName = text(record(record(payload.executionFact).observation).flowName)
    if (flowName !== undefined) flows.set(executionId, flowName)
    const decision = text(payload.decision)
    if (decision === undefined || diagnosticDecisions.has(decision)) continue
    latest.delete(executionId)
    latest.set(executionId, decision === "interrupt-released" ? { cause: releaseCauseOf(payload) } : undefined)
  }
  return [...latest].flatMap(([executionId, release]) =>
    release === undefined ? [] : [{
      executionId,
      flowName: flowNameOf(flows.get(executionId) ?? runFlow, runFlow),
      ...(release.cause === undefined ? {} : { cause: release.cause.kind }),
      ...(release.cause?.kind === "lease-lapsed" ? { unconfirmedMs: release.cause.unconfirmedMs } : {})
    }]
  )
}

/**
 * A confirmed lease lapse that did not release the execution.
 *
 * @category models
 * @since 1.0.0
 */
export interface Warning {
  readonly code: "lease-reconfirmed"
  readonly executionId: string
  readonly unconfirmedMs: number
  readonly occurredAt: number
}

const warningsOf = (events: ReadonlyArray<ControlSchema.ControlEvent>): ReadonlyArray<Warning> =>
  events.flatMap((event) => {
    if (event.kind !== "control.engine.event") return []
    const envelope = record(event.payload)
    const executionId = text(envelope.executionId)
    if (executionId === undefined || envelope.eventType !== "flows.engine.run-decision") return []
    const payload = record(envelope.payload)
    if (payload.decision !== "lease-reconfirmed") return []
    const unconfirmedMs = number(record(payload.detail).unconfirmedMs)
    if (unconfirmedMs === null || unconfirmedMs < 0) return []
    return [{ code: "lease-reconfirmed", executionId, unconfirmedMs, occurredAt: event.occurredAt }]
  })

/**
 * A run as `runs show` prints it.
 *
 * @category models
 * @since 1.0.0
 */
export type Shown = Omit<ControlSchema.RunSummary, "codeDrift"> & {
  readonly codeDrift?: NonNullable<ControlSchema.RunSummary["codeDrift"]> & { readonly verdict: string }
  readonly executions: ReadonlyArray<Execution>
  readonly executionsOmitted?: number
  /** The run's health, as the app's run card reads it. */
  readonly health: {
    readonly health: Health.HealthState
    readonly attention: Health.Attention
    readonly reason?: Health.ReasonCode
  }
  /** The released executions a run parked on `released` waits for a resume to restart. */
  readonly released?: ReadonlyArray<Released>
  /** Lease reconfirmations recorded without releasing ownership. */
  readonly warnings?: ReadonlyArray<Warning>
  readonly diagnosis: Forensics.Digest
}

/**
 * The run `runs show` prints: its health first, with the executions a run
 * parked on `released` waits for a resume to restart, then its flow named in
 * place of the engine wrapper,
 * its last progress as `updatedAt`, its executions, its drift verdict, and a
 * diagnosis whose `endedAt` is absent until the run settles.
 *
 * @param run the observed run
 * @param events the run's journal, in order
 * @category rendering
 * @since 1.0.0
 */
export const show = (
  run: ControlSchema.RunSummary,
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  now: number = Date.now()
): Shown => {
  const activity = fold(events, run)
  const diagnosis = Forensics.digest(events, run.runId)
  const rollup = statusRollup(run, events, now)
  const warnings = warningsOf(events)
  const { codeDrift, runId, flowId, status, waitingReason, ...recorded } = run
  return {
    // What a reader needs first leads, so the bounded human summary shows it.
    runId,
    flowId,
    status,
    ...(waitingReason === undefined ? {} : { waitingReason }),
    health: {
      health: rollup.health,
      attention: rollup.attention,
      ...(rollup.reason === undefined ? {} : { reason: rollup.reason })
    },
    ...(rollup.attention === "needs-resume" ? { released: released(events, run.flowId) } : {}),
    ...(warnings.length === 0 ? {} : { warnings }),
    ...recorded,
    ...(run.executionView === undefined ? {} : { executionView: presentView(run.executionView, run.flowId) }),
    updatedAt: Math.max(run.updatedAt, activity.lastProgressAt ?? run.updatedAt),
    ...(codeDrift === undefined ? {} : { codeDrift: { ...codeDrift, verdict: driftVerdict(codeDrift) } }),
    executions: activity.executions,
    ...(activity.omitted === 0 ? {} : { executionsOmitted: activity.omitted }),
    // The fold's span ends at the last event it reads, which is not an end
    // while the run is live.
    diagnosis: terminal.has(run.status) ? diagnosis : { ...diagnosis, endedAt: undefined }
  }
}
