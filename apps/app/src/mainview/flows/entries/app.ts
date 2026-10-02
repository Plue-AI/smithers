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
]
