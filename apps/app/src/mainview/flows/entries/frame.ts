/*
 * The `frame` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `frame` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "frame", label: "Frames", summary: "Navigate frames" }

/** The `frame` flows registered as one aggregator block. */
export const frameFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "frame.back",
    summary: "Go to the previous frame",
    hidden: true,
    userOnly: true,
    userOnlyReason: "frame navigation is the human's browser gesture",
    input: NoPayload,
    handler: () => actions.frameBack()
  }),
  flow({
    name: "frame.forward",
    summary: "Go to the next frame",
    hidden: true,
    userOnly: true,
    userOnlyReason: "frame navigation is the human's browser gesture",
    input: NoPayload,
    handler: () => actions.frameForward()
  })
]
