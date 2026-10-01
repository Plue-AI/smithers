/** Observational health contracts shared by durable runs and native sessions.
 * @since 1.0.0
 */

import * as Sha256 from "@smthrs/crypto/Sha256"
import * as Fault from "@smthrs/flow/Fault"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Cause, Effect, Metric, Schema } from "effect"
import type { ControlEvent, RunSummary } from "./ControlSchema.ts"
import { makeJevSessionChecker } from "./JevSessionChecker.ts"

/** Authoritative subject lifecycle.
 * @category schemas
 * @since 1.0.0
 */
export const SubjectState = Schema.Literals([
  "accepted",
  "running",
  "parked",
  "waiting-approval",
  "completed",
  "failed",
  "cancelled",
  "spawning",
  "exited"
])
/** Authoritative subject lifecycle.
 * @category models
 * @since 1.0.0
 */
export type SubjectState = typeof SubjectState.Type
/** Health vocabulary shared with Monitor.
 * @category schemas
 * @since 1.0.0
 */
export const HealthState = Schema.Literals([
  "healthy",
  "stalled",
  "wedged-node",
  "runaway-loop",
  "awaiting-human",
  "failing",
  "unknown"
])
/** Derived subject health.
 * @category models
 * @since 1.0.0
 */
export type HealthState = typeof HealthState.Type
/** Only explicit semantic checks establish activity.
 * @category schemas
 * @since 1.0.0
 */
export const Activity = Schema.Literals(["working", "idle", "needs-input", "unknown"])
/** Semantic activity.
 * @category models
 * @since 1.0.0
 */
export type Activity = typeof Activity.Type
/** Attention never confers permission to act. `needs-resume` is a run parked over
 * executions its owner released: nothing restarts them until `smthrs runs resume`.
 * @category schemas
 * @since 1.0.0
 */
export const Attention = Schema.Literals(["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"])
/** Human attention.
 * @category models
 * @since 1.0.0
 */
export type Attention = typeof Attention.Type
/** Whether a successful reading still describes this subject.
 * @category schemas
 * @since 1.0.0
 */
export const Freshness = Schema.Literals(["fresh", "stale", "unobserved"])
/** Reading freshness.
 * @category models
 * @since 1.0.0
 */
export type Freshness = typeof Freshness.Type
/** Public reasons; arbitrary exception text and terminal bytes never cross this boundary.
 * @category schemas
 * @since 1.0.0
 */
export const ReasonCode = Schema.Literals([
  "ok",
  "no-progress",
  "awaiting-reply",
  "prompt-detected",
  "quota-wait",
  "timer-wait",
  "event-wait",
  "released",
  "unreachable",
  "probe-timeout",
  "probe-error",
  "owner-changed"
])
/** Public reason code.
 * @category models
 * @since 1.0.0
 */
export type ReasonCode = typeof ReasonCode.Type
/** Validated checker output, containing no authority or ordering fields.
 * @category schemas
 * @since 1.0.0
 */
export const ProbeReport = Schema.Struct({ activity: Activity, reason: Schema.optional(ReasonCode) })
/** Validated checker output.
 * @category models
 * @since 1.0.0
 */
export type ProbeReport = typeof ProbeReport.Type
const Counter = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

/** A host-stamped observation; its journal sequence is supplied by the durable writer.
 * @category schemas
 * @since 1.0.0
 */
export const HealthObservation = Schema.Struct({
  subjectId: Schema.String,
  state: SubjectState,
  checkerId: Schema.String,
  monitorId: Schema.String,
  incarnation: Schema.String,
  evidenceSeq: Counter,
  observedAt: Counter,
  expiresAt: Counter,
  durationMs: Counter,
  baseHealth: Schema.optional(HealthState),
  outcome: Schema.Literals(["ok", "timeout", "error", "interrupted", "discarded"]),
  report: Schema.optional(ProbeReport),
  reason: Schema.optional(ReasonCode)
})
/** A host-stamped observation.
 * @category models
 * @since 1.0.0
 */
export type HealthObservation = typeof HealthObservation.Type
/** One observation with its authoritative publication order.
 * @category models
 * @since 1.0.0
 */
export interface RecordedObservation {
  readonly observation: HealthObservation
  readonly sequence: number
}
/** The additive wire contract rendered by every status surface.
 * @category schemas
 * @since 1.0.0
 */
export const StatusRollup = Schema.Struct({
  subjectId: Schema.String,
  state: SubjectState,
  activity: Activity,
  health: HealthState,
  attention: Attention,
  freshness: Freshness,
  reason: Schema.optional(ReasonCode),
  provenance: Schema.optional(Schema.Struct({
    checkerId: Schema.String,
    monitorId: Schema.String,
    observedAt: Counter,
    expiresAt: Counter,
    evidenceSeq: Counter,
    incarnation: Schema.String,
    version: Counter
  })),
  updatedAt: Counter
})
/** The additive wire contract.
 * @category models
 * @since 1.0.0
 */
export type StatusRollup = typeof StatusRollup.Type
/** Durable event type for observational health.
 * @category constants
 * @since 1.0.0
 */
export const statusObservedEventType = "control.status.observed"
/** Opaque identity of the authoritative run ownership and lifecycle point being observed.
 * Equality is meaningful; lexical or numeric ordering is not.
 * @category getters
 * @since 1.0.0
 */
export const runIncarnation = (run: RunSummary): string =>
  Sha256.digestSync(JSON.stringify([
    run.runId,
    run.createdAt,
    run.updatedAt,
    run.ownerId ?? null,
    run.parkedBy ?? null,
    run.status,
    run.waitingReason ?? null
  ]))

/** Read-only evidence, deliberately excluding mutation ports and terminal text by default.
 * Checkers are trusted host TypeScript, not a sandbox: captured ambient authority remains their author's responsibility.
 * @category models
 * @since 1.0.0
 */
export interface ProbeContext {
  readonly subjectId: string
  readonly state: SubjectState
  readonly events: ReadonlyArray<ControlEvent>
  readonly summary?: RunSummary | undefined
  readonly session?: {
    readonly alive: boolean
    readonly exitCode: number | null
    readonly outputCursor: number
    readonly outputTail?: string | undefined
  } | undefined
  readonly sinceCursor: number
}
/** Bounded polling, expiry and failure backoff.
 * @category models
 * @since 1.0.0
 */
export interface CheckPolicy {
  readonly intervalMs: number
  readonly timeoutMs: number
  readonly ttlMs: number
  /** Grace for silent work before the flow host considers missing progress unhealthy. */
  readonly stallAfterMs: number
  readonly backoff: { readonly initialMs: number; readonly maxMs: number; readonly factor: number }
}
/** Trusted host checker; supply service requirements around its Effect before registration.
 * @category models
 * @since 1.0.0
 */
export interface HealthChecker<C = unknown> {
  readonly id: string
  readonly configSchema?: Schema.Codec<C, unknown> | undefined
  readonly defaults?: Partial<CheckPolicy> | undefined
  readonly probe: (context: ProbeContext, config: C) => Effect.Effect<ProbeReport, unknown>
}
/** Data may select a registered checker but never executable code.
 * @category models
 * @since 1.0.0
 */
export interface HealthBinding {
  readonly checkerId: string
  readonly config?: unknown
  readonly policy?: Partial<CheckPolicy> | undefined
  readonly exposeOutput?: boolean | undefined
}
/** Trusted host health configuration.
 * @category models
 * @since 1.0.0
 */
export interface HealthConfig {
  // A heterogeneous registry erases C only after each binding is decoded by its own schema.
  readonly checkers?: ReadonlyArray<HealthChecker<any>> | undefined
  readonly bindings?: Readonly<Record<string, HealthBinding>> | undefined
  readonly limits?: { readonly maxSubjects?: number; readonly maxConcurrentProbes?: number } | undefined
}
/** Fully admitted checker binding.
 * @category models
 * @since 1.0.0
 */
export interface ResolvedCheck {
  readonly checker: HealthChecker<any>
  readonly config: unknown
  readonly policy: CheckPolicy
  readonly exposeOutput: boolean
}
/** Host registry, built once before admitting subjects.
 * @category models
 * @since 1.0.0
 */
export interface Registry {
  readonly resolve: (key: string) => ResolvedCheck
  readonly limits: { readonly maxSubjects: number; readonly maxConcurrentProbes: number }
}
/** Invalid trusted configuration fails startup instead of silently running another policy.
 * @category errors
 * @since 1.0.0
 */
export class HealthConfigurationError
  extends Schema.TaggedError<HealthConfigurationError>()("HealthConfigurationError", {
    reason: Schema.Literals(["invalid-policy", "invalid-checker", "invalid-config"])
  })
{}
Fault.register("HealthConfigurationError", "bug")
/** Safe cadence used by unconfigured hosts.
 * @category constants
 * @since 1.0.0
 */
export const defaultPolicy: CheckPolicy = {
  intervalMs: 5_000,
  timeoutMs: 2_000,
  ttlMs: 20_000,
  stallAfterMs: 120_000,
  backoff: { initialMs: 5_000, maxMs: 60_000, factor: 2 }
}
/** A known engine wait is a lifecycle fact, not missing progress.
 * @category getters
 * @since 1.0.0
 */
export const waitReason = (state: SubjectState, waitingReason?: string): ReasonCode | undefined =>
  state !== "parked" ? undefined : waitingReason === "quota" ?
    "quota-wait"
    : waitingReason === "timer"
    ? "timer-wait"
    : waitingReason === "event"
    ? "event-wait"
    : undefined
/** Flow default observes lifecycle without inventing semantic activity.
 * @category constants
 * @since 1.0.0
 */
export const lifecycleRunChecker: HealthChecker = {
  id: "lifecycle.run",
  probe: (context) =>
    Effect.succeed({ activity: "unknown", reason: waitReason(context.state, context.summary?.waitingReason) ?? "ok" })
}
/** Session default never interprets silence or output movement as task activity.
 * @category constants
 * @since 1.0.0
 */
export const lifecycleSessionChecker: HealthChecker = {
  id: "lifecycle.session",
  probe: () => Effect.succeed({ activity: "unknown", reason: "ok" })
}
const hostCheckers = (evaluator: Evaluator.Evaluator | undefined): ReadonlyArray<HealthChecker<any>> => [
  makeJevSessionChecker({ evaluator })
]
/** Checkers every host may bind by id, beyond the lifecycle default it always has.
 *
 * Registration is not a binding. A host opts in by naming one of these as a
 * `HealthBinding.checkerId`; a host that names none keeps the lifecycle
 * default, and no entry here is ever consulted for an unbound subject.
 *
 * @category constants
 * @since 1.0.0
 */
export const registeredCheckers: ReadonlyArray<HealthChecker<any>> = hostCheckers(undefined)
const bounded = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max
const invalid = (reason: HealthConfigurationError["reason"]): never => {
  throw new HealthConfigurationError({ reason })
}
/** Admit a host registry and all configured bindings. Unknown checker ids use the lifecycle default.
 * @category constructors
 * @since 1.0.0
 */
export const makeRegistry = (
  config: HealthConfig = {},
  kind: "run" | "session" = "run",
  evaluator?: Evaluator.Evaluator
): Registry => {
  const fallback = kind === "run" ? lifecycleRunChecker : lifecycleSessionChecker
  const checkers = new Map<string, ResolvedCheck["checker"]>([
    [fallback.id, fallback],
    ...hostCheckers(evaluator).map((checker) => [checker.id, checker] as const)
  ])
  for (const checker of config.checkers ?? []) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(checker.id) || checkers.has(checker.id)) invalid("invalid-checker")
    checkers.set(checker.id, checker)
  }
  const resolve = (binding?: HealthBinding): ResolvedCheck => {
    const checker = binding === undefined ? fallback : checkers.get(binding.checkerId) ?? fallback
    const merged = { ...defaultPolicy, ...checker.defaults, ...binding?.policy }
    if (merged.backoff == null || typeof merged.backoff !== "object") invalid("invalid-policy")
    const policy = { ...merged, backoff: { ...merged.backoff } }
    if (
      !bounded(policy.intervalMs, 10, 3_600_000) || !bounded(policy.timeoutMs, 1, 60_000) ||
      !bounded(policy.ttlMs, policy.timeoutMs, 86_400_000) ||
      !bounded(policy.stallAfterMs, policy.intervalMs, 86_400_000) ||
      !bounded(policy.backoff.initialMs, 10, 3_600_000) ||
      !bounded(policy.backoff.maxMs, policy.backoff.initialMs, 3_600_000) ||
      !Number.isFinite(policy.backoff.factor) || policy.backoff.factor < 1 || policy.backoff.factor > 10
    ) invalid("invalid-policy")
    let decoded: unknown = undefined
    if (checker !== fallback || binding?.checkerId === fallback.id) {
      if (checker.configSchema !== undefined) {
        try {
          decoded = Schema.decodeUnknownSync(checker.configSchema)(binding?.config)
        } catch {
          invalid("invalid-config")
        }
      } else if (binding?.config !== undefined) invalid("invalid-config")
    }
    return { checker, config: decoded, policy, exposeOutput: binding?.exposeOutput === true }
  }
  const defaults = resolve()
  const bindings = new Map(Object.entries(config.bindings ?? {}).map(([key, value]) => [key, resolve(value)]))
  const maxSubjects = config.limits?.maxSubjects ?? 128
  const maxConcurrentProbes = config.limits?.maxConcurrentProbes ?? 8
  if (!bounded(maxSubjects, 1, 500) || !bounded(maxConcurrentProbes, 1, 64)) invalid("invalid-policy")
  return { resolve: (key) => bindings.get(key) ?? defaults, limits: { maxSubjects, maxConcurrentProbes } }
}
/** Failure delay, bounded even when a subject has failed for a long time.
 * @category getters
 * @since 1.0.0
 */
export const nextDelay = (policy: CheckPolicy, consecutiveFailures: number): number =>
  consecutiveFailures <= 0 ? policy.intervalMs : Math.max(
    policy.intervalMs,
    Math.min(
      policy.backoff.maxMs,
      policy.backoff.initialMs * policy.backoff.factor ** Math.min(consecutiveFailures - 1, 32)
    )
  )
/** Host-only ordering stamp captured before a probe.
 * @category models
 * @since 1.0.0
 */
export interface ObservationStamp {
  readonly monitorId: string
  readonly incarnation: string
  readonly evidenceSeq: number
}
const outcomes = Metric.counter("smithers.health.probes")
const durations = Metric.histogram("smithers.health.probe_duration_ms", {
  boundaries: [1, 10, 100, 1_000, 5_000, 60_000]
})
const decodeReport = Schema.decodeUnknownSync(ProbeReport)
/** Evaluate one trusted checker with bounded timeout and safe failure values. Scope interruption propagates.
 * The host must still compare current ownership/lifecycle before durably publishing the returned observation.
 * @category constructors
 * @since 1.0.0
 */
export const evaluate = (
  check: ResolvedCheck,
  context: ProbeContext,
  stamp: ObservationStamp
): Effect.Effect<HealthObservation> =>
  Effect.gen(function*() {
    const subjectId = context.subjectId
    const state = context.state
    const captured = { ...stamp }
    const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    const result = yield* Effect.suspend(() => check.checker.probe(context, check.config)).pipe(
      Effect.flatMap((candidate) => Effect.try({ try: () => decodeReport(candidate), catch: () => "invalid-report" })),
      Effect.map((report) => ({ outcome: "ok" as const, report })),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.succeed({ outcome: "error" as const, reason: "probe-error" as const })
      ),
      Effect.timeoutOrElse({
        duration: check.policy.timeoutMs,
        orElse: () => Effect.succeed({ outcome: "timeout" as const, reason: "probe-timeout" as const })
      }),
      Effect.tap((outcome) =>
        Effect.annotateCurrentSpan({
          outcome: outcome.outcome,
          activity: "report" in outcome ? outcome.report.activity : "unknown"
        })
      ),
      Effect.withSpan("smithers.health.probe", {
        attributes: {
          subjectKind: context.session === undefined ? "run" : "session",
          subjectId,
          checkerId: check.checker.id,
          monitorId: captured.monitorId
        }
      })
    )
    const observedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    const durationMs = Math.max(0, observedAt - started)
    yield* Metric.update(outcomes.pipe(Metric.withAttributes({ outcome: result.outcome })), 1)
    yield* Metric.update(durations, durationMs)
    return {
      subjectId,
      state,
      checkerId: check.checker.id,
      ...captured,
      observedAt,
      expiresAt: observedAt + check.policy.ttlMs,
      durationMs,
      ...result
    }
  })

/** Select evidence for the current opaque owner incarnation, breaking equal evidence ties by durable sequence.
 * @category projections
 * @since 1.0.0
 */
export const latestObservation = (
  candidates: ReadonlyArray<RecordedObservation>,
  subjectId: string,
  incarnation: string
): RecordedObservation | undefined => {
  let selected: RecordedObservation | undefined
  for (const candidate of candidates) {
    const observation = candidate.observation
    if (
      observation.subjectId !== subjectId || observation.incarnation !== incarnation ||
      observation.outcome === "discarded"
    ) continue
    if (
      selected === undefined || observation.evidenceSeq > selected.observation.evidenceSeq ||
      observation.evidenceSeq === selected.observation.evidenceSeq && candidate.sequence > selected.sequence
    ) selected = candidate
  }
  return selected
}
/** Authoritative facts supplied independently of checker output.
 * @category models
 * @since 1.0.0
 */
export interface RollupInput {
  readonly subjectId: string
  readonly state: SubjectState
  readonly incarnation: string
  readonly waitingReason?: string | undefined
  readonly exitCode?: number | null | undefined
  readonly baseHealth?: HealthState | undefined
  readonly latest?: RecordedObservation | undefined
  readonly evidenceSeq?: number | undefined
  readonly now: number
  readonly updatedAt: number
}
/** Pure precedence: lifecycle and approvals win, and stale probes never establish activity.
 * @category projections
 * @since 1.0.0
 */
export const rollup = (input: RollupInput): StatusRollup => {
  const latest = input.latest
  const reading = latest?.observation
  const freshness = reading === undefined ?
    "unobserved" :
    reading.subjectId !== input.subjectId || reading.incarnation !== input.incarnation ||
      reading.state !== input.state ||
      reading.outcome !== "ok" || reading.report === undefined || input.now < reading.observedAt ||
      input.now >= reading.expiresAt ||
      (input.evidenceSeq !== undefined && reading.evidenceSeq < input.evidenceSeq) ?
    "stale" :
    "fresh"
  const terminal = input.state === "completed" || input.state === "failed" || input.state === "cancelled" ||
    input.state === "exited"
  const approval = input.state === "waiting-approval" || input.state === "parked" && input.waitingReason === "approval"
  // Released executions stay parked until an operator resumes the run (#3328).
  const released = input.state === "parked" && input.waitingReason === "released"
  const waiting = waitReason(input.state, input.waitingReason)
  let activity: typeof Activity.Type = freshness === "fresh" && !terminal && !approval && !released
    ? reading!.report!.activity
    : "unknown"
  let health: HealthState = input.state === "failed" ? "failing" : input.state === "exited" ?
    input.exitCode === 0 ? "healthy" : input.exitCode == null ? "unknown" : "failing" :
    terminal ?
    "healthy" :
    approval || released ?
    "awaiting-human" :
    waiting !== undefined ?
    "healthy" :
    input.state === "parked" && input.waitingReason === undefined ?
    "awaiting-human" :
    freshness !== "fresh"
    ? "unknown"
    : input.baseHealth ?? "unknown"
  const reason = approval
    ? "awaiting-reply"
    : released
    ? "released"
    : waiting ?? (freshness === "fresh" ? reading?.report?.reason : reading?.reason)
  if (!terminal && !approval && !released && waiting === undefined && freshness === "fresh") {
    if (reason === "unreachable" && health !== "awaiting-human") health = "failing"
    else if (reason === "no-progress" && health === "healthy") health = "stalled"
  }
  if (waiting !== undefined) activity = "unknown"
  const attention: typeof Attention.Type = approval ? "awaiting-approval" : released ? "needs-resume" :
    activity === "needs-input" ?
    "needs-input" :
    ["stalled", "wedged-node", "runaway-loop", "failing"].includes(health)
    ? "unhealthy"
    : "none"
  return {
    subjectId: input.subjectId,
    state: input.state,
    activity,
    health,
    attention,
    freshness,
    ...(reason === undefined ? {} : { reason }),
    ...(reading === undefined ? {} : {
      provenance: {
        checkerId: reading.checkerId,
        monitorId: reading.monitorId,
        observedAt: reading.observedAt,
        expiresAt: reading.expiresAt,
        evidenceSeq: reading.evidenceSeq,
        incarnation: reading.incarnation,
        version: latest!.sequence
      }
    }),
    updatedAt: Math.max(input.updatedAt, reading?.observedAt ?? 0)
  }
}
