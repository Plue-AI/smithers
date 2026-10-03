/**
 * Incur projection of executable, model-visible module routes.
 *
 * @since 0.1.0
 */

import * as Positionals from "@smthrs/build-cli/Positionals"
import type * as Flow from "@smthrs/core/Flow"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import { Cli as IncurCli, type MiddlewareHandler } from "incur"
import * as CommandTree from "./CommandTree.ts"
import * as FlowInvoker from "./FlowInvoker.ts"
import { FsError } from "./FsError.ts"
import * as SchemaBridge from "./internal/SchemaBridge.ts"
import * as Route from "./Route.ts"

type IncurContext = {
  readonly args: Readonly<Record<string, unknown>>
  readonly error: (options: {
    readonly code: string
    readonly exitCode?: number | undefined
    readonly message: string
  }) => never
  readonly ok: (data: unknown) => never
  readonly options: Readonly<Record<string, unknown>>
  readonly request?: Request | undefined
}

type SelectedRoute = {
  readonly route: Route.Route
  readonly flow: Pick<Flow.Any, "name" | "description" | "input" | "output">
  readonly schema: SchemaBridge.CommandSchema
}

type Selection = SelectedRoute & {
  readonly dispatch: ReadonlyArray<string>
}

/** What one route contributes to the metadata surface once it is projected. */
type Projection =
  | { readonly _tag: "Ready"; readonly selected: SelectedRoute }
  | { readonly _tag: "Failed"; readonly error: FsError }

/**
 * The reserved child segment that invokes a route which also has children.
 *
 * Incur cannot represent a node that is both runnable and a command group, so
 * `domains` alongside `domains/list` is advertised and dispatched as
 * `domains self` on the CLI and `/domains/self` over HTTP. The bare name keeps
 * dispatching to the same route.
 *
 * @category constants
 * @since 0.1.0
 */
export const selfSegment = "self"

const discoveryFlags = new Set(["--help", "-h", "--llms", ["--llms", "full"].join("-"), "--schema", "--version"])

const isDiscovery = (argv: ReadonlyArray<string>): boolean =>
  // Incur itself tests truthiness, so `COMPLETE=""` must not divert a run.
  Boolean(process.env.COMPLETE) || argv.includes("--mcp") || argv.some((token) => discoveryFlags.has(token))

const isFetchDiscovery = (pathname: string): boolean =>
  pathname === "/mcp" || pathname === "/openapi.json" || pathname === "/openapi.yml" ||
  pathname === "/openapi.yaml" || pathname.startsWith("/.well-known/")

const descriptionOf = (route: Route.Route): string | undefined => Option.getOrUndefined(route.description)

const normalizeArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const first = argv[0]
  return first === undefined || !first.includes("/")
    ? argv
    : Object.freeze([...first.split("/"), ...argv.slice(1)])
}

const commandTokens = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const tokens: Array<string> = []
  for (const token of normalizeArgv(argv)) {
    if (token.startsWith("-")) break
    tokens.push(token)
  }
  return Object.freeze(tokens)
}

type RequestPath = {
  /** Segments exactly as Incur's own matcher will see them. */
  readonly raw: ReadonlyArray<string>
  /** The same segments decoded, which is what route resolution compares. */
  readonly decoded: ReadonlyArray<string>
}

const requestPath = (pathname: string): RequestPath | undefined => {
  const raw: Array<string> = []
  const decoded: Array<string> = []
  for (const segment of pathname.split("/")) {
    if (segment.length === 0) continue
    try {
      // Splitting before decoding keeps `%2F` inside one segment, so an encoded
      // slash can never invent a path boundary.
      decoded.push(decodeURIComponent(segment))
    } catch {
      return undefined
    }
    raw.push(segment)
  }
  return { raw: Object.freeze(raw), decoded: Object.freeze(decoded) }
}

const malformedPath = (): FsError =>
  new FsError({
    code: "parse_failed",
    method: "Incur.fetch",
    description: "The request path contains a malformed percent escape"
  })

const errorEnvelope = (error: FsError): string =>
  JSON.stringify({ ok: false, error: { code: error.code, message: error.description } }, null, 2)

const reportServe = (error: FsError, options: IncurCli.serve.Options): void => {
  const write = options.stdout ?? ((value: string) => {
    process.stdout.write(value)
  })
  write(`${errorEnvelope(error)}\n`)
  const exit = options.exit ?? ((code: number) => {
    process.exit(code)
  })
  exit(1)
}

const reportFetch = (error: FsError): Response =>
  new Response(errorEnvelope(error), {
    status: 400,
    headers: { "content-type": "application/json" }
  })

const runOptions = (request: Request | undefined): { readonly signal: AbortSignal } | undefined =>
  request === undefined ? undefined : { signal: request.signal }

const mapError = (context: IncurContext, error: FsError): never =>
  context.error({ code: error.code, exitCode: 1, message: error.description })

const execute = (
  selected: SelectedRoute,
  context: IncurContext
): Effect.Effect<unknown, never, FlowInvoker.FlowInvoker> =>
  Effect.gen(function*() {
    const input = yield* selected.schema.decode(selected.schema.assemble(context.args, context.options))
    const invoker = yield* Effect.service(FlowInvoker.FlowInvoker)
    const output = yield* invoker.invoke(Object.freeze({
      name: selected.route.name,
      flow: selected.flow,
      input
    }))
    return yield* SchemaBridge.encodeOutput(selected.flow.output, output)
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => {
        const reason = cause.reasons[0]!
        if (cause.reasons.length === 1 && reason._tag === "Fail" && reason.error instanceof FsError) {
          return Effect.sync(() => mapError(context, reason.error))
        }
        // Host diagnostics stay in Effect's logger, never in Incur's response.
        return Effect.logDebug("Incur invocation failed", cause).pipe(
          Effect.provideService(Logger.LogToStderr, true),
          Effect.andThen(() =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)))
              : Effect.sync(() =>
                mapError(
                  context,
                  new FsError({
                    code: "invocation_unavailable",
                    method: "Incur.execute",
                    description: "The flow invocation failed"
                  })
                )
              )
          )
        )
      },
      // Incur's ok/error callbacks throw transport control signals. Keep them
      // outside the effect whose failures are sanitized.
      onSuccess: (output) => Effect.sync(() => context.ok(output))
    })
  )

const failedDefinition = (
  route: Route.Route,
  error: FsError,
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, FlowInvoker.FlowInvoker>,
    options?: { readonly signal: AbortSignal } | undefined
  ) => Promise<A>
) => ({
  description: descriptionOf(route),
  // A route whose input cannot be projected stays advertised, because it stays
  // dispatchable. Calling it reports the exact failure that stopped the
  // projection instead of a contentless error.
  run(context: IncurContext) {
    return runEffect(Effect.sync(() => mapError(context, error)), runOptions(context.request))
  }
})

const selectedDefinition = (
  selected: SelectedRoute,
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, FlowInvoker.FlowInvoker>,
    options?: { readonly signal: AbortSignal } | undefined
  ) => Promise<A>
) => ({
  args: selected.schema.args,
  description: descriptionOf(selected.route),
  options: selected.schema.options,
  run(context: IncurContext) {
    return runEffect(execute(selected, context), runOptions(context.request))
  }
})

const project = (route: Route.Route): Effect.Effect<Projection> =>
  Effect.gen(function*() {
    const flow = yield* Route.load(route)
    const schema = yield* SchemaBridge.toCommandSchema(route.input, flow.input)
    return { route, flow, schema }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.fail(
          new FsError({
            code: "load_failed",
            method: "Incur.project",
            description: "The route metadata load timed out",
            path: route.name
          })
        )
    }),
    Effect.match({
      onFailure: (error: FsError): Projection => ({ _tag: "Failed", error }),
      onSuccess: (selected: SelectedRoute): Projection => ({ _tag: "Ready", selected })
    })
  )

const projectAll = (
  tree: CommandTree.CommandTree
): Effect.Effect<ReadonlyMap<Route.Route, Projection>> =>
  Effect.gen(function*() {
    const projections = new Map<Route.Route, Projection>()
    for (const route of CommandTree.traverse(tree)) projections.set(route, yield* project(route))
    return projections
  })

const metadataCli = (
  name: string,
  tree: CommandTree.CommandTree,
  projections: ReadonlyMap<Route.Route, Projection>,
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, FlowInvoker.FlowInvoker>,
    options?: { readonly signal: AbortSignal } | undefined
  ) => Promise<A>
): IncurCli.Cli => {
  const cli = IncurCli.create(name)
  // Every advertised command carries the same descriptors the dispatch path
  // mounts, so `--llms`, `--schema`, the OpenAPI document, and the MCP tool
  // list describe the input the flow actually accepts, and an MCP tool call
  // reaches the flow with its arguments intact.
  const definitionFor = (route: Route.Route) => {
    const projection = projections.get(route)!
    return projection._tag === "Ready"
      ? selectedDefinition(projection.selected, runEffect)
      : failedDefinition(route, projection.error, runEffect)
  }
  const mountChildren = (parent: IncurCli.Cli, node: CommandTree.CommandTree): void => {
    for (const [segment, child] of node.children) {
      const route = Option.getOrUndefined(child.route)
      if (child.children.size === 0) {
        // A trie node without children is always the leaf of a route.
        parent.command(segment, definitionFor(route!))
        continue
      }
      const group = IncurCli.create(segment, {
        description: route === undefined ? undefined : descriptionOf(route)
      })
      mountChildren(group, child)
      // Incur cannot represent a node that is both runnable and a group, so a
      // route carrying children is advertised under the reserved segment
      // instead of disappearing from every discovery surface.
      if (route !== undefined) group.command(selfSegment, definitionFor(route))
      parent.command(group)
    }
  }
  mountChildren(cli, tree)
  return cli
}

const dispatchCli = (
  name: string,
  selection: Selection,
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, FlowInvoker.FlowInvoker>,
    options?: { readonly signal: AbortSignal } | undefined
  ) => Promise<A>
): IncurCli.Cli => {
  const cli = IncurCli.create(name)
  // The rebuilt CLI serves exactly one request, so it mounts only the tokens
  // that request actually consumed. Mounting the caller's own spelling is what
  // lets a percent-encoded or decomposed name reach Incur's raw matcher.
  const definition = selectedDefinition(selection, runEffect)
  let parent = cli
  for (let index = 0; index < selection.dispatch.length - 1; index++) {
    const group = IncurCli.create(selection.dispatch[index]!)
    parent.command(group)
    parent = group
  }
  parent.command(selection.dispatch[selection.dispatch.length - 1]!, definition)
  return cli
}

const groupedRoutes = (tree: CommandTree.CommandTree): Effect.Effect<ReadonlySet<Route.Route>, FsError> =>
  Effect.suspend(() => {
    const grouped = new Set<Route.Route>()
    const stack: Array<CommandTree.CommandTree> = [tree]
    while (stack.length > 0) {
      const node = stack.pop()!
      const route = Option.getOrUndefined(node.route)
      if (route !== undefined && node.children.size > 0) {
        if (node.children.has(selfSegment)) {
          return Effect.fail(
            new FsError({
              code: "duplicate_route",
              method: "Incur.createCli",
              description: "A child route claims the reserved self segment",
              path: `${route.name}/${selfSegment}`
            })
          )
        }
        grouped.add(route)
      }
      for (const child of node.children.values()) stack.push(child)
    }
    return Effect.succeed(grouped)
  })

const hydrate = (
  tree: CommandTree.CommandTree,
  grouped: ReadonlySet<Route.Route>,
  tokens: ReadonlyArray<string>,
  dispatchTokens: ReadonlyArray<string>
): Effect.Effect<Option.Option<Selection>, FsError> =>
  CommandTree.resolve(tree, tokens).pipe(
    Effect.matchEffect({
      // Only an unmatched name may fall back to metadata: every other typed
      // failure has to reach the caller.
      onFailure: (error: FsError) =>
        error.code === "unknown_command"
          ? Effect.succeed(Option.none<Selection>())
          : Effect.fail(error),
      // A name that resolves but cannot be loaded or projected keeps its typed
      // failure: it is reported, never softened into help output.
      onSuccess: (resolved) =>
        Effect.gen(function*() {
          const consumed = tokens.length - resolved.rest.length
          const viaSelf = resolved.rest[0] === selfSegment && grouped.has(resolved.route)
          const flow = yield* Route.load(resolved.route)
          const schema = yield* SchemaBridge.toCommandSchema(resolved.route.input, flow.input)
          return Option.some<Selection>({
            route: resolved.route,
            flow,
            schema,
            dispatch: Object.freeze(dispatchTokens.slice(0, viaSelf ? consumed + 1 : consumed))
          })
        })
    })
  )

/**
 * Projects routes onto an Incur CLI while preserving metadata-only discovery.
 *
 * Dispatching one command loads only that command's module. Its actual Effect
 * input schema is then projected into Incur flags and remains the
 * authoritative decoder. A discovery surface must publish those flags, so the
 * first discovery request loads every command module once and reuses the
 * result. Each route has a five-second metadata deadline. Hosts must call
 * `close()` at shutdown to interrupt an active build and release its cache.
 *
 * @category constructors
 * @since 0.1.0
 */
export const createCli = (
  name: string,
  routes: ReadonlyArray<Route.Route>
): Effect.Effect<IncurCli.Cli & { readonly close: () => Promise<void> }, FsError, FlowInvoker.FlowInvoker> =>
  Effect.gen(function*() {
    const validated = yield* CommandTree.make(routes)
    const executable = CommandTree.traverse(validated).filter(Route.isCommandRoute)
    const tree = yield* CommandTree.make(executable)
    const grouped = yield* groupedRoutes(tree)
    const services = yield* Effect.context<FlowInvoker.FlowInvoker>()
    const runEffect = Effect.runPromiseWith(services)
    const cli = IncurCli.create(name)

    // Dispatch CLIs are short-lived; the metadata CLI also receives guards
    // registered after discovery, including an already running MCP server.
    const middlewares: Array<MiddlewareHandler> = []
    let metadataInstance: IncurCli.Cli | undefined
    const register = cli.use.bind(cli)
    cli.use = (handler) => {
      middlewares.push(handler)
      metadataInstance?.use(handler)
      return register(handler)
    }
    const guarded = (surface: IncurCli.Cli): IncurCli.Cli => {
      Positionals.guard(surface)
      for (const handler of middlewares) surface.use(handler)
      return surface
    }

    // The host owns the shared build. Request cancellation only releases that
    // request's waiter; closing the host interrupts projection itself.
    const lifetime = new AbortController()
    let metadata: Promise<IncurCli.Cli> | undefined
    const metadataSurface = (signal?: AbortSignal): Promise<IncurCli.Cli> => {
      lifetime.signal.throwIfAborted()
      signal?.throwIfAborted()
      // Only successful builds are cached. A rejected build must not poison
      // later discovery requests, including failures while mounting Incur.
      const build = metadata ??= runEffect(projectAll(tree), { signal: lifetime.signal }).then((projections) => {
        lifetime.signal.throwIfAborted()
        return metadataInstance = guarded(metadataCli(name, tree, projections, runEffect))
      }).catch((error: unknown) => {
        metadata = undefined
        throw error
      })
      if (signal === undefined) return build
      return new Promise((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener("abort", abort)
          reject(signal.reason)
        }
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
        build.then((surface) => {
          signal.removeEventListener("abort", abort)
          resolve(surface)
        }, (error: unknown) => {
          signal.removeEventListener("abort", abort)
          reject(error)
        })
      })
    }

    const select = (
      tokens: ReadonlyArray<string>,
      dispatchTokens: ReadonlyArray<string>,
      options?: { readonly signal: AbortSignal } | undefined
    ): Promise<
      { readonly _tag: "Selection"; readonly selection: Option.Option<Selection> } | {
        readonly _tag: "Error"
        readonly error: FsError
      }
    > =>
      runEffect(
        hydrate(tree, grouped, tokens, dispatchTokens).pipe(
          Effect.match({
            onFailure: (error: FsError) => ({ _tag: "Error" as const, error }),
            onSuccess: (selection) => ({ _tag: "Selection" as const, selection })
          })
        ),
        options
      )

    cli.serve = async (argv = process.argv.slice(2), options = {}) => {
      lifetime.signal.throwIfAborted()
      if (isDiscovery(argv)) return (await metadataSurface()).serve(argv, options)
      const normalized = normalizeArgv(argv)
      const tokens = commandTokens(normalized)
      const outcome = await select(tokens, tokens)
      if (outcome._tag === "Error") return reportServe(outcome.error, options)
      return Option.isNone(outcome.selection)
        ? (await metadataSurface()).serve([...normalized], options)
        : guarded(dispatchCli(name, outcome.selection.value, runEffect)).serve([...normalized], options)
    }

    cli.fetch = async (request) => {
      lifetime.signal.throwIfAborted()
      request.signal.throwIfAborted()
      const url = new URL(request.url)
      if (isFetchDiscovery(url.pathname)) return (await metadataSurface(request.signal)).fetch(request)
      const path = requestPath(url.pathname)
      if (path === undefined) return reportFetch(malformedPath())
      const outcome = await select(path.decoded, path.raw, { signal: request.signal })
      if (outcome._tag === "Error") return reportFetch(outcome.error)
      return Option.isNone(outcome.selection)
        ? (await metadataSurface(request.signal)).fetch(request)
        : guarded(dispatchCli(name, outcome.selection.value, runEffect)).fetch(request)
    }

    return Object.assign(cli, {
      async close(): Promise<void> {
        lifetime.abort(new DOMException("The CLI is closed", "AbortError"))
        // Interruption settles the Effect fiber even when a native import is
        // still evaluating. Never await the native import itself at shutdown.
        await metadata?.catch(() => undefined)
        metadata = undefined
        metadataInstance = undefined
      }
    })
  })
