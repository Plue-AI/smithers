/**
 * `organization/meetings-prepare`: a role prepares its next one-on-one.
 *
 * The role answers a preparation task under its own host: its agenda from
 * its receipts since the last week, its blockers, its open tasks from earlier
 * one-on-ones, and the decisions it needs. The agenda is written to its
 * private note (`<generatedDir>/meetings/<role>/<date>.md`), keeping any notes
 * already there. The schedule starts it the day before the slot; `at` finds
 * the next slot after another instant.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import { fieldTurn } from "../field-turn.ts"
import { blocked, finish, report } from "../meetings-shared.ts"
import { FindOccurrence, MeetingFailed, MeetingReport, PrepareTask, WriteAgenda } from "../meetings.ts"

const implementationVersion = "organization/meetings-prepare/v1"

/** Prepare one role's next one-on-one. */
export default Flow.make("organization/meetings-prepare", {
  description:
    "Have a role prepare its next weekly one-on-one: an agenda from its receipts, open tasks, blockers, and decisions needed, written to its private meeting note before the slot.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: { principal: Profile.PrincipalId, at: Schema.optionalKey(Schema.Number) },
  success: MeetingReport,
  error: Schema.Union([MeetingFailed, Actions.ReceiptFailed]),
  body: (payload) =>
    FindOccurrence.call({
      principal: payload.principal,
      which: "next",
      ...(payload.at === undefined ? {} : { at: payload.at })
    }).pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (occurrence) =>
        Node.branch(Node.succeed(occurrence), {
          if: Node.capture({ implementationVersion }, (seen) => seen.found),
          else: () =>
            report({
              key: occurrence.key,
              status: "not planned",
              summary: occurrence.reason,
              principal: payload.principal
            }),
          then: () =>
            Actions.PinRoster.call({}).pipe(
              Node.bindPlanned(Node.capture({ implementationVersion }, (pin) =>
                PrepareTask.call({ revision: pin.revision, occurrence }).pipe(
                  Node.bindPlanned(
                    Node.capture({ implementationVersion }, (stage) => fieldTurn(pin.revision, stage, ["agenda"]))
                  )
                ))),
              Node.bindPlanned(
                Node.capture({ implementationVersion }, (answer) =>
                  Node.all({ occurrence: Node.succeed(occurrence), written: WriteAgenda.call({ occurrence, answer }) }))
              ),
              Node.map(Node.capture({ implementationVersion }, ({ occurrence: seen, written }): MeetingReport => ({
                key: seen.key,
                status: "prepared",
                summary: `${written.agenda.length} agenda items for ${seen.localDate} ${seen.startLocal}`,
                principal: seen.principal,
                paths: [written.path]
              })))
            )
        }).pipe(
          blocked(occurrence.key, payload.principal),
          Node.bindPlanned(
            Node.capture({ implementationVersion }, (outcome) =>
              finish(occurrence.key, "meeting-prepare", payload, outcome))
          )
        )))
    )
})
