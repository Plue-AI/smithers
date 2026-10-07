/*
 * The `palette` flows (Search and Command Palette Spec 2026-09-07 §6): the
 * overlay itself as flows. Opening it is focus and a menu is a menu, so
 * `palette.open` and `palette.actions` are user-only with their reasons
 * (the three-door law's enumerated exceptions); the agent's door to what the
 * palette shows is every `search.*` flow, which answers the same rows as
 * data. `palette.recent` is the frecency ledger as data, agent-invocable.
 */
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `palette` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "palette", label: "Palette", summary: "The search and command palette" }

export const PALETTE_OPEN_REASON = "focusing the composer and opening the overlay is the human's gesture; the agent searches with the search.* flows, which answer the same rows as data"
export const PALETTE_ACTIONS_REASON = "opening a menu is the human's gesture; every action in it is a registered flow the agent can run by name"

/** The `palette.*` flows registered as one aggregator block. */
export const paletteFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "palette.open",
    summary: "Open the search palette (Cmd+K); a prefix opens it in that mode",
    agent: "never" as const,
    agentReason: PALETTE_OPEN_REASON,
    args: "[prefix]",
    input: Schema.Struct({ prefix: Schema.optional(Schema.String) }),
    handler: ({ prefix }) => actions.openPalette(prefix)
  }),
  flow({
    name: "palette.actions", visibility: "in-card",
    summary: "Open the actions panel for a palette item",
    hidden: true,
    agent: "never" as const,
    agentReason: PALETTE_ACTIONS_REASON,
    args: "<ref>",
    input: Schema.Struct({ ref: Schema.String }),
    handler: ({ ref }) => actions.togglePaletteActions(ref)
  }),
  flow({
    name: "palette.recent",
    summary: "The palette's recent items as data: what was opened in the last seven days, most recent first",
    input: NoPayload,
    handler: () => actions.paletteRecent()
  })
]
