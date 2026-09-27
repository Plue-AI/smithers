/*
 * The `workspace.*` flows: the sidebar heading that names the person's
 * workspace (the account-level home), not a box.
 */
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `workspace` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "workspace", label: "Workspace", summary: "Name the workspace heading" }

/** The workspace rename, registered with the sidebar flows after `repo.tree`. */
export const workspaceRenameFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /* The workspace heading: its name, and the pencil that edits it inline. */
  flow({
    name: "workspace.rename",
    summary: "Name this workspace",
    args: "<name>",
    input: Schema.Struct({ name: Schema.String }),
    handler: ({ name }) => actions.renameWorkspace(name)
  }),
  flow({
    name: "workspace.rename.edit",
    summary: "Rename the workspace",
    hidden: true,
    userOnly: true,
    userOnlyReason: "opening the inline editor is the human's gesture; the agent names the workspace with workspace.rename",
    input: NoPayload,
    handler: () => actions.toggleWorkspaceRename()
  })
]
