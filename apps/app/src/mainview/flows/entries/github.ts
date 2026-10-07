/*
 * The `github` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

export const GitHubInstallationInput = Schema.Struct({ installationId: Schema.String })
export const GitHubInstallationForm = { fields: { installationId: { label: "Installation", kind: "select" as const } } }

/** The `github` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "github", label: "GitHub", summary: "The GitHub App and the mirror (ADR 0005)" }

/** The `github` flows registered as one aggregator block. */
export const githubFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [

  flow({
    name: "github.app",
    summary: "Open Settings",
    hidden: true,
    minimumRole: "owner",
    actors: ["person"],
    agent: "never",
    agentReason: "Install controls require the owner’s person session",
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: async () => { await actions.presentCard("settings", "Settings"); return actions.showSettings() }
  }),
  flow({
    /* The card's Install button — browser mechanics the human clicks. */
    name: "github.app.open",
    summary: "Open the GitHub App's install page",
    hidden: true,
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.githubOpenInstall(repo)
  }),
  flow({
    name: "github.app.choose",
    summary: "Choose a GitHub App installation",
    hidden: true,
    runtime: ["cloud"],
    args: "<installationId>",
    requires: ["signed-in"],
    input: GitHubInstallationInput,
    form: GitHubInstallationForm,
    handler: ({ installationId }) => actions.githubChooseInstallation(installationId)
  }),
  flow({
    name: "github.reconcile",
    summary: "Re-derive the GitHub App's wiring, then re-read the status",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.githubReconcile(repo)
  }),
  flow({
    name: "github.mirror-sync", visibility: "hidden",
    summary: "Sync the repository to GitHub",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.githubMirrorSync(repo)
  }),
  flow({
    /*
     * plue#491: one failed ref, pushed again. The ref name carries slashes
     * and rides as one escaped path segment; the answer is a new mirror run,
     * which the same card then tracks.
     */
    name: "github.mirror.retry-ref", visibility: "hidden",
    summary: "Retry one failed mirror ref",
    runtime: ["cloud"],
    args: "<ref> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ ref: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ ref, repo }) => actions.retryMirrorRef(ref, repo)
  })
]
