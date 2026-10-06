/*
 * The `form` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import type { AgentInvocation } from "../AgentInvocation"
import { Schema } from "effect"
import { flow, CardTarget } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `form` flows registered as one aggregator block. */
export const formFlows = (actions: CommandActions, invocation?: AgentInvocation): ReadonlyArray<FlowEntry> => [
  /*
   * THE FORM LAW (apps/app/AGENTS.md): the generic form card's own acts. A
   * field commits through form.set (one payload update, never component
   * state); form.submit assembles the line and runs the form's flow as the
   * actor that asked for it, so a consequential flow the agent asked for
   * still confirms. Hidden like every id-scoped card act, callable by the
   * agent like every hidden act.
   */
  flow({
    name: "form.set", visibility: "in-card",
    summary: "Set one field of a form card",
    hidden: true,
    args: "<cardId> <field> [value]",
    input: Schema.Struct({ cardId: Schema.String, field: Schema.String, value: Schema.String }),
    handler: ({ cardId, field, value }) => actions.setFormField(cardId, field, value)
  }),
  flow({
    name: "form.submit", visibility: "in-card",
    summary: "Submit a form card: run its flow with the fields filled in",
    hidden: true,
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }, _signal, _call, gesture) => actions.submitForm(cardId, invocation, gesture)
  })
]
