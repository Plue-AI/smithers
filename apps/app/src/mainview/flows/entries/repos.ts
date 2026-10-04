/*
 * The `repos` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `repos` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "repos", label: "Repositories", summary: "GitHub and Smithers Cloud repositories" }

/** `repos.import`, registered after billing. */
export const reposImportFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /*
   * The multi-parity domain flows (MULTI-ACTIONS-GAP.md): issues, PRs
   * (landings — a land QUEUES, it never "merges"), billing checkout,
   * notifications, the agent environment, and repo import. Repo-scoped flows
   * take an optional `repo` target; absent one, a single watched repository is
   * the target and several are an honest choice (RepoContext.ts). They require
   * signed-in only — an explicit owner/repo must not defer into the
   * watched-repos chooser.
   */
  flow({
    name: "repos.import", hidden: true, discloseToAgent: false,
    summary: "Import a GitHub repository into Smithers Cloud",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.importRepository(repo)
  })
]

/** `repos.import.retry`, registered beside the GitHub mirror flows it retries. */
export const reposImportRetryFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "repos.import.retry", hidden: true, discloseToAgent: false,
    summary: "Retry a failed GitHub import job",
    runtime: ["cloud"],
    args: "<jobId>",
    requires: ["signed-in"],
    input: Schema.Struct({ jobId: Schema.String }),
    handler: ({ jobId }) => actions.retryImport(jobId)
  })
]
