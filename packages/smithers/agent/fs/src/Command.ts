/**
 * Agent-facing projection of executable, model-visible module routes.
 *
 * @since 0.1.0
 */

import type * as Flow from "@smthrs/core/Flow"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as CommandTree from "./CommandTree.ts"
import * as FlowInvoker from "./FlowInvoker.ts"
import { FsError } from "./FsError.ts"
import * as Boundary from "./internal/Boundary.ts"
import * as CommandLine from "./internal/CommandLine.ts"
import * as SchemaBridge from "./internal/SchemaBridge.ts"
import * as Route from "./Route.ts"

/**
 * A route advertised to an agent.
 *
 * @category models
 * @since 0.1.0
 */
export interface ListedCommand {
  readonly name: string
  readonly description: string | undefined
}

/**
 * A decoded command-string invocation.
 *
 * @category models
 * @since 0.1.0
 */
export interface ParsedCommand<A = unknown> {
  readonly route: Route.Route
  readonly argv: ReadonlyArray<string>
  readonly input: A
}

/**
 * Runtime projection of a route manifest for agent use.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommandSurface {
  /** Lists executable model-visible module routes without loading them. */
  readonly list: () => ReadonlyArray<ListedCommand>
  /** Loads the selected module and schema-decodes an agent command string. */
  readonly parse: (commandString: string) => Effect.Effect<ParsedCommand, FsError>
  /** Parses, invokes, and output-encodes an agent command string. */
  readonly execute: (commandString: string) => Effect.Effect<unknown, FsError, FlowInvoker.FlowInvoker>
  /** Validates decoded input and output for an exact named route. */
  readonly call: <N extends Route.Name>(
    name: N,
    input: Route.Input<N>
  ) => Effect.Effect<Route.Output<N>, FsError, FlowInvoker.FlowInvoker>
}

interface Prepared {
  readonly route: Route.Route
  readonly flow: Flow.Any
  readonly argv: ReadonlyArray<string>
  readonly input: unknown
}

// Admit and detach even when the typed value contains native Date leaves.
const snapshotDecoded = (value: unknown): Effect.Effect<unknown, FsError> =>
  Effect.suspend(() => {
    const admitted = Boundary.admitDecoded(value)
    return admitted.ok ? Effect.succeed(admitted.value) : Effect.fail(
      new FsError({
        code: "decode_failed",
        method: "Command.call",
        description: "The decoded flow value did not satisfy the boundary"
      })
    )
  })

const validateDecoded = (
  schema: Schema.Top,
  value: unknown,
  field: "input" | "output"
): Effect.Effect<unknown, FsError> =>
  Effect.matchCauseEffect(
    Effect.flatMap(snapshotDecoded(value), (input) => Schema.decodeUnknownEffect(Schema.toType(schema))(input)),
    {
      onFailure: () =>
        Effect.fail(
          new FsError({
            code: "decode_failed",
            method: "Command.call",
            description: `The decoded flow ${field} did not satisfy its schema`
          })
        ),
      onSuccess: snapshotDecoded
    }
  )

const descriptionOf = (route: Route.Route): string | undefined => Option.getOrUndefined(route.description)

const routeArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const first = argv[0]
  if (first === undefined || !first.includes("/")) return argv
  return Object.freeze([...first.split("/"), ...argv.slice(1)])
}

/**
 * Constructs a command surface from routes.
 *
 * Non-module, hidden, and non-model-invocable routes remain available from the
 * registry but never enter this executable projection.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (routes: ReadonlyArray<Route.Route>): Effect.Effect<CommandSurface, FsError> =>
  Effect.gen(function*() {
    const validated = yield* CommandTree.make(routes)
    const commandRoutes = CommandTree.traverse(validated).filter(Route.isCommandRoute)
    const tree = yield* CommandTree.make(commandRoutes)

    const prepare = (commandString: string): Effect.Effect<Prepared, FsError> =>
      Effect.gen(function*() {
        const argv = yield* CommandLine.lex(commandString)
        const resolved = yield* CommandTree.resolve(tree, routeArgv(argv))
        const flow = yield* Route.load(resolved.route)
        const schema = yield* SchemaBridge.toCommandSchema(resolved.route.input, flow.input)
        const parsed = yield* CommandLine.parseFlags(resolved.rest)
        const input = yield* schema.decode(schema.assemble(parsed.args, parsed.options))
        return Object.freeze({ route: resolved.route, flow, argv, input })
      })

    const invoke = (
      route: Route.Route,
      flow: Flow.Any,
      input: unknown
    ): Effect.Effect<unknown, FsError, FlowInvoker.FlowInvoker> =>
      Effect.gen(function*() {
        const invoker = yield* Effect.service(FlowInvoker.FlowInvoker)
        return yield* invoker.invoke(Object.freeze({ name: route.name, flow, input }))
      })

    const listed = Object.freeze(
      CommandTree.traverse(tree).map((route) =>
        Object.freeze({
          name: route.name,
          description: descriptionOf(route)
        })
      )
    )

    const call: CommandSurface["call"] = Effect.fn("Command.call")(
      <N extends Route.Name>(name: N, candidate: Route.Input<N>): Effect.Effect<
        Route.Output<N>,
        FsError,
        FlowInvoker.FlowInvoker
      > =>
        Effect.gen(function*() {
          const input = yield* snapshotDecoded(candidate)
          const segments = typeof name === "string" ? name.split("/") : []
          const route = yield* CommandTree.resolveExact(tree, segments)
          const flow = yield* Route.load(route)
          const decoded = yield* validateDecoded(flow.input, input, "input")
          const output = yield* invoke(route, flow, decoded)
          return (yield* validateDecoded(flow.output, output, "output")) as Route.Output<N>
        })
    )

    return Object.freeze({
      list: () => listed,
      parse: (commandString: string) =>
        Effect.map(prepare(commandString), ({ argv, input, route }) => Object.freeze({ route, argv, input })),
      execute: Effect.fn("Command.execute")((commandString) =>
        Effect.flatMap(
          prepare(commandString),
          ({ flow, input, route }) =>
            Effect.flatMap(invoke(route, flow, input), (output) => SchemaBridge.encodeOutput(flow.output, output))
        )
      ),
      call
    })
  })
