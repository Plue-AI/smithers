/**
 * Unified Incur CLI; Effect remains the durable execution and service runtime.
 * Command handlers acquire services only after parsing, keeping help/schema inert.
 * @since 1.0.0
 */

import { makeCli as makeBuildCli } from "@smthrs/build-cli/Cli"
import * as Positionals from "@smthrs/build-cli/Positionals"
import * as RedactedLogger from "@smthrs/journal/RedactedLogger"
import * as MigrateCommand from "@smthrs/migrate/flow/Command"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Logger } from "effect"
import { Cli, z } from "incur"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import * as Agents from "./Agents.ts"
import * as Argv from "./cli/Argv.ts"
import * as Bridge from "./cli/ControlBridge.ts"
import { createApprovalsCli, createFlowCli, createRunsCli } from "./cli/ControlCommands.ts"
import { createEnvironmentCli } from "./cli/EnvironmentCommands.ts"
import * as Generate from "./cli/Generate.ts"
import { createGenerateCli, initialize } from "./cli/Generate.ts"
import { appendHistoryCommands } from "./cli/HistoryCommands.ts"
import * as Presentation from "./cli/Presentation.ts"
import { createStepCacheCli } from "./cli/StepCacheCommands.ts"
import * as TargetApprovals from "./cli/TargetApprovals.ts"
import { createTokenCli } from "./cli/TokenCommands.ts"
import * as CliError from "./CliError.ts"
import * as BugCmd from "./commands/Bug.ts"
import * as DoctorCmd from "./commands/Doctor.ts"
import * as GcCmd from "./commands/Gc.ts"
import type * as Globals from "./commands/Globals.ts"
import * as MigrateCmd from "./commands/Migrate.ts"
import * as OpenCmd from "./commands/Open.ts"
import * as TuiCmd from "./commands/Tui.ts"
import * as UpdateCmd from "./commands/Update.ts"
import * as DidYouMean from "./DidYouMean.ts"
import * as Doctor from "./Doctor.ts"
import { createEvalCli } from "./evaluation/EvalCli.ts"
import * as Init from "./Init.ts"
import * as NodeControl from "./NodeControl.ts"
import { createCredentialsCli } from "./operator/Credentials.ts"
import { createIntegrationsCli } from "./operator/Integrations.ts"
import { createMemoryCli } from "./operator/Memory.ts"
import { localRoot } from "./operator/Store.ts"
import { createTriggersCli } from "./operator/Triggers.ts"
import * as Project from "./Project.ts"
import * as Serve from "./Serve.ts"
import * as Suggest from "./Suggest.ts"
import * as Ui from "./Ui.ts"
import * as Unsupported from "./Unsupported.ts"
import * as Update from "./Update.ts"
import { packageVersion } from "./Version.ts"

import { mount as mountBackend } from "./internal/backend/Commands.ts"

const options = Bridge.connectionOptions

/** Decisions use the same Jev judge (Luna backup) as native flow completions. */
const evaluator = (environment: Record<string, string | undefined>): Layer.Layer<Evaluator.Evaluator> =>
  NodeControl.layerSeatEvaluator(environment).pipe(
    Layer.provide(NodeControl.layerRebuildableRequestExecutor(NodeControl.environmentDispatcher(environment)))
  )

/** The shared guard's inputs, read from the typed connection options. */
const globalsOf = (connection: Bridge.ConnectionOptions, config: Bridge.Runtime): Globals.Options => ({
  environment: config.environment ?? process.env
})

/**
 * Construct the public command tree without opening stores or evaluating declarations.
 * @category constructors
 * @since 1.0.0
 */
export const makeCli = (config: Bridge.Runtime = {}): ReturnType<typeof makeBuildCli> => {
  const mcpGlobals = z.object({
    audience: z.enum(["auto", "human", "agent"]).default("auto"),
    silent: z.boolean().default(false),
    ui: z.enum(["auto", "tty", "stream", "plain"]).default("auto")
  })
  const mcp = Cli.create("mcp", {
    version: packageVersion,
    description: "Register the Smithers MCP server with an agent",
    globals: mcpGlobals
  }).command("add", {
    description: "Register with Claude Code or Codex; omit --agent to configure both",
    mcp: false,
    options: options.extend({ agent: z.string().optional() }),
    run: (c) =>
      Presentation.guard(c, async () => {
        const requested = c.options.agent
        const targets = requested === undefined
          ? Agents.agents
          : Agents.agents.filter((agent) => agent.id === requested)
        if (targets.length === 0) {
          throw new CliError.UsageError({
            message: `Unknown agent ${requested}. Known agents: ${Agents.agents.map((agent) => agent.id).join(", ")}`
          })
        }
        const environment = config.environment ?? process.env
        const wired = targets.map((agent) => Agents.addMcp(agent, environment["HOME"], environment))
        if (wired.every((entry) => entry.status === "failed")) {
          const stderr = config.stderr ?? process.stderr
          stderr.write(`${Agents.manualInstructions(targets.map((agent) => agent.id))}\n`)
          throw new CliError.UnsupportedError({ message: "Could not register the MCP server" })
        }
        return wired
      })
  })
  Positionals.guard(mcp, mcpGlobals)
  mcp.use((context, next) => Presentation.scope(context, config, next))
  const cli = makeBuildCli({
    ...config,
    cliName: "smthrs",
    cliVersion: packageVersion,
    cliDescription: "Build workspace targets and operate durable agent flows",
    sync: {
      cwd: dirname(createRequire(import.meta.url).resolve("@smthrs/cli/package.json")),
      include: ["skills/*"]
    },
    cacheSteps: createStepCacheCli(),
    approvals: config.approvals ?? TargetApprovals.store
  })
  cli.use((context, next) => Presentation.scope(context, config, next))
  cli
    .command(createFlowCli(config))
    .command(appendHistoryCommands(createRunsCli(config), config))
    .command(createApprovalsCli(config))
    .command(createGenerateCli(config))
    .command(createMemoryCli())
    .command(mcp)
    .command(createCredentialsCli())
    .command(createTokenCli(config))
    .command(createTriggersCli(config))
    .command(createIntegrationsCli())
    .command(createEnvironmentCli(config))
    .command(createEvalCli(config))
    .command("init", {
      description: "Initialize workspace and target declarations plus a starter flow, preserving existing files",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ name: z.string().optional() }),
      options: z.object({
        root: z.string().optional().describe("Directory to initialize; defaults to cwd"),
        global: z.boolean().default(false).describe("Removed; initialize a workspace instead")
      }),
      run: (c) =>
        Presentation.guard(c, () => {
          if (c.options.global) throw Unsupported.flagError(Unsupported.findFlag("init", "global"))
          const root = resolve(c.options.root ?? process.cwd())
          return initialize(root, c.args.name ?? Init.defaultName(root), config.environment ?? process.env)
        }, { next: Generate.scaffolded })
    })
    .command("doctor", {
      description: "Check project discovery, providers, tools, and durable-state compatibility",
      mcp: { annotations: { readOnlyHint: true } },
      options,
      run: (c) =>
        Presentation.guard(c, async () => {
          const globals = globalsOf(c.options, config)
          // Local diagnostics read the discovery snapshot without opening
          // execution databases; a remote host answers with its own catalog.
          const report = !Bridge.isRemote(c.options, config)
            ? await Bridge.project(DoctorCmd.fromRegistry(globals), c.options, config)
            : await Bridge.query(DoctorCmd.fromControl(globals), c.options, config)
          // The complete report stays available to scripts on a nonzero exit.
          if (Doctor.failed(report)) config.exit?.(1)
          return report
        }, { next: [{ command: "info", description: "Inspect workspace and host configuration" }] })
    })
    .command("serve", {
      aliases: ["gateway"],
      description: "Host the control gateway and durable trigger scheduler",
      mcp: false,
      options: options.extend({
        host: z.string().default(Serve.defaultBind.host),
        port: z.number().int().min(0).max(65535).default(Serve.defaultBind.port),
        listen: z.boolean().default(false)
      }),
      run: (c) =>
        Presentation.guard(
          c,
          () =>
            Bridge.host(
              {
                host: c.options.host,
                port: c.options.port,
                listen: c.options.listen,
                credential: (config.environment ?? process.env)["SMITHERS_TOKEN"]
              },
              c.options,
              config
            )
        )
    })
    .command("gc", {
      description: "Collect old terminal runs and compact their journals; separate from target caches",
      mcp: { annotations: { readOnlyHint: false } },
      destructive: true,
      options: options.extend({ olderThan: z.string().default("30d"), dryRun: z.boolean().default(false) }),
      run: (c) =>
        Presentation.guard(c, async () => {
          localRoot(c.options)
          const swept = await Bridge.local(
            GcCmd.sweep({ olderThan: c.options.olderThan, dryRun: c.options.dryRun }, globalsOf(c.options, config)),
            c.options,
            config
          )
          // A partial sweep still reports what the readable databases held.
          if (swept.failures.length > 0) config.exit?.(1)
          return swept
        })
    })
    .command("suggest", {
      description: "Discover ways Smithers can help; interactively choose one to implement",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ path: z.string().optional() }),
      options: z.object({ root: z.string().optional(), seat: z.string().optional(), list: z.boolean().default(false) }),
      run: (c) =>
        Presentation.guard(c, async () => {
          const root = c.args.path === undefined ? localRoot(c.options) : resolve(c.args.path)
          if (!Suggest.isDirectory(root)) {
            throw new CliError.UsageError({ message: `The path must be a directory: ${root}` })
          }
          const documents: Array<unknown> = []
          const presentation = Presentation.current()?.policy ?? Presentation.policy(c, config)
          const json = presentation.structured
          const outcome = await Effect.runPromise(
            Suggest.run({
              root,
              seat: c.options.seat,
              list: c.options.list,
              json,
              environment: config.environment ?? process.env,
              emit: (line) => {
                documents.push(JSON.parse(line))
              }
            }).pipe(
              Effect.provideService(
                Ui.Ui,
                Ui.make({
                  output: Presentation.current()?.stderr ?? process.stderr,
                  input: process.stdin,
                  interactive: presentation.interactive
                })
              ),
              Effect.provide(RedactedLogger.layer()),
              Effect.provideService(Logger.LogToStderr, true)
            ),
            { signal: config.signal }
          )
          config.exit?.(Suggest.exitStatus(outcome))
          return json ? { ...outcome, documents } : undefined
        })
    })
    .command("open", {
      description: "Open this checkout's repository in the Smithers app; `smthrs .` is the same",
      mcp: false,
      args: z.object({ directory: z.string().optional().describe("Checkout directory; defaults to cwd") }),
      run: (c) =>
        Presentation.guard(
          c,
          () => OpenCmd.open(OpenCmd.processHost(config.environment ?? process.env), c.args.directory)
        )
    })
    .command("tui", {
      description: "Open the terminal coding agent",
      mcp: false,
      args: z.object({ directory: z.string().optional().describe("Working directory; defaults to cwd") }),
      options: z.object({
        model: z.string().optional().describe("Chat seat as provider:model"),
        continue: z.boolean().default(false).describe("Continue the latest session in the directory"),
        resume: z.boolean().default(false).describe("Pick a session to continue"),
        print: z.string().optional().describe("Answer one prompt, print it, and exit"),
        approve: z.enum(["all", "ask", "deny"]).optional().describe("Consequential calls: all, ask, or deny"),
        budgetTokens: z.string().optional().describe("Token ceiling per turn and worker; unbounded by default"),
        environment: z.string().optional().describe("Run the TUI app in a saved execution environment")
      }),
      alias: { model: "m", continue: "c", resume: "r", print: "p" },
      run: (c) =>
        Presentation.guard(c, async () => {
          config.exit?.(
            await TuiCmd.run(
              { ...c.options, directory: c.args.directory },
              config.environment ?? process.env,
              undefined,
              undefined,
              config.signal
            )
          )
          return undefined
        })
    })
    .command("migrate", {
      description: "Inventory, plan, or apply the 0.x-to-1.x source migration",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ path: z.string().optional() }),
      options: options.extend({
        scan: z.boolean().default(false),
        apply: z.boolean().default(false),
        seat: z.string().optional(),
        allowUnsafe: z.string().optional(),
        acknowledgeRunState: z.boolean().default(false),
        allowNoVcs: z.boolean().default(false),
        keepOldSources: z.boolean().default(false),
        unit: z.string().optional(),
        maxRepairRounds: z.number().int().nonnegative().optional(),
        reportDir: z.string().optional(),
        flowsDir: z.string().optional(),
        verifyInstall: z.string().optional(),
        verifyFormat: z.string().optional(),
        verifyTypecheck: z.array(z.string()).optional(),
        verifyTest: z.string().optional()
      }),
      run: (c) =>
        Presentation.guard(c, async () => {
          localRoot(c.options)
          const outcome = await Bridge.local(
            Effect.gen(function*() {
              const migrationRoot = yield* Project.MigrationRoot
              return yield* MigrateCmd.run({
                target: c.args.path ?? migrationRoot,
                scan: c.options.scan,
                apply: c.options.apply,
                seat: c.options.seat,
                allowUnsafe: c.options.allowUnsafe,
                acknowledgeRunState: c.options.acknowledgeRunState,
                allowNoVcs: c.options.allowNoVcs,
                keepOldSources: c.options.keepOldSources,
                unit: c.options.unit,
                maxRepairRounds: c.options.maxRepairRounds,
                reportDir: c.options.reportDir,
                flowsDir: c.options.flowsDir,
                verifyInstall: c.options.verifyInstall,
                verifyFormat: c.options.verifyFormat,
                verifyTypecheck: c.options.verifyTypecheck,
                verifyTest: c.options.verifyTest
              }, globalsOf(c.options, config))
            }),
            c.options,
            config
          )
          if (outcome._tag === "Parked") {
            config.exit?.(3)
            const { _tag: _, ...document } = outcome
            return document
          }
          config.exit?.(MigrateCommand.exitCode(outcome.report))
          return MigrateCmd.document(outcome.report)
        })
    })
    .command("update", {
      description: "Check the registry for newer CLI versions; does not install them",
      mcp: { annotations: { readOnlyHint: true } },
      options,
      run: (c) =>
        Presentation.guard(
          c,
          async () =>
            Update.render(await Bridge.local(UpdateCmd.check(globalsOf(c.options, config)), c.options, config))
        )
    })
    .command("bug", {
      description: "Submit a redacted bug report to the configured endpoint",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ summary: z.array(z.string()).min(1) }),
      options: options.extend({
        run: z.string().optional(),
        yes: z.boolean().default(false).describe("Post the previewed report without an interactive confirmation"),
        dryRun: z.boolean().default(false).describe("Preview the redacted report without posting")
      }),
      run: (c) =>
        Presentation.guard(c, () =>
          Bridge.query(
            BugCmd.submit({
              summary: c.args.summary.join(" "),
              runId: c.options.run,
              yes: c.options.yes,
              dryRun: c.options.dryRun,
              // The endpoint and the already-redacted consent document go to
              // stderr even under quiet, so the operator can inspect
              // everything a subsequent POST will send.
              preview: (line) =>
                Effect.sync(() => {
                  const stderr = Presentation.current()?.stderr ?? process.stderr
                  stderr.write(`${line}\n`)
                })
            }, globalsOf(c.options, config)),
            c.options,
            config
          ))
    })
  const verbose = (tree: NonNullable<ReturnType<typeof Cli.toCommands.get>>): void => {
    for (const [name, entry] of tree) {
      if ("_group" in entry) verbose(entry.commands)
      else if ("run" in entry && entry.options?.shape.verbose === undefined) {
        tree.set(name, {
          ...entry,
          options: (entry.options ?? z.object({})).extend({
            verbose: z.boolean().default(false).describe("Show redacted diagnostic details")
          })
        })
      }
    }
  }
  // The backend mount retains local handlers for overlapping commands. Give
  // those retained option schemas the common flag before they are captured.
  verbose(Cli.toCommands.get(cli as never)!)
  mountBackend(cli, config)
  verbose(Cli.toCommands.get(cli as never)!)
  // Incur 0.5 intercepts `mcp` before looking up registered commands. Dispatch
  // the mounted subtree directly so registration uses Agents.addMcp as documented.
  const serve = cli.serve.bind(cli)
  cli.serve = async (argv = process.argv.slice(2), serveOptions) => {
    // Incur's document selector reads the spaced spelling before command
    // parsing. Preserve the public inline spelling and keep literal tails opaque.
    const separator = argv.indexOf("--")
    argv = argv.flatMap((argument, index) =>
      (separator < 0 || index < separator) && argument.startsWith("--format=")
        ? ["--format", argument.slice("--format=".length)]
        : [argument]
    )
    const parsed = Argv.parse(argv)
    let offset = 0
    // Argv retains document switches and --ui in rest; use its parsed option
    // values to skip those prefixes without mistaking their values for verbs.
    while (parsed.rest[offset]?.startsWith("-") && parsed.rest[offset] !== "--") {
      const flag = parsed.rest[offset]!
      const value = parsed.options.get(flag.split("=")[0]!)
      offset += !flag.includes("=") && typeof value === "string" ? 2 : 1
    }
    const index = parsed.restIndices[offset]
    if (parsed.rest[offset] === "mcp" && index !== undefined && !argv.includes("--mcp")) {
      return mcp.serve([...argv.slice(0, index), ...argv.slice(index + 1)], serveOptions)
    }
    if (parsed.rest[offset] === "repo" && index !== undefined && argv[index + 1] === "clone") {
      // Incur does not consume a literal tail. Preserve git/jj clone options
      // as values of the existing repeatable clone-arg option.
      const separator = argv.indexOf("--", index + 2)
      if (separator >= 0) {
        argv = [
          ...argv.slice(0, separator),
          ...argv.slice(separator + 1).map((value) => `--clone-arg=${value}`)
        ]
      }
    }
    if (parsed.rest[offset] === "environment" && index !== undefined && argv[index + 1] === "exec") {
      const separator = argv.indexOf("--", index + 2)
      if (separator >= 0) {
        argv = [...argv.slice(0, separator), ...argv.slice(separator + 1).map((value) => `--arg=${value}`)]
      }
    }
    const typed = parsed.rest[offset]
    if (typed === undefined) return serve(argv, serveOptions)
    // The parser decides what a verb is, and it has already refused by the
    // time its sentence is written: asking Jev beforehand would question every
    // command that runs, and the bare-label form means a token this module
    // does not recognise can still be a target. Human prose can append a
    // suggestion after refusal; structured output must remain one document.
    const write = serveOptions?.stdout ?? ((text: string) => void process.stdout.write(text))
    let refused = false
    await serve(argv, {
      ...serveOptions,
      stdout: (text) => {
        refused ||= text.includes(`'${typed}' is not a command`)
        write(text)
      }
    })
    if (!refused || parsed.json || parsed.format !== undefined || config.presentation?.structured) return
    const suggestion = await Effect.runPromise(
      DidYouMean.didYouMean(typed, parsed.rest.slice(offset + 1), DidYouMean.commands(cli)).pipe(
        Effect.provide(evaluator(config.environment ?? process.env))
      )
    )
    if (suggestion !== undefined) write(`${suggestion}\n`)
  }
  return cli
}
