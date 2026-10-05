/**
 * Adapter from the durable notification queue to harness turn boundaries.
 *
 * Governing contract: `../docs/concepts.md#notification-queue`.
 *
 * @since 0.1.0
 */

import * as ModelRequest from "@smthrs/model/ModelRequest"
import { NotificationQueue } from "@smthrs/notifications"
import type { Notification } from "@smthrs/notifications/Notification"
import * as SteerPayload from "@smthrs/notifications/SteerPayload"
import { Effect, Layer } from "effect"
import { HarnessError } from "./HarnessError.ts"
import * as Steering from "./Steering.ts"

/**
 * Which run and lineage this steering source draws notifications for.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  readonly runId: string
  readonly lineageId: string
}

// A real `UserMessage`, not a structurally similar literal: the turn-boundary
// drain is journaled through `Steering.DrainRecord`, whose schema accepts
// only `flows/model/UserMessage` instances, so a plain object fails the
// record boundary the first time a composed run drains one.
const render = (notification: Notification): ModelRequest.Message => {
  const payload = notification.payload
  const record = typeof payload === "object" &&
      notification.payload !== null &&
      !Array.isArray(payload)
    ? payload as Readonly<Record<string, unknown>>
    : undefined
  const body = typeof record?.["body"] === "string"
    ? record["body"]
    : JSON.stringify(payload)
  const attribution = notification.provenance.attribution === undefined
    ? ""
    : ` attribution ${JSON.stringify(notification.provenance.attribution)}`
  return ModelRequest.Message.user(
    `[notification ${notification.id} from ${notification.provenance.sourceActor} ` +
      `at ${notification.provenance.sourceLineageId} turn ${notification.provenance.sourceTurn}${attribution}]\n${body}`
  )
}

/**
 * The steering item one notification carries, or nothing when it carries none.
 *
 * A steer names what it wants — a message, a seat, a thinking level, a widened
 * tool set — and only the message belongs in the transcript. Telling the model
 * "your seat changed" would be a turn spent on bookkeeping; changing the seat
 * is what the operator asked for. Anything the steering vocabulary does not
 * recognize stays an insert, because a system event or a webhook body is still
 * something the run should be told about.
 */
const steerItem = (notification: Notification): Steering.Item => {
  const item = SteerPayload.decode(notification)
  // Zero, and not a timestamp: `admittedAt` orders items inside a queue this
  // adapter does not keep. The durable queue already decided which
  // notifications this boundary may deliver, so every item it handed back is
  // at or before the boundary's cutoff by construction.
  const admittedAt = 0
  if (item === undefined || item.kind === "Message") {
    return notification.delivery === "steer"
      ? { _tag: "Insert", delivery: "steer", admittedAt, message: render(notification) }
      : { _tag: "Insert", delivery: "queue", admittedAt, message: render(notification) }
  }
  switch (item.kind) {
    case "Seat":
      return { _tag: "SeatChange", delivery: "steer", admittedAt, seat: item.seat }
    case "Thinking":
      return { _tag: "ThinkingChange", delivery: "steer", admittedAt, thinking: item.thinking }
    case "Tools":
      // Refused out loud rather than dropped. The cell-first loop declares no
      // provider tools at all — every sealed request carries `tools: []` and
      // `toolChoice: "none"` — so a steer that activates tools by name had
      // nothing to activate: it was drained, journaled as delivered, and did
      // nothing, which is exactly the "appears to work partially" the release
      // contract forbids. The operator's intent still reaches the run, as the
      // one thing the run can act on.
      return {
        _tag: "Insert",
        delivery: "steer",
        admittedAt,
        message: ModelRequest.Message.user(
          `[steer ${notification.id} from ${notification.provenance.sourceActor}] An operator asked to activate `
            + `the tools ${item.toolNames.join(", ")}. This run has no provider tools. The only authority a cell `
            + "holds is ctx.call over the flows ctx.flows lists, so do what the operator asked for with those."
        )
      }
  }
}

/**
 * Folds the notifications one boundary promoted into the drain it produces.
 *
 * The durable queue has already decided WHICH notifications this boundary may
 * deliver, so nothing is held back here: the fold sorts promoted notifications
 * into the three things a turn boundary can act on.
 */
const drainOf = (receipt: NotificationQueue.DrainReceipt): Steering.Drain => {
  const notifications = receipt.notifications
  const inserts: Array<ModelRequest.Message> = []
  const seatChanges: Array<Steering.SeatChange | Steering.ThinkingChange> = []
  for (const notification of notifications) {
    const item = steerItem(notification)
    switch (item._tag) {
      case "Insert":
        inserts.push(item.message)
        break
      case "SeatChange":
      case "ThinkingChange":
        seatChanges.push(item)
        break
    }
  }
  return {
    inserts,
    seatChanges,
    remaining: Steering.empty(),
    queued: notifications.some((notification) => notification.delivery === "queue"),
    // The queue's own answer to "has this boundary drained before". A parked
    // run walks its park's boundaries until one says no, which is the first one
    // it has not already consulted. See `Steering.Drain.duplicate`.
    duplicate: receipt.duplicate
  }
}

const mapFailure = (cause: unknown): HarnessError =>
  new HarnessError({
    code: "engine_failed",
    message: "The durable notification queue failed at a turn boundary",
    cause
  })

/**
 * Captures the journal-backed queue as the harness steering source for one
 * run lineage.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  options: Options
): Effect.Effect<Steering.Source, never, NotificationQueue.NotificationQueue> =>
  Effect.gen(function*() {
    const queue = yield* NotificationQueue.NotificationQueue
    return Steering.make({
      read: () => Effect.succeed(Steering.empty()),
      drain: (input) =>
        queue.drain({
          runId: options.runId,
          targetLineageId: options.lineageId,
          boundary: input.boundary,
          wouldIdle: input.wouldIdle
        }).pipe(
          Effect.mapError(mapFailure),
          Effect.map(drainOf)
        )
    })
  })

/**
 * Provides {@link Steering.Source} backed by the durable notification
 * queue for one run lineage.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (
  options: Options
): Layer.Layer<Steering.Source, never, NotificationQueue.NotificationQueue> =>
  Layer.effect(Steering.Source)(make(options))
