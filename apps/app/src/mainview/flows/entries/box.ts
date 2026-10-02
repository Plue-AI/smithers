/*
 * The `workspace` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { fileArgs } from "../FileArgs"
import { flowArgs } from "../FlowArgs"
import { flag, line, text } from "@smthrs/ui/flow-form"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `workspace` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "box", label: "Boxes", summary: "Open and drive the box for a branch: stream and inspect it (ADR 0002)" }

/**
 * The repository `/desktop` will act on: the one the invocation named, else
 * the one the selection names right now. Resolved at ASK time so the
 * confirmation can bind it (registry.ts `confirmArgs`); undefined when
 * nothing is selected, which is the seam's refusal to make, not this
 * declaration's.
 */
const desktopRepo = (actions: CommandActions, payload: Record<string, unknown>): string | undefined =>
  text(payload, "repo") ?? actions.activeRepository() ?? undefined

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
    args: "[bookmark] [owner/repo] [--kind container|vm|desktop] [--snapshot id] [--recoveryOf id]",
    requires: ["signed-in"],
    input: Schema.Struct({
      bookmark: Schema.optional(Schema.String),
      repo: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.Literals(["container", "vm", "desktop"])),
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
  /*
   * The pick a box-bound act asks for when several boxes could be meant
   * (RepoContext.defaultBoxBinding): its form lists those boxes, and Submit
   * selects the chosen one and runs the act that asked, once.
   */
  flow({
    name: "box.select",
    form: { fields: { workspaceId: { optionsFrom: "workspaces", label: "Box" }, repo: { hidden: true }, flow: { hidden: true }, args: { hidden: true } } },
    summary: "Select a box",
    runtime: ["cloud"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "which box an act runs on is the human's selection",
    args: "<workspaceId>",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.String, repo: Schema.optional(Schema.String), flow: Schema.optional(Schema.String), args: Schema.optional(Schema.String) }),
    handler: ({ workspaceId, repo, flow, args }) => actions.selectBox(workspaceId, repo, flow, args)
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
    /* The card's body tab: showing a facet is how the agent answers "show me the files" too (agent-parity.md). */
    name: "box.facet",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Switch a box card's facet",
    runtime: ["cloud"],
    args: "<workspaceId> <facet>",
    requires: ["signed-in"],
    input: Schema.Struct({
      workspaceId: Schema.String,
      facet: Schema.Literals(["terminal", "files", "services", "egress", "desktop"])
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
  /*
   * Lane L3b: the desktop. Every flow here MINTS a session — an absolute,
   * already-credentialed stream URL carrying a live machine's VNC password —
   * so each carries `confirm`: the model may ask for it, the human performs
   * it. The credential never enters the store; the facet reads it out of
   * module memory (state/seams/DesktopStream.ts).
   *
   * `/desktop` — the one-command open. Two slash commands and two confirms
   * (`box.open --kind desktop`, then `box.desktop`) were the
   * whole of what a person wanted: a box with a screen. This flow is that
   * want, and it carries ONE confirmation for the launch AND the mint
   * because it is one act.
   *
   * It is the VISIBLE desktop door, which is also how `/desktop` resolves
   * deterministically: the slash tree ranks by name (registry.ts nameRank),
   * so a needle of "desktop" reaches exactly the visible flows whose name or
   * summary holds it. `box.desktop` below is therefore hidden — it
   * mints on an id a card already holds, which is a button's act, like
   * `box.desktop.rotate` beside it — and the bare `desktop` alias at
   * the end of this block catches the typed line with arguments.
   */
  flow({
    name: "box.desktop.open",
    form: {
      fields: { bookmark: { optionsFrom: "bookmarks", kind: "text" }, repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) => line(text(payload, "bookmark"), text(payload, "repo"))
    },
    summary: "Open a desktop box on a bookmark and stream its screen into the card: create or reuse it, wait for it, and start the stream",
    runtime: ["cloud"],
    confirm: (payload) => `open a desktop box on ${desktopRepo(actions, payload) ?? "the selected repository"}`,
    /*
     * The confirmation carries the repository this ask resolved, never the
     * bare line: the human may switch repositories while the message waits,
     * and the button must run the act the message named.
     */
    confirmArgs: (payload) => {
      const repo = desktopRepo(actions, payload)
      return repo === undefined ? undefined : flowArgs("box.desktop.open", { bookmark: text(payload, "bookmark"), repo })
    },
    args: "[bookmark] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ bookmark: Schema.optional(Schema.String), repo: Schema.optional(Schema.String) }),
    handler: ({ bookmark, repo }) => actions.openDesktopBox(bookmark, repo)
  }),
  flow({
    /* The card's "Stop waiting": it ends the wait, and leaves the box to plue. */
    name: "box.desktop.stop",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Stop waiting for a desktop box to come up",
    runtime: ["cloud"],
    hidden: true,
    args: "<workspaceId>",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.String }),
    handler: ({ workspaceId }) => actions.stopDesktopWait(workspaceId)
  }),
  flow({
    name: "box.desktop",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Mint a new stream for a desktop box the card already holds",
    runtime: ["cloud"],
    hidden: true,
    confirm: "open the box's desktop",
    args: "<workspaceId>",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.String }),
    handler: ({ workspaceId }) => actions.openWorkspaceDesktop(workspaceId)
  }),
  flow({
    /* Rotating changes the VNC password in the guest: the old iframe disconnects. */
    name: "box.desktop.rotate",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Rotate a box desktop session",
    runtime: ["cloud"],
    hidden: true,
    confirm: "rotate the desktop session",
    args: "<workspaceId>",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.String }),
    handler: ({ workspaceId }) => actions.rotateWorkspaceDesktop(workspaceId)
  }),
  flow({
    /*
     * The bare door. `/desktop` typed with arguments never opens the slash
     * overlay (the draft holds a space), so it lands on parseSubmit's exact,
     * hidden-inclusive name match — the same way `/issues open` reaches the
     * bare `issues` alias. Hidden, because the visible door is
     * `box.desktop.open` and the two run the same handler, so whichever
     * one a line resolves to, the act is identical.
     */
    name: "desktop",
    hidden: true,
    form: {
      fields: { bookmark: { optionsFrom: "bookmarks", kind: "text" }, repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) => line(text(payload, "bookmark"), text(payload, "repo"))
    },
    summary: "Open a desktop box on a bookmark and stream its screen into the card",
    runtime: ["cloud"],
    confirm: (payload) => `open a desktop box on ${desktopRepo(actions, payload) ?? "the selected repository"}`,
    confirmArgs: (payload) => {
      const repo = desktopRepo(actions, payload)
      return repo === undefined ? undefined : flowArgs("box.desktop.open", { bookmark: text(payload, "bookmark"), repo })
    },
    args: "[bookmark] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ bookmark: Schema.optional(Schema.String), repo: Schema.optional(Schema.String) }),
    handler: ({ bookmark, repo }) => actions.openDesktopBox(bookmark, repo)
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
