/*
 * The `code` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { fileArgs } from "../FileArgs"
import { text } from "@smthrs/ui/flow-form"
import { flow, CodePosition } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `code` flows registered as one aggregator block. */
export const codeFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /*
   * Code intelligence (docs/code-intel/PLAN.md §4): three reads against the
   * language server plue runs inside the workspace VM, one act each with the
   * three doors, none confirming. Each answers `{ value }` to the model and
   * patches the human's FILE card (hover, diagnostics, what the card knows
   * about the server); the definition opens its target through files.read's
   * line anchor.
   *
   * The door is `cloud.terminal`, the same tunnel the workspace terminal
   * rides (`/api/cloud-ws/repos/{o}/{r}/workspace/sessions/{id}/lsp`,
   * state/CloudLspClient.ts). It used to be the desktop app's own language
   * server on `local.lsp`; that backend retired
   * (docs/LOCAL-BACKEND-RETIREMENT.md) and the cloud relay is the whole
   * implementation now, so both hosts list these flows wherever the tunnel is
   * open.
   */
  flow({
    name: "code.hover",
    form: {
      fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) => fileArgs(`${text(payload, "path") ?? ""}:${text(payload, "line") ?? ""}:${text(payload, "column") ?? ""}`, text(payload, "repo"))
    },
    summary: "The type and docs of the symbol at a position",
    runtime: ["cloud.terminal"],
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
    runtime: ["cloud.terminal"],
    args: "<path>:<line>:<col> [owner/repo]",
    input: CodePosition,
    handler: ({ path, line, column, repo }) => actions.codeDefinition(path, line, column, repo)
  }),
  flow({
    name: "code.diagnostics",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } }, args: (payload) => fileArgs(text(payload, "path"), text(payload, "repo")) },
    summary: "The language server's errors and warnings for a file",
    runtime: ["cloud.terminal"],
    args: "<path> [owner/repo]",
    input: Schema.Struct({ path: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ path, repo }) => actions.codeDiagnostics(path, repo)
  })
]
