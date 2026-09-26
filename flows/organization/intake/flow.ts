/**
 * `organization/intake`: one request from a person, admitted and handed to
 * `organization/deliver`.
 *
 * The host admits the request against its configuration first: a Slack
 * request must come from an allowlisted owner, and the repository must be one
 * the host serves. A Slack request is then acknowledged before any role works
 * on it: 👀 on the owner's message, or "On it." in its thread under the
 * assistant's persona when the app cannot react (no `reactions:write`). Delivery runs as a
 * child execution keyed by the request key, so the same request admitted twice
 * joins one delivery; the host starts intake itself under that key, so a
 * redelivered Slack event joins one intake run too.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import * as Slack from "../../../packages/smithers/agent/integrations/src/slack/Actions.ts"
import Deliver from "../deliver/flow.ts"
import { Admit, DeliveryFailed, IntakeRefused, React, RenderReply, Report, Request, StepFailure } from "../schema.ts"
import { slackConnection } from "../slack-connection.ts"

const implementationVersion = "organization/intake/v2"

/** Admit one request and deliver it. */
export default Flow.make("organization/intake", {
  description:
    "Admit one owner request from Slack or the local CLI under the host's configuration, acknowledge it with a reaction or in its thread, and deliver it.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  idempotencyKey: (payload) => payload.request.key,
  payload: { request: Request },
  success: Report,
  error: Schema.Union([IntakeRefused, DeliveryFailed, StepFailure]),
  body: ({ request }) =>
    Admit.call({ request }).pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (admission) => {
        const deliver = Deliver.child({ request, admission })
        const conversation = request.conversation
        if (conversation === undefined) return deliver
        const said = RenderReply.call({ speaker: admission.assistant, text: "On it." }).pipe(
          Node.bindPlanned(Node.capture({ implementationVersion }, (reply) =>
            Slack.PostMessage.call({
              connectionId: slackConnection,
              channel: conversation.channel,
              threadTs: conversation.thread,
              text: reply.text,
              key: `${request.key}/ack`,
              persona: reply.persona
            })))
        )
        return React.call({
          channel: conversation.channel,
          ts: conversation.message ?? conversation.thread,
          add: ["eyes"],
          remove: []
        }).pipe(
          Node.branch({
            if: Node.capture({ implementationVersion }, (seen) => seen.reacted),
            then: () => Node.succeed(null),
            else: () => said
          }),
          Node.andThen(deliver)
        )
      }))
    )
})
