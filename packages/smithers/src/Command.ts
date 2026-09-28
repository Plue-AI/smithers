/**
 * Retained Effect handlers and migration refusals for the unified CLI.
 *
 * Cli.ts owns the public command tree. Its control commands delegate here,
 * and Compatibility.ts retains old spellings with their output contracts.
 * Local init, suggest, memory, MCP registration, and gateway hosting belong
 * exclusively to the Incur tree.
 *
 * @since 1.0.0
 */

import * as Canonical from "@smthrs/canonical/Canonical"
import { Control as ControlService, ControlSchema } from "@smthrs/control"
import * as Sha256 from "@smthrs/crypto/Sha256"
import * as MigrateCommand from "@smthrs/migrate/flow/Command"
import { Ownership } from "@smthrs/run-store"
import { Clock, Console, Effect, Option, Schema, SchemaIssue, Stream } from "effect"
import { Argument, CliError as ParserError, Command, Flag, Prompt } from "effect/unstable/cli"
import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { resolve } from "node:path"
import * as CliError from "./CliError.ts"
import * as BugCmd from "./commands/Bug.ts"
import { cancelAll } from "./commands/CancelAll.ts"
import * as ClaudeCmd from "./commands/Claude.ts"
import * as DoctorCmd from "./commands/Doctor.ts"
import * as FlowCatalog from "./commands/FlowCatalog.ts"
import * as GcCmd from "./commands/Gc.ts"
import * as Globals from "./commands/Globals.ts"
import * as MigrateCmd from "./commands/Migrate.ts"
import * as Removed from "./commands/Removed.ts"
import * as RunReads from "./commands/RunReads.ts"
import * as Settlement from "./commands/Settlement.ts"
import * as UpdateCmd from "./commands/Update.ts"
import * as Detached from "./Detached.ts"
import * as Doctor from "./Doctor.ts"
import * as Environment from "./Environment.ts"
import * as Forensics from "./Forensics.ts"
import * as Gc from "./Gc.ts"
import { defaultApprovalScope } from "./internal/ApprovalScope.ts"
import * as BoundedEvents from "./internal/BoundedEvents.ts"
import * as CommandStatus from "./internal/CommandStatus.ts"
import * as FeaturedFlows from "./internal/FeaturedFlows.ts"
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
  Flag.withDescription("Flow input as JSON; object members override key=value entries")
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

const selectedFlow = (value: string) =>
  Effect.gen(function*() {
    if (value !== "") return value
    const ui = yield* Ui.prompting
    const control = yield* ControlService.Control
    const catalog = yield* flowCatalog(control)
    const flows = catalog.items.filter((item) => !Unsupported.isReservedFlow(item.flowId))
    if (flows.length === 0) {
      return yield* Effect.fail(
        new CliError.UsageError({ message: "No flows discovered; run smthrs init to create one" })
      )
    }
    const selected = yield* ui.pickSuggestion(flows, {
      message: "Choose a flow",
      label: (flow) => flow.flowId,
      hint: (flow) => flow.description
    })
    if (Option.isNone(selected)) return yield* Effect.interrupt
    return selected.value.flowId
  })

const globalsOf = Effect.map(rootCommand, (root): Globals.Options => ({
  backend: Option.getOrUndefined(root.backend),
  environment: process.env
}))

const guardGlobals = Effect.flatMap(globalsOf, Globals.guard)

const malformedJson = (label: string): CliError.UsageError =>
  new CliError.UsageError({ message: `${label} must be valid JSON` })

const formatSchemaIssue = SchemaIssue.makeFormatterDefault()

const schemaMismatch = (label: string, issue: SchemaIssue.Issue): CliError.UsageError => {
  // Approval payloads can carry capability material. Input reporting stays
  // disabled at the decoder, and this bounded formatter keeps only the path
  // and expectation an operator needs to repair one field.
  const detail = formatSchemaIssue(issue).split("\n").slice(0, 4).join("\n").slice(0, 800)
  return new CliError.UsageError({
    message: `${label} must match the expected payload schema:\n${detail}`
  })
}

const decodeJson = <A>(
  label: string,
  serialized: string,
  decode: (value: unknown) => Effect.Effect<A, Schema.SchemaError>
): Effect.Effect<A, CliError.UsageError> =>
  Effect.try({
    try: () => JSON.parse(serialized) as unknown,
    catch: () => malformedJson(label)
  }).pipe(
    Effect.flatMap((decoded) =>
      decode(decoded).pipe(
        Effect.mapError((error) => schemaMismatch(label, error.issue))
      )
    )
  )

const decodeInput = (
  entries: ReadonlyArray<string>,
  raw: Option.Option<string>
): Effect.Effect<unknown, CliError.UsageError> => {
  const pairs = Object.fromEntries(entries.map((entry) => {
    const separator = entry.indexOf("=")
    return separator < 1 ? [entry, true] : [entry.slice(0, separator), entry.slice(separator + 1)]
  }))
  if (Option.isNone(raw)) return Effect.succeed(pairs)
  return Effect.try({
    try: () => JSON.parse(raw.value) as unknown,
    catch: () => malformedJson("--data")
  }).pipe(
    Effect.map((decoded) =>
      decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
        ? { ...pairs, ...(decoded as Record<string, unknown>) }
        : { ...pairs, data: decoded }
    )
  )
}

const approval = (serialized: string): Effect.Effect<ControlService.ApprovalInput, CliError.UsageError> =>
  decodeJson(
    "approval",
    serialized,
    Schema.decodeUnknownEffect(ControlSchema.ApprovalPayload, { reportInput: false })
  )

const signal = (serialized: string): Effect.Effect<ControlSchema.SignalPayload, CliError.UsageError> =>
  decodeJson(
    "signal-json",
    serialized,
    Schema.decodeUnknownEffect(ControlSchema.SignalPayload, { reportInput: false })
  )

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

/** Waits for a run this process's executor owns; see `Settlement.awaitOwnedRun`. */
const awaitOwnedRun = (
  control: ControlService.Service,
  receipt: ControlSchema.Receipt,
  afterSequence: number | undefined
) => Effect.flatMap(quiet, (suppressed) => Settlement.awaitOwnedRun(control, receipt, afterSequence, suppressed))

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

/**
 * Renders what the control plane knows about a declined launch, and returns
 * the refusal the verb exits with.
 */
const declinedLaunch = (control: ControlService.Service, runId: string) =>
  Effect.gen(function*() {
    const summary = yield* RunReads.summary(control, runId)
    if (summary !== undefined) yield* render(summary)
    return Settlement.declined(runId, summary)
  })

const renderReceipt = (receipt: ControlSchema.Receipt, settlement: Settlement.Settlement | undefined) =>
  render(Settlement.receiptDocument(receipt, settlement))

// == the shipped-command contract verbs

const plan = Command.make(
  "plan",
  { flowId: requiredArgument("flow-id", true), input, data },
  (config) =>
    Effect.gen(function*() {
      yield* guardGlobals
      const decodedInput = yield* decodeInput(config.input, config.data)
      const flowId = yield* selectedFlow(config.flowId)
      if (Unsupported.isReservedFlow(flowId)) {
        return yield* Effect.fail(Unsupported.reservedFlowError("flow plan", flowId))
      }
      const control = yield* ControlService.Control
      yield* render(yield* control.plan({ flowId, input: decodedInput }))
    })
).pipe(Command.withDescription(Verb.find("plan")!.help))

const allowCodeDriftFlag = Flag.Boolean("allow-code-drift").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Resume even though the run's flow changed since it started")
)

const runResume = (planOrRunId: string, allowCodeDrift: boolean) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    const parkSequence = yield* Settlement.latestPark(control, planOrRunId)
    const key = parkSequence === undefined ? `cli:resume:${planOrRunId}` : `cli:resume:${planOrRunId}:${parkSequence}`
    const receipt = yield* control.resume({
      runId: planOrRunId,
      // A refused resume records no receipt, so the retry with the override
      // takes a key of its own rather than colliding with the refused one.
      idempotencyKey: allowCodeDrift ? `${key}:allow-code-drift` : key,
      ...(allowCodeDrift ? { allowCodeDrift } : {})
    })
    const settlement = yield* awaitOwnedRun(control, receipt, parkSequence)
    if (Settlement.wasDeclined(settlement) && receipt._tag === "Accepted" && receipt.runId !== undefined) {
      return yield* Effect.fail(yield* declinedLaunch(control, receipt.runId))
    }
    yield* renderReceipt(receipt, settlement)
    return yield* Settlement.report(settlement)
  })

/**
 * Announces a detached run's admission to its own log, as soon as the run row
 * is durable. The launcher in the parent process waits for exactly this line.
 */
const announceAdmission = (receipt: ControlSchema.Receipt) =>
  Effect.sync(() => {
    const nonce = process.env[Detached.admissionVariable]
    if (nonce === undefined || nonce === "") return
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return
    process.stderr.write(`${Detached.admissionLine(nonce, receipt.runId)}\n`)
  })

const runLaunch = (payload: ControlService.ApprovalInput) =>
  Effect.gen(function*() {
    const target = payload.target
    if (target._tag !== "Plan") {
      return yield* Effect.fail(new CliError.UsageError({ message: "run requires a plan approval payload" }))
    }
    const control = yield* ControlService.Control
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: target.planId,
      digest: target.digest,
      envelope: target.envelope,
      idempotencyKey: payload.idempotencyKey
    })
    yield* announceAdmission(receipt)
    const settlement = yield* awaitOwnedRun(control, receipt, undefined)
    if (Settlement.wasDeclined(settlement) && receipt._tag === "Accepted" && receipt.runId !== undefined) {
      return yield* Effect.fail(yield* declinedLaunch(control, receipt.runId))
    }
    yield* renderReceipt(receipt, settlement)
    yield* Settlement.report(settlement)
  })

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
    yield* runLaunch(yield* approval(config.plan))
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
  "max-concurrency": Removed.valueFlag("max-concurrency")
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
    const remote = Option.getOrUndefined(globals.remote) ?? Environment.read(process.env, "SMITHERS_REMOTE")
    if (config.detached && remote !== undefined) {
      return yield* Effect.fail(
        new CliError.UnsupportedError({
          message: "flow start -d spawns a local executor; run `smthrs flow start` attached against --remote"
        })
      )
    }
    const flowId = yield* selectedFlow(config.flow)
    if (Unsupported.isReservedFlow(flowId)) {
      return yield* Effect.fail(Unsupported.reservedFlowError("flow start", flowId))
    }
    const decodedInput = yield* decodeInput([], config.data)
    const control = yield* ControlService.Control
    const card = yield* control.plan({ flowId, input: decodedInput })
    // The bare `*` envelope grants every capability, and markdown discovery
    // substitutes it for a flow that declares none, so `up` never approves it
    // unseen. The operator reviews the card with `plan` and signs it with
    // `approve`.
    if (card.envelope.capabilities.includes("*")) {
      return yield* Effect.fail(
        new CliError.UsageError({
          message: `flow start will not approve ${flowId}: its envelope grants every capability ("*"). `
            + `Declare capabilities in the flow, or review it with \`smthrs flow plan ${flowId}\` and approve it with \`smthrs approvals approve\``
        })
      )
    }
    // Scope `run`: the approval authorizes this launch and its whole run, not
    // every future launch of the flow.
    yield* control.approve({ ...card.approval, scope: "run" })
    if (!config.detached) return yield* runLaunch({ ...card.approval, scope: "run" })

    const projectRoot = yield* Project.ProjectRoot
    const timeoutMs = Environment.readInteger(process.env, "SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS")
    const passthrough = [
      // The child runs with the project root as its cwd. An absolute MCP path
      // preserves the file the parent parsed when the flag was relative.
      ...(Option.isNone(globals.mcpConfig)
        ? []
        : ["--mcp-config", resolve(process.cwd(), globals.mcpConfig.value)]),
      ...(Option.isNone(globals.root) ? [] : ["--root", projectRoot])
    ]
    // Each `up` plans afresh, so the plan id is this launch's alone. An id the
    // child's log announces is trusted only when this process's own control
    // store holds that run under this plan: the log is shared with every tool
    // the run spawns, and they inherit the admission nonce.
    const planId = card.approval.target._tag === "Plan" ? card.approval.target.planId : undefined
    const admission = (runId: string) =>
      Effect.runPromise(
        RunReads.summary(control, runId).pipe(
          Effect.map((summary) => planId !== undefined && summary !== undefined && summary.planId === planId)
        )
      )
    const launched = yield* Effect.callback<Detached.Launched | Detached.Rejected>((resume, signal) => {
      const pending = Detached.launch({
        root: projectRoot,
        payload: JSON.stringify({ ...card.approval, scope: "run" }),
        passthrough,
        signal,
        admission,
        ...(timeoutMs === undefined ? {} : { timeoutMs })
      })
      pending.then((result) => resume(Effect.succeed(result)), (error) => resume(Effect.die(error)))
      // Interruption aborts the signal first. Wait for termination and reaping
      // before the CLI scope can close and the process can exit.
      return Effect.promise(() => pending.then(() => undefined, () => undefined))
    })
    if (!Detached.isLaunched(launched)) {
      return yield* Effect.fail(
        new CliError.UnsupportedError({
          message: `${launched.reason}\nLog: ${launched.logFile}${launched.tail === "" ? "" : `\n${launched.tail}`}`
        })
      )
    }
    // The receipt's own field, never an operator-supplied id: rc.0 has no
    // `--run-id`, and a caller reads the run id from here.
    yield* render({ runId: launched.runId, logFile: launched.logFile, detached: true })
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
    const payload = yield* approval(config.approval)
    const control = yield* ControlService.Control
    const parkSequence = yield* Settlement.decisionPark(control, payload.target)
    const receipt = yield* control.approve({ ...payload, scope: config.scope })
    // A decision restarts the run it answers, in this call, on this process's
    // own executor. The decision therefore ends with
    // a settled run, and the shell that ran `smthrs approve` is entitled to
    // read that run's status from `$?` exactly as `up` and `run` promise it.
    const settlement = yield* awaitOwnedRun(control, receipt, parkSequence)
    yield* renderReceipt(receipt, settlement)
    yield* Settlement.report(settlement)
  })).pipe(Command.withDescription(Verb.find("approve")!.help))

const deny = Command.make("deny", { approval: requiredArgument("approval") }, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const payload = yield* approval(config.approval)
    const control = yield* ControlService.Control
    const parkSequence = yield* Settlement.decisionPark(control, payload.target)
    const receipt = yield* control.deny(payload)
    const settlement = yield* awaitOwnedRun(control, receipt, parkSequence)
    yield* renderReceipt(receipt, settlement)
    yield* Settlement.report(settlement)
  })).pipe(Command.withDescription(Verb.find("deny")!.help))

const cancel = Command.make("cancel", { runId: requiredArgument("run-id") }, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    yield* render(yield* control.cancel({ runId: config.runId, idempotencyKey: `cli:cancel:${config.runId}` }))
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
export const signalKey = (runId: string, payload: ControlSchema.SignalPayload): string => {
  const encoded = Schema.encodeSync(ControlSchema.SignalPayload)(payload)
  const canonical = Schema.decodeUnknownSync(Canonical.Canonical)(encoded)
  return `cli:signal:${runId}:${Sha256.digestSync(canonical)}`
}

const signalCommand = Command.make("signal", {
  runId: requiredArgument("run-id"),
  payload: requiredArgument("signal-json")
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const payload = yield* signal(config.payload)
    const control = yield* ControlService.Control
    yield* render(
      yield* control.signal({
        runId: config.runId,
        signal: payload,
        idempotencyKey: signalKey(config.runId, payload)
      })
    )
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
    const control = yield* ControlService.Control
    const stamp = Date.now()
    const messageId = `cli:steer:${config.runId}:${randomUUID()}`
    yield* render(
      yield* control.steer({
        runId: config.runId,
        message: {
          kind: "Message",
          messageId,
          runId: config.runId,
          principal: { kind: "operator", id: "cli", stampedAt: stamp },
          createdAt: stamp,
          body: config.message
        },
        idempotencyKey: messageId
      })
    )
  })).pipe(Command.withDescription(Verb.find("steer")!.help))

const flowCatalog = FlowCatalog.read

const listFlows = Effect.gen(function*() {
  yield* guardGlobals
  const control = yield* ControlService.Control
  const catalog = yield* flowCatalog(control)
  // The reserved catalog is the control plane's projection surface, not this
  // project's flows. Listing it invited `up system/release`, which planned,
  // launched, and then sat at `accepted` with nothing to run. Discovery
  // warnings belong to `doctor`, so the stable `ls` document remains a plain
  // flow page even though both commands read the same paged catalog.
  // The featured set and the one-line summaries come from the project's
  // generated .smithers/factory.json when it is checked in; a project without
  // one lists exactly the discovered page. A person at a terminal reads one line
  // per flow with the featured rows starred; `--json` keeps the document.
  const { items, apps } = FlowCatalog.listing(catalog.items, yield* Project.ProjectRoot)
  const root = yield* rootCommand
  yield* render(
    root.json
      ? { _tag: "flows", items, ...(apps === undefined ? {} : { apps }) }
      : FeaturedFlows.human(items, apps).replace(/\n$/, "")
  )
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
  ).pipe(Flag.optional, Flag.withDescription("Only list runs with this lifecycle status"))
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const now = yield* Clock.currentTimeMillis
    yield* render(
      yield* labelled(
        yield* control.list({
          _tag: "runs",
          filters: {
            ...(Option.isNone(config.flow) ? {} : { flowId: config.flow.value }),
            ...(Option.isNone(config.status) ? {} : { status: config.status.value })
          }
        }),
        now
      )
    )
  })).pipe(Command.withDescription(Verb.find("ps")!.help))

/**
 * The window a driven launch may sit at `accepted` before it claims the run.
 *
 * An ordinary driven launch commits an accepted summary before its executor
 * begins work, so the listing waits out this handoff before probing the owner.
 */
const executorHandoffWindowMillis = 5_000

/**
 * Whether a listing should say a run is waiting for an executor.
 *
 * This is a rendering heuristic over the listing's own fields, not a durable
 * verdict: the durable one is the `control.run.pending` event the status card
 * reads from the run's journal. For a same-host owner it uses the same
 * fail-closed PID probe as run recovery. A foreign-host owner cannot be
 * inspected and is never declared absent here.
 */
const statusObserver: Ownership.OwnerId = Object.freeze({
  hostId: hostname(),
  pid: process.pid,
  nonce: "cli-status-observer"
})

const unclaimed = (run: ControlSchema.RunSummary, now: number): Effect.Effect<boolean> => {
  if (run.status !== "accepted" || run.waitingReason !== undefined) return Effect.succeed(false)
  if (now - run.updatedAt < executorHandoffWindowMillis) return Effect.succeed(false)
  if (run.ownerId === undefined) return Effect.succeed(true)
  try {
    const owner = Schema.decodeUnknownSync(Ownership.OwnerId)(JSON.parse(run.ownerId))
    if (owner.hostId !== statusObserver.hostId) return Effect.succeed(false)
    return Ownership.sameHostPidProbe(owner, {
      claimant: statusObserver,
      heartbeatAtMs: null,
      nowMs: now
    }).pipe(Effect.map((alive) => !alive))
  } catch {
    return Effect.succeed(false)
  }
}

/**
 * Names what an unclaimed run waits for, in the field that already carries it.
 *
 * `RunSummary.waitingReason` is "what a parked run is holding on". This one
 * holds on an executor, and before the label a listing showed it as an
 * ordinary `accepted` run, indistinguishable from one a live peer owns.
 */
const labelled = (listed: ControlSchema.ListResponse, now: number): Effect.Effect<ControlSchema.ListResponse> =>
  listed._tag === "runs"
    ? Effect.map(
      Effect.forEach(
        listed.items,
        (run) => Effect.map(unclaimed(run, now), (missing) => missing ? { ...run, waitingReason: "executor" } : run)
      ),
      (items) => ({ ...listed, items })
    )
    : Effect.succeed(listed)

const statusOf = (runId: Option.Option<string>) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const filters = Option.isSome(runId) ? { runId: runId.value } : undefined
    const listed = yield* labelled(yield* control.list({ _tag: "runs", filters }), yield* Clock.currentTimeMillis)
    const root = yield* rootCommand
    // `--json` keeps the stable listing shape untouched; a human reader with a
    // run id gets the diagnosis card computed from that run's own events.
    if (Option.isNone(runId)) return yield* render(listed)
    const run = listed._tag === "runs" ? listed.items.find((item) => item.runId === runId.value) : undefined
    if (run === undefined) return yield* Effect.fail(RunReads.missing(runId.value))
    if (root.json) return yield* render(listed)
    const events = yield* RunReads.events(control, runId.value)
    yield* render(Forensics.renderDiagnosis(run, Forensics.digest(events)))
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
    yield* render(Forensics.renderTranscript(collected))
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
    const control = yield* ControlService.Control
    yield* RunReads.existing(control, config.runId)
    const collected = yield* RunReads.events(control, config.runId)
    const nodes = NodeOutput.project(collected)
    const requested = Option.getOrUndefined(config.nodeId)
    if (requested === undefined) return yield* render(renderValue(nodes))
    const node = nodes.find((candidate) => candidate.nodeId === requested)
    if (node === undefined) {
      return yield* Effect.fail(
        new CliError.UsageError({ message: NodeOutput.notFound(config.runId, requested, nodes) })
      )
    }
    const root = yield* rootCommand
    yield* render(renderValue(root.json ? node : NodeOutput.render(node)))
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
