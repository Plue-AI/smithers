/*
 * The `appearance` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { PALETTES } from "../../state/AppState"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `appearance` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "appearance", label: "Appearance", summary: "Theme and colors" }

/** The `appearance` flows registered as one aggregator block. */
export const appearanceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  /*
   * Shared declarations used by the registry and UI controls.
   */
  const THEME = {
    name: "appearance.theme",
    summary: "Set the color theme",
    args: PALETTES.join(" | "),
    input: Schema.Struct({ palette: Schema.String }),
    handler: ({ palette }: { readonly palette: string }) => actions.setPalette(palette)
  }
  const DARK_MODE = {
    name: "appearance.dark-mode",
    summary: "Switch to light or dark mode; bare toggles",
    args: "[light|dark]",
    input: Schema.Struct({ mode: Schema.optional(Schema.Literals(["light", "dark"])) }),
    handler: ({ mode }: { readonly mode?: "light" | "dark" }) => actions.setTheme(mode)
  }
  return [
  /*
   * `appearance.*` — look and feel. The color theme is the axis orthogonal to
   * light/dark: `/appearance.theme <key>` wears a palette, bare answers with
   * the list and where the human already is. User-only browser chrome.
   */
  flow(THEME),
  flow(DARK_MODE)
  ]
}
