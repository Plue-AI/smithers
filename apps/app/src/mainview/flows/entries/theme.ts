/*
 * `/theme` (mvp.md Appendix A; was theme): light or dark, per
 * person. A bare surface flow: it has no namespace and the slash menu lists it
 * at the top level.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `theme` flow registered as one aggregator block. */
export const themeFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "theme",
    summary: "Switch light or dark; bare toggles",
    args: "[light|dark]",
    input: Schema.Struct({ mode: Schema.optional(Schema.Literals(["light", "dark"])) }),
    handler: ({ mode }: { readonly mode?: "light" | "dark" }) => actions.setTheme(mode)
  })
]
