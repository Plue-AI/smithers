/**
 * The migration report: its schema, its writers, and its Markdown renderer.
 *
 * The report is the product. It says what the tool found, what it changed,
 * what it could not translate, and what a person still has to decide. The
 * Markdown is deterministic for a given JSON — every list is sorted and no
 * field carries a clock except `generatedAt` — so two runs of the same scan
 * diff cleanly and a reviewer sees only what actually changed.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import type { Detection } from "./Detect.ts"
import * as Fs from "./internal/Fs.ts"
import * as Sort from "./internal/Sort.ts"
import type { InventoryEntry } from "./Inventory.ts"
import type { MappingClass } from "./Mapping.ts"
import { io, type MigrateError } from "./MigrateError.ts"
import type { RunStateReport } from "./RunState.ts"

/**
 * The mode the tool ran in.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Mode = Schema.Literals(["scan", "plan", "apply"])

/**
 * The mode the tool ran in.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Mode = typeof Mode.Type

/**
 * One command the verification step ran.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const CommandResult = Schema.Struct({
  command: Schema.String,
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  /**
   * The last 12 KB the command wrote to stdout.
   *
   * The verification step passes it through the journal's shared redaction
   * rules before it lands here, because the operator commits this report and
   * a failing install or test suite in a 0.x project can print a registry
   * token or a value read from `.env`. The rules match known credential
   * shapes only, so the Markdown still asks for a review beside the commands.
   */
  stdoutTail: Schema.String,
  /** The last 12 KB of stderr, redacted like {@link CommandResult.stdoutTail}. */
  stderrTail: Schema.String,
  skipped: Schema.optional(Schema.String)
})

/**
 * One command the verification step ran.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type CommandResult = typeof CommandResult.Type

/**
 * What verification did. `typecheck` is an array because a project can have
 * more than one `tsconfig.json` covering the changed files; every other step
 * runs at most once.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const VerificationResult = Schema.Struct({
  install: Schema.optional(CommandResult),
  format: Schema.optional(CommandResult),
  typecheck: Schema.Array(CommandResult),
  tests: Schema.optional(CommandResult),
  discovery: Schema.optional(CommandResult)
})

/**
 * What verification did.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type VerificationResult = typeof VerificationResult.Type

/**
 * The class the tool assigned a construct, and who decided it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const MappingDecision = Schema.Struct({
  construct: Schema.String,
  target: Schema.NullOr(Schema.String),
  rule: Schema.String,
  class: Schema.Literals(["automatic", "guided", "unsafe"]),
  decidedBy: Schema.Literals(["scanner", "agent", "operator"]),
  reason: Schema.optional(Schema.String),
  unit: Schema.optional(Schema.String),
  occurrences: Schema.Number
})

/**
 * The class the tool assigned a construct.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type MappingDecision = typeof MappingDecision.Type

/**
 * One inventory row, as the report carries it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const InventoryRow = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  construct: Schema.String,
  props: Schema.Array(Schema.String),
  class: Schema.Literals(["automatic", "guided", "unsafe"])
})

/**
 * One inventory row.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type InventoryRow = typeof InventoryRow.Type

/**
 * One file the migration touched.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const ChangedFile = Schema.Struct({
  path: Schema.String,
  change: Schema.Literals(["added", "modified", "deleted", "archived"]),
  bytes: Schema.Number
})

/**
 * One file the migration touched.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ChangedFile = typeof ChangedFile.Type

/**
 * A choice the migration made that a reader should check.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Decision = Schema.Struct({
  construct: Schema.String,
  choice: Schema.String,
  reason: Schema.String,
  file: Schema.String,
  line: Schema.Number
})

/**
 * A choice the migration made.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Decision = typeof Decision.Type

/**
 * Something the migration left for a person, with the change that would settle
 * it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const UnresolvedEntry = Schema.Struct({
  construct: Schema.String,
  reason: Schema.String,
  file: Schema.String,
  line: Schema.Number,
  suggestion: Schema.String,
  unit: Schema.optional(Schema.String)
})

/**
 * Something the migration left for a person.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type UnresolvedEntry = typeof UnresolvedEntry.Type

/**
 * A construct with no counterpart, and the closest composition there is.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const UnsupportedEntry = Schema.Struct({
  construct: Schema.String,
  reason: Schema.String,
  file: Schema.String,
  line: Schema.Number,
  closest: Schema.String,
  unit: Schema.optional(Schema.String)
})

/**
 * A construct with no counterpart.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type UnsupportedEntry = typeof UnsupportedEntry.Type

/**
 * The checkpoint a unit can be restored to.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Checkpoint = Schema.Struct({
  vcs: Schema.Literals(["jj", "git", "none"]),
  ref: Schema.String,
  restore: Schema.String
})

/**
 * The checkpoint a unit can be restored to.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Checkpoint = typeof Checkpoint.Type

/**
 * One migration unit's outcome.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const UnitReport = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["dependencies", "workflow", "integration", "project"]),
  sources: Schema.Array(Schema.String),
  targets: Schema.Array(Schema.String),
  status: Schema.Literals(["planned", "skipped", "blocked", "migrated", "failed"]),
  checkpoint: Schema.optional(Checkpoint),
  changedFiles: Schema.Array(ChangedFile),
  decisions: Schema.Array(Decision),
  unresolved: Schema.Array(UnresolvedEntry),
  unsupported: Schema.Array(UnsupportedEntry),
  verification: Schema.optional(VerificationResult),
  repairRounds: Schema.Number,
  durationMs: Schema.Number
})

/**
 * One migration unit's outcome.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type UnitReport = typeof UnitReport.Type

/**
 * The project as the report carries it: everything `Detect` found, minus the
 * file contents it read to find it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const ProjectDetection = Schema.Struct({
  manifests: Schema.Array(Schema.Struct({
    path: Schema.String,
    kind: Schema.String,
    oldPackages: Schema.Array(Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      field: Schema.String,
      reason: Schema.String
    })),
    companions: Schema.Array(Schema.Struct({ name: Schema.String, version: Schema.String, field: Schema.String }))
  })),
  lockfiles: Schema.Array(Schema.String),
  packageManager: Schema.optional(Schema.String),
  effectPin: Schema.optional(Schema.String),
  tsconfigs: Schema.Array(Schema.Struct({
    path: Schema.String,
    jsx: Schema.optional(Schema.String),
    jsxImportSource: Schema.optional(Schema.String),
    paths: Schema.Array(Schema.String)
  })),
  pragmas: Schema.Array(Schema.Struct({ file: Schema.String, line: Schema.Number, text: Schema.String })),
  workflowFiles: Schema.Array(Schema.Struct({ path: Schema.String, kind: Schema.String, api: Schema.String })),
  prompts: Schema.Array(Schema.Struct({ path: Schema.String, classification: Schema.String })),
  components: Schema.Array(Schema.String),
  uis: Schema.Array(Schema.Struct({ path: Schema.String, resolved: Schema.Boolean })),
  tests: Schema.Array(Schema.String),
  libs: Schema.Array(Schema.String),
  scripts: Schema.Array(Schema.Struct({
    file: Schema.String,
    line: Schema.Number,
    text: Schema.String,
    kind: Schema.String
  })),
  config: Schema.Array(Schema.Struct({ kind: Schema.String, path: Schema.String, detail: Schema.String })),
  integrations: Schema.Array(Schema.Struct({
    file: Schema.String,
    line: Schema.Number,
    integration: Schema.String,
    kind: Schema.String
  })),
  globalState: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.Struct({ code: Schema.String, file: Schema.String, message: Schema.String }))
})

/**
 * The project as the report carries it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ProjectDetection = typeof ProjectDetection.Type

/**
 * One non-terminal run the report names.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const RunStateRun = Schema.Struct({
  runId: Schema.String,
  workflowName: Schema.String,
  status: Schema.String,
  heartbeatAtMs: Schema.optional(Schema.Number)
})

/**
 * The run state as the report carries it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const RunStateSummary = Schema.Struct({
  verdict: Schema.Literals(["clean", "history-only", "blocked"]),
  databases: Schema.Array(Schema.Struct({
    path: Schema.String,
    readable: Schema.Boolean,
    migrations: Schema.Number,
    runsByStatus: Schema.Array(Schema.Struct({ status: Schema.String, count: Schema.Number })),
    live: Schema.Array(RunStateRun),
    parked: Schema.Array(RunStateRun)
  })),
  postgres: Schema.Array(Schema.String),
  pglite: Schema.Array(Schema.String),
  stateDirs: Schema.Array(Schema.Struct({ path: Schema.String, files: Schema.Number, bytes: Schema.Number })),
  gatewayState: Schema.Array(Schema.String),
  instructions: Schema.Array(Schema.String)
})

/**
 * The run state as the report carries it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type RunStateSummary = typeof RunStateSummary.Type

/**
 * A manual follow-up the operator owns.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const FollowUp = Schema.Struct({
  severity: Schema.Literals(["must", "should", "info"]),
  text: Schema.String,
  unit: Schema.optional(Schema.String)
})

/**
 * A manual follow-up the operator owns.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type FollowUp = typeof FollowUp.Type

/**
 * The whole report.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export class MigrationReport extends Schema.Class<MigrationReport>("@smthrs/migrate/MigrationReport")({
  version: Schema.Literal(1),
  tool: Schema.Struct({ name: Schema.String, version: Schema.String }),
  generatedAt: Schema.String,
  root: Schema.String,
  mode: Mode,
  exitCode: Schema.Literals([0, 1, 3]),
  project: ProjectDetection,
  runState: RunStateSummary,
  inventory: Schema.Array(InventoryRow),
  mapping: Schema.Array(MappingDecision),
  units: Schema.Array(UnitReport),
  verification: Schema.optional(VerificationResult),
  unresolved: Schema.Array(UnresolvedEntry),
  unsupported: Schema.Array(UnsupportedEntry),
  followUps: Schema.Array(FollowUp)
}) {}

/**
 * The tool's own name and version, as the report records them.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const tool = { name: "@smthrs/migrate", version: "1.0.0-rc.1" } as const

/**
 * Projects a {@link Detection} into the report's project section.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const project = (detection: Detection): ProjectDetection => {
  const config: Array<{ kind: string; path: string; detail: string }> = []
  const settings = detection.config
  if (settings.smithersConfig !== undefined) {
    config.push({
      kind: "smithers.config",
      path: settings.smithersConfig.path,
      detail: `backend=${settings.smithersConfig.backend ?? "unset"} repoCommands=${
        [...settings.smithersConfig.repoCommands.keys()].sort().join(",") || "none"
      }`
    })
  }
  for (const path of settings.agents) config.push({ kind: "agents", path, detail: "agent pool" })
  for (const entry of settings.preload) {
    config.push({ kind: "preload", path: entry.path, detail: entry.mdxPlugin ? "calls mdxPlugin()" : "no mdxPlugin" })
  }
  for (const entry of settings.bunfig) {
    config.push({ kind: "bunfig", path: entry.path, detail: `preload=${entry.preload.join(",") || "none"}` })
  }
  for (
    const [kind, paths] of [
      ["gateway", settings.gateway],
      ["toon", settings.toon],
      ["listeners", settings.listeners],
      ["packs", settings.packs],
      ["asset-types", settings.assetTypes],
      ["gitignore", settings.gitignore],
      ["skills", settings.skills],
      ["evals", settings.evals]
    ] as const
  ) {
    for (const path of paths) config.push({ kind, path, detail: "" })
  }

  return {
    manifests: detection.manifests.map((manifest) => ({
      path: manifest.path,
      kind: manifest.kind,
      oldPackages: manifest.oldPackages.map((entry) => ({ ...entry })),
      companions: manifest.companions.map((entry) => ({ ...entry }))
    })),
    lockfiles: [...detection.lockfiles].sort(),
    ...(detection.packageManager === undefined ? {} : { packageManager: detection.packageManager }),
    ...(detection.effectPin === undefined ? {} : { effectPin: detection.effectPin }),
    tsconfigs: detection.tsconfigs.map((entry) => ({
      path: entry.path,
      ...(entry.jsx === undefined ? {} : { jsx: entry.jsx }),
      ...(entry.jsxImportSource === undefined ? {} : { jsxImportSource: entry.jsxImportSource }),
      paths: entry.paths
    })),
    pragmas: detection.pragmas.map((hit) => ({ file: hit.file, line: hit.line, text: hit.text })),
    workflowFiles: detection.workflowFiles.map((entry) => ({ path: entry.path, kind: entry.kind, api: entry.api })),
    prompts: detection.prompts.map((entry) => ({ path: entry.path, classification: entry.classification })),
    components: [...detection.components].sort(),
    uis: detection.uis.map((entry) => ({ path: entry.path, resolved: entry.resolved })),
    tests: [...detection.tests].sort(),
    libs: [...detection.libs].sort(),
    scripts: [...detection.scripts]
      .map((hit) => ({ file: hit.file, line: hit.line, text: hit.text, kind: hit.kind }))
      .sort((left, right) =>
        Sort.byText(left.file, right.file) || left.line - right.line || Sort.byText(left.text, right.text)
      ),
    config: config.sort((left, right) => Sort.byText(left.kind, right.kind) || Sort.byText(left.path, right.path)),
    integrations: [...detection.integrations]
      .map((hit) => ({ file: hit.file, line: hit.line, integration: hit.integration, kind: hit.kind }))
      .sort((left, right) => Sort.byText(left.file, right.file) || left.line - right.line),
    globalState: [...detection.globalState].sort(),
    warnings: [...detection.warnings]
      .map((warning) => ({ code: warning.code, file: warning.file, message: warning.message }))
      .sort((left, right) => Sort.byText(left.code, right.code) || Sort.byText(left.file, right.file))
  }
}

const summaryRun = (
  row: { runId: string; workflowName: string; status: string; heartbeatAtMs: number | undefined }
) => ({
  runId: row.runId,
  workflowName: row.workflowName,
  status: row.status,
  ...(row.heartbeatAtMs === undefined ? {} : { heartbeatAtMs: row.heartbeatAtMs })
})

/**
 * Projects a {@link RunStateReport} into the report's run-state section.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const runState = (report: RunStateReport): RunStateSummary => ({
  verdict: report.verdict,
  databases: report.databases.map((database) => ({
    path: database.path,
    readable: database.readable,
    migrations: database.migrations.count,
    runsByStatus: database.runsByStatus.map((entry) => ({ ...entry })),
    live: database.live.map(summaryRun),
    parked: database.parked.map(summaryRun)
  })),
  postgres: (report.postgres?.sources ?? []).map((entry) => `${entry.file}: ${entry.text}`),
  pglite: (report.pglite?.sources ?? []).map((entry) => `${entry.file}: ${entry.text}`),
  stateDirs: report.stateDirs.map((entry) => ({ path: entry.path, files: entry.files, bytes: entry.bytes })),
  gatewayState: [...report.gatewayState].sort(),
  instructions: report.instructions
})

/**
 * An empty report for one project and mode. Every scan starts here.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const empty = (root: string, mode: Mode, generatedAt: string): MigrationReport =>
  new MigrationReport({
    version: 1,
    tool,
    generatedAt,
    root,
    mode,
    exitCode: 0,
    project: {
      manifests: [],
      lockfiles: [],
      tsconfigs: [],
      pragmas: [],
      workflowFiles: [],
      prompts: [],
      components: [],
      uis: [],
      tests: [],
      libs: [],
      scripts: [],
      config: [],
      integrations: [],
      globalState: [],
      warnings: []
    },
    runState: {
      verdict: "clean",
      databases: [],
      postgres: [],
      pglite: [],
      stateDirs: [],
      gatewayState: [],
      instructions: []
    },
    inventory: [],
    mapping: [],
    units: [],
    unresolved: [],
    unsupported: [],
    followUps: []
  })

/** Compares two entries by file, then line, then construct. */
const bySite = (
  left: { readonly file: string; readonly line: number; readonly construct: string },
  right: { readonly file: string; readonly line: number; readonly construct: string }
): number =>
  Sort.byText(left.file, right.file) || left.line - right.line || Sort.byText(left.construct, right.construct)

/**
 * Puts one unit's arrays in a canonical order.
 *
 * A report is an audit artifact, so two runs that found the same things have to
 * render the same bytes. Nothing else pins the order the caller collected these
 * in: a repair round appends, a second pass over the same file prepends, and
 * the Markdown would differ with no difference in what was found.
 */
const canonical = (unit: UnitReport): UnitReport => ({
  ...unit,
  sources: [...unit.sources].sort(Sort.byText),
  targets: [...unit.targets].sort(Sort.byText),
  changedFiles: [...unit.changedFiles].sort((left, right) => Sort.byText(left.path, right.path)),
  decisions: [...unit.decisions].sort(bySite),
  unresolved: [...unit.unresolved].sort(bySite),
  unsupported: [...unit.unsupported].sort(bySite)
})

/**
 * Adds or replaces one unit's outcome, keeping units in plan order.
 *
 * Every array inside the unit is put in a canonical order first, so a report
 * renders the same bytes whatever order the caller collected them in.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const withUnit = (report: MigrationReport, entry: UnitReport): MigrationReport => {
  const unit = canonical(entry)
  const units = report.units.some((existing) => existing.id === unit.id)
    ? report.units.map((existing) => (existing.id === unit.id ? unit : existing))
    : [...report.units, unit]
  return new MigrationReport({ ...report, units })
}

/**
 * Options for {@link finalize}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface FinalizeOptions {
  /**
   * Whether the operator passed `--acknowledge-run-state`.
   *
   * Without it, `apply` refuses a project that holds 0.x run state of any age.
   * A database with only finished runs still blocks, because a 1.0 runtime
   * cannot read it and the operator has to say what happens to it.
   */
  readonly acknowledgeRunState?: boolean | undefined
}

/**
 * Rolls the units up: the unresolved and unsupported unions, the follow-up
 * list, and the exit code.
 *
 * Exit 3 is "parked": the project is intact and the operator has a decision to
 * make. Exit 1 is a failure the tool could not repair. Exit 0 means every
 * planned unit finished.
 *
 * In `apply` mode both run-state verdicts park the run. `blocked` means a live
 * or parked run exists; `history-only` means the project still holds a 0.x
 * database or state directory whose runs have all finished. Neither can be
 * migrated, so both require `--acknowledge-run-state`.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const finalize = (report: MigrationReport, options: FinalizeOptions = {}): MigrationReport => {
  const unresolved = report.units
    .flatMap((unit) => unit.unresolved.map((entry) => ({ ...entry, unit: unit.id })))
    .sort((left, right) => Sort.byText(left.file, right.file) || left.line - right.line)
  const unsupported = report.units
    .flatMap((unit) => unit.unsupported.map((entry) => ({ ...entry, unit: unit.id })))
    .sort((left, right) => Sort.byText(left.file, right.file) || left.line - right.line)

  const followUps: Array<FollowUp> = []
  for (const line of report.runState.instructions) {
    followUps.push({ severity: "must", text: line })
  }
  for (const entry of unsupported) {
    followUps.push({
      severity: "must",
      text: `${entry.construct} at ${entry.file}:${entry.line} has no counterpart: ${entry.closest}`,
      unit: entry.unit
    })
  }
  for (const entry of unresolved) {
    followUps.push({
      severity: "should",
      text: `${entry.construct} at ${entry.file}:${entry.line}: ${entry.suggestion}`,
      unit: entry.unit
    })
  }
  for (const unit of report.units) {
    if (unit.status === "failed") {
      followUps.push({ severity: "must", text: `unit ${unit.id} failed verification and was restored`, unit: unit.id })
    }
    if (unit.status === "blocked") {
      followUps.push({ severity: "must", text: `unit ${unit.id} is blocked and was not attempted`, unit: unit.id })
    }
  }

  const runStateBlocks = options.acknowledgeRunState !== true &&
    (report.runState.verdict === "blocked" || report.runState.verdict === "history-only")
  const blocked = runStateBlocks || report.units.some((unit) => unit.status === "blocked")
  const failed = report.units.some((unit) => unit.status === "failed")
  const exitCode: 0 | 1 | 3 = failed ? 1 : blocked && report.mode === "apply" ? 3 : 0

  return new MigrationReport({ ...report, unresolved, unsupported, followUps, exitCode })
}

/**
 * The report as canonical JSON, with a trailing newline.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const toJson = (report: MigrationReport): string =>
  `${JSON.stringify(Schema.encodeUnknownSync(MigrationReport)(report), null, 2)}\n`

const table = (headers: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> => {
  if (rows.length === 0) return ["None."]
  const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\n/g, " ")
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)
  ]
}

const commandLine = (name: string, result: CommandResult | undefined): string =>
  result === undefined
    ? `- ${name}: not run`
    : result.skipped !== undefined
    ? `- ${name}: skipped (${result.skipped})`
    : `- ${name}: \`${result.command}\` exited ${result.exitCode} in ${result.durationMs} ms`

/** Whether any command in a verification captured output into the report. */
const capturedOutput = (result: VerificationResult): boolean =>
  [result.install, result.format, ...result.typecheck, result.tests, result.discovery]
    .some((command) => command !== undefined && (command.stdoutTail !== "" || command.stderrTail !== ""))

/**
 * The sentence an operator has to read before committing the report.
 *
 * The docs tell them to review, then commit, the report, and `report.json`
 * beside it carries every command's last {@link CommandResult.stdoutTail}
 * bytes after the journal's redaction rules. Those rules match known
 * credential shapes only, so the report says so rather than pretending the
 * capture is safe.
 */
const captureWarning =
  "Command output is captured into `report.json`, up to the last 12 KB of each stream, with known credential shapes such as bearer tokens and `*_KEY=` values redacted. Review it before committing the report: the redaction rules cannot catch every secret."

const verificationLines = (result: VerificationResult | undefined): ReadonlyArray<string> => {
  if (result === undefined) return ["Not run."]
  return [
    commandLine("install", result.install),
    commandLine("format", result.format),
    ...(result.typecheck.length === 0
      ? ["- typecheck: not run"]
      : result.typecheck.map((entry) => commandLine("typecheck", entry))),
    commandLine("tests", result.tests),
    commandLine("discovery", result.discovery),
    ...(capturedOutput(result) ? ["", captureWarning] : [])
  ]
}

/**
 * The report as Markdown.
 *
 * The section order is fixed: `Summary`, `Run state and operator instructions`,
 * `Project detection`, `Construct inventory`, `Mapping decisions`, `Units`,
 * `Verification`, `Manual follow-ups`, and `Appendix: restoring a checkpoint`.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const toMarkdown = (report: MigrationReport): string => {
  const lines: Array<string> = []
  const heading = (text: string): void => {
    lines.push("", `## ${text}`, "")
  }

  lines.push(`# Smithers 0.x to 1.0 migration report`, "")
  lines.push(`Generated by ${report.tool.name} ${report.tool.version} at ${report.generatedAt}.`)

  heading("Summary")
  lines.push(...table(["Field", "Value"], [
    ["Project", report.root],
    ["Mode", report.mode],
    ["Exit code", String(report.exitCode)],
    ["Run state", report.runState.verdict],
    ["Workflow files", String(report.project.workflowFiles.length)],
    ["Constructs found", String(report.inventory.length)],
    ["Units", String(report.units.length)],
    ["Unresolved", String(report.unresolved.length)],
    ["Unsupported", String(report.unsupported.length)]
  ]))

  heading("Run state and operator instructions")
  if (report.runState.instructions.length === 0) {
    lines.push("No Smithers 0.x run state found. Nothing to finish, archive, or discard.")
  } else {
    lines.push("The 1.0 runtime cannot resume a 0.x run. Do these in order, then rerun the scan.", "")
    for (const [index, instruction] of report.runState.instructions.entries()) {
      lines.push(`${index + 1}. ${instruction}`)
    }
  }
  lines.push("")
  lines.push(...table(
    ["Database", "Readable", "Migrations", "Live", "Parked"],
    report.runState.databases.map((database) => [
      database.path,
      String(database.readable),
      String(database.migrations),
      database.live.map((run) => run.runId).join(", ") || "none",
      database.parked.map((run) => run.runId).join(", ") || "none"
    ])
  ))

  heading("Project detection")
  lines.push("### Packages", "")
  lines.push(...table(
    ["Manifest", "Package", "Version", "Field", "Why"],
    report.project.manifests.flatMap((manifest) =>
      manifest.oldPackages.map((entry) => [manifest.path, entry.name, entry.version, entry.field, entry.reason])
    )
  ))
  lines.push("", "### TypeScript configuration", "")
  lines.push(...table(
    ["tsconfig", "jsx", "jsxImportSource", "paths"],
    report.project.tsconfigs.map((entry) => [
      entry.path,
      entry.jsx ?? "",
      entry.jsxImportSource ?? "",
      entry.paths.join(", ")
    ])
  ))
  lines.push("", "### Workflow files", "")
  lines.push(...table(
    ["File", "Kind", "Authoring API"],
    report.project.workflowFiles.map((entry) => [entry.path, entry.kind, entry.api])
  ))
  lines.push("", "### Scripts and configuration", "")
  lines.push(...table(
    ["File", "Line", "Match", "Kind"],
    report.project.scripts.map((hit) => [hit.file, String(hit.line), hit.text, hit.kind])
  ))
  lines.push("", "### Integrations", "")
  lines.push(...table(
    ["File", "Line", "Integration", "Kind"],
    report.project.integrations.map((hit) => [hit.file, String(hit.line), hit.integration, hit.kind])
  ))
  if (report.project.warnings.length > 0) {
    lines.push("", "### Warnings", "")
    lines.push(...table(
      ["Code", "File", "Message"],
      report.project.warnings.map((warning) => [warning.code, warning.file, warning.message])
    ))
  }

  heading("Construct inventory")
  lines.push(...table(
    ["File", "Line", "Construct", "Props", "Class"],
    report.inventory.map((row) => [row.file, String(row.line), row.construct, row.props.join(" "), row.class])
  ))

  heading("Mapping decisions")
  lines.push(...table(
    ["Construct", "Target", "Class", "Uses", "Decided by", "Rule"],
    report.mapping.map((decision) => [
      decision.construct,
      decision.target ?? "none",
      decision.class,
      String(decision.occurrences),
      decision.decidedBy,
      decision.rule
    ])
  ))

  heading("Units")
  if (report.units.length === 0) lines.push("None.")
  for (const unit of report.units) {
    lines.push(`### ${unit.id}`, "")
    lines.push(`Kind: ${unit.kind}. Status: ${unit.status}. Repair rounds: ${unit.repairRounds}.`, "")
    if (unit.checkpoint !== undefined) {
      lines.push(`Checkpoint: ${unit.checkpoint.vcs} \`${unit.checkpoint.ref}\`.`, "")
    }
    lines.push("Sources:", "")
    for (const source of unit.sources) lines.push(`- \`${source}\``)
    lines.push("", "Targets:", "")
    for (const target of unit.targets) lines.push(`- \`${target}\``)
    lines.push("", "Changed files:", "")
    lines.push(...table(
      ["Path", "Change", "Bytes"],
      unit.changedFiles.map((file) => [file.path, file.change, String(file.bytes)])
    ))
    lines.push("", "Decisions:", "")
    lines.push(...table(
      ["Construct", "Choice", "Reason", "Where"],
      unit.decisions.map((decision) => [
        decision.construct,
        decision.choice,
        decision.reason,
        `${decision.file}:${decision.line}`
      ])
    ))
    lines.push("", "Unresolved:", "")
    lines.push(...table(
      ["Construct", "Reason", "Where", "Suggestion"],
      unit.unresolved.map((entry) => [entry.construct, entry.reason, `${entry.file}:${entry.line}`, entry.suggestion])
    ))
    lines.push("", "Unsupported:", "")
    lines.push(...table(
      ["Construct", "Reason", "Where", "Closest"],
      unit.unsupported.map((entry) => [entry.construct, entry.reason, `${entry.file}:${entry.line}`, entry.closest])
    ))
    lines.push("", "Verification:", "")
    lines.push(...verificationLines(unit.verification))
    lines.push("")
  }

  heading("Verification")
  lines.push(...verificationLines(report.verification))

  heading("Manual follow-ups")
  if (report.followUps.length === 0) lines.push("None.")
  for (const followUp of report.followUps) {
    lines.push(
      `- [ ] (${followUp.severity}) ${followUp.text}${followUp.unit === undefined ? "" : ` — ${followUp.unit}`}`
    )
  }

  heading("Appendix: restoring a checkpoint")
  const checkpoints = report.units.flatMap((unit) =>
    unit.checkpoint === undefined ? [] : [[unit.id, unit.checkpoint.vcs, unit.checkpoint.restore] as const]
  )
  lines.push(...table(["Unit", "VCS", "Command"], checkpoints.map((entry) => [entry[0], entry[1], `\`${entry[2]}\``])))

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`
}

/**
 * Writes `report.json` and `report.md` into `directory`.
 *
 * Both land atomically: the report is the file a person opens first after a
 * run that went wrong, and that is exactly the run whose last write may have
 * been cut in half.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const write = (
  directory: string,
  report: MigrationReport
): Effect.Effect<ReadonlyArray<string>, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(directory, { recursive: true })
    const json = `${directory}/report.json`
    const markdown = `${directory}/report.md`
    yield* Fs.writeAtomic(json, toJson(report))
    yield* Fs.writeAtomic(markdown, toMarkdown(report))
    return [json, markdown]
  }).pipe(Effect.mapError(io(`could not write the report into "${directory}"`)))

/**
 * The inventory rows the report carries, with each hit's class.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const inventory = (
  hits: ReadonlyArray<InventoryEntry>,
  classify: (hit: InventoryEntry) => MappingClass
): ReadonlyArray<InventoryRow> =>
  hits.map((hit) => ({
    file: hit.file,
    line: hit.line,
    column: hit.column,
    construct: hit.construct,
    props: hit.props,
    class: classify(hit)
  }))
