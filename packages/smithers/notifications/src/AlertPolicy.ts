/**
 * Alert policy: what a condition is, when a journal leaves one open, and
 * which open conditions have outlived their delay.
 *
 * Everything here is pure and a function of journal time, so the same entries
 * decide the same alerts in any process at any instant past the delay. The
 * transport that pages about them is `./layerWebhook.ts` and the journal-backed
 * tick that drives them is `./AlertRuntime.ts`; `./Alerts.ts` is the module a
 * consumer imports.
 *
 * @since 1.0.0
 */

import type { JournalEvent } from "@smthrs/journal"
import { Schema } from "effect"

/**
 * The journal event type one delivered alert is recorded under.
 *
 * @category constants
 * @since 0.1.0
 */
export const deliveredEventType = "flows.alerts.delivered"

/**
 * The journal event type one failed delivery attempt is recorded under.
 *
 * One entry is written per alert per failure code, never one per tick: a
 * webhook that stays down for an hour leaves one record, not a hundred and
 * twenty that every later tick has to read past.
 *
 * @category constants
 * @since 0.1.0
 */
export const failedEventType = "flows.alerts.failed"

/**
 * How loud an alert is.
 *
 * @category models
 * @since 0.1.0
 */
export const Severity = Schema.Literals(["info", "warning", "critical"])

/**
 * How loud an alert is.
 *
 * @category models
 * @since 0.1.0
 */
export type Severity = typeof Severity.Type

/**
 * How a condition is recognized in the journal.
 *
 * `field` names a payload key, `value` the value that means the condition
 * holds, and `eventTypes` narrows which entries are consulted at all. An entry
 * that carries the field with a different value CLOSES the condition, which is
 * what makes a resume clear an approval alert without a second vocabulary for
 * "cleared".
 *
 * @category models
 * @since 0.1.0
 */
export const Detector = Schema.Struct({
  field: Schema.NonEmptyString,
  value: Schema.NonEmptyString,
  eventTypes: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

/**
 * How a condition is recognized in the journal.
 *
 * @category models
 * @since 0.1.0
 */
export type Detector = typeof Detector.Type

/**
 * What to do about one condition, and after how long.
 *
 * `afterMs` is a whole, non-negative number of milliseconds. The bound is the
 * schema's job because the delay is also arithmetic on journal time: a `NaN`
 * delay fires on the first tick and stamps a `firedAt` that JSON writes as
 * `null`, and a negative one fires with a `firedAt` earlier than the condition
 * it describes.
 *
 * @category models
 * @since 0.1.0
 */
export const Rule = Schema.Struct({
  afterMs: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  severity: Schema.optional(Severity),
  owner: Schema.optional(Schema.String),
  runbook: Schema.optional(Schema.String)
})

/**
 * What to do about one condition, and after how long.
 *
 * @category models
 * @since 0.1.0
 */
export type Rule = typeof Rule.Type

/**
 * The conditions a policy alerts on and the delays it alerts after.
 *
 * `defaults` fills in what a rule leaves out, so a policy states the delay per
 * condition and the ownership once.
 *
 * @category models
 * @since 0.1.0
 */
export const Policy = Schema.Struct({
  defaults: Schema.optional(Schema.Struct({
    severity: Schema.optional(Severity),
    owner: Schema.optional(Schema.String),
    runbook: Schema.optional(Schema.String)
  })),
  rules: Schema.Record(Schema.String, Rule),
  /** Detectors for conditions this deployment names itself. */
  detectors: Schema.optional(Schema.Record(Schema.String, Detector))
})

/**
 * The conditions a policy alerts on and the delays it alerts after.
 *
 * @category models
 * @since 0.1.0
 */
export type Policy = typeof Policy.Type

/**
 * The four conditions a control plane journals out of the box.
 *
 * `status` rides on every `control.run.*` entry, and `health` on every
 * `control.monitor.beat`. A deployment whose supervisor journals a park reason
 * gets `quota-parked` from the same field the run summary reports it under.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultDetectors: Readonly<Record<string, Detector>> = {
  "waiting-approval": { field: "status", value: "waiting-approval" },
  failed: { field: "status", value: "failed" },
  stalled: { field: "health", value: "stalled" },
  "quota-parked": { field: "waitingReason", value: "quota" }
}

/**
 * A condition that is open on a run, and when it opened.
 *
 * @category models
 * @since 0.1.0
 */
export interface Open {
  readonly runId: string
  readonly condition: string
  /** The journal time of the entry that opened the condition. */
  readonly since: number
}

/**
 * One alert a policy decided to raise.
 *
 * @category models
 * @since 0.1.0
 */
export interface Alert {
  readonly runId: string
  readonly condition: string
  readonly since: number
  /**
   * The journal instant the condition outlived its delay: `since` plus the
   * rule's `afterMs`, never the wall clock of whichever tick noticed.
   */
  readonly firedAt: number
  readonly severity: Severity
  readonly coalescingKey: string
  readonly owner?: string | undefined
  readonly runbook?: string | undefined
}

/**
 * The key an alert coalesces on: one open condition on one run.
 *
 * Each component is percent-encoded before it is joined, so a run id or a
 * condition name containing the separator cannot forge another pair's key and
 * suppress a page that belongs to somebody else. Both components are values a
 * deployment chooses, which is why the encoding is not optional.
 *
 * @param runId the run the condition is open on
 * @param condition the condition name the policy uses
 * @category getters
 * @since 1.0.0
 */
export const coalescingKey = (runId: string, condition: string): string =>
  `${encodeURIComponent(runId)}:${encodeURIComponent(condition)}`

/**
 * The identity a delivery is recorded under.
 *
 * The opening time is part of it on purpose. A condition that clears and
 * re-opens is a NEW alert, because the second approval wait is not the first
 * one, and a key without the time would suppress it forever.
 *
 * @param alert the alert
 * @category getters
 * @since 0.1.0
 */
export const alertId = (alert: Pick<Alert, "coalescingKey" | "since">): string =>
  `alert:${alert.coalescingKey}:${alert.since}`

/**
 * The detectors one policy decides with: the four this package ships, with
 * the deployment's own overriding them by name.
 *
 * @private
 * @since 1.0.0
 */
export const detectorsOf = (policy: Policy): Readonly<Record<string, Detector>> => ({
  ...defaultDetectors,
  ...policy.detectors
})

/**
 * One entry's payload when it is a record a detector can read a field off,
 * and `undefined` for the arrays and primitives that carry no fields at all.
 *
 * @private
 * @since 1.0.0
 */
export const payloadRecord = (payload: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? payload as Readonly<Record<string, unknown>>
    : undefined

/**
 * Folds one entry into the open-condition map. Shared by {@link conditions}
 * and the runtime's incremental read, so both decide a condition the same
 * way.
 *
 * The alerter's own records are never evidence about a condition. They are
 * written into the same journal they are read from, and they carry the alert's
 * own vocabulary: a refusal reports the answering HTTP `status`, which a
 * detector watching the run's `status` would read as the condition clearing.
 * A page would then close the condition it paged about and the next tick would
 * re-open it, so a webhook that answered 503 once would alert forever.
 *
 * @private
 * @since 1.0.0
 */
export const observe = (
  policy: Policy,
  detectors: Readonly<Record<string, Detector>>,
  entry: JournalEvent.Entry,
  payload: Readonly<Record<string, unknown>>,
  open: Map<string, number>
): void => {
  if (entry.eventType === deliveredEventType || entry.eventType === failedEventType) return
  for (const condition of Object.keys(policy.rules)) {
    const detector = detectors[condition]
    if (detector === undefined) continue
    if (detector.eventTypes !== undefined && !detector.eventTypes.includes(entry.eventType)) continue
    // Own properties only. `in` walks `Object.prototype`, so a detector named
    // `toString` or `constructor` would read every record-shaped entry in the
    // run as evidence and close the condition on all of them.
    if (!Object.hasOwn(payload, detector.field)) continue
    if (payload[detector.field] === detector.value) {
      if (!open.has(condition)) open.set(condition, entry.emittedAtMs)
    } else {
      open.delete(condition)
    }
  }
}

/**
 * Every condition a run's journal leaves open, with the time each opened.
 *
 * An entry that carries a detector's field opens the condition when the value
 * matches and closes it when it does not. Entries the detector does not name
 * are ignored entirely, so a monitor beat cannot close an approval wait and an
 * approval cannot close a stall.
 *
 * @param policy the policy whose detectors decide what counts
 * @param runId the run the entries belong to
 * @param entries the run's journal, oldest first
 * @category projections
 * @since 0.1.0
 */
export const conditions = (
  policy: Policy,
  runId: string,
  entries: ReadonlyArray<JournalEvent.Entry>
): ReadonlyArray<Open> => {
  const detectors = detectorsOf(policy)
  const open = new Map<string, number>()
  for (const entry of entries) {
    const payload = payloadRecord(entry.payload)
    if (payload === undefined) continue
    observe(policy, detectors, entry, payload, open)
  }
  return Array.from(open, ([condition, since]) => ({ runId, condition, since }))
}

/**
 * The alerts a policy raises for the conditions open at `now`.
 *
 * Pure, and a function of journal time: the same journal raises the same
 * alerts in any process, at any instant past the delay. `now` decides WHETHER
 * an alert is raised; it never appears in one. A condition that has been open
 * for less than its rule's delay raises nothing, which is the whole point of
 * the delay, because most stalls clear themselves.
 *
 * @param policy the policy
 * @param open the conditions the journal left open
 * @param now the instant to judge them at
 * @category projections
 * @since 0.1.0
 */
export const decide = (
  policy: Policy,
  open: ReadonlyArray<Open>,
  now: number
): ReadonlyArray<Alert> =>
  open.flatMap((condition) => {
    const rule = policy.rules[condition.condition]
    if (rule === undefined) return []
    if (now - condition.since < rule.afterMs) return []
    const severity = rule.severity ?? policy.defaults?.severity ?? "warning"
    const owner = rule.owner ?? policy.defaults?.owner
    const runbook = rule.runbook ?? policy.defaults?.runbook
    return [{
      runId: condition.runId,
      condition: condition.condition,
      since: condition.since,
      // Derived from the journal, not read off the clock. The alert id is
      // stable across ticks, and the queue refuses a reused id whose content
      // changed, so an alert stamped with the reading time would become
      // permanently undeliverable the moment a tick refused and time moved on.
      firedAt: condition.since + rule.afterMs,
      severity,
      coalescingKey: coalescingKey(condition.runId, condition.condition),
      ...(owner === undefined ? {} : { owner }),
      ...(runbook === undefined ? {} : { runbook })
    }]
  })
