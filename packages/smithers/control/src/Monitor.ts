/**
 * Run health over the control plane: what a run's state means, and what to do
 * about it.
 *
 * A control plane answers "what is this run doing". A monitor answers the
 * question after it — "is that all right, and if not, what now" — and the two
 * are deliberately separate modules. {@link classify} is a pure function of
 * one observation, so the vocabulary an operator reads on a dashboard is the
 * same one a heal loop branches on and the same one a test can enumerate.
 * {@link run} is the loop that beats over `Control` and journals what it saw.
 *
 * The classification is decided from durable evidence only: the run summary
 * the control plane projects, and the journal entries `watch` replays. Nothing
 * here reads an in-process fiber, which is what makes a monitor able to watch
 * a run in another process at all.
 *
 * @since 0.1.0
 */

import { Journal, JournalEvent } from "@smthrs/journal"
import { Duration, Effect, Stream } from "effect"
import { Control } from "./Control.ts"
import type { ControlError } from "./ControlError.ts"
import { PersistenceError } from "./ControlError.ts"
import type { ControlEvent, Receipt, RunId, RunSummary, WatchFilter } from "./ControlSchema.ts"
import * as SubjectHealth from "./Health.ts"

/**
 * The journal event type the engine records when an action attempt starts.
 *
 * Named as a string rather than imported, exactly as in `Lineage`: a monitor
 * reads journals, not engines.
 *
 * @category constants
 * @since 0.1.0
 */
export const attemptStartedEventType = "flows.engine.attempt-started"

/**
 * The journal event type the engine records when an action attempt settles.
 *
 * @category constants
 * @since 0.1.0
 */
export const attemptFinishedEventType = "flows.engine.attempt-finished"

/**
 * The journal event type one monitor beat is recorded under.
 *
 * @category constants
 * @since 0.1.0
 */
export const beatEventType = "control.monitor.beat"

/**
 * The journal event type one applied remedy is recorded under.
 *
 * A beat and a heal are two records because they are two facts, and only one
 * of them is true before the remedy runs. A single record carrying `healed`
 * has to be written either before the remedy — leaving durable evidence of a
 * heal that a crash one instruction later never performed — or after it, which
 * loses the evidence of what a monitor decided when the remedy is what killed
 * it. Splitting them keeps both.
 *
 * @category constants
 * @since 0.1.0
 */
export const healedEventType = "control.monitor.healed"

/**
 * What a run looks like to a monitor.
 *
 * `healthy` covers both "moving" and "finished": a completed run needs nothing
 * done to it, and neither does one that is making progress. The other six name
 * a specific thing that is wrong, because a heal that cannot tell them apart
 * would resume a run that is waiting for a human.
 *
 * @category models
 * @since 0.1.0
 */
export const Health = SubjectHealth.HealthState

/**
 * What a run looks like to a monitor.
 *
 * @category models
 * @since 0.1.0
 */
export type Health = typeof Health.Type

/**
 * Everything one classification is decided from.
 *
 * `events` is the run's journal as `watch` projects it, oldest first.
 * `beatsWithoutProgress` counts consecutive beats that added no entry, and
 * `stallBeats` is how many of those make a stall. Splitting the count from the
 * threshold is what lets the same pure function serve a monitor that beats
 * every second and one that beats every hour.
 *
 * @category models
 * @since 0.1.0
 */
export interface Observation {
  /** The run's projection, or nothing when the control plane has no such run. */
  readonly summary?: RunSummary | undefined
  readonly events: ReadonlyArray<ControlEvent>
  readonly beatsWithoutProgress: number
  readonly stallBeats: number
  /**
   * The trampoline round at which a lineage stops being a loop and starts
   * being a runaway. A run past it is looping without converging.
   */
  readonly roundBound?: number | undefined
  /** Fresh, explicitly reported semantic work; never inferred from bytes or monitor events. */
  readonly semanticProgress?: boolean | undefined
}

/** How many rounds a trampoline may take before a monitor calls it runaway. */
const defaultRoundBound = 32

interface AttemptState {
  open: number
  failed: boolean
}

const foldAttempt = (state: AttemptState, event: ControlEvent): void => {
  if (event.kind === attemptStartedEventType) state.open += 1
  if (event.kind === attemptFinishedEventType) {
    state.open -= 1
    const payload = event.payload
    state.failed = typeof payload === "object" && payload !== null && !Array.isArray(payload) &&
      (payload as { readonly state?: unknown })["state"] === "failed"
  }
}

/**
 * Decides what a run's state means.
 *
 * The order is the order an operator would read it in, and each rule earns its
 * place by naming a different response:
 *
 * | Condition | Health | Because |
 * | --- | --- | --- |
 * | No summary | `unknown` | Nothing to say, and nothing to do. |
 * | `failed` | `failing` | The run itself reported the failure. |
 * | `completed`, `cancelled` | `healthy` | A finished run needs nothing. |
 * | `waiting-approval`, or parked on `approval` | `awaiting-human` | A human owes it an answer; no machine can supply one. |
 * | Parked with no waiting reason | `awaiting-human` | Only an operator's own park writes no waiting reason, so a person stopped it and a person restarts it. |
 * | `roundOrdinal` at or past the bound | `runaway-loop` | The lineage is looping without converging. |
 * | The last settled attempt failed | `failing` | The run is still alive but its work is not landing. |
 * | No progress for `stallBeats`, an attempt open | `wedged-node` | One attempt started and never settled: the work is stuck, not the run. |
 * | No progress for `stallBeats` | `stalled` | Nothing is happening and nothing is in flight. |
 * | Anything else | `healthy` | Entries are still arriving. |
 *
 * `awaiting-human` deliberately outranks `failing`: a run parked for approval
 * after a failed attempt is waiting for a person, and resuming or cancelling
 * it would take the decision away from them.
 *
 * A park with no reason is the same case. The engine names every park it makes
 * — `event`, `approval`, `timer`, `quota`, `released` — so a parked run whose
 * `waitingReason` is absent was parked by an operator through
 * `ControlRuntime.writeStatus`. Calling that a stall and resuming it would undo
 * a deliberate act, which is the worst thing an unattended heal loop can do.
 *
 * @param observation what the beat saw
 * @category projections
 * @since 0.1.0
 */
export const classify = (observation: Observation): Health => {
  const attempts: AttemptState = { open: 0, failed: false }
  for (const event of observation.events) foldAttempt(attempts, event)
  return classifyState(observation, attempts)
}

const classifyState = (observation: Omit<Observation, "events">, attempts: AttemptState): Health => {
  const summary = observation.summary
  if (summary === undefined) return "unknown"
  if (summary.status === "failed") return "failing"
  if (summary.status === "completed" || summary.status === "cancelled") return "healthy"
  if (summary.status === "waiting-approval") return "awaiting-human"
  if (summary.status === "parked" && (summary.waitingReason === "approval" || summary.waitingReason === undefined)) {
    return "awaiting-human"
  }
  if (SubjectHealth.waitReason(summary.status, summary.waitingReason) !== undefined) return "healthy"
  const bound = observation.roundBound ?? defaultRoundBound
  if (summary.roundOrdinal !== undefined && summary.roundOrdinal >= bound) return "runaway-loop"
  if (attempts.failed) return "failing"
  if (!observation.semanticProgress && observation.beatsWithoutProgress >= observation.stallBeats) {
    return attempts.open > 0 ? "wedged-node" : "stalled"
  }
  return "healthy"
}

/**
 * What a monitor does about one unhealthy run.
 *
 * @category models
 * @since 0.1.0
 */
export type Remedy = "resume" | "cancel" | "none"

/**
 * The remedy a health warrants, before `autoHeal` decides whether to apply it.
 *
 * A stalled or wedged run is one nobody is driving, and a resume claims it. A
 * failing or runaway run is one that will not get better by being driven
 * harder. Everything else is left alone.
 *
 * @param health what the beat classified
 * @category projections
 * @since 0.1.0
 */
export const remedyFor = (health: Health): Remedy => {
  switch (health) {
    case "stalled":
    case "wedged-node":
      return "resume"
    case "failing":
    case "runaway-loop":
      return "cancel"
    default:
      return "none"
  }
}

/**
 * One beat of a monitor.
 *
 * @category models
 * @since 0.1.0
 */
export interface Beat {
  /** Which beat this was, counting from zero. */
  readonly beat: number
  readonly health: Health
  /** The newest journal sequence the run had, ignoring the monitor's own records. */
  readonly sequence: number
  /**
   * The remedy that ran and returned, absent when none did.
   *
   * Present only after the heal succeeded, which is also when
   * `control.monitor.healed` is journaled. A beat that decided on a remedy the
   * monitor never got to apply reports nothing here.
   */
  readonly healed?: Remedy | undefined
  /** The receipt the remedy returned, absent when none was applied. */
  readonly receipt?: Receipt | undefined
}

/**
 * What a monitor found.
 *
 * @category models
 * @since 0.1.0
 */
export interface Report {
  readonly runId: RunId
  readonly beats: ReadonlyArray<Beat>
  /** The last beat's health, or `unknown` when no beat ran. */
  readonly health: Health
}

/**
 * How a monitor beats.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly runId: RunId
  /** Optional configured observational checker; checker results never authorize a remedy. */
  readonly healthCheck?: SubjectHealth.ResolvedCheck | undefined
  /** Shared host admission limit around probes. */
  readonly withProbePermit?: (<A>(effect: Effect.Effect<A>) => Effect.Effect<A>) | undefined
  /** Bounded retained beat history for long-lived host monitoring. */
  readonly retainBeats?: number | undefined
  /** Hosts with structured status observations omit redundant legacy heartbeat records. */
  readonly recordBeats?: boolean | undefined
  /**
   * Who is watching. Defaults to `default`.
   *
   * It reaches the journal twice: as the source of every record this monitor
   * writes, and as `monitorId` in each payload. Two monitors pointed at one
   * run both beat and both remedy — nothing on the control plane leases a run
   * to one watcher — so the identity is what makes their evidence tellable
   * apart, and what keeps their remedies on separate idempotency keys.
   */
  readonly monitorId?: string | undefined
  /** How long to wait between beats. Defaults to one second. */
  readonly intervalMs?: number | undefined
  /** How many beats to take before reporting. Defaults to ten. */
  readonly maxChecks?: number | undefined
  /** How many beats without progress make a stall. Defaults to three. */
  readonly stallBeats?: number | undefined
  /** The round at which a trampoline is a runaway. Defaults to 32. */
  readonly roundBound?: number | undefined
  /** Which healths the monitor is allowed to act on. Defaults to none. */
  readonly autoHeal?: ReadonlyArray<Health> | undefined
  /**
   * What to do about an unhealthy run. Defaults to `Control.resume` and
   * `Control.cancel` per {@link remedyFor}.
   *
   * A heal that fails does not abort the monitor: the failure is logged, the
   * beat is recorded without `healed` or `receipt`, and the loop moves to the
   * next beat, where the stall evidence still stands and the remedy is
   * retried under that beat's own idempotency key.
   */
  readonly heal?: (
    input: { readonly runId: RunId; readonly health: Health; readonly remedy: Remedy; readonly beat: number }
  ) => Effect.Effect<Receipt, ControlError>
}

const summaryOf = (runId: RunId): Effect.Effect<RunSummary | undefined, ControlError, Control> =>
  Effect.flatMap(Control, (control) =>
    control.list({ _tag: "runs", filters: { runId } }).pipe(
      Effect.map((listed) => listed._tag === "runs" ? listed.items[0] : undefined)
    ))

const terminal = (summary: RunSummary | undefined): boolean =>
  summary !== undefined &&
  (summary.status === "completed" || summary.status === "failed" || summary.status === "cancelled")

/**
 * Watches one run and, when told to, heals it.
 *
 * The loop stops early on a terminal run, because a finished run has nothing
 * left to observe and beating at it would fill its journal with heartbeats.
 * Otherwise it takes `maxChecks` beats and reports what it saw.
 *
 * Every beat is journaled as `control.monitor.beat` before any remedy is
 * applied, carrying the `remedy` it is about to attempt, so a monitor that
 * crashes mid-heal leaves the evidence of what it decided. The remedy itself
 * is journaled separately as `control.monitor.healed`, and only once the heal
 * returned a receipt: a heal that failed, or a process that died running one,
 * must not leave a durable record saying the run was healed.
 *
 * `autoHeal` is empty by default. A monitor that healed by default would be a
 * monitor that cancels a run the first time it looks at one, which is the
 * wrong default for a thing an operator points at production.
 *
 * Nothing here leases the run. Two monitors on one run both beat and both
 * remedy, so a remedy has to be idempotent on the control plane — which the
 * two defaults are, through `Control.resume` and `Control.cancel`
 * idempotency keys that name the monitor, the run, and the beat. A custom
 * `heal` owes the same property.
 *
 * @param options how to beat and what to heal
 * @category constructors
 * @since 0.1.0
 */
export const run = (
  options: Options
): Effect.Effect<Report, ControlError, Control | Journal.Journal> =>
  Effect.gen(function*() {
    const control = yield* Control
    const journal = yield* Journal.Journal
    const intervalMs = options.intervalMs ?? options.healthCheck?.policy.intervalMs ?? 1_000
    let consecutiveProbeFailures = 0
    let lastPublished: SubjectHealth.HealthObservation | undefined
    const maxChecks = options.maxChecks ?? 10
    const stallBeats = options.stallBeats ?? 3
    const autoHeal = options.autoHeal ?? []
    const monitorId = options.monitorId ?? "default"
    const heal = options.heal ?? ((input) =>
      input.remedy === "resume"
        ? control.resume({
          runId: input.runId,
          idempotencyKey: `monitor:${monitorId}:resume:${input.runId}:${input.beat}`
        })
        : control.cancel({
          runId: input.runId,
          reason: `monitor:${input.health}`,
          idempotencyKey: `monitor:${monitorId}:cancel:${input.runId}:${input.beat}`
        }))

    const emit = (
      eventType: string,
      payload: Record<string, unknown>,
      operation: string
    ): Effect.Effect<void, ControlError> => {
      const unrecorded = (cause: unknown) =>
        new PersistenceError({
          operation: eventType,
          message: `Failed to record ${operation} for ${options.runId}`,
          cause
        })
      // The record is BUILT inside the failure channel, not before it.
      // `JournalEvent.RunId`/`SourceId` refuse an identifier the store cannot
      // tell apart from another one — a lone UTF-16 surrogate, an embedded NUL
      // — by THROWING, and `monitorId` reaches here from an operator's flag. A
      // thrown constructor is a defect, which the RPC boundary reports as an
      // opaque `TransportError` and a caller cannot handle; a beat whose record
      // cannot be built is the same event as a beat whose record cannot be
      // appended, so both fail as `PersistenceError` naming the record.
      return Effect.try({
        try: () =>
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(options.runId),
            sourceId: JournalEvent.SourceId.make(`/control/monitor/${monitorId}`),
            eventType,
            payload: { runId: options.runId, monitorId, ...payload }
          }),
        catch: unrecorded
      }).pipe(
        Effect.flatMap((input) => Effect.mapError(journal.emitDurableUnfenced(input), unrecorded)),
        Effect.asVoid
      )
    }

    /** What the beat saw, and what it is about to do about it. */
    const record = (beat: Beat, remedy: Remedy): Effect.Effect<void, ControlError> =>
      emit(
        beatEventType,
        {
          beat: beat.beat,
          health: beat.health,
          sequence: beat.sequence,
          ...(remedy === "none" ? {} : { remedy })
        },
        `monitor beat ${beat.beat}`
      )

    /** What the remedy did, once it returned. */
    const recordHealed = (
      beat: Beat,
      remedy: Remedy,
      receipt: Receipt
    ): Effect.Effect<void, ControlError> =>
      emit(
        healedEventType,
        { beat: beat.beat, health: beat.health, healed: remedy, receipt: receipt._tag },
        `monitor heal ${beat.beat}`
      )

    const beats: Array<Beat> = []
    let beatsWithoutProgress = 0
    let lastSequence = -1
    let checkpoint: Pick<WatchFilter, "afterCursor" | "afterSequence"> = {}
    const attempts: AttemptState = { open: 0, failed: false }
    let sequence = -1
    for (let beat = 0; beat < maxChecks; beat += 1) {
      if (beat > 0 && intervalMs > 0) {
        yield* Effect.sleep(Duration.millis(
          options.healthCheck === undefined
            ? intervalMs
            : SubjectHealth.nextDelay(options.healthCheck.policy, consecutiveProbeFailures)
        ))
      }
      const summary = yield* summaryOf(options.runId)
      const newEvents: Array<ControlEvent> = []
      const sinceCursor = Math.max(0, sequence)
      yield* control.watch({ runId: options.runId, follow: false, ...checkpoint }).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            // Advance over bookkeeping too, but never count it as run progress.
            checkpoint = event.cursor === undefined
              ? { afterSequence: event.sequence }
              : { afterCursor: event.cursor }
            if (isBookkeepingEvent(event.kind)) return
            newEvents.push(event)
            if (newEvents.length > 256) newEvents.shift()
            sequence = event.sequence
            foldAttempt(attempts, event)
          })
        )
      )
      beatsWithoutProgress = sequence === lastSequence ? beatsWithoutProgress + 1 : 0
      lastSequence = sequence
      const health = classifyState({
        ...(summary === undefined ? {} : { summary }),
        beatsWithoutProgress,
        stallBeats,
        ...(options.roundBound === undefined ? {} : { roundBound: options.roundBound })
      }, attempts)
      if (options.healthCheck !== undefined && summary !== undefined) {
        const check = options.healthCheck
        const subjectId = `run:${options.runId}`
        const incarnation = SubjectHealth.runIncarnation(summary)
        const probe = SubjectHealth.evaluate(check, {
          subjectId,
          state: summary.status,
          summary,
          events: newEvents,
          sinceCursor
        }, { monitorId, incarnation, evidenceSeq: Math.max(0, sequence) })
        let observation = yield* (options.withProbePermit?.(probe) ?? probe)
        const current = yield* summaryOf(options.runId)
        if (current === undefined || SubjectHealth.runIncarnation(current) !== incarnation) {
          observation = { ...observation, outcome: "discarded", report: undefined, reason: "owner-changed" }
        }
        consecutiveProbeFailures = observation.outcome === "ok" ? 0 : consecutiveProbeFailures + 1
        const semanticProgress = observation.outcome === "ok" && observation.report?.activity === "working"
        const baseHealth = classifyState({
          summary,
          beatsWithoutProgress,
          stallBeats,
          roundBound: options.roundBound,
          semanticProgress
        }, attempts)
        observation = { ...observation, baseHealth }
        const status = SubjectHealth.rollup({
          subjectId,
          state: summary.status,
          incarnation,
          waitingReason: summary.waitingReason,
          baseHealth,
          latest: { observation, sequence: 0 },
          now: observation.observedAt,
          updatedAt: summary.updatedAt
        })
        const changed = lastPublished === undefined || lastPublished.incarnation !== observation.incarnation ||
          lastPublished.outcome !== observation.outcome || lastPublished.baseHealth !== observation.baseHealth ||
          lastPublished.evidenceSeq !== observation.evidenceSeq ||
          JSON.stringify(lastPublished.report) !== JSON.stringify(observation.report) ||
          lastPublished.reason !== observation.reason
        // Renew before expiry, but do not fill the journal with identical per-probe records.
        if (changed || observation.observedAt >= lastPublished!.observedAt + check.policy.ttlMs / 2) {
          yield* emit(SubjectHealth.statusObservedEventType, {
            ...observation,
            status: summary.status,
            health: status.health,
            activity: status.activity,
            attention: status.attention,
            freshness: status.freshness,
            waitingReason: summary.waitingReason ?? ""
          }, "health observation")
          lastPublished = observation
        }
      }
      // Checker output is observational and never participates in remedy authorization.
      const remedy = autoHeal.includes(health) ? remedyFor(health) : "none"
      const observed: Beat = { beat, health, sequence }
      if (options.recordBeats !== false) yield* record(observed, remedy)
      if (remedy === "none") {
        beats.push(observed)
      } else {
        const receipt = yield* heal({ runId: options.runId, health, remedy, beat }).pipe(
          // A remedy that fails must not abort the run of beats: the monitor
          // is an unattended loop, and one failing heal leaves every other
          // beat — and every other run it would have observed — unwatched.
          // The failure is logged with the beat it failed on, and the beat is
          // recorded without `healed` or `receipt`, exactly as a remedy the
          // monitor never got to apply reports.
          Effect.catch((failure) =>
            Effect.annotateLogs(
              Effect.logWarning("A monitor remedy failed and was skipped"),
              { runId: options.runId, beat, health, remedy, cause: String(failure) }
            ).pipe(Effect.as(undefined))
          )
        )
        if (receipt === undefined) {
          // The stall evidence stands: nothing provably moved the run, so the
          // next beat compares against the same progress mark and the remedy
          // is retried with the beat's own idempotency key.
          beats.push(observed)
        } else {
          // A remedy that returned is not a remedy that was applied. `Terminal`
          // says the run had already settled, so nothing was healed; `Conflict`
          // says the key belonged to another mutation, so this monitor's remedy
          // never ran. Recording either as `healed` claimed something that did
          // not happen, and resetting the stall count on either erased the
          // evidence the next beat needs to notice the run is still stuck.
          const applied = receipt._tag === "Accepted" || receipt._tag === "AlreadyApplied"
          if (applied) {
            // Journaled here and not a line earlier: `healed` is a claim about
            // something that happened, and until the receipt came back it had not.
            yield* recordHealed(observed, remedy, receipt)
            // The heal moved the run, so the next beat compares against a run
            // that has changed. Counting the beats before it as stall evidence
            // again would heal a second time for the same stall.
            beatsWithoutProgress = 0
          }
          beats.push(applied ? { ...observed, healed: remedy, receipt } : { ...observed, receipt })
          // A remedy that answered `Terminal` observed the run settle. The loop
          // ends on the same evidence a terminal summary ends it on, rather than
          // beating against a run nothing can move.
          if (receipt._tag === "Terminal") break
        }
      }
      if (options.retainBeats !== undefined && beats.length > options.retainBeats) {
        beats.splice(0, beats.length - options.retainBeats)
      }
      if (terminal(summary)) {
        break
      }
    }
    return {
      runId: options.runId,
      beats,
      health: beats[beats.length - 1]?.health ?? "unknown"
    }
  })

/** Observer and notification bookkeeping is never execution progress.
 * @category predicates
 * @since 1.0.0
 */
export const isBookkeepingEvent = (kind: string): boolean =>
  kind.startsWith("control.monitor.") || kind.startsWith("control.status.") ||
  kind.startsWith("flows.alerts.") || kind.startsWith("flows.notifications.") || kind.startsWith("flows.notification.")
