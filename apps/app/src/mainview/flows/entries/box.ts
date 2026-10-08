/*
 * The `workspace` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `workspace` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "box", label: "Boxes", summary: "Open and drive the box for a branch: stream and inspect it (ADR 0002)" }

/** The `workspace.*` flows: the boxes (the design session says box, never computer). */
export const workspaceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "box.suspend", agent: "run", minimumRole: "member", actors: ["person","app_agent"], visibility: "in-card",
    summary: "Sleep this branch",
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String), branch: Schema.optional(Schema.String) }),
    handler: ({ workspaceId, branch }) => actions.branchControls && branch ? actions.branchControls.request("sleep", branch) : actions.live || actions.bootstrap?.capabilities.includes("install") ? "Branch unavailable" : actions.suspendWorkspace(workspaceId)
  }),
  flow({
    name: "box.resume", agent: "run", minimumRole: "member", actors: ["person","app_agent"], visibility: "in-card",
    summary: "Wake this branch",
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String), branch: Schema.optional(Schema.String) }),
    handler: ({ workspaceId, branch }) => actions.branchControls && branch ? actions.branchControls.request("wake", branch) : actions.live || actions.bootstrap?.capabilities.includes("install") ? "Branch unavailable" : actions.resumeWorkspace(workspaceId)
  }),
  flow({
    name: "box.session.destroy",
    summary: "Destroy a box session",
    runtime: ["cloud"],
    hidden: true,
    confirm: "destroy the session",
    args: "<sessionId> [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ sessionId: Schema.String, workspaceId: Schema.optional(Schema.String) }),
    handler: ({ sessionId, workspaceId }) => actions.destroyWorkspaceSession(sessionId, workspaceId)
  }),
  flow({
    name: "box.delete",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" }, confirmName: { label: "Name, typed back" } } },
    summary: "Delete a box",
    runtime: ["cloud"],
    hidden: true,
    confirm: "delete the box",
    /* The workspace's name typed back is the flow's own input: the seam deletes only when it matches, whoever invoked. */
    args: "<workspaceId> <name>",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.String, confirmName: Schema.String }),
    handler: ({ workspaceId, confirmName }) => actions.deleteWorkspace(workspaceId, confirmName)
  }),
  flow({
    /* The card's body tab: showing a facet is how the agent answers "show me the files" too (.specs/engineering/spec.md §6.1). */
    name: "box.facet", visibility: "in-card", hidden: true, discloseToAgent: false,
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Switch a box card's facet",
    runtime: ["cloud"],
    args: "<workspaceId> <facet>",
    requires: ["signed-in"],
    input: Schema.Struct({
      workspaceId: Schema.String,
      facet: Schema.Literals(["terminal", "files", "services", "egress"])
    }),
    prepare: ({ workspaceId, facet }) => actions.setWorkspaceFacet.preload?.(workspaceId, facet),
    handler: ({ workspaceId, facet }) => actions.setWorkspaceFacet(workspaceId, facet)
  }),
  flow({
    name: "box.services", hidden: true, discloseToAgent: false,
    summary: "List a box's services",
    runtime: ["cloud"],
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.listWorkspaceServices(workspaceId)
  }),
  flow({
    name: "box.egress", hidden: true, discloseToAgent: false,
    summary: "List what a box called out to, and which secret names were swapped in",
    runtime: ["cloud"],
    args: "[workspaceId] [cursor]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String), cursor: Schema.optional(Schema.String) }),
    handler: ({ workspaceId, cursor }) => actions.listWorkspaceEgress(workspaceId, cursor)
  }),
  flow({
    name: "box.images", hidden: true, discloseToAgent: false,
    summary: "List the environment images a repository has built for its boxes",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listEnvironmentImages(repo)
  })
]
