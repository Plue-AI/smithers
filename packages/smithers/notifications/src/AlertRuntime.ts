/**
 * The journal-backed alert runtime: one tick per run.
 *
 * A tick folds the run's journal into the conditions it leaves open, decides
 * which have outlived their delay, admits each one as a coalesced system
 * event, pages the sink, and journals what the sink did with it. The fold is
 * retained per run, so a tick costs the entries committed since the previous
 * one rather than the run's whole journal.
 *
 * The rules it enforces are `./AlertPolicy.ts` and the channel it pages over
 * is `./AlertSink.ts`; neither knows this module exists.
 *
 * @since 1.0.0
 */

import { Journal, JournalEvent } from "@smthrs/journal"
import { Clock, Context, Effect, HashSet, Layer, Result, Schema } from "effect"
import {
  type Alert,
  alertId,
  decide,
  deliveredEventType,
  detectorsOf,
  failedEventType,
  observe,
  payloadRecord,
  Policy
} from "./AlertPolicy.ts"
import { Sink } from "./AlertSink.ts"
import * as FoldCache from "./internal/foldCache.ts"
import type * as NotificationModel from "./Notification.ts"
import { type NotificationError, NotificationQueue } from "./NotificationQueue.ts"

/**
 * What one tick decided.
 *
 * @category models
 * @since 0.1.0
 */
export interface Tick {
  /** Alerts raised and delivered on this tick. */
  readonly delivered: ReadonlyArray<Alert>
  /** Alerts the sink refused on this tick. They are retried on the next one. */
  readonly failed: ReadonlyArray<Alert>
  /**
   * Alerts the notification queue refused because the run is at capacity. The
   * sink was not called for them, and they are retried on the next tick.
   */
  readonly refused: ReadonlyArray<Alert>
  /** Alerts that had already been delivered, and were not delivered again. */
  readonly suppressed: ReadonlyArray<Alert>
}

/**
 * The alert runtime: one tick per run.
 *
 * @category services
 * @since 0.1.0
 */
export interface RuntimeService {
  /**
   * Reads one run's journal and pages about whatever has waited too long.
   *
   * The two failures stay apart because they mean different things to an
   * operator. A `JournalError` is the alerter's own record channel failing: it
   * read no entries, or it could not write the delivery record. A
   * `NotificationError` is the notification queue rejecting the alert outright,
   * which is a producer or storage fault rather than a full queue. Neither is
   * a sink failure: a refused page is journaled as `flows.alerts.failed` and
   * retried on the next tick, and it comes back in {@link Tick.failed}. A queue
   * at capacity is not a failure either; it comes back in {@link Tick.refused}.
   */
  readonly tick: (runId: string) => Effect.Effect<Tick, Journal.JournalError | NotificationError>
}

/**
 * The {@link RuntimeService} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class AlertRuntime extends Context.Service<AlertRuntime, RuntimeService>()(
  "/notifications/AlertRuntime"
) {}

/**
 * One run's folded alert history: the conditions still open, the alerts
 * already paged, and the sequence the fold stopped at.
 */
interface Watched {
  readonly open: ReadonlyMap<string, number>
  /**
   * The alerts already paged, as a persistent set: a tick adds a node and
   * leaves the fold the previous tick published untouched, where copying the
   * set would cost the run's whole delivery history on every tick.
   */
  readonly delivered: HashSet.HashSet<string>
  readonly cursor: number | undefined
}

/**
 * How many runs one alert runtime keeps folded at a time. The retention policy
 * is scan-resistant, so a sweep of more runs than this reads journal tails for
 * all but a fixed handful of them.
 */
const maximumWatchedRuns = 64

const alertNotification = (alert: Alert): NotificationModel.Notification => ({
  _tag: "system-event",
  id: alertId(alert),
  targetLineageId: alert.runId,
  delivery: "queue",
  coalescingKey: alert.coalescingKey,
  provenance: {
    sourceRunId: alert.runId,
    sourceLineageId: alert.runId,
    sourceTurn: 0,
    sourceActor: "alerts"
  },
  payload: {
    condition: alert.condition,
    severity: alert.severity,
    since: alert.since,
    firedAt: alert.firedAt,
    ...(alert.owner === undefined ? {} : { owner: alert.owner }),
    ...(alert.runbook === undefined ? {} : { runbook: alert.runbook })
  }
})

/**
 * The alert runtime over one policy.
 *
 * A tick reads the run's journal, derives the open conditions, decides which
 * have outlived their delay, and for each one that has not already been
 * delivered: admits a coalesced system event, sends it to the sink, and
 * journals the delivery. The admission comes first because it is idempotent
 * and the send is not: a crash between them costs a duplicate admission, which
 * the queue drops, while a crash between an accepted send and the delivery
 * record costs a duplicate PAGE, which is why {@link SinkService.deliver} is
 * required to dedupe on {@link alertId}.
 *
 * The policy is decoded when the layer is built, so a rule with an impossible
 * delay fails the composition by name instead of mis-paging at 3am.
 *
 * @param policy the rules to enforce
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  policy: Policy
): Layer.Layer<AlertRuntime, never, Journal.Journal | NotificationQueue | Sink> =>
  Layer.effect(
    AlertRuntime,
    Effect.gen(function*() {
      const checked = yield* Effect.orDie(Schema.decodeUnknownEffect(Policy)(policy))
      const detectors = detectorsOf(checked)
      const journal = yield* Journal.Journal
      const queue = yield* NotificationQueue
      const sink = yield* Sink
      // Folded history per run, so a tick costs the entries committed since
      // the previous one rather than the run's whole journal.
      const watched = FoldCache.make<Watched>(maximumWatchedRuns)

      const observed = (runId: JournalEvent.RunId): Effect.Effect<Watched, Journal.JournalError> =>
        Effect.gen(function*() {
          const base: Watched = watched.get(runId) ??
            { open: new Map(), delivered: HashSet.empty(), cursor: undefined }
          const fresh: Array<JournalEvent.Entry> = []
          let after = base.cursor === undefined ? undefined : JournalEvent.Seq.make(base.cursor)
          while (true) {
            const page = yield* journal.entries({ runId, ...(after === undefined ? {} : { after }), limit: 512 })
            fresh.push(...page.entries)
            if (!page.hasMore || page.entries.length === 0) break
            after = page.entries.at(-1)!.seq
          }
          if (fresh.length === 0) return base

          // `open` is bounded by the policy's rules, so it is copied; the
          // delivery history is not, so it grows by one persistent node.
          const open = new Map(base.open)
          let delivered = base.delivered
          let cursor = base.cursor
          for (const entry of fresh) {
            cursor = entry.seq
            const payload = payloadRecord(entry.payload)
            if (payload === undefined) continue
            if (entry.eventType === deliveredEventType) {
              const id = payload["alertId"]
              if (typeof id === "string") delivered = HashSet.add(delivered, id)
            }
            observe(checked, detectors, entry, payload, open)
          }
          const next: Watched = { open, delivered, cursor }
          // Published at commit, exactly as `NotificationQueue.load` publishes
          // its fold. A tick inside an enclosing transaction reads that
          // transaction's uncommitted rows, and caching them would outlive the
          // rollback that erased them: the run would page about a condition
          // durable history never held.
          yield* journal.whenCommitted(Effect.sync(() => watched.put(runId, next)))
          return next
        })

      const record = (
        eventType: string,
        alert: Alert,
        source: string,
        outcome: { readonly code?: string | undefined; readonly status?: number | undefined }
      ): Effect.Effect<void, Journal.JournalError> =>
        journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(alert.runId),
            sourceId: JournalEvent.SourceId.make(`/notifications/alerts/${alertId(alert)}/${source}`),
            sourceSeq: JournalEvent.SourceSeq.make(0),
            // One record per alert per outcome. Without an explicit identity
            // the journal allocates a new sequence on every attempt, and a
            // webhook that stays down appends a row per tick forever.
            dedupe: "identity",
            eventType,
            payload: {
              runId: alert.runId,
              condition: alert.condition,
              since: alert.since,
              severity: alert.severity,
              alertId: alertId(alert),
              ...(outcome.code === undefined ? {} : { code: outcome.code }),
              ...(outcome.status === undefined ? {} : { status: outcome.status })
            }
          })
        ).pipe(Effect.asVoid)

      return AlertRuntime.of({
        tick: Effect.fn("AlertRuntime.tick")(function*(runId: string) {
          const journalRunId = JournalEvent.RunId.make(runId)
          const history = yield* observed(journalRunId)
          const now = yield* Clock.currentTimeMillis
          const open = Array.from(history.open, ([condition, since]) => ({ runId, condition, since }))
          const raised = decide(checked, open, now)
          const delivered: Array<Alert> = []
          const failed: Array<Alert> = []
          const refused: Array<Alert> = []
          const suppressed: Array<Alert> = []
          for (const alert of raised) {
            if (HashSet.has(history.delivered, alertId(alert))) {
              suppressed.push(alert)
              continue
            }
            // Raised unchanged: a queue that rejects the admission outright is
            // not the journal failing, and calling it `sink_failed` would send
            // an operator looking at the webhook.
            const receipt = yield* queue.admit(runId, alertNotification(alert))
            if (receipt.decision === "rejected-full") {
              // The alert has nowhere durable to sit, so paging about it would
              // tell an operator about something the run will never read.
              yield* record(failedEventType, alert, "refused", { code: "notification_full" })
              refused.push(alert)
              continue
            }
            const outcome = yield* Effect.result(sink.deliver(alert))
            if (Result.isFailure(outcome)) {
              yield* record(failedEventType, alert, `failed/${outcome.failure.code}`, {
                code: outcome.failure.code,
                status: outcome.failure.status
              })
              failed.push(alert)
            } else {
              yield* record(deliveredEventType, alert, "delivered", {})
              delivered.push(alert)
            }
          }
          return { delivered, failed, refused, suppressed }
        })
      })
    })
  )
