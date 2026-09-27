/**
 * The code-intelligence seam behind the `lsp` flow.
 *
 * A host binds {@link LanguageServer} to a client such as
 * `NodeLanguageServer.layer`. Every method answers one language-server request
 * with the server's own result; {@link layerNoop} answers every request with
 * `unsupported`, for a host that runs no server.
 *
 * @since 1.0.0
 */

import { Context, Effect, Layer } from "effect"
import * as StdError from "./StdError.ts"

/**
 * A point in a file, addressed the way a language server addresses it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Position {
  readonly path: string
  readonly line: number
  readonly character: number
}
/**
 * The code-intelligence seam. Every method answers one language-server
 * request and reports an unavailable server as a typed failure.
 *
 * @category models
 * @since 1.0.0
 */
export interface LanguageServer {
  readonly hover: (position: Position) => Effect.Effect<unknown, StdError.StdError>
  readonly definition: (position: Position) => Effect.Effect<unknown, StdError.StdError>
  readonly references: (position: Position) => Effect.Effect<unknown, StdError.StdError>
  readonly implementation: (position: Position) => Effect.Effect<unknown, StdError.StdError>
  readonly documentSymbols: (path: string) => Effect.Effect<unknown, StdError.StdError>
  readonly workspaceSymbols: (query: string) => Effect.Effect<unknown, StdError.StdError>
  readonly prepareCallHierarchy: (position: Position) => Effect.Effect<unknown, StdError.StdError>
  readonly callHierarchyIncoming: (position: Position) => Effect.Effect<unknown, StdError.StdError>
  readonly callHierarchyOutgoing: (position: Position) => Effect.Effect<unknown, StdError.StdError>
  readonly diagnostics: (path: string) => Effect.Effect<unknown, StdError.StdError>
}
/**
 * The {@link LanguageServer} service tag.
 *
 * @category services
 * @since 1.0.0
 */
export const LanguageServer: Context.Service<LanguageServer, LanguageServer> = Context.Service(
  "@smthrs/std/LanguageServer"
)
/**
 * Builds a {@link LanguageServer} from an implementation of its methods.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (service: LanguageServer): LanguageServer => LanguageServer.of(service)
const unsupported = (): Effect.Effect<never, StdError.StdError> =>
  Effect.fail(new StdError.StdError({ code: "unsupported", message: "Language server support is unavailable" }))
/**
 * A {@link LanguageServer} that reports `unsupported` for every request,
 * for an environment with no server configured.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeNoop = (): LanguageServer =>
  make({
    hover: unsupported,
    definition: unsupported,
    references: unsupported,
    implementation: unsupported,
    documentSymbols: unsupported,
    workspaceSymbols: unsupported,
    prepareCallHierarchy: unsupported,
    callHierarchyIncoming: unsupported,
    callHierarchyOutgoing: unsupported,
    diagnostics: unsupported
  })
/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerNoop: Layer.Layer<LanguageServer> = Layer.succeed(LanguageServer, makeNoop())
