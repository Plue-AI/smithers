/*
 * The `files` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { fileArgs, FILES_READ_COPY } from "@smthrs/rpc/FileRead"
import { flowArgs } from "../FlowArgs"
import { text } from "@smthrs/ui/flow-form"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `files` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "files", label: "Files", summary: "Read repository files" }

/** `files.list` and `files.read`. */
export const filesFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
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
    summary: "List a repository directory",
    runtimeAny: ["cloud"],
    args: "[path] [owner/repo]",
    requires: ["first-run-target", "repo-source"],
    input: Schema.Struct({ path: Schema.String, repo: Schema.optional(Schema.String) }),
    prepare: ({ path, repo }) => actions.listFiles.preload?.(path, repo),
    handler: ({ path, repo }) => actions.listFiles(path, repo)
  }),
  flow({
    name: "files.read",
    form: {
      /*
       * The path is TEXT: an inventory lists part of a tree, so the field takes
       * any path the human types and offers what was read as suggestions
       * (controller/forms.ts attaches `optionsFrom: "files"`). A select would
       * refuse every value that is not already an option, including each
       * keystroke on the way to one.
       */
      fields: { path: { kind: "text" }, repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) => flowArgs("files.read", {
        path: text(payload, "path") ?? "", repo: text(payload, "repo"), ref: text(payload, "ref"),
        ...(payload.line === undefined ? {} : { line: Number(payload.line) }),
        ...(payload.column === undefined ? {} : { column: Number(payload.column) })
      })
    },
    /* The model host binds its read of the mirrored main to the same copy and grammar (@smthrs/rpc/FileRead). */
    summary: FILES_READ_COPY.summary,
    runtimeAny: ["cloud"],
    /* `:line[:col]` (docs/code-intel/PLAN.md §1): the card scrolls to and marks the line; the parser strips it off the path token. */
    args: FILES_READ_COPY.args,
    requires: ["first-run-target", "repo-source"],
    input: Schema.Struct({
      path: Schema.String,
      repo: Schema.optional(Schema.String),
      line: Schema.optional(Schema.Number),
      column: Schema.optional(Schema.Number),
      ref: Schema.optional(Schema.String)
    }),
    prepare: ({ path, repo, line, column, ref }) => actions.readFile.preload?.(path, repo, line === undefined ? undefined : { line, ...(column === undefined ? {} : { column }) }, ref),
    handler: ({ path, repo, line, column, ref }) =>
      actions.readFile(path, repo, line === undefined ? undefined : { line, ...(column === undefined ? {} : { column }) }, ref)
  })
]

