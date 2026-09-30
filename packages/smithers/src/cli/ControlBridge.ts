/**
 * Adapts the existing Effect command handlers to the unified Incur surface.
 *
 * @since 1.0.0
 */

import { NodeServices } from "@effect/platform-node"
import * as Audience from "@smthrs/build-cli/Audience"
import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import { ApprovalAuthority, Control } from "@smthrs/control"
import * as RedactedLogger from "@smthrs/journal/RedactedLogger"
import type * as Evaluator from "@smthrs/model/Evaluator"
import type * as Otlp from "@smthrs/observability/Otlp"
import type * as Registry from "@smthrs/registry/Registry"
import { Cause, Console, Effect, Exit, Layer, Logger, References, Stream } from "effect"
import { Command } from "effect/unstable/cli"
import { z } from "incur"
import { randomBytes } from "node:crypto"
import { format } from "node:util"
import * as CliError from "../CliError.ts"
import { cli as legacyCli } from "../Command.ts"
import * as ExecutionTarget from "../history/ExecutionTarget.ts"
import * as GatewayHistory from "../history/GatewayHistory.ts"
import * as HistoryWorkspace from "../history/History.ts"
import * as CommandStatus from "../internal/CommandStatus.ts"
import * as DatabaseLocation from "../internal/DatabaseLocation.ts"
import * as Telemetry from "../internal/Telemetry.ts"
import * as NodeControl from "../NodeControl.ts"
import { layerTriggerScheduler } from "../operator/Triggers.ts"
import * as Project from "../Project.ts"
import * as Serve from "../Serve.ts"
import * as Ui from "../Ui.ts"
import * as Verb from "../Verb.ts"
import { packageVersion } from "../Version.ts"
import * as Argv from "./Argv.ts"
import * as Presentation from "./Presentation.ts"
import * as RunProgress from "./RunProgress.ts"

/**
 * Shared connection options for commands that reach the control plane.
 * @category schemas
 * @since 1.0.0
 */
export const connectionOptions = z.object({
  root: z.string().optional().describe("Project directory; defaults to the nearest Smithers project"),
  remote: z.string().optional().describe("Remote control plane URL; defaults to SMITHERS_REMOTE"),
  mcpConfig: z.string().optional().describe("Path to the configured MCP servers"),
  quiet: z.boolean().default(false).describe("Suppress progress messages")
})

/**
 * Parsed control-plane connection options.
 * @category models
 * @since 1.0.0
 */
export type ConnectionOptions = z.output<typeof connectionOptions>

/**
 * Host inputs used while invoking an adapted command.
 * @category models
 * @since 1.0.0
 */
export interface Runtime extends RuntimeConfig {
  /** Explicit judge for an embedded or offline CLI host; otherwise select the gateway. */
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  /** Host-owned delegation for local commands and the served gateway, never a request argument. */
  readonly approvalAuthority?: ApprovalAuthority.Service | undefined
  readonly executionRoot?: string | undefined
  readonly signal?: AbortSignal | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly exit?: ((code: number) => void) | undefined
}

/**
 * Renders connection options as arguments for the Effect CLI.
 * @category constructors
 * @since 1.0.0
 */
export const connectionArguments = (options: ConnectionOptions): Array<string> => {
  const args: Array<string> = []
  for (
    const [flag, value] of [
      ["root", options.root],
      ["remote", options.remote],
      ["mcp-config", options.mcpConfig]
    ] as const
  ) {
    if (value !== undefined) args.push(`--${flag}`, value)
  }
  if (options.quiet) args.push("--quiet")
  return args
}

// The control plane an MCP session reaches, and the credential it presents,
// are host configuration. Honouring them as tool arguments would let any
// connected client aim the host's SMITHERS_TOKEN at a server it chose.
// Refuse the override rather than silently substituting the host destination,
// so a caller is never told it queried a plane it did not.
const hostConnection = (options: ConnectionOptions): ConnectionOptions => {
  if (Presentation.current()?.transport !== "mcp") return options
  for (const flag of ["remote"] as const) {
    if (options[flag] !== undefined) {
      throw new CliError.UsageError({
        message:
          `--${flag} is not accepted over MCP; the host selects the control plane with SMITHERS_REMOTE and SMITHERS_TOKEN`
      })
    }
  }
  return options
}

const resolved = (options: ConnectionOptions, runtime: Runtime) =>
  NodeControl.makeConfig(
    connectionArguments(hostConnection(options)),
    runtime.environment ?? process.env,
    process.cwd()
  )

/**
 * Resolves transport and execution roots for an adapted command.
 * @category constructors
 * @since 1.0.0
 */
export const configuration = (options: ConnectionOptions, runtime: Runtime) => {
  const config = resolved(options, runtime)
  if (config.remote === undefined) Project.assertRoot(config.root ?? process.cwd())
  return {
    ...config,
    ...(runtime.evaluator === undefined ? {} : { evaluator: runtime.evaluator }),
    executionRoot: runtime.executionRoot,
    approvalAuthority: runtime.approvalAuthority,
    principal: Presentation.current()?.transport === "mcp" ? { id: "mcp", kind: "agent" as const } : undefined
  }
}

/**
 * Whether this invocation targets a remote control plane.
 * @category predicates
 * @since 1.0.0
 */
export const isRemote = (options: ConnectionOptions, runtime: Runtime): boolean =>
  resolved(options, runtime).remote !== undefined

/**
 * Whether there are durable records to observe: a remote control plane, or a
 * local project whose control store exists. Observing verbs answer empty
 * without opening, and so creating, a local store that does not.
 * @category predicates
 * @since 1.0.0
 */
export const hasRecords = (options: ConnectionOptions, runtime: Runtime): boolean => {
  const config = configuration(options, runtime)
  return config.remote !== undefined ||
    DatabaseLocation.exists(NodeControl.databasePath(config.root ?? process.cwd()))
}

/** The display policy one invocation renders progress and prompts under. */
const display = (options: ConnectionOptions, runtime: Runtime) => {
  const session = Presentation.current()
  const explicit = session?.policy ?? runtime.presentation
  const policy = explicit ?? Audience.resolve({ env: runtime.environment })
  return {
    policy: options.quiet ? { ...policy, progress: "silent" as const, interactive: false } : policy,
    // Only an explicit or quiet silence lowers the log floor; the ambient
    // audience fallback keeps operator-facing logs visible.
    logLevel: options.quiet || explicit?.progress === "silent" ? "Error" as const : "Info" as const,
    output: session?.stderr ?? process.stderr
  }
}

/**
 * The per-invocation services every typed verb reads, whichever host it runs
 * against: the prompt surface, the progress sink, and the redacting logger.
 */
const provideServices = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  options: ConnectionOptions,
  runtime: Runtime
): Effect.Effect<A, E | Otlp.LayerError, Exclude<R, Ui.Ui>> => {
  const { logLevel, output, policy } = display(options, runtime)
  return operation.pipe(
    Effect.provideService(RunProgress.Configuration, { policy, output }),
    Effect.provideService(References.MinimumLogLevel, logLevel),
    Effect.provideService(
      Ui.Ui,
      Ui.make({ output, input: process.stdin, interactive: policy.interactive })
    ),
    Effect.provideService(Logger.LogToStderr, true),
    Effect.provide(RedactedLogger.layer()),
    Effect.provide(Telemetry.layer(runtime.environment ?? process.env))
  )
}

const settle = async <A, E>(operation: Effect.Effect<A, E>, runtime: Runtime): Promise<A> => {
  const result = await Effect.runPromiseExit(operation, { signal: runtime.signal })
  if (Exit.isFailure(result)) throw Cause.squash(result.cause)
  return result.value
}

/**
 * Reuses the tested flow control handlers without starting a second process.
 * @category constructors
 * @since 1.0.0
 */
export const invoke = async (
  args: ReadonlyArray<string>,
  options: ConnectionOptions,
  runtime: Runtime = {}
): Promise<unknown> => {
  const { output: progressOutput, policy } = display(options, runtime)
  let config = configuration(options, runtime)
  if (config.remote === undefined && runtime.executionRoot === undefined) {
    // The same extraction the legacy executable uses, so a flat alias binds
    // to the same worktree whichever entry it arrived through.
    const runId = ExecutionTarget.executionRunId(args)
    if (runId !== undefined) {
      config = { ...config, ...HistoryWorkspace.prepare(Project.root(config.root, process.cwd()), runId) }
    }
  }
  const values: Array<unknown> = []
  const outputConsole: Console.Console = Object.assign(Object.create(console), {
    error: (...items: ReadonlyArray<unknown>) => {
      if (policy.progress !== "silent") progressOutput.write(`${RunProgress.text(format(...items), 500)}\n`)
    },
    log: (...items: ReadonlyArray<unknown>) => {
      for (const item of items) {
        if (typeof item !== "string") values.push(item)
        else {
          try {
            values.push(JSON.parse(item))
          } catch {
            values.push(item)
          }
        }
      }
    }
  })
  const commandArguments = [
    "--json",
    // Quiet suppresses progress, not the returned data. Silence the progress
    // sink without changing the handler's result projection.
    ...connectionArguments({ ...options, quiet: false }),
    ...args
  ]
  const run: Effect.Effect<void, unknown, Ui.Ui> = Command.runWith(legacyCli, { version: packageVersion })(
    commandArguments
  ).pipe(
    // The flat verb these arguments name is what decides whether this host
    // composes an executor, and so whether it needs a completion judge. A
    // canonical verb that starts a run reaches it through exactly this call
    // (`flow start` is `up`, `approvals approve` is `approve`), so the verb
    // catalog stays the one authority on the question.
    Effect.provide(NodeControl.layer({
      ...config,
      startsRuns: Verb.startsRuns(Argv.words(args)),
      plansFlows: Argv.words(args)[0] === "plan"
    })),
    Effect.provide(NodeServices.layer),
    Effect.provideService(Console.Console, outputConsole),
    Effect.provideService(CommandStatus.CommandStatus, (code) => runtime.exit?.(code))
  )
  const result = await Effect.runPromiseExit(provideServices(run, options, runtime), { signal: runtime.signal })
  if (Exit.isFailure(result)) throw Cause.squash(result.cause)
  return values.length === 1 ? values[0] : values
}

/**
 * Runs a typed verb against the same local or remote host as flow commands.
 *
 * The host layer also carries the project references, so a verb that reads
 * `Project.ProjectRoot` or the 0.x snapshot sees the host's answer.
 *
 * The host observes runs and drives none, so it opens with no gateway key: a
 * flow listing, a run diagnosis, a pending-approval listing and a bulk cancel
 * all work in a project that has never had one. An operation that starts or
 * resumes a run does not belong here and its launch would die on the observing
 * executor; route one through {@link invoke}, whose verb declares the
 * capability.
 * @category constructors
 * @since 1.0.0
 */
export const query = async <A, E>(
  operation: Effect.Effect<A, E, Control.Control | Ui.Ui>,
  options: ConnectionOptions,
  runtime: Runtime = {}
): Promise<A> =>
  settle(
    provideServices(
      operation.pipe(
        Effect.provide(NodeControl.layer({ ...configuration(options, runtime), startsRuns: false }))
      ),
      options,
      runtime
    ),
    runtime
  )

/**
 * Runs a read-only verb over the project's existing stores.
 *
 * Nothing is created, migrated, recovered or reaped, and the reads answer
 * while another process holds the writer. Only a verb that changes nothing
 * belongs here; one that cancels, signals or decides goes through
 * {@link query} or {@link invoke}.
 * @category constructors
 * @since 1.0.0
 */
export const read = async <A, E>(
  operation: Effect.Effect<A, E, Control.Control | Ui.Ui>,
  options: ConnectionOptions,
  runtime: Runtime = {}
): Promise<A> =>
  settle(
    provideServices(
      operation.pipe(Effect.provide(NodeControl.layerObserve(configuration(options, runtime)))),
      options,
      runtime
    ),
    runtime
  )

/**
 * Runs a typed verb on the project alone, without opening the control host or
 * building the flow registry. The project references are the host's.
 * @category constructors
 * @since 1.0.0
 */
export const project = async <A, E>(
  operation: Effect.Effect<A, E, Ui.Ui>,
  options: ConnectionOptions,
  runtime: Runtime = {}
): Promise<A> => {
  const config = configuration(options, runtime)
  const root = config.root ?? process.cwd()
  return settle(
    provideServices(
      operation.pipe(
        Effect.provide([
          Project.layer(root, config.migrationRoot ?? Project.legacyRoot(undefined, root)),
          NodeServices.layer
        ])
      ),
      options,
      runtime
    ),
    runtime
  )
}

/**
 * Runs a typed verb on the project alone, without opening the control host:
 * the 0.x migration, garbage collection, and the registry check. The project
 * references and the flow registry are the host's.
 * @category constructors
 * @since 1.0.0
 */
export const local = <A, E>(
  operation: Effect.Effect<A, E, Registry.Registry | Ui.Ui>,
  options: ConnectionOptions,
  runtime: Runtime = {}
): Promise<A> =>
  project(
    operation.pipe(Effect.provide(NodeControl.layerRegistry(configuration(options, runtime).root ?? process.cwd()))),
    options,
    runtime
  )

/**
 * A scoped stream closes its transports when the consumer stops following.
 *
 * Reading events changes nothing, so it observes the stores as {@link read} does.
 * @category constructors
 * @since 1.0.0
 */
export const events = (
  runId: string,
  follow: boolean,
  options: ConnectionOptions,
  runtime: Runtime = {},
  afterSequence?: number
) => {
  const stream = Stream.unwrap(Effect.map(Control.Control, (control) =>
    control.watch({
      runId,
      follow,
      ...(afterSequence === undefined ? {} : { afterSequence })
    }))).pipe(Stream.provide(NodeControl.layerObserve(configuration(options, runtime))))
  const signal = runtime.signal
  if (signal === undefined) return Stream.toAsyncIterable(stream)
  const interrupted = Effect.callback<void>((resume) => {
    const abort = () => resume(Effect.void)
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", abort))
  })
  return Stream.toAsyncIterable(stream.pipe(Stream.interruptWhen(interrupted)))
}

/**
 * Serves the gateway and durable trigger scheduler on one shared local Control host.
 * @category constructors
 * @since 1.0.0
 */
export const host = async (bind: Serve.Bind, options: ConnectionOptions, runtime: Runtime = {}): Promise<void> => {
  const config = configuration(options, runtime)
  if (config.remote !== undefined) {
    throw new CliError.UnsupportedError({
      message: "serve must run on the host owning the project; --remote is not supported"
    })
  }
  const refusal = Serve.refuse(bind)
  if (refusal !== undefined) throw refusal
  // A gateway credential authenticates callers; only the host may delegate
  // approval authority. Do not inherit NodeControl's credential-based default.
  // A served gateway and the trigger scheduler beside it both launch runs, so
  // this host is a run-capable one and refuses to open without a judge.
  const operatorToken = bind.credential === undefined || bind.credential === ""
    ? randomBytes(32).toString("hex")
    : undefined
  const servedBind = { ...bind, operatorToken }
  const control = NodeControl.layer({
    ...config,
    startsRuns: true,
    approvalChannel: true,
    approvalAuthority: config.approvalAuthority ?? ApprovalAuthority.local
  })
  const root = Project.root(config.root, process.cwd())
  const host = Layer.merge(control, layerTriggerScheduler(root).pipe(Layer.provide(control)))
  if (!options.quiet) process.stderr.write(`${Serve.banner(servedBind)}\n`)
  if (operatorToken !== undefined) process.stderr.write(`  approval token  ${operatorToken}\n`)
  const result = await Effect.runPromiseExit(
    Serve.host(servedBind, root).pipe(
      Effect.provide(host),
      // The gateway's Run.Fork and Run.Verify, over this project's stores.
      Effect.provide(GatewayHistory.layer(root)),
      Effect.provide(RedactedLogger.layer()),
      Effect.provide(Telemetry.layer(runtime.environment ?? process.env)),
      Effect.provideService(Logger.LogToStderr, true)
    ),
    { signal: runtime.signal }
  )
  if (Exit.isFailure(result)) throw Cause.squash(result.cause)
}
