/*
 * The `workspace` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { fileArgs } from "../FileArgs"
import { flag, line, text } from "@smthrs/ui/flow-form"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `workspace` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "box", label: "Boxes", summary: "Open and drive the box for a branch: stream and inspect it (ADR 0002)" }

/** The `workspace.*` flows: the boxes (the design session says box, never computer). */
export const workspaceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /*
   * Lane citc (ADR 0002): the persistent cloud computers. `box.open`
   * creates-or-reuses one on a bookmark and renders its card (the transcript
   * is the review surface); the acts ride the one seam; a bare act resolves
   * the active workspace copy, else the single loaded one. Destructive acts
   * are id-scoped and hidden — the card's buttons invoke them.
   */
  flow({
    name: "box.list",
    summary: "List your boxes",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listWorkspaces(repo)
  }),
  flow({
    /* Launching a cloud computer is an outbound act: the capability always asks. */
    name: "box.open",
    form: {
      /* A recovery's snapshot and recoveryOf are the restore buttons' routing data (WorkspaceCard), never typed. */
      fields: {
        bookmark: { optionsFrom: "bookmarks", kind: "text" }, repo: { optionsFrom: "cloud-repos", kind: "text" },
        snapshot: { hidden: true }, recoveryOf: { hidden: true }
      },
      args: (payload) => line(text(payload, "bookmark"), text(payload, "repo"), flag(payload, "kind"), flag(payload, "snapshot"), flag(payload, "recoveryOf"))
    },
    summary: "Open (create or reuse) a Linux box in Smithers Cloud on a bookmark: a real machine with a terminal, files, and services the user can use",
    runtime: ["cloud"],
    /* ADR 0002: three sandbox kinds share one option surface, and the kind is the choice. */
    args: "[bookmark] [owner/repo] [--kind container|vm] [--snapshot id] [--recoveryOf id]",
    requires: ["signed-in"],
    input: Schema.Struct({
      bookmark: Schema.optional(Schema.String),
      repo: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.Literals(["container", "vm"])),
      snapshot: Schema.optional(Schema.String),
      recoveryOf: Schema.optional(Schema.String)
    }),
    handler: ({ bookmark, repo, kind, snapshot, recoveryOf }) => actions.openWorkspace(bookmark, repo, kind, snapshot, recoveryOf)
  }),
  flow({
    name: "box.view",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Open one box's card",
    runtime: ["cloud"],
    args: "<workspaceId>",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.String }),
    handler: ({ workspaceId }) => actions.viewWorkspace(workspaceId)
  }),
  flow({
    name: "box.terminal",
    summary: "Open a terminal on a box",
    /* The terminal rides this origin's `/api/cloud-ws/` tunnel: an origin without one registers no terminal. */
    runtime: ["cloud", "cloud.terminal"],
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.openWorkspaceTerminal(workspaceId)
  }),
  flow({
    name: "box.suspend",
    summary: "Suspend a box",
    runtime: ["cloud"],
    confirm: "suspend the box",
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.suspendWorkspace(workspaceId)
  }),
  flow({
    name: "box.resume",
    summary: "Resume a box",
    runtime: ["cloud"],
    confirm: "resume the box",
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.resumeWorkspace(workspaceId)
  }),
  flow({
    name: "box.sessions",
    summary: "List a box's sessions",
    runtime: ["cloud"],
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.listWorkspaceSessions(workspaceId)
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
    name: "box.facet",
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
  /*
   * Lane L3: the facets plue#449 and the egress audit answer. Files and the
   * file read are ordinary reads — the model asks about a computer's working
   * copy the same way a human clicks the facet. The egress audit is cursor
   * paginated: a bare call reads the newest page, a cursor reads the page
   * behind it and the card appends.
   */
  flow({
    name: "box.files",
    form: { args: (payload) => fileArgs(text(payload, "path") ?? "/", text(payload, "workspaceId")) },
    summary: "List a box's files under a directory",
    runtime: ["cloud"],
    args: "[path] [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ path: Schema.optional(Schema.String), workspaceId: Schema.optional(Schema.String) }),
    handler: ({ path, workspaceId }) => actions.listWorkspaceFiles(path, workspaceId)
  }),
  flow({
    name: "box.file",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } }, args: (payload) => fileArgs(text(payload, "path"), text(payload, "workspaceId")) },
    summary: "Read one file out of a box",
    runtime: ["cloud"],
    args: "<path> [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ path: Schema.String, workspaceId: Schema.optional(Schema.String) }),
    handler: ({ path, workspaceId }) => actions.readWorkspaceFile(path, workspaceId)
  }),
  flow({
    name: "box.services",
    summary: "List a box's services",
    runtime: ["cloud"],
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.listWorkspaceServices(workspaceId)
  }),
  flow({
    name: "box.egress",
    summary: "List what a box called out to, and which secret names were swapped in",
    runtime: ["cloud"],
    args: "[workspaceId] [cursor]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String), cursor: Schema.optional(Schema.String) }),
    handler: ({ workspaceId, cursor }) => actions.listWorkspaceEgress(workspaceId, cursor)
  }),
  flow({
    name: "box.images",
    summary: "List the environment images a repository has built for its boxes",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listEnvironmentImages(repo)
  })
]
