/*
 * The `appearance` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `appearance` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "appearance", label: "Appearance", summary: "Light or dark mode" }

/** The `appearance` flows registered as one aggregator block. */
export const appearanceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  /*
   * Shared declarations used by the registry and UI controls.
   */
  const DARK_MODE = {
    name: "appearance.dark-mode",
    summary: "Switch to light or dark mode; bare toggles",
    args: "[light|dark]",
    input: Schema.Struct({ mode: Schema.optional(Schema.Literals(["light", "dark"])) }),
    handler: ({ mode }: { readonly mode?: "light" | "dark" }) => actions.setTheme(mode)
  }
  return [
  flow(DARK_MODE)
  ]
}
