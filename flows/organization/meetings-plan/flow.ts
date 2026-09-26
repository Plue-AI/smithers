/**
 * `organization/meetings-plan`: plans the weekly one-on-ones from the
 * meetings page.
 *
 * The page's series (weekday, slot length, role order, the owner's time zone,
 * first start, and first date) becomes one contiguous block of back-to-back
 * slots; each slot's weekly event is written to the connected calendar, or
 * the step reports `not connected`; each role's prepare, open, and follow-up
 * triggers are registered on the host's scheduler in the series' zone; and
 * the plan is written to `<generatedDir>/meetings/plan.md`. While an owner
 * input is unset nothing is planned and the run says which. The host runs it
 * daily, so an edit to the page takes effect the next day, or at once when
 * started by hand.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import { finish } from "../meetings-shared.ts"
import { LoadPlan, MeetingFailed, MeetingReport, Schedule, SyncCalendar, WritePlan } from "../meetings.ts"

const implementationVersion = "organization/meetings-plan/v1"

/** Plan the weekly one-on-ones. */
export default Flow.make("organization/meetings-plan", {
  description:
    "Plan the weekly one-on-ones from the meetings page: the back-to-back block, each slot's calendar event when a calendar is connected, and each role's prepare, open, and follow-up schedule.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: {},
  success: MeetingReport,
  error: Schema.Union([MeetingFailed, Actions.ReceiptFailed]),
  body: () =>
    LoadPlan.call({}).pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (plan) =>
        Node.all({
          plan: Node.succeed(plan),
          calendar: SyncCalendar.call({ plan }),
          schedule: Schedule.call({ plan })
        }))),
      Node.bindPlanned(Node.capture({ implementationVersion }, (done) =>
        Node.all({
          done: Node.succeed(done),
          written: WritePlan.call({ plan: done.plan, calendar: done.calendar, schedule: done.schedule })
        }))),
      Node.map(Node.capture({ implementationVersion }, ({ done, written }): MeetingReport => ({
        key: "meetings",
        status: done.plan.configured ? "planned" : "not planned",
        summary: done.plan.configured
          ? `${done.plan.slots.length} slots ${done.plan.blockStart}–${done.plan.blockEnd} ${done.plan.timezone}; ${done.schedule.triggers.length} triggers`
          : done.plan.reason,
        principal: "",
        paths: [written.path],
        calendar: done.calendar.reason === ""
          ? done.calendar.status
          : `${done.calendar.status}: ${done.calendar.reason}`
      }))),
      Node.bindPlanned(Node.capture({ implementationVersion }, (outcome) => finish("meetings", "plan", {}, outcome)))
    )
})
