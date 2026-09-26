/**
 * `organization/meetings-open`: opens a role's one-on-one at its slot.
 *
 * When the owner's Slack app is configured, the role's agenda (from its
 * private note) is posted in the owner's direct messages with the app, under
 * the role's name, and the thread is recorded: the owner's replies in it are
 * answered by the role (`organization/meetings-reply`) and become the
 * meeting's notes. Without Slack the run records `not connected` and the
 * note's Notes section is the meeting's only channel. The owner is messaged
 * only with a contact receipt the host mints for the slot
 * (`Grants.canContactOwner`), so a run resumed after its slot records the
 * refusal instead of posting. The schedule starts it
 * at the slot's start; `at` names another instant inside the slot.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import * as Slack from "../../../packages/smithers/agent/integrations/src/slack/Actions.ts"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import { blocked, finish, report } from "../meetings-shared.ts"
import { FindOccurrence, MeetingFailed, MeetingReport, OpenDirect, ReadAgenda, RecordThread } from "../meetings.ts"
import { slackConnection } from "../slack-connection.ts"

const implementationVersion = "organization/meetings-open/v1"

/** Open one role's one-on-one. */
export default Flow.make("organization/meetings-open", {
  description:
    "Open a role's weekly one-on-one at its slot: post its agenda in the owner's private Slack conversation with the app under the role's name, or record that Slack is not connected.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: { principal: Profile.PrincipalId, at: Schema.optionalKey(Schema.Number) },
  success: MeetingReport,
  error: Schema.Union([MeetingFailed, Actions.ReceiptFailed]),
  body: (payload) =>
    FindOccurrence.call({
      principal: payload.principal,
      which: "current",
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
            Node.all({
              agenda: ReadAgenda.call({ occurrence }),
              direct: OpenDirect.call({
                principal: payload.principal,
                occurrence,
                ...(payload.at === undefined ? {} : { at: payload.at })
              })
            }).pipe(
              Node.bindPlanned(Node.capture({ implementationVersion }, (opened) =>
                Node.branch(Node.succeed(opened), {
                  if: Node.capture({ implementationVersion }, (seen) => seen.direct.connected),
                  else: () =>
                    report({
                      key: occurrence.key,
                      status: "opened",
                      summary: opened.direct.reason,
                      principal: payload.principal,
                      paths: [occurrence.notePath],
                      slack: "not connected"
                    }),
                  then: () =>
                    Slack.PostMessage.call({
                      connectionId: slackConnection,
                      channel: opened.direct.channel,
                      text: opened.agenda.text,
                      key: occurrence.key,
                      persona: opened.agenda.persona
                    }).pipe(
                      Node.bindPlanned(Node.capture({ implementationVersion }, (posted) =>
                        RecordThread.call({ occurrence, channel: posted.channel, thread: posted.ts }).pipe(
                          Node.andThen(report({
                            key: occurrence.key,
                            status: "opened",
                            summary: posted.ts,
                            principal: payload.principal,
                            paths: [occurrence.notePath],
                            slack: "posted"
                          }))
                        )))
                    )
                })))
            )
        }).pipe(
          blocked(occurrence.key, payload.principal),
          Node.bindPlanned(
            Node.capture(
              { implementationVersion },
              (outcome) => finish(occurrence.key, "meeting-open", payload, outcome)
            )
          )
        )))
    )
})
