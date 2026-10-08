/*
 * The `change` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `change` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "change", label: "Changes", summary: "Changes and diffs — the change is the unit (ADR 0003)" }

/** The `change` flows registered as one aggregator block. */
export const changeFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "change.resolve",
    summary: "Dispatch an agent to resolve a change's conflict",
    runtime: ["cloud"],
    confirm: "dispatch an agent to resolve the conflict",
    args: "<changeId> <path>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, path: Schema.String }),
    handler: ({ changeId, path }) => actions.resolveChangeConflict(changeId, path)
  }),
  flow({
    /* The card's body tab: showing a facet is how the agent answers "show me the diff / the checks" (.specs/engineering/spec.md §6.1). */
    name: "change.facet",
    summary: "Switch a change card's facet",
    runtime: ["cloud"],
    args: "<changeId> <facet>",
    requires: ["signed-in"],
    input: Schema.Struct({
      changeId: Schema.String,
      facet: Schema.Literals(["walkthrough", "diff", "findings", "checks", "review", "history", "owners"])
    }),
    handler: ({ changeId, facet }) => actions.setChangeFacet(changeId, facet)
  }),
]
