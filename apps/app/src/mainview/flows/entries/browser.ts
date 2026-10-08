/*
 * The `browser` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `browser` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "browser", label: "Browser", summary: "Read web pages" }

/** The `browser` flows registered as one aggregator block. */
export const browserFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  /* The browser tool + surface (§2d/§2d′): read a page; embed its card. */
  const BROWSER = {
    name: "browser.open",
    summary: "Open a web page as a card Smithers can read",
    runtime: ["browser.read"] as const,
    args: "<url>",
    input: Schema.Struct({ url: Schema.String }),
    handler: ({ url }: { readonly url: string }) => actions.openBrowser(url)
  }
  return [
  flow(BROWSER)
  ]
}
