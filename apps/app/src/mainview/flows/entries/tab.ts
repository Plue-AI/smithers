/*
 * The `tab` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 *
 * A tab is a card pinned beside the conversation (docs/LOCAL-APP.md "Cards",
 * "Open in tab"). The terminal and harness tabs retired with the local backend
 * (docs/LOCAL-BACKEND-RETIREMENT.md, smithersai/smithers#2229): no host runs a
 * process behind a tab, so there is no session to read, no `+` menu, and no
 * close question to answer.
 */
import { Schema } from "effect"
import { flow, CardTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `tab` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "tab", label: "Sessions", summary: "Card tabs" }

/** The card tab flows: card, select, close. */
export const tabFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /* Pins a card the agent just rendered into its own tab: an ordinary act. */
    name: "tab.card",
    summary: "Open a card in a tab",
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.openCardTab(cardId)
  }),
  flow({
    name: "tab.select",
    summary: "Select a session",
    hidden: true,
    userOnly: true,
    userOnlyReason: "focus is the human's",
    args: "<tabId | 1-9>",
    input: Schema.Struct({ tab: Schema.String }),
    handler: ({ tab }) => actions.selectTab(tab)
  }),
  flow({
    /* Closing a card tab keeps the card in the transcript: an ordinary act. */
    name: "tab.close",
    summary: "Close a session",
    args: "[tabId]",
    input: Schema.Struct({ tabId: Schema.optional(Schema.String) }),
    handler: ({ tabId }) => actions.closeTab(tabId)
  })
]
