/**
 * `smthrs doctor`: the one command that answers "why did that not work?"
 * without running anything.
 *
 * Every check here is a thing an operator has been surprised by: a flow
 * directory that discovers nothing, a database that is not where they thought,
 * a Node build below the durable engine's floor, `jj` missing from a `PATH`
 * that has it interactively, a provider key that is exported but empty, and
 * Smithers 0.x state beside a project that has already moved on.
 *
 * The report is data, not text. `--json` prints it verbatim, the human
 * rendering is one line per check, and nothing about a check's outcome is
 * decided by the renderer.
 *
 * @since 1.0.0
 */

import * as Migrations from "@smthrs/database/Migrations"
import { existsSync, readdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import * as Environment from "./Environment.ts"
import * as Failure from "./internal/Failure.ts"
import { hasTable } from "./internal/SqliteTable.ts"
import * as Legacy from "./Legacy.ts"
import * as NodeControl from "./NodeControl.ts"
import * as Project from "./Project.ts"
import { starterSeats } from "./Providers.ts"
import * as Ui from "./Ui.ts"

/**
 * The outcome of one check.
 *
 * `warn` is a fact the operator should know and that stops nothing; `fail` is
 * a fact that will stop the next command they run.
 *
 * @category models
 * @since 1.0.0
 */
export type Level = "ok" | "warn" | "fail"

/**
 * One line of the report.
 *
 * @category models
 * @since 1.0.0
 */
export type Check = Ui.Check

/**
 * The whole report.
 *
 * @category models
 * @since 1.0.0
 */
export interface Report {
  readonly root: string
  readonly checks: ReadonlyArray<Check>
}

/**
 * The minimum Node the durable engine runs on (the release policy).
 *
 * @category constants
 * @since 1.0.0
 */
export const minimumNode = "26.4.0"

/**
 * Node versions supported by the CLI and its runtime dependencies.
 *
 * @category constants
 * @since 1.0.0
 */
export const supportedNodeRange = ">=26.4.0"

const order = (version: string): ReadonlyArray<number> | undefined => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (match === null) return undefined
  const parts = match.slice(1).map(Number)
  return parts.every(Number.isSafeInteger) ? parts : undefined
}

const atLeast = (actual: ReadonlyArray<number>, floor: ReadonlyArray<number>): boolean => {
  for (let index = 0; index < floor.length; index++) {
    const left = actual[index] ?? 0
    const right = floor[index]!
    if (left !== right) return left > right
  }
  return true
}

/**
 * Whether a Node version is supported and satisfies an optional higher floor.
 *
 * @category predicates
 * @since 1.0.0
 */
export const satisfiesNode = (version: string, minimum: string = minimumNode): boolean => {
  const actual = order(version)
  const required = order(minimum)
  if (actual === undefined || required === undefined) return false
  return atLeast(actual, order(minimumNode)!) && atLeast(actual, required)
}

/** How many migrations one database file has recorded, or a reason it cannot say. */
const ladder = (file: string): Check => {
  if (!existsSync(file)) return { name: `database ${file}`, level: "ok", detail: "not created yet" }
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(file, { readOnly: true })
    // `@smthrs/database` owns the name, so a rename there fails to compile
    // here rather than turning every database into "not created by Smithers".
    if (!hasTable(database, Migrations.table)) {
      return {
        name: `database ${file}`,
        level: "warn",
        detail: `no ${Migrations.table} table; this file was not created by Smithers 1.0`
      }
    }
    const row = database
      .prepare(`SELECT COUNT(*) AS applied, MAX(migration_id) AS latest FROM ${Migrations.table}`)
      .get() as Record<string, unknown> | undefined
    // SQLite aggregate queries always return exactly one row.
    const applied = Number(row!["applied"])
    const latest = row!["latest"] ?? "none"
    return { name: `database ${file}`, level: "ok", detail: `${applied} migrations applied, latest ${latest}` }
  } catch (error) {
    return {
      name: `database ${file}`,
      level: "fail",
      detail: Failure.operatorSentence(error)
    }
  } finally {
    database?.close()
  }
}

interface DiscoveredFlow {
  readonly flowId: string
  readonly description: string
}

interface DiscoveryWarning {
  readonly code: string
  readonly path: string
  readonly message: string
  readonly name?: string | undefined
}

const discoveredOnDisk = (directory: string): { readonly flows: number; readonly skipped: number } => {
  let flows = 0
  let skipped = 0
  const visit = (parent: string): void => {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const child = `${parent}/${entry.name}`
      if (
        existsSync(`${child}/flow.ts`) ||
        existsSync(`${child}/flow.mdx`) ||
        existsSync(`${child}/SKILL.md`)
      ) {
        flows += 1
      } else {
        skipped += 1
      }
      visit(child)
    }
  }
  visit(directory)
  return { flows, skipped }
}

/** Every flow real discovery found, with a recursive filesystem fallback. */
const registry = (
  root: string,
  discoveredFlows: ReadonlyArray<DiscoveredFlow> | undefined,
  discoveryFailure: string | undefined
): Check => {
  if (discoveryFailure !== undefined) return { name: "registry", level: "fail", detail: discoveryFailure }
  const directory = Project.flowsDirectory(root)
  if (discoveredFlows !== undefined) {
    return discoveredFlows.length === 0
      ? {
        name: "registry",
        level: "warn",
        detail: `${directory} yielded no discovered flows; discovery finds nothing`
      }
      : { name: "registry", level: "ok", detail: `${discoveredFlows.length} flows discovered` }
  }
  if (!existsSync(directory)) {
    return {
      name: "registry",
      level: "warn",
      detail: `no ${directory}; run \`smthrs init\` to scaffold one`
    }
  }
  const found = discoveredOnDisk(directory)
  if (found.flows === 0) {
    return {
      name: "registry",
      level: "warn",
      detail: `${directory} holds no flow.ts, flow.mdx, or SKILL.md; discovery finds nothing`
    }
  }
  return {
    name: "registry",
    level: "ok",
    detail: found.skipped === 0
      ? `${found.flows} flows discovered`
      : `${found.flows} flows discovered, ${found.skipped} directories skipped with no flow body`
  }
}

/** Which provider credentials are present, and which are exported but empty. */
const providers = (environment: Environment.Source): Check => {
  const variables = starterSeats.map(([variable]) => variable)
  const present = variables.filter((variable) => (environment[variable] ?? "") !== "")
  const blank = variables.filter((variable) => environment[variable] === "")
  const auth = Environment.read(environment, "SMITHERS_OPENAI_AUTH")
  const chatgpt = auth === "chatgpt" ? "; openai seats use the ChatGPT session" : ""
  if (present.length === 0) {
    return {
      name: "providers",
      level: "warn",
      detail: `no provider key set${blank.length === 0 ? "" : ` (${blank.join(", ")} exported but empty)`}`
    }
  }
  return {
    name: "providers",
    level: "ok",
    detail: `${present.join(", ")}${blank.length === 0 ? "" : `; ${blank.join(", ")} exported but empty`}${chatgpt}`
  }
}

/**
 * Arguments accepted by {@link inspect}. Every host fact is a parameter so the
 * report is deterministic in a test.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly root: string
  /**
   * The descriptors returned by the same control listing as `smthrs ls`.
   * When present, including as an empty list, this authoritative discovery
   * result replaces the filesystem fallback.
   */
  readonly discoveredFlows?: ReadonlyArray<DiscoveredFlow> | undefined
  /** Why discovery produced no registry; replaces every other registry fact. */
  readonly discoveryFailure?: string | undefined
  /** Diagnostics returned by the same registry snapshot as discoveredFlows. */
  readonly discoveryWarnings?: ReadonlyArray<DiscoveryWarning> | undefined
  readonly environment?: Environment.Source | undefined
  readonly nodeVersion?: string | undefined
  readonly jj?: { readonly path: string; readonly executable: boolean; readonly hint?: string | undefined } | undefined
  readonly cwd?: string | undefined
  /**
   * The 0.x state found when the invocation started. The caller samples it,
   * because by the time a command runs its own control database has created
   * `<root>/.flows` and `Project.legacyState` would report nothing.
   */
  readonly legacyPaths?: ReadonlyArray<string> | undefined
}

/**
 * Runs every check and returns the report.
 *
 * @category constructors
 * @since 1.0.0
 */
export const inspect = (options: Options): Report => {
  const environment = options.environment ?? process.env
  const nodeVersion = options.nodeVersion ?? process.versions.node
  const checks: Array<Check> = [registry(options.root, options.discoveredFlows, options.discoveryFailure)]

  for (const warning of options.discoveryWarnings ?? []) {
    checks.push({
      name: `registry ${warning.path}`,
      level: "warn",
      detail: `${warning.code}: ${warning.message}`
    })
  }

  checks.push({
    name: "state",
    level: "ok",
    detail: existsSync(Project.stateDirectory(options.root))
      ? Project.stateDirectory(options.root)
      : `${Project.stateDirectory(options.root)} (not created yet)`
  })
  checks.push(ladder(NodeControl.databasePath(options.root)))
  checks.push(ladder(NodeControl.executionDatabasePath(options.root)))

  checks.push({
    name: "node",
    level: satisfiesNode(nodeVersion) ? "ok" : "fail",
    detail: satisfiesNode(nodeVersion)
      ? `v${nodeVersion.replace(/^v/, "")}`
      : `v${nodeVersion.replace(/^v/, "")} is unsupported; use Node 26.4+`
  })

  if (options.jj !== undefined) {
    checks.push({
      name: "jj",
      level: options.jj.executable ? "ok" : "warn",
      detail: options.jj.executable ? options.jj.path : options.jj.hint ?? "not found"
    })
  }

  checks.push(providers(environment))

  const backend = Environment.unsupportedBackend(Environment.read(environment, "SMITHERS_BACKEND"))
  if (backend !== undefined) checks.push({ name: "backend", level: "fail", detail: backend })

  // Two sources, because the 0.x-project guard gates them differently. The markers are
  // the notice's paths and stop at a directory that already holds `.flows/`.
  // The databases are the refusal's input and do not, so doctor keeps
  // answering "what does the old database still hold?" for a project that
  // has already started running rc.0 commands.
  const markers = options.legacyPaths ?? Project.legacyState(options.cwd ?? options.root)
  const databases = Project.legacyDatabases(options.cwd ?? options.root)
  const reported = new Set<string>()
  for (const path of [...markers, ...databases]) {
    if (reported.has(path)) continue
    reported.add(path)
    const detail = path.endsWith("smithers.db")
      ? describeLegacyDatabase(path)
      : Project.legacyNotice(path)
    checks.push({ name: "smithers 0.x", level: "warn", detail })
  }

  return { root: options.root, checks }
}

/** The 0.x notice, plus what the database still holds. */
const describeLegacyDatabase = (path: string): string => {
  const database = Legacy.read(path)
  if (!database.readable) return `${Project.legacyNotice(path)} (unreadable: ${database.reason!})`
  if (database.runs.length === 0) return `${Project.legacyNotice(path)} (no non-terminal runs)`
  return `${Project.legacyNotice(path)} (${database.runs.length} non-terminal runs)`
}

/**
 * The human rendering: one line per check.
 *
 * @category conversions
 * @since 1.0.0
 */
export const render = (report: Report): string =>
  Ui.renderChecklist(`smthrs doctor: ${report.root}`, report.checks, { interactive: false })

/**
 * Whether the report contains a failing check, which decides the exit status.
 *
 * @category predicates
 * @since 1.0.0
 */
export const failed = (report: Report): boolean => report.checks.some((check) => check.level === "fail")
