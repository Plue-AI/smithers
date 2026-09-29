#!/usr/bin/env node
/**
 * The `smthrs` executable. It builds the CLI application, runs it on the Node
 * runtime, and maps a failed exit to a process exit code.
 *
 * @since 0.1.0
 */

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Audience from "@smthrs/build-cli/Audience"
import { ApprovalAuthority } from "@smthrs/control"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as RedactedLogger from "@smthrs/journal/RedactedLogger"
import * as Redaction from "@smthrs/journal/Redaction"
import { Cause, Console, Effect, Exit, Logger, References, Runtime } from "effect"
import * as Layer from "effect/Layer"
import { CliError as EffectCliError, Command } from "effect/unstable/cli"
import * as CliError from "../CliError.ts"
import { cli } from "../Command.ts"
import * as ExecutionTarget from "../history/ExecutionTarget.ts"
import * as History from "../history/History.ts"
import * as Failure from "../internal/Failure.ts"
import * as NodeControl from "../NodeControl.ts"
import * as Project from "../Project.ts"
import * as Ui from "../Ui.ts"
import * as Unsupported from "../Unsupported.ts"
import * as Verb from "../Verb.ts"
import { packageVersion } from "../Version.ts"
import * as Argv from "./Argv.ts"
import * as RunProgress from "./RunProgress.ts"

let signalExitCode: 130 | 143 | undefined

const onSigint = () => {
  signalExitCode = 130
}

const onSigterm = () => {
  signalExitCode = 143
}

process.once("SIGINT", onSigint)
process.once("SIGTERM", onSigterm)

/**
 * A CLI failure is a sentence for the operator, on stderr.
 *
 * Effect's default error reporting logs the cause through the runtime logger,
 * which writes to STDOUT with a timestamp and a stack. For a command-line tool
 * that is two bugs at once: a script reading `--json` gets a log line in its
 * document, and an operator gets a stack trace where the contract promised a
 * migration message. Reporting is therefore disabled below and the message is
 * written here instead.
 */
const verboseRequested = (): boolean => {
  try {
    return Argv.parse(process.argv.slice(2)).verbose
  } catch {
    return false
  }
}

const report = (error: unknown): void => {
  const message = error instanceof CliError.UsageError ||
      error instanceof CliError.UnsupportedError ||
      error instanceof CliError.ResourceLimitError ||
      error instanceof CliError.RenderingError
    ? error.message
    // A refused database open is a defect by design: `NodeDatabase.layer` keeps
    // the `never` error channel eleven packages compose against, so the refusal
    // arrives here rather than as a typed failure. Render it by its contract
    // code, which is what the release policy promises an operator and what a
    // script greps for; the tagged-error name is an implementation detail of
    // how the value travelled.
    : NodeDatabase.isUnsupportedDatabase(error)
    ? `${error.code}: ${error.message}`
    : Failure.operatorLine(error, verboseRequested())
  // A failure sentence is written here rather than logged, so it misses the
  // redacting logger below. It is still a line an operator reads and a
  // collector keeps, so it takes the same rules (the release policy).
  process.stderr.write(`${String(Redaction.redact(message))}\n`)
}

const teardown: Runtime.Teardown = (exit, onExit) => {
  process.removeListener("SIGINT", onSigint)
  process.removeListener("SIGTERM", onSigterm)

  if (signalExitCode !== undefined) {
    onExit(signalExitCode)
    return
  }
  if (Exit.isSuccess(exit)) {
    onExit(typeof process.exitCode === "number" ? process.exitCode : Number(process.exitCode ?? 0))
    return
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    process.stderr.write("smthrs: startup was interrupted without a signal\n")
    onExit(1)
    return
  }

  const error = Cause.squash(exit.cause)
  if (EffectCliError.isCliError(error)) {
    // `effect/unstable/cli` renders its own help and usage output; only the
    // status is this module's to decide.
    onExit(error._tag === "ShowHelp" && error.errors.length === 0 ? 0 : 2)
    return
  }
  report(error)
  if (
    error instanceof CliError.UsageError ||
    error instanceof CliError.UnsupportedError ||
    error instanceof CliError.ResourceLimitError ||
    error instanceof CliError.RenderingError
  ) {
    onExit(CliError.exitCode(error))
    return
  }
  onExit(Runtime.getErrorExitCode(error))
}

/**
 * Whether this invocation only asks the CLI to describe itself.
 *
 * `--version` and `--help` are documents. They need the command tree and
 * nothing else, so they must not resolve a project, scan its flows, or open a
 * database — work that took more than ten minutes in the release validation when
 * the invocation directory held no project marker, the root walk climbed to
 * `$HOME`, and discovery scanned the operator's whole home tree.
 *
 * The scan stops at the first flag that is not one of the two: every other
 * flag may take a value, and a value spelled `--help` is a value, not a
 * request for the help document. Missing a document invocation here only
 * costs the old startup; misreading a value as one would run a handler with
 * no services behind it.
 */
const documentRequested = (parsed: Argv.Globals): boolean => {
  for (const argument of parsed.rest) {
    if (!argument.startsWith("-")) continue
    return argument === "--help" || argument === "--version"
  }
  return false
}

const main = Effect.gen(function*() {
  const argv = process.argv.slice(2)
  const parsed = Argv.parse(argv)
  const presentation = Audience.fromArguments(argv)
  if (documentRequested(parsed)) {
    // `effect/unstable/cli` renders the document and fails with `ShowHelp`
    // before any handler runs, so the durable services the handlers declare
    // are never requested. Discharging them by type is what keeps the
    // document off the project, the registry, and the databases.
    return yield* (Command.run(cli, { version: packageVersion }).pipe(
      Effect.provide(NodeServices.layer)
    ) as Effect.Effect<void, EffectCliError.CliError>)
  }
  // A removed verb is a document too: one sentence and exit 1. Refusing it
  // here rather than from its hidden command in `Command.ts` is what keeps a
  // refusal from creating `<cwd>/.flows/` and opening both databases on its
  // way to saying the verb is gone. `Unsupported.refusal` reads only the
  // shapes it can read without guessing; everything else still refuses from
  // the command tree.
  const refused = Unsupported.refusal(parsed)
  if (refused !== undefined) return yield* Effect.fail(refused)
  // `smthrs --mcp` alone serves MCP, from the canonical command tree.
  if (parsed.options.get("--mcp") === true) {
    return yield* Effect.fail(new CliError.UnsupportedError({ message: "--mcp takes no command; run `smthrs --mcp`" }))
  }
  const applicationConfig = yield* NodeControl.configFromArguments(parsed)
  // The durable layer belongs to the handler, not to the program.
  //
  // `Effect.provide` around `Command.run` builds `NodeControl.layer` before
  // the parser reads a single token, so an invocation that never runs a
  // command still created `<cwd>/.flows/` and opened both databases: a typo
  // (`smthrs lss`), a one-token command line (`smthrs "gateway status"`),
  // an unrecognized flag, a missing argument. `Command.provide` moves the
  // layer inside the handler the parse selects, which makes the command tree
  // itself the resolver — no second list of verbs to drift — and leaves every
  // usage error, help document, and refusal file-free. A real command builds
  // exactly the same layer it always did, one step later.
  // Hold parser documents until we know whether input collection failed.
  // A typed missing-argument sentence replaces the parser's help page on
  // pipes. Once a handler starts, documents and streams pass through live.
  const terminal = yield* Console.Console
  let parsing = process.stdin.isTTY !== true
  const pending: Array<() => void> = []
  const flush = () => {
    parsing = false
    for (const write of pending.splice(0)) write()
  }
  const parsedConsole = Object.assign(Object.create(terminal) as Console.Console, {
    log: (...args: ReadonlyArray<unknown>) =>
      parsing ? pending.push(() => terminal.log(...args)) : terminal.log(...args),
    error: (...args: ReadonlyArray<unknown>) =>
      parsing ? pending.push(() => terminal.error(...args)) : terminal.error(...args)
  })
  yield* Command.run(
    Command.provide(cli, () =>
      Layer.unwrap(Effect.gen(function*() {
        flush()
        // This callback is reached only after successful parsing. Preserve
        // help/usage's file-free contract and never inspect local state for a
        // remote invocation. Flat transition aliases use the same worktree as
        // their canonical runs/approvals equivalents.
        const runId = applicationConfig.remote === undefined ? ExecutionTarget.executionRunId(parsed) : undefined
        const config = runId === undefined ? applicationConfig : {
          ...applicationConfig,
          ...yield* Effect.promise(() => History.prepare(Project.root(applicationConfig.root, process.cwd()), runId))
        }
        // The legacy gateway alias has the same local-only approval default as
        // ControlBridge.host; configuring authentication does not delegate it.
        //
        // The verb also decides whether this host composes an executor, and so
        // whether it needs a completion judge before it opens a store. Five
        // verbs start or resume a run; the rest read, record a durable request,
        // or never touch a run, and refusing those for want of a judge refused
        // `ls`, `ps`, `status` and `logs` in every project with no gateway key.
        // The catalog answers the question and answers an unrecognized word
        // `true`, so drift can only bring the refusal back, never lose it.
        return NodeControl.layer({
          ...config,
          startsRuns: Verb.startsRuns(Argv.words(parsed)),
          approvalChannel: ["serve", "gateway"].includes(Argv.words(parsed)[0] ?? ""),
          approvalAuthority: config.approvalAuthority ?? ApprovalAuthority.local
        })
      }))),
    { version: packageVersion }
  ).pipe(
    Effect.provideService(Console.Console, parsedConsole),
    Effect.catchTag("ShowHelp", (error): Effect.Effect<never, CliError.UsageError | EffectCliError.ShowHelp> => {
      const missing = error.errors.find((issue) =>
        issue._tag === "UserError" && issue.cause instanceof CliError.UsageError
      )
      if (missing?._tag === "UserError" && missing.cause instanceof CliError.UsageError) {
        pending.length = 0
        return Effect.fail(missing.cause)
      }
      if (error.errors.length === 0 && !argv.some((arg) => arg === "--help" || arg === "-h" || arg === "--help=true")) {
        let group: Command.Command.Any = cli
        for (const name of error.commandPath.slice(1)) {
          const child = group.subcommands.flatMap((entry) => entry.commands).find((command) => command.name === name)
          if (child !== undefined) group = child
        }
        const choices = group.subcommands.flatMap((entry) => entry.commands)
          .filter((command) => !command.unlisted).map((command) => command.name)
        pending.length = 0
        return Effect.fail(
          new CliError.UsageError({
            message: `Choose a subcommand for ${error.commandPath.join(" ")}: ${
              choices.join(", ")
            }. Use --wizard for guided input`
          })
        )
      }
      return Effect.fail(error)
    }),
    Effect.ensuring(Effect.sync(flush)),
    Effect.provide(NodeServices.layer),
    Effect.provideService(RunProgress.Configuration, { policy: presentation, output: process.stderr }),
    Effect.provideService(References.MinimumLogLevel, presentation.progress === "silent" ? "Error" : "Info"),
    Effect.provideService(
      Ui.Ui,
      Ui.make({ output: process.stderr, input: process.stdin, interactive: presentation.interactive })
    )
  )
})

/**
 * Diagnostics go to stderr, so stdout carries only the document.
 *
 * `report` above already keeps CLI failures off stdout, but the runtime logger
 * is the other writer. A run's own lifecycle warnings, `An agent run failed`
 * and its rendered cause, are logged by `@smthrs/agent` through the default
 * logger, which calls `console.log`. Under `--json` that put forty lines of
 * warning inside the one document an attached launch prints, so a pipeline
 * step parsing `smthrs up <flow> --json` read a syntax error instead of the
 * receipt it was promised (the release policy, the `up` row). `LogToStderr`
 * is the reference Effect provides for exactly this: keep stdout for protocol
 * output and send every built-in logger to `console.error`.
 *
 * `RedactedLogger.layer` then puts every one of those lines through the rules
 * `@smthrs/journal` applies on the write path, so a credential an action hands
 * to `Effect.logInfo` no longer reaches the operator's terminal, the
 * `--json` stderr stream, or `.flows/logs/<runId>.log` under a detached
 * launch (the release policy). The durable engine installs the same layer
 * beneath itself, and wrapping is idempotent, so a detached `smthrs run`
 * pays the rules once.
 */
NodeRuntime.runMain(
  Effect.provideService(main, Logger.LogToStderr, true).pipe(Effect.provide(RedactedLogger.layer())),
  {
    teardown,
    disableErrorReporting: true
  }
)
