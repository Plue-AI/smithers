/*
 * The `env` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `env` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "env", label: "Environment", summary: "Workspace environment variables" }

/** The `env` flows registered as one aggregator block. */
export const envFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "env.view",
    summary: "Show a repository's agent environment",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    prepare: ({ repo }) => actions.viewEnvironment.preload?.(repo),
    handler: ({ repo }) => actions.viewEnvironment(repo)
  }),
  flow({
    name: "env.set",
    summary: "Set an agent-environment variable",
    runtime: ["cloud"],
    args: "<NAME=value> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ assignment: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ assignment, repo }) => actions.setEnvironmentVar(assignment, repo)
  }),
  flow({
    name: "env.remove-token",
    summary: "Remove a refused subscription token from a repository's agent environment",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.removeSubscriptionToken(repo)
  })
]
