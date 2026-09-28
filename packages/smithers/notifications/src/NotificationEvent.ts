/**
 * Journal event types owned by the notification queue.
 *
 * @since 0.1.0
 */

import { JournalEvent } from "@smthrs/journal"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Notification from "./Notification.ts"

/**
 * The journal `eventType` recorded for one admission decision.
 *
 * The spelling is slashes and a PascalCase leaf, where every other event type
 * in this repository is dot-separated and lowercase (`control.run.parked`,
 * `flows.alerts.delivered`). The value is already durable in every engine
 * database, and a rename would silently stop matching the projections that
 * consumers key on, so it stays as written. A foreign projection must match
 * this literal rather than the repository convention, which is why the two
 * spellings are frozen by `test/WireFormat.test.ts`.
 *
 * @category constants
 * @since 0.1.0
 */
export const AdmittedEventType = "flows/notifications/Admitted"

/**
 * The journal `eventType` recorded when pending notifications are promoted.
 *
 * Spelled like {@link AdmittedEventType}, and frozen for the same reason.
 *
 * @category constants
 * @since 0.1.0
 */
export const PromotedEventType = "flows/notifications/Promoted"

/**
 * What a durable admission record says was decided.
 *
 * This is the one declaration of the admission vocabulary: it validates every
 * journal entry through {@link fromEntry}, and `NotificationState` types its
 * public signatures against it, so a fourth decision cannot be added to one
 * half and forgotten in the other.
 *
 * @category models
 * @since 1.0.0
 */
export const AdmissionDecision = Schema.Literals(["admitted", "coalesced", "rejected-full"])

/**
 * The decoded form of {@link AdmissionDecision}.
 *
 * @category models
 * @since 1.0.0
 */
export type AdmissionDecision = typeof AdmissionDecision.Type

/**
 * A durable admission record: the notification a run was told about, and what
 * the queue decided to do with it.
 *
 * A `rejected-full` decision is never written. The queue refuses a full queue
 * in the receipt alone, so the notification id stays admissible once a
 * boundary drains. The literal remains in {@link AdmissionDecision} because a
 * reader must stay total over a record any writer could have produced.
 *
 * @category models
 * @since 0.1.0
 */
export const Admitted = Schema.Struct({
  notification: Notification.Notification,
  decision: AdmissionDecision,
  /** SHA-256 of canonical validated input, absent in legacy admission rows. */
  fingerprint: Schema.optional(Schema.String)
})

/**
 * The decoded form of {@link Admitted}.
 *
 * @category models
 * @since 0.1.0
 */
export type Admitted = typeof Admitted.Type

/**
 * A durable promotion record: which notifications one boundary of one lineage
 * delivered.
 *
 * The triple `(runId, targetLineageId, boundary)` is the unit of promotion, so
 * a second lineage draining the same boundary name is a separate record rather
 * than a repeat of the first.
 *
 * @category models
 * @since 0.1.0
 */
export const Promoted = Schema.Struct({
  boundary: Schema.String,
  targetLineageId: Schema.String,
  ids: Schema.Array(Schema.String)
})

/**
 * The decoded form of {@link Promoted}.
 *
 * @category models
 * @since 0.1.0
 */
export type Promoted = typeof Promoted.Type

/**
 * Any journal event owned by this package.
 *
 * The two members are told apart with {@link isAdmitted} and
 * {@link isPromoted} rather than a stored discriminant, because the discriminant
 * would be a durable field this vocabulary does not have.
 *
 * @category models
 * @since 0.1.0
 */
export type Event = Admitted | Promoted

/**
 * Whether an owned event is an admission record.
 *
 * @param event an owned event
 * @category refinements
 * @since 1.0.0
 */
export const isAdmitted = (event: Event): event is Admitted => "notification" in event

/**
 * Whether an owned event is a promotion record.
 *
 * @param event an owned event
 * @category refinements
 * @since 1.0.0
 */
export const isPromoted = (event: Event): event is Promoted => !isAdmitted(event)

/**
 * The journal source every admission of one notification is written under.
 *
 * @param notificationId the admitted notification's id
 * @category constructors
 * @since 1.0.0
 */
export const admissionSourceId = (notificationId: string): JournalEvent.SourceId =>
  JournalEvent.SourceId.make(`${admissionSourcePrefix}${notificationId}`)

/**
 * The identity of one drain: the lineage and the boundary, each encoded so a
 * value containing a slash cannot forge another pair's identity.
 *
 * @param targetLineageId the lineage the boundary closed on
 * @param boundary the boundary name
 * @category constructors
 * @since 1.0.0
 */
export const drainKey = (targetLineageId: string, boundary: string): string =>
  `${encodeURIComponent(targetLineageId)}/${encodeURIComponent(boundary)}`

/**
 * The journal source one drain's promotion record is written under.
 *
 * @param targetLineageId the lineage the boundary closed on
 * @param boundary the boundary name
 * @category constructors
 * @since 1.0.0
 */
export const drainSourceId = (targetLineageId: string, boundary: string): JournalEvent.SourceId =>
  JournalEvent.SourceId.make(`${drainSourcePrefix}${drainKey(targetLineageId, boundary)}`)

const admissionSourcePrefix = "/notifications/admission/"
const drainSourcePrefix = "/notifications/drain/"

const decodeAdmitted = Schema.decodeUnknownOption(Admitted)
const decodePromoted = Schema.decodeUnknownOption(Promoted)

/**
 * Decodes an owned notification event from a journal entry.
 *
 * Foreign entries and structurally invalid payloads decode to `None` so a
 * projection over a shared journal stays total.
 *
 * The event type alone does not make an entry owned: any producer on a shared
 * journal can choose one. An admission counts only under
 * {@link admissionSourceId} for the notification it carries, and a promotion
 * only under the `/notifications/drain/` source family the queue writes, so
 * another producer's record with the same event type stays out of the
 * projection. This scopes records; it does not authenticate the writer. The
 * journal fences writes on run ownership, not on source, so a writer that
 * sets this package's source id is read as this package. The drain check is
 * a prefix because records written before the lineage joined the identity
 * carry the boundary alone.
 *
 * @param entry one journal entry, owned or foreign
 * @category constructors
 * @since 0.1.0
 */
export const fromEntry = (entry: JournalEvent.Entry): Option.Option<Event> => {
  if (entry.eventType === AdmittedEventType) {
    return Option.filter(
      decodeAdmitted(entry.payload),
      (event) => entry.sourceId === admissionSourceId(event.notification.id)
    )
  }
  if (entry.eventType === PromotedEventType && entry.sourceId.startsWith(drainSourcePrefix)) {
    return decodePromoted(entry.payload)
  }
  return Option.none()
}
