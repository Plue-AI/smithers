/*
 * The `integrations` flow: the services that sync with threads, tasks and the
 * wiki — Slack, Linear, Notion — read into the connect card's rows (DESIGN
 * §3.6). One module per namespace, registered in Flows.ts.
 */
import type { FlowEntry, Namespace } from "../registry"
import { flow, RepoTarget } from "./Declare"
import type { CommandActions } from "./Declare"

/** The `integrations` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "integrations", label: "Integrations", summary: "Slack, Linear and Notion for threads, tasks and the wiki" }

export const integrationsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "integrations.list",
    summary: "Show the services connected to a repository's threads, tasks and wiki",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listIntegrations(repo)
  })
]
