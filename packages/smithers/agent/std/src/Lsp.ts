/**
 * The `lsp` flow: one code-intelligence query per call.
 *
 * The handler checks the path and 1-based position each operation needs,
 * authorizes the path as a read through the guarded `FileSystem` (the server
 * process reads the file on its own), forwards the query to the bound
 * `LanguageServer`, and returns the server's answer unchanged in `result`.
 *
 * @since 1.0.0
 */

import * as Flow from "@smthrs/core/Flow"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { capability, envelope } from "./internal/Declaration.ts"
import * as FsFailure from "./internal/FsFailure.ts"
import * as LanguageServer from "./LanguageServer.ts"
import * as StdError from "./StdError.ts"

/**
 * The registry name of the `lsp` flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "lsp"
/**
 * The one-line description the model sees for the `lsp` flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description = "Inspect code intelligence through the configured language server."
/**
 * What the `lsp` flow accepts.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  operation: Schema.Literals([
    "hover",
    "definition",
    "references",
    "implementation",
    "documentSymbols",
    "workspaceSymbols",
    "prepareCallHierarchy",
    "callHierarchyIncoming",
    "callHierarchyOutgoing",
    "diagnostics"
  ]).annotate({
    description:
      "The query to run; workspaceSymbols takes query, documentSymbols and diagnostics take path, the rest take path with line and character"
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Absolute path of the file to query; required by every operation except workspaceSymbols"
  }),
  line: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "1-based line of the position to query, as read and grep report it"
  }),
  character: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "1-based character offset within the line"
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Symbol text to search the workspace for; workspaceSymbols only"
  })
})
/**
 * Decoded input accepted by the `lsp` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type
/**
 * What the `lsp` flow returns.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  result: Schema.Unknown.annotate({
    description: "The language server's answer for this operation, passed through in the server's own shape"
  })
})
/**
 * Decoded output returned by the `lsp` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type
/**
 * The declared effect envelope of the `lsp` flow, before any input is known.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({
  tier: "sealed",
  mode: "hermetic",
  reads: ["/**"],
  writes: []
})
/**
 * Returns the workspace-wide envelope every language-server query needs.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects
/**
 * The authority the `lsp` flow requires.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("fs:read", "/**")]
/**
 * The `lsp` flow declaration: schemas, capabilities, and effects, with the
 * implementation attached separately.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = Flow.make({
  name,
  description,
  input: Input,
  output: Output,
  capabilities,
  effects
})
const isAbsolutePath = (path: string): boolean => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
/**
 * Runs the `lsp` flow: queries the configured language server.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("Lsp.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, LanguageServer.LanguageServer | FileSystem.FileSystem> {
  const server = yield* LanguageServer.LanguageServer
  const path = input.path
  const position = path === undefined || input.line === undefined || input.character === undefined
    ? undefined
    : { path, line: input.line - 1, character: input.character - 1 }
  if ((input.operation === "workspaceSymbols")) return { result: yield* server.workspaceSymbols(input.query ?? "") }
  if (path === undefined || !isAbsolutePath(path)) {
    return yield* Effect.fail(
      new StdError.StdError({ code: "invalid_input", message: "A normalized absolute path is required" })
    )
  }
  // The server reads the file itself, outside the guarded filesystem, so the
  // path is authorized here: a read the caller could not make through `read`
  // is not made through the language server either.
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem.stat(path).pipe(Effect.mapError(FsFailure.reading(path, `File not found: ${path}`)))
  if (input.operation === "documentSymbols") return { result: yield* server.documentSymbols(path) }
  if (input.operation === "diagnostics") return { result: yield* server.diagnostics(path) }
  if (position === undefined) {
    return yield* Effect.fail(
      new StdError.StdError({ code: "invalid_input", message: "1-based line and character are required" })
    )
  }
  switch (input.operation) {
    case "hover":
      return { result: yield* server.hover(position) }
    case "definition":
      return { result: yield* server.definition(position) }
    case "references":
      return { result: yield* server.references(position) }
    case "implementation":
      return { result: yield* server.implementation(position) }
    case "prepareCallHierarchy":
      return { result: yield* server.prepareCallHierarchy(position) }
    case "callHierarchyIncoming":
      return { result: yield* server.callHierarchyIncoming(position) }
    case "callHierarchyOutgoing":
      return { result: yield* server.callHierarchyOutgoing(position) }
  }
})
