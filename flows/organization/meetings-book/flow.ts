/**
 * `organization/meetings-book`: a role asks the assistant for extra time with
 * the owner.
 *
 * The assistant books the first free slot of the requested length in the
 * owner's working window, clear of the weekly block, earlier bookings, and
 * the connected calendar's busy times; the booking is written to
 * `<generatedDir>/meetings/bookings.md` and, when a calendar is connected, to
 * the calendar. The same key returns the same booking.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { Schema } from "effect"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import { BookTime, MeetingFailed, MeetingReport } from "../meetings.ts"
import { finish } from "../meetings-shared.ts"
import { Describe, RequestKey, type StepFailure } from "../schema.ts"

const implementationVersion = "organization/meetings-book/v1"

/** Book extra time with the owner. */
export default Flow.make("organization/meetings-book", {
  description:
    "Book extra time with the owner for a role, as the assistant: the first free slot in the owner's working window, written to the wiki and to the calendar when one is connected.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  idempotencyKey: (payload) => payload.key,
  payload: {
    key: RequestKey,
    requestedBy: Profile.PrincipalId,
    purpose: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
    minutes: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 240 })),
    notBefore: Schema.optionalKey(Schema.Number)
  },
  success: MeetingReport,
  error: Schema.Union([MeetingFailed, Actions.ReceiptFailed]),
  body: (payload) =>
    BookTime.call(payload).pipe(
      Node.map(Node.capture({ implementationVersion }, (booking): MeetingReport => ({
        key: booking.key,
        status: booking.booked ? "booked" : "refused",
        summary: booking.booked
          ? `${booking.localDate} ${booking.startLocal} ${booking.timezone}, ${Math.round((booking.endMs - booking.startMs) / 60_000)} minutes, booked by ${booking.bookedBy}`
          : booking.reason,
        principal: booking.requestedBy,
        paths: booking.booked ? [booking.path] : [],
        calendar: booking.calendar
      }))),
      Node.catch({
        onFailure: Node.capture({ implementationVersion }, (failure) =>
          Describe.call({ failure: failure as Planned.Planned<typeof StepFailure.Type> }).pipe(
            Node.map(Node.capture({ implementationVersion, key: payload.key, principal: payload.requestedBy }, function(described) {
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- tsc needs it for inference
              return {
                key: this.key,
                status: "refused",
                summary: `${described.code}: ${described.message}`,
                principal: this.principal,
                paths: []
              } as MeetingReport
            }))
          ))
      }),
      Node.bindPlanned(Node.capture({ implementationVersion }, (outcome) => finish(payload.key, "book", payload, outcome)))
    )
})
