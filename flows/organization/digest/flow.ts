/**
 * `organization/digest`: the owner's daily digest.
 *
 * Counts since the last digest, a line per pull request opened, per request
 * or issue that needs the owner, and per failure; written to
 * `<generatedDir>/digest/<date>.md` and sent as one direct message from the
 * assistant when Slack is connected. Once per day: a second run that day
 * posts nothing new.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { GatherDigest, PostDigest } from "../autonomy.ts"

const implementationVersion = "organization/digest/v1"

/** Send the owner's digest. */
export default Flow.make("organization/digest", {
  description: "Write the owner's daily digest to the wiki and send it as one direct message from the assistant.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: {},
  success: Schema.Struct({ path: Schema.String, slack: Schema.String }),
  body: () =>
    GatherDigest.call({}).pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (digest) => PostDigest.call({ digest })))
    )
})
