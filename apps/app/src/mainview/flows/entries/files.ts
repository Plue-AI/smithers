/*
 * The `files` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { fileArgs } from "@smthrs/rpc/FileRead"
import { FILES_LIST_COMMAND } from "@smthrs/rpc/FileList"
import { text } from "@smthrs/ui/flow-form"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `files` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "files", label: "Files", summary: "Read repository files" }

/** `files.list` and `files.read`. */
export const filesFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  ...(["file.reapply"] as const).map(name => flow({
    name, visibility: "in-card", agent: "never", actors: ["person"], minimumRole: "member", summary: "Reapply unsaved edits",
    grammar: args => {
      const value = args?.trim() ?? ""
      if (!value) return { payload: {} }
      if (value.startsWith("{")) { try { return { payload: JSON.parse(value) } } catch { return { error: "Enter a path" } } }
      return { payload: { path: value } }
    },
    args: "<path>", input: Schema.Struct({ path: Schema.String, branch: Schema.optional(Schema.String) }), handler: async ({ path, branch }) => (await actions.recoverFile(name, path, branch)) ?? "File recovery is unavailable."
  })),
  flow({ name: "files.open-diff", summary: "Read a file at the diff revision in its frame", args: "<cardId> <path>",
    input: Schema.Struct({ cardId: Schema.String, path: Schema.String }), handler: ({ cardId, path }) => actions.openDiffFile(cardId, path) }),
  flow({
    /*
     * Files flows parse the PATH as the first token, always — a lone `src/x`
     * is a path, never a repo (deterministic beats clever); name the repo as a
     * second token to cross repositories.
     */
    name: "files.list",
    form: { args: (payload) => fileArgs(text(payload, "path") ?? "/", text(payload, "repo")) },
    /* The model host binds its listing of the mirrored main to the same catalog entry and grammar (@smthrs/rpc/FileList). */
    summary: FILES_LIST_COMMAND.summary,
    runtimeAny: ["install", "cloud"],
    args: FILES_LIST_COMMAND.args,
    requires: ["first-run-target", "repo-source"],
    input: Schema.Struct({ path: Schema.String, repo: Schema.optional(Schema.String) }),
    prepare: ({ path, repo }) => actions.listFiles.preload?.(path, repo),
    handler: ({ path, repo }) => actions.listFiles(path, repo)
  }),
]
