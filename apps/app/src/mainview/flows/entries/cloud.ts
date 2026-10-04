/*
 * The `cloud` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `cloud` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "cloud", label: "Cloud", summary: "Smithers Cloud" }

/** The `cloud` flows registered as one aggregator block. */
export const cloudFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /*
   * Lane piper (ADR 0001): the Smithers Cloud login is the CLI's browser flow —
   * Bun listens for the callback and holds the token (the keychain at rest);
   * the renderer only opens the URL through the native door. Browser
   * mechanics the human clicks, so user-only, like auth.sign-in.
   */
  flow({
    name: "cloud.sign-in", hidden: true, discloseToAgent: false,
    summary: "Sign in to Smithers Cloud",
    runtime: ["cloud", "cloud.pat"],
    userOnly: true,
    userOnlyReason:
      "the Smithers Cloud browser login is the human's gesture on their account; the agent renders the step with cloud.prompt",
    input: NoPayload,
    handler: () => actions.signInCloud()
  }),
  flow({
    /*
     * The agent's door to the Cloud session, mirroring auth.prompt: it cannot
     * run cloud.sign-in, but it CAN render the step — the message's action IS
     * the sign-in button. Registered wherever Smithers Cloud is: on the web the GitHub
     * sign-in is the Cloud sign-in, and the controller offers that step.
     */
    name: "cloud.prompt", hidden: true, discloseToAgent: false,
    summary: "Offer the Smithers Cloud sign-in step in the chat",
    runtime: ["cloud"],
    input: NoPayload,
    handler: () => actions.promptCloudSignIn()
  }),
  flow({
    name: "cloud.sign-out", hidden: true, discloseToAgent: false,
    summary: "Sign out of Smithers Cloud",
    runtime: ["cloud", "cloud.pat"],
    userOnly: true,
    userOnlyReason: "dropping the human's Smithers Cloud credential is theirs alone",
    input: NoPayload,
    handler: () => actions.signOutCloud()
  })
]
