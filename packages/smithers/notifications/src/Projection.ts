/**
 * Journal projection for pending notifications.
 *
 * @since 0.1.0
 */

import { Projection as JournalProjection } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as NotificationEvent from "./NotificationEvent.ts"
import * as NotificationState from "./NotificationState.ts"

/**
 * Re-derives pending notifications from admitted and promoted journal events.
 * Foreign journal entries leave the state unchanged.
 *
 * Replay never re-decides, so capacity does not truncate it:
 * `NotificationState.applyAdmission` applies the decision each record already
 * committed, and an admitted record is retained however many are pending. A
 * composition built with `NotificationQueue.layerWith` above the default
 * replays every admission it wrote.
 *
 * The projected `capacity` is `NotificationState.defaultCapacity` because the
 * initial state has to start somewhere and no journal record carries the bound
 * the layer was built at. Read `items`, not `capacity`, to learn what a run
 * holds.
 *
 * @category projections
 * @since 0.1.0
 */
export const derive = JournalProjection.make({
  name: "flows/notifications",
  initial: NotificationState.empty(NotificationState.defaultCapacity),
  reduce: (state, entry) => {
    const decoded = NotificationEvent.fromEntry(entry)
    if (Option.isNone(decoded)) return Effect.succeed(state)

    const event = decoded.value
    if (NotificationEvent.isAdmitted(event)) {
      return Effect.succeed(
        NotificationState.applyAdmission(state, event.notification, entry.seq, event.decision)
      )
    }
    return Effect.succeed(NotificationState.applyPromoted(state, event.ids))
  }
})
