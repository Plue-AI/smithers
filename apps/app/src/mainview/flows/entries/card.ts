/*
 * The `card` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload, CardTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `card` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "card", label: "Cards", summary: "Maximize and minimize cards" }

/** The `card` flows registered as one aggregator block. */
export const cardFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "confirm.cancel", agent: "never", minimumRole: "member", actors: ["person"], visibility: "in-card",  summary: "Cancel a confirmation", hidden: true, agentReason: "a confirmation answer belongs to the person",
    input: Schema.Struct({ confirmation: Schema.String.pipe(Schema.check(Schema.isMinLength(1))), revision: Schema.String }),
    grammar: args => {
      try {
        const payload: unknown = JSON.parse(args ?? "{}")
        return payload !== null && typeof payload === "object" && !Array.isArray(payload)
          ? { payload: payload as Record<string, unknown> } : { error: "Invalid confirmation input" }
      }
      catch { return { error: "Invalid confirmation input" } }
    },
    form: { args: payload => JSON.stringify(payload) },
    handler: ({ confirmation, revision }) => actions.cancelConfirmation(confirmation, revision) }),
  flow({ name: "card.history.back", summary: "Go back inside an embedded frame", args: "<cardId>", input: CardTarget,
    handler: ({ cardId }) => actions.moveCardHistory(cardId, -1) }),
  flow({ name: "card.history.forward", summary: "Go forward inside an embedded frame", args: "<cardId>", input: CardTarget,
    handler: ({ cardId }) => actions.moveCardHistory(cardId, 1) }),
  flow({
    /* Maximize is the user's explicit act alone (THE EMBED LAW). */
    name: "card.maximize", visibility: "in-card",
    summary: "Maximize a card",
    hidden: true,
    agent: "never" as const,
    agentReason: "maximizing a card is the human's explicit act (THE EMBED LAW)",
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.maximizeCard(cardId)
  }),
  flow({
    name: "card.minimize", visibility: "in-card",
    summary: "Minimize the maximized card",
    hidden: true,
    agent: "never" as const,
    agentReason: "minimizing a card is the human's explicit act",
    input: NoPayload,
    handler: () => actions.minimizeCard()
  }),
  flow({
    /* THE FORM LAW: a form card's Cancel. Only form cards dismiss; the handler refuses the rest by kind. */
    name: "card.dismiss", visibility: "in-card",
    summary: "Dismiss a form card",
    hidden: true,
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.dismissCard(cardId)
  })
]
