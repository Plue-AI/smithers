/*
 * The `agent` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flag, line, text } from "@smthrs/ui/flow-form"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `agent` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "agent", label: "Agents", summary: "Delegate work to an agent role" }

/** The `agent.*` flows: roles, delegation, the explainer, the list. */
export const agentFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  /*
   * The explainer inside the app (AgentRoles.ts): one side turn on the
   * explainer role, answered as an embedded card. Callable by the model and
   * by a human through `/agent.explain`.
   */
  const EXPLAIN = {
    name: "agent.explain",
    summary: "Ask the Explainer to explain something",
    runtimeAny: ["agent", "model.turn"] as const,
    args: "<what>",
    input: Schema.Struct({ what: Schema.String }),
    handler: ({ what }: { readonly what: string }) => actions.explain(what)
  }
  return [
  flow(EXPLAIN),
  flow({
    name: "agent.list",
    summary: "Show the agents: built-in, with what each can launch here",
    input: NoPayload,
    handler: () => actions.listAgents()
  }),
  ]
}

/** Root composes this alongside agentFlows after binding the controller. */
export const tutorialChangeFlows = (actions: import("../../state/controller/tutorialChange").TutorialChangeController): ReadonlyArray<FlowEntry> => [
  flow({ name: "agent.change", summary: "Inspect the repository and suggest a planned change", args: "[repo] [feature]",
    input: Schema.Struct({ repo: Schema.optional(Schema.String), feature: Schema.optional(Schema.String) }),
    form: { fields: { repo: { optionsFrom: "cloud-repos" } }, args: payload => line(text(payload, "repo"), flag(payload, "feature")) },
    confirm: "inspect the repository with an agent and prepare a change plan",
    handler: ({ repo, feature }) => actions.suggestTutorialChange(repo, feature) }),
  flow({
    name: "agent.change.start",
    summary: "Start the reviewed change plan", args: "<cardId>",
    input: Schema.Struct({ cardId: Schema.String }), confirm: "execute the reviewed plan and create its commits",
    handler: ({ cardId }) => actions.startTutorialChange(cardId) })
]
