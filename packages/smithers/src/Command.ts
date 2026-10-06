/**
 * Compatibility command shims and migration refusals for the unified CLI.
 *
 * Cli.ts owns the public command tree. Both trees delegate to shared Effects,
 * and Compatibility.ts retains old spellings with their output contracts.
 * Local init, suggest, memory, MCP registration, and gateway hosting belong
 * exclusively to the Incur tree.
 *
 * @since 1.0.0
 */

import { Control as ControlService } from "@smthrs/control"
import * as MigrateCommand from "@smthrs/migrate/flow/Command"
import { BudgetOnExceeded } from "@smthrs/registry/Descriptor"
import { Clock, Console, Effect, Option, Stream } from "effect"
import { Argument, CliError as ParserError, Command, Flag, Prompt } from "effect/unstable/cli"
import * as CliError from "./CliError.ts"
import * as Launch from "./commands/Launch.ts"
import * as RunControl from "./commands/RunControl.ts"
import * as BugCmd from "./commands/Bug.ts"
import { cancelAll } from "./commands/CancelAll.ts"
import * as ClaudeCmd from "./commands/Claude.ts"
import * as DoctorCmd from "./commands/Doctor.ts"
import * as GcCmd from "./commands/Gc.ts"
import * as Globals from "./commands/Globals.ts"
import * as MigrateCmd from "./commands/Migrate.ts"
import * as Removed from "./commands/Removed.ts"
import * as RunReads from "./commands/RunReads.ts"
import * as Settlement from "./commands/Settlement.ts"
import * as UpdateCmd from "./commands/Update.ts"
import * as Doctor from "./Doctor.ts"
import * as Environment from "./Environment.ts"
import * as Forensics from "./Forensics.ts"
import * as Gc from "./Gc.ts"
import { defaultApprovalScope } from "./internal/ApprovalScope.ts"
import * as BoundedEvents from "./internal/BoundedEvents.ts"
import * as CommandStatus from "./internal/CommandStatus.ts"
import * as FeaturedFlows from "./internal/FeaturedFlows.ts"
import * as RunListing from "./internal/RunListing.ts"
import * as NodeOutput from "./NodeOutput.ts"
import { Output, renderValue } from "./Output.ts"
import * as Project from "./Project.ts"
import * as Ui from "./Ui.ts"
import * as Unsupported from "./Unsupported.ts"
import * as Update from "./Update.ts"
import * as Verb from "./Verb.ts"

const global = {
  json: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print the machine-readable document instead of the human rendering")
  ),
  remote: Flag.String("remote").pipe(
    Flag.optional,
    Flag.withDescription("http(s) URL of the control plane to act on; falls back to SMITHERS_REMOTE")
  ),
  quiet: Flag.Boolean("quiet").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Suppress banners and progress on stderr; stdout documents still print")
  ),
  silent: Flag.Boolean("silent").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Suppress progress while preserving the command result")
  ),
  audience: Flag.Literals("audience", ["auto", "human", "agent"] as const).pipe(
    Flag.withDefault("auto"),
    Flag.withDescription("Choose human or agent presentation; auto detects the calling harness")
  ),
  verbose: Flag.Boolean("verbose").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Show progress even when running inside an agent harness")
  ),
  // Declared here so the CLI's own flag validation accepts them; the values
  // are read from raw argv by `NodeControl.makeConfig`, which runs before the
  // durable layers are built.
  mcpConfig: Flag.String("mcp-config").pipe(
    Flag.optional,
    Flag.withDescription(
      "Path to the JSON array of MCP servers the local executor projects into a run's flow catalog"
    )
  ),
  root: Flag.String("root").pipe(
    Flag.optional,
    Flag.withDescription("Project root to act on, instead of walking up from the working directory")
  ),
  // Hidden: the command-line form of SMITHERS_BACKEND (`sqlite` or `postgres`).
  backend: Flag.String("backend").pipe(Flag.optional, Flag.withHidden)
}

const rootCommand = Command.make("smthrs").pipe(Command.withSharedFlags(global))

const input = Argument.String("key=value").pipe(Argument.variadic())
const data = Flag.String("data").pipe(
  Flag.optional,
  Flag.withDescription("Flow input as JSON, @file, or - for stdin; object members override key=value entries")
)
/** Required values are collected before the command opens durable services. */
const inputPrompt = (name: string, pickFlow = false) =>
  Effect.gen(function*() {
    const ui = yield* Ui.prompting
    const missing = new CliError.UsageError({
      message: `Missing required ${
        name.startsWith("--") ? "flag" : "argument"
      } <${name}>; use --wizard for guided input`
    })
    if (!ui.interactive) {
      return yield* Effect.fail(new ParserError.UserError({ cause: missing, userMessage: missing.message }))
    }
    // Discovery needs the command's Control layer. An empty value reaches
    // only the terminal handler, which replaces it with a catalog selection.
    if (pickFlow) return Prompt.succeed("")
    const value = yield* ui.text(`Enter ${name}`)
    if (Option.isNone(value)) return yield* Effect.interrupt
    return Prompt.succeed(value.value)
  })

const requiredArgument = (name: string, pickFlow = false) =>
  Argument.String(name).pipe(Argument.withFallbackPrompt(inputPrompt(name, pickFlow)))

const globalsOf = Effect.map(rootCommand, (root): Globals.Options => ({
  backend: Option.getOrUndefined(root.backend),
  environment: process.env
}))

const guardGlobals = Effect.flatMap(globalsOf, Globals.guard)

const render = (value: unknown) =>
  Effect.gen(function*() {
    const output = yield* Output
    const root = yield* rootCommand
    const rendered = yield* output.render(value, root.json ? "json" : "human")
    yield* Console.log(rendered.text)
  })

/** Forces JSON rendering, for the `events` alias and the `--json` contract. */
const renderJson = (value: unknown) =>
  Effect.gen(function*() {
    const output = yield* Output
    const rendered = yield* output.render(value, "json")
    yield* Console.log(rendered.text)
  })

/** Whether this invocation suppresses progress on stderr. */
const quiet = Effect.map(rootCommand, (globals) => globals.silent || globals.quiet)

/**
 * Finds the greatest sequence in a stream without retaining its history.
 *
 * Use this for journal cursors whose histories can exceed the JavaScript
 * argument limit. Stream failures are preserved so a caller never substitutes
 * a weaker cursor after a failed read.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export const latestSequence = Settlement.latestSequence

// == the shipped-command contract verbs

const plan = Command.make(
  "plan",
  { flowId: requiredArgument("flow-id", true), input, data },
  (config) =>
    Effect.gen(function*() {
      yield* guardGlobals
      yield* render(yield* RunControl.plan(config.flowId, config.input, config.data))
    })
).pipe(Command.withDescription(Verb.find("plan")!.help))

const allowCodeDriftFlag = Flag.Boolean("allow-code-drift").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Resume even though the run's flow changed since it started")
)

const runResume = (id: string, drift: boolean) => Effect.flatMap(quiet, suppressed => Effect.flatMap(Launch.resume(id, drift, suppressed), render))

const run = Command.make("run", {
  plan: requiredArgument("plan-payload"),
  resume: Flag.Boolean("resume").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Resume the parked run named by the positional argument")
  ),
  allowCodeDrift: allowCodeDriftFlag
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    if (config.resume) return yield* runResume(config.plan, config.allowCodeDrift)
    yield* render(yield* Launch.execute(config.plan, yield* quiet))
  })).pipe(Command.withDescription(Verb.find("run")!.help))

const resume = Command.make("resume", {
  runId: requiredArgument("run-id"),
  allowCodeDrift: allowCodeDriftFlag
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* runResume(config.runId, config.allowCodeDrift)
  })).pipe(Command.withDescription("Alias of `runs resume`"), Command.unlisted)

const upFlags = {
  flow: requiredArgument("flow", true),
  data,
  wait: Flag.Boolean("wait").pipe(Flag.withDefault(false), Flag.withDescription("Wait for run settlement")),
  detached: Flag.Boolean("detached").pipe(
    Flag.withDefault(false),
    Flag.withAlias("d"),
    Flag.withDescription("Launch a local executor in the background and print its run id and log path")
  ),
  serve: Removed.flag("up", "serve"),
  interactive: Removed.flag("up", "interactive"),
  supervise: Removed.flag("up", "supervise"),
  herdr: Removed.flag("up", "herdr"),
  monitor: Removed.flag("up", "monitor"),
  report: Removed.flag("up", "report"),
  force: Removed.flag("up", "force"),
  "steal-ownership": Removed.flag("up", "steal-ownership"),
  "resume-claim-owner": Removed.flag("up", "resume-claim-owner"),
  "resume-claim-heartbeat": Removed.flag("up", "resume-claim-heartbeat"),
  "resume-restore-owner": Removed.flag("up", "resume-restore-owner"),
  "resume-restore-heartbeat": Removed.flag("up", "resume-restore-heartbeat"),
  "max-concurrency": Removed.valueFlag("max-concurrency"),
  budgetTokens: Flag.Int("budget-tokens").pipe(
    Flag.optional,
    Flag.withDescription("Token ceiling for this run, replacing the flow's declared one")
  ),
  budgetMs: Flag.Int("budget-ms").pipe(
    Flag.optional,
    Flag.withDescription("Wall-clock ceiling in milliseconds for this run, replacing the flow's declared one")
  ),
  budgetUsd: Flag.Finite("budget-usd").pipe(
    Flag.optional,
    Flag.withDescription("Dollar ceiling for this run, replacing the flow's declared one")
  ),
  onExceeded: Flag.Literals("on-exceeded", BudgetOnExceeded.literals).pipe(
    Flag.optional,
    Flag.withDescription("What the run does at a ceiling: fail, warn, skip-remaining, or park")
  ),
  deadline: Flag.String("deadline").pipe(
    Flag.optional,
    Flag.withDescription(
      "Wall-clock time the run may take from its first start, as a duration (30 minutes) or milliseconds, " +
        "replacing the flow's declared one"
    )
  )
}

const up = Command.make("up", upFlags, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* Removed.refuse("up", {
      serve: config.serve,
      interactive: config.interactive,
      supervise: config.supervise,
      herdr: config.herdr,
      monitor: config.monitor,
      report: config.report,
      force: config.force,
      "steal-ownership": config["steal-ownership"],
      "resume-claim-owner": config["resume-claim-owner"],
      "resume-claim-heartbeat": config["resume-claim-heartbeat"],
      "resume-restore-owner": config["resume-restore-owner"],
      "resume-restore-heartbeat": config["resume-restore-heartbeat"],
      "max-concurrency": config["max-concurrency"]
    })
    const globals = yield* rootCommand
    yield* render(yield* Launch.start({ ...config, quiet: yield* quiet, remote: Option.fromUndefinedOr(Option.getOrUndefined(globals.remote) ?? Environment.read(process.env, "SMITHERS_REMOTE")), root: globals.root, mcpConfig: globals.mcpConfig }))
  })).pipe(Command.withDescription(Verb.find("up")!.help))

const approve = Command.make("approve", {
  approval: requiredArgument("approval"),
  // The interactive CLI is an operator affirming the whole launch, matching
  // `up`.
  scope: Flag.Literals("scope", ["once", "run", "remembered"] as const).pipe(
    Flag.withDefault(defaultApprovalScope),
    Flag.withDescription(
      "How far the grant reaches: this ask only, the whole run (the default, matching `up`), or every later run"
    )
  )
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* render(yield* Launch.approve(config.approval, config.scope, yield* quiet))
  })).pipe(Command.withDescription(Verb.find("approve")!.help))

const deny = Command.make("deny", { approval: requiredArgument("approval") }, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* render(yield* Launch.deny(config.approval, yield* quiet))
  })).pipe(Command.withDescription(Verb.find("deny")!.help))

const cancel = Command.make("cancel", { runId: requiredArgument("run-id") }, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* render(yield* RunControl.cancel(config.runId))
  })).pipe(Command.withDescription(Verb.find("cancel")!.help))

/**
 * The idempotency key of one signal delivery.
 *
 * The payload digest is part of the key because two different signals to one
 * run are two mutations. At the import reference the key was `cli:signal:<id>`
 * alone, so the second signal replayed the first one's recorded receipt and
 * was never delivered.
 *
 * @category constructors
 * @since 1.0.0
 */
export const signalKey = RunControl.signalKey

const signalCommand = Command.make("signal", {
  runId: requiredArgument("run-id"),
  payload: requiredArgument("signal-json")
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* render(yield* RunControl.deliverSignal(config.runId, config.payload))
  })).pipe(Command.withDescription(Verb.find("signal")!.help))

const steer = Command.make("steer", {
  runId: requiredArgument("run-id"),
  message: Flag.String("message").pipe(
    Flag.withDescription("Text to deliver as an attributed steering message to the run"),
    Flag.withFallbackPrompt(inputPrompt("--message"))
  ),
  takeover: Removed.flag("steer", "takeover")
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* Removed.refuse("steer", { takeover: config.takeover })
    yield* render(yield* RunControl.steer(config.runId, config.message))
  })).pipe(Command.withDescription(Verb.find("steer")!.help))

const listFlows = Effect.gen(function*() {
  yield* guardGlobals
  const document = yield* RunControl.listFlows
  const root = yield* rootCommand
  yield* render(root.json ? document : FeaturedFlows.human(document.items, document.apps).replace(/\n$/, ""))
})

const ls = Command.make("ls", {}, () => listFlows).pipe(Command.withDescription(Verb.find("ls")!.help))

const workflowList = Command.make("list", {}, () => listFlows).pipe(
  Command.withDescription("Alias of `flow list`"),
  Command.unlisted
)

const workflow = Command.make(
  "workflow",
  { rest: Argument.String("subcommand").pipe(Argument.variadic()) },
  (config) => Effect.fail(Unsupported.verbError(Removed.verb("workflow"), config.rest[0]))
).pipe(
  Command.withDescription("Removed; only `workflow list` survives, as an alias of `ls`"),
  Command.unlisted,
  Command.withSubcommands([workflowList])
)

const ps = Command.make("ps", {
  flow: Flag.String("flow").pipe(
    Flag.optional,
    Flag.withDescription("Only list runs of this flow id")
  ),
  // Validated, not cast: at the import reference any string reached the store
  // as a `RunStatus`, so `--status done` listed nothing and said nothing.
  status: Flag.Literals(
    "status",
    [
      "accepted",
      "running",
      "parked",
      "waiting-approval",
      "cancelled",
      "completed",
      "failed"
    ] as const
  ).pipe(Flag.optional, Flag.withDescription("Only list runs with this lifecycle status")),
  // One keyed page per call: the listing never loads every run, and a caller
  // walks further pages by passing back the `nextCursor` it printed.
  limit: Flag.Int("limit").pipe(Flag.optional, Flag.withDescription("Runs per page, 1 to 500 (default 100)")),
  cursor: Flag.String("cursor").pipe(
    Flag.optional,
    Flag.withDescription("Continue from the nextCursor a previous page printed")
  ),
  since: Flag.String("since").pipe(
    Flag.optional,
    Flag.withDescription("Only runs created at or after this time (epoch ms or ISO 8601)")
  ),
  until: Flag.String("until").pipe(
    Flag.optional,
    Flag.withDescription("Only runs created before this time (epoch ms or ISO 8601)")
  ),
  sort: Flag.Literals("sort", RunListing.sorts).pipe(
    Flag.optional,
    Flag.withDescription("Order by creation time")
  ),
  parent: Flag.String("parent").pipe(Flag.optional, Flag.withDescription("Only runs branched from this run")),
  trigger: Flag.String("trigger").pipe(Flag.optional, Flag.withDescription("Only runs this trigger started"))
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const listing = yield* RunListing.request({
      flow: Option.getOrUndefined(config.flow),
      status: Option.getOrUndefined(config.status),
      since: Option.getOrUndefined(config.since),
      until: Option.getOrUndefined(config.until),
      sort: Option.getOrUndefined(config.sort),
      parent: Option.getOrUndefined(config.parent),
      trigger: Option.getOrUndefined(config.trigger)
    }, { limit: Option.getOrUndefined(config.limit), cursor: Option.getOrUndefined(config.cursor) })
    const control = yield* ControlService.Control
    const now = yield* Clock.currentTimeMillis
    yield* render(yield* RunListing.label(yield* control.list(listing), now))
  })).pipe(Command.withDescription(Verb.find("ps")!.help))

const statusOf = (runId: Option.Option<string>) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const filters = Option.isSome(runId) ? { runId: runId.value } : undefined
    const listed = yield* RunListing.label(
      yield* control.list({ _tag: "runs", filters }),
      yield* Clock.currentTimeMillis
    )
    const root = yield* rootCommand
    // `--json` keeps the stable listing shape untouched; a human reader with a
    // run id gets the diagnosis card computed from that run's own events.
    if (Option.isNone(runId)) return yield* render(listed)
    const run = listed._tag === "runs" ? listed.items.find((item) => item.runId === runId.value) : undefined
    if (run === undefined) return yield* Effect.fail(RunReads.missing(runId.value))
    if (root.json) return yield* render(listed)
    const events = yield* RunReads.events(control, runId.value)
    yield* render(Forensics.renderDiagnosis(run, Forensics.digest(events, runId.value)))
  })

const status = Command.make("status", {
  runId: Argument.String("run-id").pipe(Argument.optional)
}, (config) => statusOf(config.runId)).pipe(
  Command.withDescription(Verb.find("status")!.help),
  Command.withAlias("inspect")
)

const why = Command.make("why", {
  runId: Argument.String("run-id").pipe(Argument.optional)
}, (config) => statusOf(config.runId)).pipe(Command.withDescription("Alias of `runs show`"), Command.unlisted)

const readLogs = (runId: Option.Option<string>, follow: boolean, forceJson: boolean) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const root = yield* rootCommand
    const json = forceJson || root.json
    if (Option.isSome(runId)) yield* RunReads.existing(control, runId.value)
    const watchedRunId = Option.getOrElse(runId, () => "*")
    const events = control.watch({
      runId: Option.getOrUndefined(runId),
      follow
    }).pipe(
      Stream.mapError((error) =>
        Settlement.watchFailure(error, watchedRunId, follow ? "log follow" : "event-history read")
      )
    )
    // Human output is the transcript projection; `--json` remains the raw
    // event stream, byte-stable for scripts. Follow mode renders one line per
    // event as it lands, because a transcript needs the whole run.
    if (follow) {
      return yield* Stream.runForEach(
        events,
        (event) =>
          Effect.gen(function*() {
            if (BoundedEvents.encodedBytes(event) > BoundedEvents.maximumEventBytes) {
              return yield* Effect.fail(
                new CliError.ResourceLimitError({
                  operation: "log follow",
                  subject: `run ${JSON.stringify(watchedRunId)}`,
                  limit: BoundedEvents.maximumEventBytes,
                  unit: "bytes"
                })
              )
            }
            yield* (json ? renderJson(event) : render(Forensics.eventLine(event)))
          })
      )
    }
    const collected = yield* BoundedEvents.collect(events, {
      operation: "event-history read",
      subject: `run ${JSON.stringify(watchedRunId)}`
    })
    if (json) return yield* renderJson(collected)
    yield* render(Forensics.renderTranscript(collected, Option.getOrUndefined(runId)))
  })

const logs = Command.make("logs", {
  runId: Argument.String("run-id").pipe(Argument.optional),
  follow: Flag.Boolean("follow").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Keep streaming new run events after the recorded history")
  )
}, (config) => readLogs(config.runId, config.follow, false)).pipe(
  Command.withDescription(Verb.find("logs")!.help)
)

const events = Command.make("events", {
  runId: Argument.String("run-id").pipe(Argument.optional),
  follow: Flag.Boolean("follow").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Keep streaming new run events after the recorded history")
  )
}, (config) => readLogs(config.runId, config.follow, true)).pipe(
  Command.withDescription("Alias of `runs logs --format jsonl`"),
  Command.unlisted
)

const output = Command.make("output", {
  runId: requiredArgument("run-id"),
  nodeId: Argument.String("node-id").pipe(Argument.optional)
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const document = yield* RunControl.output(config.runId, Option.getOrUndefined(config.nodeId))
    const root = yield* rootCommand
    yield* render(renderValue(root.json || !("nodeId" in document) ? document : NodeOutput.render(document)))
  })).pipe(Command.withDescription(Verb.find("output")!.help))

const down = Command.make("down", {}, () =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* render(yield* cancelAll())
  })).pipe(Command.withDescription(Verb.find("down")!.help))

/**
 * The migration tool's own flag set, declared on the verb.
 *
 * `smthrs migrate` and `smithers-migrate` run the same entry, so they take
 * the same options. A verb that declared none of them could only ever plan:
 * `--apply` converts the project source,
 * and an operator who cannot type it has no way to reach the transformation.
 * `--json` is not repeated here because it is already a shared global.
 */
const migrateFlags = {
  scan: Flag.Boolean("scan").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Inventory the project and write the report without planning any unit")
  ),
  apply: Flag.Boolean("apply").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Convert the project source, instead of planning the conversion")
  ),
  seat: Flag.String("seat").pipe(
    Flag.withDescription("The model seat the migration's agent runs on"),
    Flag.optional
  ),
  allowUnsafe: Flag.String("allow-unsafe").pipe(
    Flag.withDescription("Accept the named unsafe constructs, or `all`"),
    Flag.optional
  ),
  acknowledgeRunState: Flag.Boolean("acknowledge-run-state").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Accept the 0.x run state the report lists and migrate the source anyway")
  ),
  allowNoVcs: Flag.Boolean("allow-no-vcs").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Accept a file copy as the only checkpoint, in a project under no version control")
  ),
  keepOldSources: Flag.Boolean("keep-old-sources").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Leave the 0.x sources in place beside the flows written from them")
  ),
  unit: Flag.String("unit").pipe(
    Flag.withDescription("Migrate only these units, comma separated"),
    Flag.optional
  ),
  maxRepairRounds: Flag.Int("max-repair-rounds").pipe(
    Flag.withDescription("How many times one unit may be repaired before it is reported as failed"),
    Flag.optional
  ),
  reportDir: Flag.String("report-dir").pipe(
    Flag.withDescription("Where the report is written, relative to the project root"),
    Flag.optional
  ),
  flowsDir: Flag.String("flows-dir").pipe(
    Flag.withDescription("Where the written flows go, instead of `flows/`"),
    Flag.optional
  ),
  verifyInstall: Flag.String("verify-install").pipe(
    Flag.withDescription("The command that installs dependencies, instead of the one the lockfile implies"),
    Flag.optional
  ),
  verifyFormat: Flag.String("verify-format").pipe(
    Flag.withDescription("The command that formats the project, instead of the one its config implies"),
    Flag.optional
  ),
  verifyTypecheck: Flag.String("verify-typecheck").pipe(
    Flag.withDescription(
      "The command that typechecks the project, repeatable; one empty value runs no typecheck at all"
    ),
    Flag.atLeast(0)
  ),
  verifyTest: Flag.String("verify-test").pipe(
    Flag.withDescription("The command that runs the tests, instead of the project's own test script"),
    Flag.optional
  )
}

const migrate = Command.make("migrate", {
  path: Argument.String("path").pipe(Argument.optional),
  to: Removed.valueFlag("to"),
  ...migrateFlags
}, (config) =>
  Effect.gen(function*() {
    yield* Removed.refuse("migrate", { to: config.to })
    const migrationRoot = yield* Project.MigrationRoot
    const target = Option.getOrElse(config.path, () => migrationRoot)
    const root = yield* rootCommand
    const outcome = yield* MigrateCmd.run({
      target,
      scan: config.scan,
      apply: config.apply,
      seat: Option.getOrUndefined(config.seat),
      allowUnsafe: Option.getOrUndefined(config.allowUnsafe),
      acknowledgeRunState: config.acknowledgeRunState,
      allowNoVcs: config.allowNoVcs,
      keepOldSources: config.keepOldSources,
      unit: Option.getOrUndefined(config.unit),
      maxRepairRounds: Option.getOrUndefined(config.maxRepairRounds),
      reportDir: Option.getOrUndefined(config.reportDir),
      flowsDir: Option.getOrUndefined(config.flowsDir),
      verifyInstall: Option.getOrUndefined(config.verifyInstall),
      verifyFormat: Option.getOrUndefined(config.verifyFormat),
      verifyTypecheck: config.verifyTypecheck,
      verifyTest: Option.getOrUndefined(config.verifyTest)
    }, yield* globalsOf)
    if (outcome._tag === "Parked") {
      const { _tag: _, ...document } = outcome
      if (root.json) yield* Console.log(JSON.stringify(document))
      else {
        yield* Console.error(
          `smthrs migrate: ${outcome.message}${outcome.details === undefined ? "" : `\n${outcome.details}`}`
        )
      }
      return yield* CommandStatus.set(3)
    }
    yield* Console.log(MigrateCommand.render(outcome.report, root.json ? "json" : "human", outcome.reportDirectory))
    // The migration's own status, the way `smithers-migrate` reports it: 3 is
    // "parked, the operator has a decision", not a failure. `cli/LegacyBin.ts` hands a
    // successful exit whatever `process.exitCode` holds, which is also how
    // `NodeControl.layerOutput` transfers a rendered status.
    yield* CommandStatus.set(MigrateCommand.exitCode(outcome.report))
  })).pipe(Command.withDescription(Verb.find("migrate")!.help))

const update = Command.make("update", {}, () =>
  Effect.gen(function*() {
    const status = yield* UpdateCmd.check(yield* globalsOf)
    yield* render(Update.render(status))
  })).pipe(Command.withDescription(Verb.find("update")!.help))

const bug = Command.make("bug", {
  summary: requiredArgument("summary"),
  rest: Argument.String("summary").pipe(Argument.variadic()),
  runId: Flag.String("run").pipe(Flag.optional, Flag.withDescription("Include only this run and its event digest")),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Post the previewed payload without an interactive confirmation")
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print the exact redacted payload and endpoint without posting")
  )
}, (config) =>
  Effect.gen(function*() {
    const outcome = yield* BugCmd.submit({
      summary: [config.summary, ...config.rest].join(" "),
      runId: Option.getOrUndefined(config.runId),
      yes: config.yes,
      dryRun: config.dryRun,
      preview: (line) => Console.error(line)
    }, yield* globalsOf)
    yield* render(outcome)
  })).pipe(Command.withDescription(Verb.find("bug")!.help))

const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function*() {
    const root = yield* rootCommand
    const report = yield* DoctorCmd.fromControl(yield* globalsOf)
    // `--json` prints the report verbatim. The human rendering goes through
    // `Ui`: clack symbols and a verdict line on a terminal, and on a pipe the
    // same one-line-per-check text `Doctor.render` has always produced.
    const ui = yield* Ui.current
    yield* render(
      root.json
        ? report
        : Ui.renderChecklist(`smthrs doctor: ${report.root}`, report.checks, { interactive: ui.interactive })
    )
    if (Doctor.failed(report)) {
      yield* Effect.fail(new CliError.UnsupportedError({ message: "doctor found a blocking problem" }))
    }
  })).pipe(Command.withDescription(Verb.find("doctor")!.help))

const gc = Command.make("gc", {
  olderThan: Flag.String("older-than").pipe(
    Flag.withDefault(Gc.defaultRetention),
    Flag.withDescription("Delete terminal runs older than this duration, for example 7d")
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Report the runs and rows that would be deleted without deleting them")
  ).pipe(Flag.withDefault(false))
}, (config) =>
  Effect.gen(function*() {
    const swept = yield* GcCmd.sweep({ olderThan: config.olderThan, dryRun: config.dryRun }, yield* globalsOf)
    yield* render(swept)
    if (swept.failures.length > 0) {
      return yield* Effect.fail(new CliError.UnsupportedError({ message: Gc.failureMessage(swept.failures) }))
    }
  })).pipe(Command.withDescription(Verb.find("gc")!.help))

/**
 * The composed root command. Application composition supplies Control and
 * Output layers; this module contains no transport selection.
 *
 * Reach for this value from the executable or parser-level tests. Individual
 * handlers fail with the package's typed CLI errors, while a missing service
 * is left visible as a composition defect rather than hidden by the command
 * tree.
 *
 * @category constructors
 * @since 1.0.0
 */
export const cli = rootCommand.pipe(
  Command.withDescription("Plan, approve, and run durable flows"),
  Command.withSubcommands([
    plan,
    run,
    resume,
    up,
    approve,
    deny,
    cancel,
    signalCommand,
    steer,
    ls,
    workflow,
    ps,
    status,
    why,
    logs,
    events,
    output,
    down,
    doctor,
    gc,
    migrate,
    ClaudeCmd.make({ guard: guardGlobals, required: requiredArgument }),
    update,
    bug,
    ...Removed.commands
  ])
)
