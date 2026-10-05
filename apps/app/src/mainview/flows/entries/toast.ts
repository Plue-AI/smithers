/*
 * The `toast` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `toast` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "toast", label: "Toasts", summary: "Notifications on screen" }

/** The `toast` flows registered as one aggregator block. */
export const toastFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  // T-APP-18: the routed-entry and synchronous catalog providers are not mounted.
  // Keep the person-only door registered, but refuse without touching browser APIs.
  flow({
    name: "notifications.allow",
    summary: "Allow notifications",
    hidden: true,
    userOnly: true,
    userOnlyReason: "browser permission requires the person’s in-card gesture",
    input: NoPayload,
    handler: () => "Browser notifications are unavailable."
  }),
  flow({
    name: "toast.dismiss",
    summary: "Dismiss a toast notification",
    hidden: true,
    userOnly: true,
    userOnlyReason: "dismissing a toast is the human's gesture",
    args: "<toastId>",
    input: Schema.Struct({ toastId: Schema.String }),
    handler: ({ toastId }) => {
      actions.dismissToast(toastId)
    }
  })
]
