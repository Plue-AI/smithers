/** Request messages belong to the coordinator; model settings keep their lane. */
import type * as ControlRuntime from "@smthrs/control/ControlRuntime"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Effect, Option, Schema } from "effect"
import type * as Journal from "../../packages/smithers/flows/journal/src/Journal.ts"
import * as JournalEvent from "../../packages/smithers/flows/journal/src/JournalEvent.ts"
import * as Notification from "../../packages/smithers/notifications/src/Notification.ts"
import * as NotificationEvent from "../../packages/smithers/notifications/src/NotificationEvent.ts"
import * as NotificationQueue from "../../packages/smithers/notifications/src/NotificationQueue.ts"
import { defaultCapacity } from "../../packages/smithers/notifications/src/NotificationState.ts"
import * as SteerPayload from "../../packages/smithers/notifications/src/SteerPayload.ts"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { CodingError, PlanningInput } from "./schema.ts"

const flowId = "coding/request"
const lineage = (rootId: string) => JSON.stringify([flowId, rootId])
const unavailable = (notificationId: string) =>
  new NotificationQueue.NotificationError({
    code: "notification_unavailable",
    notificationId,
    message: "Request message requires its active approved coding control run"
  })

/** Called once by the private host over its existing control queue. Returning
 * the original admit Effect preserves the enclosing control transaction.
 * All Message payloads use this policy; provenance strings are not identity roles.
 */
export const routeMessages = (
  queue: NotificationQueue.Service,
  control: ControlRuntime.Service,
  journal: Journal.Service
): NotificationQueue.Service => ({
  ...queue,
  admit: (runId, notification) =>
    Effect.suspend(() => {
      if (SteerPayload.decode(notification)?.kind !== "Message") {
        return queue.admit(runId, notification)
      }
      return journal.transact(Effect.gen(function*() {
        const run = yield* control.getRun(runId).pipe(Effect.mapError(() => unavailable(notification.id)))
        // TODO ownership, boundary closure and guest delivery are supplied by
        // T-FLW-11/T-STK-01. Until their production gates pass, a TODO message
        // must not fall through to generic admission and reach a model turn.
        if (run.flowId === "todo") return yield* Effect.fail(unavailable(notification.id))
        if (notification.targetLineageId !== runId || run.flowId !== flowId) {
          return yield* queue.admit(runId, notification)
        }
        if (
          run.planId === undefined || run.status === "cancelled" || run.status === "failed" ||
          run.status === "completed"
        ) {
          return yield* Effect.fail(unavailable(notification.id))
        }
        const plan = yield* control.getPlan(run.planId).pipe(Effect.mapError(() => unavailable(notification.id)))
        if (
          plan.decision !== "approved" || plan.card.flowId !== flowId || run.planDigest !== plan.card.digest ||
          plan.card.executionDigest === undefined ||
          // `coding/request` IS its own flow, so its approved envelope names no
          // delegate. An envelope that names one was approved for a descriptor
          // that hands this work to code this coordinator does not own, and a
          // steering message must not reach it.
          plan.card.envelope.flows.length !== 0
        ) {
          return yield* Effect.fail(unavailable(notification.id))
        }
        const closed = yield* isClosed(journal, runId)
        const receipt = yield* queue.admit(runId, { ...notification, targetLineageId: lineage(runId) })
        if (receipt.duplicate) return receipt
        // A duplicate keeps its original acceptance; a new admission after the
        // final empty receipt rolls back with this transaction, including the
        // queue's sequence allocation and after-commit publication.
        if (closed) {
          return yield* Effect.fail(
            new NotificationQueue.NotificationError({
              code: "notification_closed",
              notificationId: notification.id,
              message: "The request coordinator has finished receiving feedback; start a new request with this message"
            })
          )
        }
        // Preserve the same typed refusal for direct configured queue callers:
        // an accepted request message must actually have a retained notification.
        if (receipt.decision === "rejected-full") {
          return yield* Effect.fail(
            new NotificationQueue.NotificationError({
              code: "notification_full",
              notificationId: notification.id,
              message: "Request feedback queue is full; retry after the coordinator receives pending messages"
            })
          )
        }
        return receipt
      }))
    })
})

const Boundary = Schema.Literals(["after-poc", "before-implementation", "after-correction"])
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const BoundaryTuple = Schema.Tuple([Schema.NonEmptyString, Boundary, Revision])
const decodeBoundary = Schema.decodeUnknownOption(Schema.fromJsonString(BoundaryTuple))
/** The queue treats this as an opaque durable key; only this recipe interprets it. */
export const feedbackBoundary = (executionId: string, input: typeof ReceiveFeedback.payloadSchema.Type) =>
  JSON.stringify([executionId, input.boundary, input.revision])

const unreadable = () =>
  new NotificationQueue.NotificationError({
    code: "notification_unavailable",
    message: "Request feedback closure evidence is unreadable"
  })
/** Read the existing promotion receipts, never a follow stream or another
 * ledger. The caller's writer transaction serializes this scan/admission with
 * the coordinator's final drain. A finite snapshot must advance every page.
 */
const isClosed = (journal: Journal.Service, rootId: string) =>
  Effect.gen(function*() {
    let after: JournalEvent.Seq | undefined
    const target = lineage(rootId)
    // Refuse implausibly large or non-terminating adapters while holding the
    // writer transaction; a feedback admission must not lock the database forever.
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = yield* journal.entries({
        runId: JournalEvent.RunId.make(rootId),
        eventTypes: [NotificationEvent.PromotedEventType],
        limit: 1000,
        ...(after === undefined ? {} : { after })
      })
      if (page.entries.length > 1000) return yield* Effect.fail(unreadable())
      let previous = after ?? -1
      for (const entry of page.entries) {
        if (entry.runId !== rootId || entry.seq <= previous) return yield* Effect.fail(unreadable())
        previous = entry.seq
        if (entry.eventType !== NotificationEvent.PromotedEventType) continue
        const decoded = NotificationEvent.fromEntry(entry)
        if (Option.isNone(decoded) || !NotificationEvent.isPromoted(decoded.value)) {
          return yield* Effect.fail(unreadable())
        }
        const receipt = decoded.value
        if (receipt.targetLineageId !== target) continue
        const boundary = decodeBoundary(receipt.boundary)
        if (
          Option.isNone(boundary) || JSON.stringify(boundary.value) !== receipt.boundary || entry.sourceSeq !== 0 ||
          entry.sourceId !==
            `/notifications/drain/${encodeURIComponent(target)}/${encodeURIComponent(receipt.boundary)}`
        ) {
          return yield* Effect.fail(unreadable())
        }
        if (boundary.value[1] === "after-correction" && receipt.ids.length === 0) return true
      }
      if (!page.hasMore) return false
      const next = page.entries.at(-1)?.seq
      if (next === undefined || next <= (after ?? -1)) return yield* Effect.fail(unreadable())
      after = next
    }
    return yield* Effect.fail(unreadable())
  })
export const FeedbackReceipt = Schema.Struct({
  boundary: Schema.NonEmptyString,
  messages: Schema.Array(Notification.Notification).check(Schema.isMaxLength(defaultCapacity))
})
export type FeedbackReceipt = typeof FeedbackReceipt.Type

export const ReceiveFeedback = Action.make("coding/receive-request-feedback", {
  payload: { boundary: Boundary, revision: Revision },
  success: FeedbackReceipt,
  error: CodingError,
  nondeterministic: true
})

/** Runtime identity is installed only after native ownership is proved again.
 * Reading it optionally avoids inventing a construction-time owner just to
 * register the action. Missing identity refuses before accessing the queue.
 */
export const receiveFeedback = (input: typeof ReceiveFeedback.payloadSchema.Type) =>
  Effect.gen(function*() {
    const owner = yield* Effect.serviceOption(ModuleOwner)
    if (Option.isNone(owner) || owner.value.flowId !== flowId) {
      return yield* Effect.fail(
        new CodingError({
          code: "unavailable",
          message: "Request feedback requires its proved coding coordinator owner"
        })
      )
    }
    const instance = yield* FlowRuntime.FlowInstance
    const queue = yield* NotificationQueue.NotificationQueue
    const boundary = feedbackBoundary(instance.executionId, input)
    const receipt = yield* queue.drain({
      runId: owner.value.rootId,
      targetLineageId: lineage(owner.value.rootId),
      boundary,
      wouldIdle: true
    }).pipe(Effect.mapError(() =>
      new CodingError({ code: "unavailable", message: `Request feedback at ${boundary} could not be read` })
    ))
    return { boundary, messages: receipt.notifications }
  })
export const feedbackLayer = ReceiveFeedback.toLayer(receiveFeedback)

/** Apply only after ReceiveFeedback's native action result is recorded. A
 * refusal leaves the exact notifications, attribution and drain receipt in
 * the existing journals; it never truncates accepted instructions silently.
 */
export const appendFeedback = (feedback: string, receipt: FeedbackReceipt): Effect.Effect<string, CodingError> => {
  const rendered: Array<string> = []
  for (const message of receipt.messages) {
    const payload = SteerPayload.decode(message)
    if (payload?.kind !== "Message") {
      return Effect.fail(
        new CodingError({
          code: "invalid_plan",
          message: `Request feedback ${JSON.stringify(message.id)} has no readable Message payload`
        })
      )
    }
    rendered.push(`[request message ${JSON.stringify({ id: message.id, ...message.provenance })}]\n${payload.body}`)
  }
  const combined = [feedback, ...rendered].filter((value) => value.length > 0).join("\n\n")
  return Schema.decodeUnknownEffect(PlanningInput.fields.feedback)(combined).pipe(
    Effect.mapError(() =>
      new CodingError({
        code: "invalid_plan",
        message: `Request feedback exceeds the planning limit at ${receipt.boundary}; retained message IDs: ${
          receipt.messages.map((message) => JSON.stringify(message.id)).join(", ")
        }`
      })
    )
  )
}
