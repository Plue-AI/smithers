/**
 * Projects a connected MCP server's tools as an ordinary {@link FlowBinding.Source}.
 *
 * This is the whole adapter: `@smthrs/harness/FlowBinding`'s own module doc
 * already names the target directly: "a standard filesystem flow, a memory
 * flow, an incoming MCP tool, a durable child agent" are all just a flow
 * declaration plus the code that runs it. Nothing about the harness, the
 * registry, or the cell loop needs to know a given flow's implementation
 * happens to proxy a remote MCP `tools/call`; a cell that reads a file and a
 * cell that calls an MCP tool run the identical two lines.
 *
 * @since 1.0.0-rc.0
 */

import * as Capability from "@smthrs/capability/Capability"
import * as Effects from "@smthrs/core/Effects"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Effect, Exit, Schema, Scope } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as McpClient from "./McpClient.ts"
import { McpError } from "./McpError.ts"

/**
 * Decoded input accepted by every MCP tool flow, which is whatever the remote
 * tool's own JSON Schema describes. The registry still discloses the real parameter
 * shape, as shown by {@link toolBinding}. This is only the runtime decode, and it
 * is permissive because the server, not this adapter, owns validation.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Args = Schema.Record(Schema.String, Schema.Unknown)

/**
 * Decoded output returned by every MCP tool flow, carrying the tool's content
 * blocks by shape plus whether the server reported an error.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Result = Schema.Struct({
  content: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  isError: Schema.Boolean,
  structuredContent: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
})

/**
 * The authority every MCP tool flow declares.
 *
 * An MCP tool is opaque code this adapter does not control, the same
 * situation `@smthrs/registry/MarkdownFlow` calls "unprojectable authority"
 * for a skill with no declared `capabilities`: the honest declaration is
 * everything, not a guess.
 *
 * It is spelled as one exact `namespace:operation:resource` per action because
 * the cell boundary reads each declaration with `Capability.parse`, which
 * rejects anything that does not have exactly those three colon-separated
 * components. An unparseable declaration counts as unauthorized. The list is
 * derived from `Capability.Action.literals`, so adding a host action cannot
 * silently omit it from MCP tools, and it is frozen because every binding
 * shares this reference.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const capabilities: ReadonlyArray<string> = Object.freeze(
  Capability.Action.literals.map((action) => `${action}:**`)
)

/**
 * The conservative effect envelope every MCP tool flow declares.
 *
 * @category effects
 * @since 1.0.0-rc.0
 */
export const effects = Effects.make({
  reads: ["**"],
  writes: ["**"],
  mode: "expected",
  onConflict: "serialize",
  tier: "irreversible"
})

/**
 * Selects and names the tools projected from one MCP catalog.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ProjectionOptions {
  /** Exact tool names to project. Omitted or empty means every tool. */
  readonly include?: ReadonlyArray<string> | undefined
  /** Exact tool names to drop, applied after `include`. */
  readonly exclude?: ReadonlyArray<string> | undefined
  /** Replaces the default `mcp/<server>` flow-name prefix. */
  readonly namePrefix?: string | undefined
}

/** One remote tool, bound to a flow name scoped by server so two servers may reuse a tool name. */
const toolBinding = (
  client: McpClient.McpClient,
  tool: McpClient.ToolDescription,
  prefix: string
): FlowBinding.Binding => {
  const toolName = tool.name
  return FlowBinding.make({
    flow: {
      name: `${prefix}/${toolName}`,
      // The server authors this text, so it is attributed as remote content
      // rather than read as if the host had written it. The client bounds it.
      description: tool.description === undefined
        ? `MCP tool "${toolName}" on server "${client.server}"`
        : `MCP tool "${toolName}" on server "${client.server}". Server-supplied description: ${tool.description}`,
      capabilities,
      effects,
      input: Args,
      output: Result
    },
    // The server's own JSON Schema document, carried by value so a caller
    // reading `ctx.flows` sees the real parameter shape rather than `Args`'s
    // permissive record type.
    inputDocument: tool.inputSchema as Schema.Json,
    // McpClient authors these messages with remote/process diagnostics withheld.
    publicError: (error: McpError) => error.message,
    handler: (input): Effect.Effect<typeof Result.Type, McpError> =>
      Effect.map(client.callTool(toolName, input), (result) =>
        result.structuredContent === undefined
          ? { content: result.content, isError: result.isError }
          : {
            content: result.content,
            isError: result.isError,
            structuredContent: result.structuredContent
          })
  })
}

/**
 * Projects an already-connected MCP session's tool catalog as a
 * {@link FlowBinding.Source}, one flow per tool.
 *
 * The client is a precondition, not a parameter this constructor resolves:
 * connecting is a scoped effect (it owns a subprocess), and a `Source` is not
 * scoped, so the host composes {@link McpClient.connect} once, at the same
 * place it composes every other scoped kernel service, and passes the live
 * client here.
 *
 * This constructor is total: it applies exact filters to the catalog it is
 * given. Use {@link connected} when unknown `include` names and an empty
 * `namePrefix` must fail loudly against a freshly fetched catalog.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const mcp = (client: McpClient.McpClient, options: ProjectionOptions = {}): FlowBinding.Source => {
  const prefix = options.namePrefix ?? `mcp/${client.server}`
  const include = options.include === undefined || options.include.length === 0
    ? undefined
    : new Set(options.include)
  const exclude = new Set(options.exclude ?? [])
  const tools = client.tools.filter((tool) =>
    (include === undefined || include.has(tool.name)) && !exclude.has(tool.name)
  )
  return FlowBinding.source(prefix, tools.map((tool) => toolBinding(client, tool, prefix)))
}

/**
 * Connects to an MCP server and projects its tools in one step.
 *
 * This is the checked entry point: it validates projection options against
 * the freshly fetched catalog before constructing the source. An empty prefix
 * fails before spawning. Failed or interrupted setup, including projection
 * validation, releases the connection before returning to the caller.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const connected = (
  options: McpClient.ConnectOptions & ProjectionOptions
): Effect.Effect<FlowBinding.Source, McpError, ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function*() {
    if (options.namePrefix === "") {
      return yield* Effect.fail(
        new McpError({
          code: "protocol_error",
          message: `MCP server "${options.server}" option "namePrefix" must not be empty`,
          server: options.server
        })
      )
    }
    return yield* Effect.acquireUseRelease(
      Effect.flatMap(Effect.scope, Scope.fork),
      (scope) =>
        Effect.gen(function*() {
          const client = yield* McpClient.connect(options)
          const offered = new Set(client.tools.map((tool) => tool.name))
          const missing = options.include?.find((name) => !offered.has(name))
          if (missing !== undefined) {
            return yield* Effect.fail(
              new McpError({
                code: "tool_not_found",
                message: `MCP server "${client.server}" offers no requested include tool`,
                server: client.server
              })
            )
          }
          return mcp(client, options)
        }).pipe(Scope.provide(scope)),
      // Projection rejection must release the successfully initialized client.
      (scope, exit) => Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void
    )
  })
