/**
 * `organization/team-reply`: a role answers another role's post in a team
 * channel thread. A post that names a role (`@<id>`) asks it; the serving
 * host starts this flow for it (`team-channel.ts`), at most three per thread.
 * The role reads the thread and answers with `reply`, posted in the same
 * thread under its name; a reply that names another role asks that one in
 * turn, within the same budget.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import { fieldTurn } from "../field-turn.ts"
import { RenderReply, StepFailure } from "../schema.ts"
import { ReplyTask, TeamPost } from "../team-channel.ts"

const implementationVersion = "organization/team-reply/v1"

/** Answer one post in a team thread. */
export default Flow.make("organization/team-reply", {
  description: "Have a role answer another role's post in a team channel thread, in that thread under its own name.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  idempotencyKey: (payload) => payload.key,
  payload: {
    key: Schema.NonEmptyString,
    thread: Schema.NonEmptyString,
    from: Profile.PrincipalId,
    to: Profile.PrincipalId,
    text: Schema.String,
    depth: Schema.Int
  },
  success: Schema.Struct({ key: Schema.String, status: Schema.String, reply: Schema.String }),
  error: StepFailure,
  body: (payload) =>
    Actions.PinRoster.call({}).pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (pin) =>
        ReplyTask.call({
          revision: pin.revision,
          key: payload.key,
          thread: payload.thread,
          from: payload.from,
          to: payload.to,
          text: payload.text
        }).pipe(
          Node.bindPlanned(Node.capture({ implementationVersion }, (stage) => fieldTurn(pin.revision, stage, ["reply"])))
        ))),
      Node.bindPlanned(Node.capture({ implementationVersion }, (answer) =>
        Node.branch(Node.succeed(answer), {
          if: Node.capture({ implementationVersion }, (seen) =>
            seen.valid && seen.result.status === "done" && typeof seen.result.fields["reply"] === "string" &&
            (seen.result.fields["reply"] as string).trim() !== ""),
          else: () => Node.succeed({ key: payload.key, status: "no reply", reply: "" }),
          then: () =>
            RenderReply.call({ speaker: payload.to, text: answer.result.fields["reply"] as unknown as string }).pipe(
              Node.bindPlanned(Node.capture({ implementationVersion }, (rendered) =>
                Node.all({
                  posted: TeamPost.call({ thread: payload.thread, role: payload.to, text: rendered.text, depth: payload.depth }),
                  reply: Node.succeed(rendered.text)
                }).pipe(
                  Node.map(Node.capture({ implementationVersion, key: payload.key }, function(done) {
                    return { key: this.key, status: done.posted.posted, reply: done.reply as string }
                  }))
                )))
            )
        })))
    )
})
