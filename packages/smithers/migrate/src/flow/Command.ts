/**
 * The entry point every caller shares: the CLI verb, the `smithers-migrate`
 * bin, and the durable control-plane launch.
 *
 * A migration is one flow execution. What this module adds around it is the
 * part a flow body cannot do: the read-only survey that turns a project into
 * the plan-time unit list, the composition the execution runs under, and the
 * two renderings a person or a script reads afterwards.
 *
 * @since 1.0.0-rc.0
 */

import type { Action } from "@smthrs/flow"
import type * as FlowRuntime from "@smthrs/flow/FlowRuntime"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Layer from "effect/Layer"
import type * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { resolve } from "node:path"
import { make, MigrateError, MigrateErrorCode } from "../MigrateError.ts"
import * as Report from "../Report.ts"
import * as RunState from "../RunState.ts"
import type * as Scan from "../Scan.ts"
import type * as Units from "../Units.ts"
import type * as Contract from "./Contract.ts"
import * as Gate from "./Gate.ts"
import * as VcsInternal from "./internal/Vcs.ts"
import * as Layers from "./Layers.ts"
import * as Lock from "./Lock.ts"
import * as MigrateFlow from "./MigrateFlow.ts"
import * as Options from "./Options.ts"
import type * as Transform from "./Transform.ts"

/**
 * What one migration run was asked to do. The CLI decodes its flags into this.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const MigrateOptions = Options.MigrateOptions

/**
 * What one migration run was asked to do.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type MigrateOptions = Options.MigrateOptions

/**
 * Integration label for a host exposing migration through its control plane.
 * The package does not install a CLI route for this label. The bundled entry
 * points are `smthrs migrate`, `smithers-migrate`, and {@link runNode}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const flowId = "system/migrate"

/**
 * Everything {@link run} needs provided.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Requirements =
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | FlowRuntime.FlowRuntime
  | Action.Implementations
  | MigrateFlow.Requires

/**
 * What the read-only survey found: the scan, the plan-time unit outlines, the
 * run-state roots a checkpoint has to digest, and the verification commands
 * the host binds.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Survey {
  readonly scan: Scan.ScanResult
  readonly outlines: ReadonlyArray<Transform.UnitOutline>
  readonly runStateRoots: ReadonlyArray<string>
  readonly commands: Contract.Commands
  /** The plan, sealed: what the flow's seal step checks the tree against before the first checkpoint. */
  readonly seal: MigrateFlow.PlanSeal
}

/**
 * Reads the project without touching it.
 *
 * The survey runs before the flow because a flow body is plan time: the unit
 * list is topology, and topology cannot come from a value a step returns. The
 * flow scans again inside its own sealed step, and its gate refuses a plan the
 * project has since outgrown.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const survey = (
  options: MigrateOptions
): Effect.Effect<Survey, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    // The same scan, the same layout checks, and the same refusals the flow's
    // own scan step makes: a survey that read a project the flow would refuse
    // would plan units against a layout nothing may write to.
    const result = yield* MigrateFlow.scan(options)
    const outlines = MigrateFlow.outlines(result, options)
    return {
      scan: result,
      outlines,
      runStateRoots: RunState.roots(result.runState),
      commands: commandsOf(result, options),
      seal: yield* MigrateFlow.planSeal(result, options)
    }
  })

/**
 * The verification commands this project verifies a unit with.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const commandsOf = (
  result: Scan.ScanResult,
  options: MigrateOptions
): Contract.Commands =>
  Layers.commandsFor(
    result.detection,
    options.commands === undefined ? {} : {
      ...(options.commands.install === undefined ? {} : { install: options.commands.install }),
      ...(options.commands.format === undefined ? {} : { format: options.commands.format }),
      ...(options.commands.typecheck === undefined ? {} : { typecheck: options.commands.typecheck }),
      ...(options.commands.test === undefined ? {} : { test: options.commands.test })
    },
    Options.flowsDir(options)
  )

/**
 * Whether a failure is this package's own error, decided by the class and
 * its schema rather than by a `_tag` string any object can carry. A forged
 * tag would otherwise be printed as an operator instruction.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const isMigrateError = (error: unknown): error is MigrateError =>
  error instanceof MigrateError && Schema.is(MigrateErrorCode)(error.code) && typeof error.message === "string"

/**
 * The execution id one migration invocation takes. The direct Node composition
 * uses an in-memory engine, so this id is intentionally unique per start and
 * cannot imply cross-process resume. The checkpoint's pending marker is the
 * crash-recovery path for that composition.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const executionId = (options: MigrateOptions, generatedAt: string): string =>
  `migrate-${options.mode}-${generatedAt}`

/**
 * Runs one migration and returns its report.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const run = (
  options: MigrateOptions
): Effect.Effect<Report.MigrationReport, MigrateError, Requirements> =>
  Effect.flatMap(survey(options), (surveyed) => launch(options, surveyed))

/**
 * Notes a taken-over lock in the report and rewrites it, so the audit trail
 * names the run this one replaced. The lock file said when the earlier run
 * started and which report directory holds its pending recovery marker.
 */
const noteReclaimedLock = (
  options: MigrateOptions,
  reclaimed: Lock.Record,
  report: Report.MigrationReport
): Effect.Effect<Report.MigrationReport, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const amended = new Report.MigrationReport({
      ...report,
      followUps: [
        ...report.followUps,
        {
          severity: "info" as const,
          text:
            `this run took over the lock of an earlier apply (pid ${reclaimed.pid}, started ${reclaimed.startedAt}) whose operating-system lock was released; if it stopped mid-unit, ${
              reclaimed.reportDir ?? Options.defaultReportDir
            }/pending-unit.json holds its recovery record`
        }
      ]
    })
    yield* Report.write(reportDirectory(options), amended)
    return amended
  })

/**
 * Executes the migration flow over a survey taken earlier.
 *
 * This is the seam a durable host uses when the plan was approved in one
 * process and run in another: the survey is the plan, and the flow's own seal
 * step is what refuses it if the project has moved on since.
 *
 * An apply runs under the canonical project's lock, so a second apply over the
 * same project refuses instead of sharing the backups and the pending marker
 * with the first. A lock whose owner died is taken over, and the takeover is
 * noted in the report the run writes: the earlier run may have stopped
 * mid-unit, and the report is where a person learns that.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const launch = (
  options: MigrateOptions,
  surveyed: Survey
): Effect.Effect<Report.MigrationReport, MigrateError, Requirements> =>
  Effect.gen(function*() {
    const generatedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    const execute = MigrateFlow.flow.execute({
      options,
      units: surveyed.outlines,
      runStateRoots: surveyed.runStateRoots,
      generatedAt,
      seal: surveyed.seal
    }, { executionId: executionId(options, generatedAt) }).pipe(
      Effect.mapError((error) =>
        isMigrateError(error) ? error : make("io", "the migration flow could not run", String(error))
      )
    )
    if (options.mode !== "apply") return yield* execute
    // A refusal already established by the read-only survey must leave no
    // lock state behind. The flow repeats these gates under the lock, so this
    // early check never authorizes a tree that changed after the survey.
    yield* Gate.evaluate(surveyed.scan, options)
    if (surveyed.outlines.length > 0) {
      yield* VcsInternal.requireCheckpoint(
        options.root,
        `${options.root}/${Options.reportDir(options)}/backup`,
        options.allowNoVcs === true
      )
    }
    yield* MigrateFlow.validateSeal({ options, seal: surveyed.seal })
    return yield* Effect.acquireUseRelease(
      Lock.acquire({ root: options.root, reportDir: Options.reportDir(options) }),
      (lock) =>
        Effect.flatMap(execute, (report) =>
          lock.reclaimed === undefined
            ? Effect.succeed(report)
            : noteReclaimedLock(options, lock.reclaimed, report)),
      (lock) => Lock.release(lock)
    )
  })

/**
 * Everything a migration needs on Node, derived from the project itself.
 *
 * The composition has to know two things the caller does not: which paths hold
 * 0.x run state, so the grant store can deny every write to them, and which
 * commands verify a unit, so the agent can run them before it answers. Both
 * come from a read-only scan, which is why this layer is effectful and fails
 * with the scanner's own error.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerNode = (config: {
  readonly root: string
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly seat?: string | undefined
  readonly flowsDir?: string | undefined
  readonly reportDir?: string | undefined
  readonly state?: Options.State | undefined
  readonly commands?: Units.CommandOverrides | undefined
}) =>
  Layers.layerNodeScanned({
    root: config.root,
    ...(config.evaluator === undefined ? {} : { evaluator: config.evaluator }),
    ...(config.environment === undefined ? {} : { environment: config.environment }),
    ...(config.seat === undefined ? {} : { seat: config.seat }),
    ...(config.flowsDir === undefined ? {} : { flowsDir: config.flowsDir }),
    ...(config.reportDir === undefined ? {} : { reportDir: config.reportDir }),
    ...(config.state === undefined ? {} : { state: config.state }),
    ...(config.commands === undefined ? {} : { commands: config.commands })
  })

/**
 * The migration's own registrations, for a host that already has an engine.
 *
 * A host such as `@smthrs/flows`' `NodeRuntime` can compose this as its
 * `registerFlows` layer after supplying {@link Requirements}. It does not
 * create a control-plane route. Invoke {@link launch} with a survey so the
 * enriched payload and apply lock surround the execution; directly executing
 * the underlying flow bypasses that lock.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const registration: typeof MigrateFlow.layer = MigrateFlow.layer

/**
 * The process exit status one report implies. Exit 3 is "parked": the project
 * is intact and the operator has a decision to make.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const exitCode = (report: Report.MigrationReport): 0 | 1 | 3 => report.exitCode

const count = (label: string, total: number): string => `${total} ${label}${total === 1 ? "" : "s"}`

/**
 * Renders a report for a person or for a script.
 *
 * The human rendering is a summary, not the report: `report.md` is the report,
 * and the last line says where it is.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const render = (
  report: Report.MigrationReport,
  format: "human" | "json",
  reportDirectory?: string
): string => {
  if (format === "json") return Report.toJson(report)
  const byStatus = (status: Report.UnitReport["status"]): number =>
    report.units.filter((unit) => unit.status === status).length
  const lines: Array<string> = [
    `smthrs migrate ${report.mode}: ${report.root}`,
    "",
    `Units: ${byStatus("planned")} planned, ${byStatus("migrated")} migrated, ${byStatus("failed")} failed, ${
      byStatus("blocked")
    } blocked.`,
    `Constructs: ${count("row", report.inventory.length)} across ${count("mapping decision", report.mapping.length)}.`,
    `Run state: ${report.runState.verdict}.`
  ]
  if (report.runState.instructions.length > 0) {
    lines.push("", "Run state the operator owns:")
    for (const instruction of report.runState.instructions) lines.push(`  - ${instruction}`)
  }
  const must = report.followUps.filter((entry) => entry.severity === "must")
  if (must.length > 0) {
    lines.push("", `Must be settled by a person (${must.length}):`)
    for (const entry of must.slice(0, 10)) lines.push(`  - ${entry.text}`)
    if (must.length > 10) lines.push(`  ... and ${must.length - 10} more in the report`)
  }
  lines.push(
    "",
    `${count("unresolved item", report.unresolved.length)}, ${
      count("unsupported construct", report.unsupported.length)
    }.`
  )
  if (reportDirectory !== undefined && report.mode !== "scan") {
    lines.push(`Report: ${reportDirectory}/report.md`)
  }
  lines.push(`Exit ${report.exitCode}.`)
  return lines.join("\n")
}

/**
 * The directory this run wrote its report into.
 *
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const reportDirectory = (options: MigrateOptions): string => `${options.root}/${Options.reportDir(options)}`

/**
 * Runs one migration under a Node composition built from the project itself,
 * and returns the report and the rendering the caller asked for.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const runNode = (
  options: MigrateOptions,
  config: {
    readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
    readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  } = {}
): Effect.Effect<Report.MigrationReport, MigrateError> => {
  try {
    return Effect.provide(
      run(options),
      options.mode !== "apply" ? Layers.layerPlan : layerNode({
        root: options.root,
        ...(config.evaluator === undefined ? {} : { evaluator: config.evaluator }),
        flowsDir: Options.flowsDir(options),
        reportDir: Options.reportDir(options),
        // The same state paths the flow's own scan reads, so the host's grant
        // rules deny the same run-state paths the report names.
        ...(options.state === undefined ? {} : { state: options.state }),
        ...(options.seat === undefined ? {} : { seat: options.seat }),
        ...(config.environment === undefined ? {} : { environment: config.environment }),
        // The host verifies and spawns with the same commands the units do.
        ...(options.commands === undefined ? {} : { commands: options.commands })
      })
    ).pipe(
      // The composition itself can refuse to build: the scan it derives the
      // grant rules from can fail, and so can the sandbox. Both are this tool
      // failing to start, which is an `io` failure with the cause attached
      // rather than a defect nobody can act on.
      Effect.mapError((error) =>
        isMigrateError(error) ? error : make("io", "the migration could not build its runtime", String(error))
      )
    )
  } catch (error) {
    if (error instanceof Evaluator.EvaluatorError) return Effect.fail(make("io", error.message))
    throw error
  }
}

/**
 * What the `smithers-migrate` bin and the `smithers migrate` verb parse into.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Flags {
  readonly root: string | undefined
  readonly scan: boolean
  readonly apply: boolean
  readonly seat: string | undefined
  readonly allowUnsafe: string | undefined
  readonly acknowledgeRunState: boolean
  readonly allowNoVcs: boolean
  readonly keepOldSources: boolean
  readonly unit: string | undefined
  readonly maxRepairRounds: number | undefined
  readonly reportDir: string | undefined
  readonly flowsDir: string | undefined
  /**
   * What the project really runs to verify itself, when the detection ladder
   * guessed wrong.
   *
   * The orchestrator verifies every unit with these commands after the agent
   * answers. A project whose checks live in a Makefile needs an override when
   * the detection ladder cannot derive them.
   *
   * `verifyTypecheck` is repeatable because a project can have several
   * tsconfigs. One empty value means "run no typecheck at all"; no value at all
   * means "keep what the project's own manifests imply".
   */
  readonly verifyInstall: string | undefined
  readonly verifyFormat: string | undefined
  readonly verifyTypecheck: ReadonlyArray<string> | undefined
  readonly verifyTest: string | undefined
}

const list = (value: string | undefined): ReadonlyArray<string> | undefined =>
  value === undefined ? undefined : value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")

/**
 * Turns parsed flags into the flow's payload.
 *
 * `--scan` wins over `--apply` when both are given: of two contradictory
 * instructions, the safer one is the one to obey.
 *
 * `environment` is where the three state paths come from (`SMITHERS_HOME`,
 * `HOME`, `TMPDIR`); nothing else in it reaches the payload.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const optionsOf = (
  flags: Flags,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>> = {}
): MigrateOptions => {
  const state = Options.stateOf(environment)
  const unsafe = flags.allowUnsafe
  const units = list(flags.unit)
  // One empty value is how a shell says "none": `--verify-typecheck ""` runs no
  // typecheck, where the flag's absence keeps whatever the project implies.
  const typecheck = flags.verifyTypecheck === undefined || flags.verifyTypecheck.length === 0
    ? undefined
    : flags.verifyTypecheck.filter((entry) => entry.trim() !== "")
  const commands = {
    ...(flags.verifyInstall === undefined ? {} : { install: flags.verifyInstall }),
    ...(flags.verifyFormat === undefined ? {} : { format: flags.verifyFormat }),
    ...(typecheck === undefined ? {} : { typecheck }),
    ...(flags.verifyTest === undefined ? {} : { test: flags.verifyTest })
  }
  return {
    // The CLI passes its positional target as both values, so an explicit path
    // must resolve from the process rather than treating that target as a base.
    root: resolve(flags.root ?? cwd),
    mode: flags.scan ? "scan" : flags.apply ? "apply" : "plan",
    ...(flags.seat === undefined ? {} : { seat: flags.seat }),
    ...(unsafe === undefined
      ? {}
      : { allowUnsafe: unsafe.trim() === "all" ? "all" as const : list(unsafe) ?? [] }),
    ...(flags.acknowledgeRunState ? { acknowledgeRunState: true } : {}),
    ...(flags.allowNoVcs ? { allowNoVcs: true } : {}),
    ...(flags.keepOldSources ? { keepOldSources: true } : {}),
    ...(units === undefined ? {} : { units }),
    ...(flags.maxRepairRounds === undefined ? {} : { maxRepairRounds: flags.maxRepairRounds }),
    ...(flags.reportDir === undefined ? {} : { reportDir: flags.reportDir }),
    ...(flags.flowsDir === undefined ? {} : { layout: { flowsDir: flags.flowsDir } }),
    ...(Object.keys(commands).length === 0 ? {} : { commands }),
    ...(state === undefined ? {} : { state })
  }
}
