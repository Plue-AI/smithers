/*
 * The `app` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import type { FlowEntry,Namespace } from "../registry"
import type { CommandActions } from "./Declare"
import { flow,NoPayload } from "./Declare"

/** The `app` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "app", label: "App", summary: "The Smithers app itself" }

/** The `app` flows registered as one aggregator block. */
export const appFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "app.first-run.dismiss", hidden: true, summary: "Dismiss recommended actions", input: NoPayload, handler: () => actions.dismissFirstRun() }),
  flow({ name: "app.hint.dismiss", hidden: true, summary: "Dismiss a hint", args: "<id>", input: Schema.Struct({ id: Schema.String }), handler: ({ id }) => actions.dismissHint(id) }),
  /*
   * The web app's one door to the native app (docs/web-mode/PLAN.md §3). The
   * split mirrors auth.sign-in / auth.prompt: `window.open` outside a user
   * gesture is popup-blocked, so the model renders the card and the click is
   * the human's. Both exist only on the cloud host — native chrome gains
   * nothing, and the native model is never told to offer a download.
   */
  flow({
    name: "app.download",
    summary: "Download the native Smithers app",
    hosts: ["cloud"],
    /* The chrome button and the refusal card's action; the prompt flow is the listed door. */
    hidden: true,
    userOnly: true,
    userOnlyReason: "a browser handoff the human clicks; the agent renders the step with app.download.prompt",
    input: NoPayload,
    handler: (_payload, _signal, _call, gesture) => actions.openDownload(gesture?.openExternal)
  }),
  flow({
    name: "app.download.prompt",
    summary: "Offer the native app download in the chat",
    hosts: ["cloud"],
    args: "[flow]",
    input: Schema.Struct({ flow: Schema.optional(Schema.String) }),
    handler: ({ flow }) => actions.promptDownload(flow)
  })
]
