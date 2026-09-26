/**
 * `organization/meetings-follow-up`: turns a role's one-on-one into tasks.
 *
 * The meeting's notes are the owner's and the role's messages in its Slack
 * thread and whatever the owner wrote in the note's Notes section. With none,
 * the slot is recorded as not held and no model is asked. Otherwise the role
 * turns them into tasks (`{ title, owner, due }`), written to the note's Tasks
 * section and to its open task list
 * (`<generatedDir>/meetings/<role>/tasks.md`), which its next preparation
 * reads. The schedule starts it just after the slot; `at` names another
 * instant after it.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import { fieldTurn } from "../field-turn.ts"
import { blocked, finish, report } from "../meetings-shared.ts"
import { CollectNotes, FindOccurrence, FollowUpTask, MeetingFailed, MeetingReport, WriteTasks } from "../meetings.ts"
import type { Answer } from "../schema.ts"

const implementationVersion = "organization/meetings-follow-up/v1"

const notHeld: Answer = {
  principal: "owner-absent",
  result: {
    status: "declined",
    summary: "Not held.",
    fields: {},
    evidence: [],
    handoffs: [],
    escalations: [],
    decisions: []
  },
  valid: false,
  violations: []
}

/** Follow up one role's one-on-one. */
export default Flow.make("organization/meetings-follow-up", {
  description:
    "Turn a role's weekly one-on-one notes (its Slack thread and its meeting note) into tasks on its open task list, or record the slot as not held.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: { principal: Profile.PrincipalId, at: Schema.optionalKey(Schema.Number) },
  success: MeetingReport,
  error: Schema.Union([MeetingFailed, Actions.ReceiptFailed]),
  body: (payload) =>
    FindOccurrence.call({
      principal: payload.principal,
      which: "last",
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
            CollectNotes.call({ occurrence }).pipe(
              Node.bindPlanned(Node.capture({ implementationVersion }, (notes) =>
                Node.branch(Node.succeed(notes), {
                  if: Node.capture({ implementationVersion }, (seen) => seen.held),
                  else: () =>
                    WriteTasks.call({ occurrence, answer: notHeld, held: false }).pipe(
                      Node.andThen(report({
                        key: occurrence.key,
                        status: "not held",
                        summary: "no notes in the wiki or the Slack thread",
                        principal: payload.principal,
                        paths: [occurrence.notePath]
                      }))
                    ),
                  then: () =>
                    Actions.PinRoster.call({}).pipe(
                      Node.bindPlanned(Node.capture({ implementationVersion }, (pin) =>
                        FollowUpTask.call({ revision: pin.revision, occurrence, transcript: notes.transcript }).pipe(
                          Node.bindPlanned(
                            Node.capture(
                              { implementationVersion },
                              (stage) => fieldTurn(pin.revision, stage, ["tasks"])
                            )
                          )
                        ))),
                      Node.bindPlanned(Node.capture({ implementationVersion }, (answer) =>
                        Node.all({
                          occurrence: Node.succeed(occurrence),
                          sources: Node.succeed(notes.sources),
                          written: WriteTasks.call({ occurrence, answer, held: true })
                        }))),
                      Node.map(
                        Node.capture(
                          { implementationVersion },
                          ({ occurrence: seen, sources, written }): MeetingReport => ({
                            key: seen.key,
                            status: "followed-up",
                            summary: `${written.tasks.length} tasks from ${sources.join(", ")}`,
                            principal: seen.principal,
                            paths: [written.path]
                          })
                        )
                      )
                    )
                })))
            )
        }).pipe(
          blocked(occurrence.key, payload.principal),
          Node.bindPlanned(
            Node.capture(
              { implementationVersion },
              (outcome) => finish(occurrence.key, "meeting-follow-up", payload, outcome)
            )
          )
        )))
    )
})
