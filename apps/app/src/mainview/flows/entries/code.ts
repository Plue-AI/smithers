/*
 * The `code` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { fileArgs } from "@smthrs/rpc/FileRead"
import { text } from "@smthrs/ui/flow-form"
import { flow, CodePosition } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `code` flows registered as one aggregator block. */
export const codeFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  // The controller admits all three doors only with a qualified daemon session host.
  flow({
    name: "code.hover",
    form: {
      fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) => fileArgs(`${text(payload, "path") ?? ""}:${text(payload, "line") ?? ""}:${text(payload, "column") ?? ""}`, text(payload, "repo"))
    },
    summary: "The type and docs of the symbol at a position",
    args: "<path>:<line>:<col> [owner/repo]",
    input: CodePosition,
    handler: ({ path, line, column, repo }) => actions.codeHover(path, line, column, repo)
  }),
  flow({
    name: "code.definition",
    form: {
      fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) => fileArgs(`${text(payload, "path") ?? ""}:${text(payload, "line") ?? ""}:${text(payload, "column") ?? ""}`, text(payload, "repo"))
    },
    summary: "Where the symbol at a position is defined; opens that file at the line",
    args: "<path>:<line>:<col> [owner/repo]",
    input: CodePosition,
    handler: ({ path, line, column, repo }) => actions.codeDefinition(path, line, column, repo)
  }),
  flow({
    name: "code.diagnostics",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } }, args: (payload) => fileArgs(text(payload, "path"), text(payload, "repo")) },
    summary: "The language server's errors and warnings for a file",
    args: "<path> [owner/repo]",
    input: Schema.Struct({ path: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ path, repo }) => actions.codeDiagnostics(path, repo)
  })
]
