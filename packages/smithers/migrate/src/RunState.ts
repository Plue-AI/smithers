/**
 * Read-only detection of live and persisted Smithers 0.x run state.
 *
 * This module never opens a database in write mode, never runs a migration,
 * never deletes a file, and never connects to Postgres. It reports what is
 * there and hands the operator the instruction that clears it.
 *
 * There is one rule for both non-clean verdicts. `apply` refuses to touch a
 * project whose verdict is `blocked` or `history-only` until the operator
 * passes `--acknowledge-run-state`, and even then the tool writes nothing under
 * any path this module records. `history-only` blocks because a database whose
 * runs have all finished is still 0.x run state: a 1.0 runtime cannot read it,
 * so the operator has to archive or discard it deliberately.
 *
 * A 1.0 runtime cannot resume a 0.x run. That is why the answer is always
 * "finish, archive, or discard it", never "convert it".
 *
 * @since 1.0.0-rc.0
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { posix, win32 } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Detection } from "./Detect.ts"
import * as Fs from "./internal/Fs.ts"
import type { MigrateError } from "./MigrateError.ts"

/**
 * Run statuses that mean the run is over. Everything else is either running or
 * parked, and both block a migration.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const terminalStatuses: ReadonlyArray<string> = ["finished", "failed", "cancelled", "continued"]

/**
 * How recent a heartbeat has to be for a non-terminal run to count as live.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const defaultLiveWindowMs = 10 * 60 * 1000

/**
 * One non-terminal run row, with only the columns the operator needs to decide
 * what to do with it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface RunRow {
  readonly runId: string
  readonly workflowName: string
  readonly workflowPath: string | undefined
  readonly status: string
  readonly heartbeatAtMs: number | undefined
  readonly runtimeOwnerId: string | undefined
  readonly parentRunId: string | undefined
  readonly pauseRequestedAtMs: number | undefined
  readonly cancelRequestedAtMs: number | undefined
}

/**
 * One Smithers 0.x SQLite database.
 *
 * An unreadable database is recorded rather than skipped, and it blocks exactly
 * as a live run does: the tool cannot prove the project has no work in flight.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface DatabaseFinding {
  readonly path: string
  readonly readable: boolean
  readonly unreadableReason: string | undefined
  readonly tables: ReadonlyArray<string>
  readonly migrations: { readonly count: number; readonly maxId: string | undefined }
  readonly runsByStatus: ReadonlyArray<{ readonly status: string; readonly count: number }>
  readonly live: ReadonlyArray<RunRow>
  readonly parked: ReadonlyArray<RunRow>
  readonly siblings: ReadonlyArray<string>
}

/**
 * A configured 0.x database that resolves outside the project root.
 *
 * It is recorded here rather than in {@link DatabaseFinding} because every
 * consumer of a `DatabaseFinding.path` treats it as project-relative: the
 * grant rules build a deny pattern under the root from it, the checkpoint
 * digests it under the root, the membership walk walks it under the root, and
 * the archive refuses writes under it. Fed an absolute or `../` path, all four
 * silently watch nothing while the report says the project is protected. The
 * tool cannot protect a file outside the tree it was pointed at, so it says so
 * instead and blocks.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ExternalDatabase {
  /** The path exactly as the project's own configuration spells it. */
  readonly declared: string
  /** Where that spelling resolves from the project root. */
  readonly resolved: string
}

/**
 * A Postgres or PGlite backend setting found in configuration, environment, or
 * a deployment manifest. The tool records it and never connects.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface BackendSetting {
  readonly backend: "postgres" | "pglite"
  readonly sources: ReadonlyArray<{ readonly file: string; readonly text: string }>
}

/**
 * One directory or file of persisted run state, reported so the operator can
 * see what archiving would move.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface StateDir {
  readonly path: string
  /**
   * Whether `path` names a directory or a single file. 0.x leaves loose state
   * files beside its directories (`.smithers/workflows/run-<id>.log`,
   * `.smithers/claude-mirror-subscriptions.json`), and a file cannot be walked,
   * so {@link roots} has to tell the two apart.
   */
  readonly kind: "directory" | "file"
  readonly files: number
  readonly bytes: number
  readonly newestMtimeMs: number | undefined
}

/**
 * What the tool found, and what the operator has to do about it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface RunStateReport {
  readonly databases: ReadonlyArray<DatabaseFinding>
  readonly external: ReadonlyArray<ExternalDatabase>
  readonly postgres: BackendSetting | undefined
  readonly pglite: BackendSetting | undefined
  readonly stateDirs: ReadonlyArray<StateDir>
  /**
   * Gateway state files that name this workspace, as ABSOLUTE paths: the
   * gateway lives outside the project, so these are the one run-state paths
   * that are not project-relative. Everything downstream — the deny rules,
   * the checkpoint digests, the byte-identity check — handles them as they
   * are rather than joining them under the root, where they would name
   * nothing.
   */
  readonly gatewayState: ReadonlyArray<string>
  /**
   * `clean` when the project holds no 0.x run state, `history-only` when every
   * run it holds has finished, `blocked` when a run is live, parked, or
   * unreadable, a database resolves outside the project, or a non-SQLite
   * backend is configured. `apply` requires `--acknowledge-run-state` for both
   * non-clean verdicts.
   */
  readonly verdict: "clean" | "history-only" | "blocked"
  readonly instructions: ReadonlyArray<string>
}

/**
 * Options for {@link scan}. Every clock and directory the scan depends on is a
 * parameter so its verdict is deterministic in a test.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  readonly now?: number | undefined
  readonly liveWindowMs?: number | undefined
  /** Where gateway state files live. Defaults to no gateway directory. */
  readonly tmpdir?: string | undefined
}

const windowsAbsolute = (path: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)

/**
 * Every directory that holds 0.x run state.
 *
 * Project-relative, with one exception: the parent of a gateway state file is
 * absolute, because the gateway's directory is outside the project. It is
 * carried absolute rather than folded into the root, so the checkpoint's
 * digests and the checks' membership walk cover the files that are really
 * there.
 *
 * A checkpoint records these so `Checks.run` can prove the migration wrote
 * nothing under them. The digest map alone cannot: it holds the paths that
 * existed when it was taken, and a file written afterwards is a write no digest
 * covers.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const roots = (report: RunStateReport): ReadonlyArray<string> => {
  const parent = (file: string): string => {
    const index = file.lastIndexOf("/")
    return index <= 0 ? "" : file.slice(0, index)
  }
  const found = new Set<string>()
  for (const entry of report.stateDirs) {
    // A loose state file is not a walkable root: walking it finds nothing, and
    // the sibling `run-<id>.log` 0.x writes next to it would then be invisible
    // to the membership half of the run-state check. Its directory is the root.
    const directory = entry.kind === "file" ? parent(entry.path) : entry.path
    if (directory !== "") found.add(directory)
  }
  for (const database of report.databases) {
    const directory = parent(database.path)
    if (directory !== "") found.add(directory)
  }
  for (const file of report.gatewayState) {
    const directory = (windowsAbsolute(file) ? win32 : posix).dirname(file)
    if (directory !== ".") found.add(directory)
  }
  // A root that lives inside another root is already walked by it.
  const all = [...found].sort()
  const comparable = (entry: string): string => windowsAbsolute(entry) ? entry.replaceAll("\\", "/") : entry
  return all.filter((entry) =>
    !all.some((other) => {
      const directory = comparable(other)
      return other !== entry && comparable(entry).startsWith(directory.endsWith("/") ? directory : `${directory}/`)
    })
  )
}

/**
 * The instruction text the report and stderr both carry, verbatim.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const instructionText = {
  live:
    "finish or cancel these runs with the 0.x CLI you already have (`smithers cancel <run-id>` or `smithers down`), then rerun the scan",
  parked: "cancel or accept the loss of these parked runs; the 1.0 runtime cannot resume them",
  archive:
    "archive the database: `mkdir -p .smithers-migrate/archive && mv .smithers/smithers.db* .smithers-migrate/archive/`; 1.0 does not import history",
  backend: "the 1.0 RC supports SQLite only; export what you need with the 0.x CLI, then remove the backend setting"
} as const

const stateDirectories = [
  ".smithers/executions",
  ".smithers/runs",
  ".smithers/logs",
  ".smithers/sandboxes",
  ".smithers/state",
  ".smithers/workflows/.worktrees"
]

/**
 * Single files that hold 0.x runtime state.
 *
 * `claude-mirror-subscriptions.json` records which agent seats a run mirrored
 * to which subscription. It is runtime state, it names accounts, and a 1.0
 * runtime never reads it, so the operator has to decide what happens to it.
 */
const stateFiles = [".smithers/claude-mirror-subscriptions.json"]

const numberOr = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined)
const stringOr = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

/**
 * Opens a database read only and reads what the report needs.
 *
 * `node:sqlite` throws on a locked or corrupt file rather than failing an
 * Effect, so every call is wrapped: a throw becomes `readable: false`, which
 * blocks the migration instead of silently passing it.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export const readDatabase = (
  file: string,
  relativePath: string,
  siblings: ReadonlyArray<string>,
  now: number,
  liveWindowMs: number
): DatabaseFinding => {
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(file, { readOnly: true })
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '_smithers_%' ORDER BY name")
      .all()
      .flatMap((row) => {
        const name = stringOr((row as Record<string, unknown>)["name"])
        return name === undefined ? [] : [name]
      })

    const hasMigrations = tables.includes("_smithers_schema_migrations")
    const migrationRow = hasMigrations
      ? (database.prepare("SELECT COUNT(*) AS count, MAX(id) AS maxId FROM _smithers_schema_migrations").get() ??
        {}) as Record<string, unknown>
      : {}
    const migrations = {
      count: numberOr(migrationRow["count"]) ?? 0,
      maxId: stringOr(migrationRow["maxId"])
    }

    const hasRuns = tables.includes("_smithers_runs")
    const runsByStatus = hasRuns
      ? database
        .prepare("SELECT status, COUNT(*) AS count FROM _smithers_runs GROUP BY status ORDER BY status")
        .all()
        .map((row) => {
          const record = row as Record<string, unknown>
          return { status: stringOr(record["status"]) ?? "", count: numberOr(record["count"]) ?? 0 }
        })
      : []

    const placeholders = terminalStatuses.map(() => "?").join(", ")
    const nonTerminal = hasRuns
      ? database
        .prepare(
          `SELECT run_id, workflow_name, workflow_path, status, heartbeat_at_ms, runtime_owner_id,
                  parent_run_id, pause_requested_at_ms, cancel_requested_at_ms
             FROM _smithers_runs WHERE status NOT IN (${placeholders}) ORDER BY run_id`
        )
        .all(...terminalStatuses)
        .map((row): RunRow => {
          const record = row as Record<string, unknown>
          return {
            runId: stringOr(record["run_id"]) ?? "",
            workflowName: stringOr(record["workflow_name"]) ?? "",
            workflowPath: stringOr(record["workflow_path"]),
            status: stringOr(record["status"]) ?? "",
            heartbeatAtMs: numberOr(record["heartbeat_at_ms"]),
            runtimeOwnerId: stringOr(record["runtime_owner_id"]),
            parentRunId: stringOr(record["parent_run_id"]),
            pauseRequestedAtMs: numberOr(record["pause_requested_at_ms"]),
            cancelRequestedAtMs: numberOr(record["cancel_requested_at_ms"])
          }
        })
      : []

    const isLive = (row: RunRow): boolean => row.heartbeatAtMs !== undefined && now - row.heartbeatAtMs <= liveWindowMs

    return {
      path: relativePath,
      readable: true,
      unreadableReason: undefined,
      tables,
      migrations,
      runsByStatus,
      live: nonTerminal.filter(isLive),
      parked: nonTerminal.filter((row) => !isLive(row)),
      siblings
    }
  } catch (cause) {
    return {
      path: relativePath,
      readable: false,
      unreadableReason: String(cause),
      tables: [],
      migrations: { count: 0, maxId: undefined },
      runsByStatus: [],
      live: [],
      parked: [],
      siblings
    }
  } finally {
    try {
      database?.close()
    } catch {
      // A database that failed to open has nothing to close.
    }
  }
}

const dbPathLiterals = (text: string): ReadonlyArray<string> => {
  const found = new Set<string>()
  const call = /dbPath\s*:\s*([^,}\n]+)/g
  let match = call.exec(text)
  while (match !== null) {
    const literal = /["'`]([^"'`]+)["'`]/g
    let inner = literal.exec(match[1] ?? "")
    while (inner !== null) {
      const value = inner[1] ?? ""
      if (value !== "" && value !== ":memory:") found.add(value)
      inner = literal.exec(match[1] ?? "")
    }
    match = call.exec(text)
  }
  return [...found]
}

const environmentDbPaths = (text: string): ReadonlyArray<string> => {
  const found = new Set<string>()
  const regexp = /^\s*(?:export\s+)?SMITHERS_DB(?:_PATH)?\s*=\s*["']?([^"'\n#]+)["']?/gm
  let match = regexp.exec(text)
  while (match !== null) {
    const value = (match[1] ?? "").trim()
    if (value !== "" && value !== ":memory:") found.add(value)
    match = regexp.exec(text)
  }
  return [...found]
}

const backendSetting = (
  backend: "postgres" | "pglite",
  sources: ReadonlyArray<{ readonly file: string; readonly text: string }>
): BackendSetting | undefined => (sources.length === 0 ? undefined : { backend, sources })

/** Gateway JSON escapes native Windows separators and may nest workspace records. */
const mentionsRoot = (text: string, root: string): boolean => {
  if (text.includes(root)) return true
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return false
  }
  const pending: Array<unknown> = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === "string" && current.includes(root)) return true
    if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        if (key.includes(root)) return true
        pending.push(child)
      }
    }
  }
  return false
}

/**
 * Reads every trace of Smithers 0.x run state under `root` and returns the
 * verdict plus the operator instructions, in the order the operator has to act
 * on them.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export const scan = (
  root: string,
  detection: Detection,
  options: Options = {}
): Effect.Effect<RunStateReport, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // The Clock service, not the wall clock. The live-versus-parked split
    // decides the verdict, the operator instructions, the gate, and the exit
    // code, and that answer crosses the journal as part of a sealed scan: a
    // step that replays has to reach the same verdict it recorded.
    const now = options.now ?? (yield* Clock.currentTimeMillis)
    const liveWindowMs = options.liveWindowMs ?? defaultLiveWindowMs
    const fileSet = new Set(detection.files)

    // Candidate databases: the two conventional paths, every `dbPath:` literal
    // in project source, and every SMITHERS_DB value in an env file.
    const candidates = new Set<string>(["smithers.db", ".smithers/smithers.db"])
    for (const [file, text] of detection.sources) {
      if (/\.(ts|tsx|js|jsx|mjs|mts)$/.test(file)) {
        for (const literal of dbPathLiterals(text)) candidates.add(literal)
      }
    }
    for (const file of detection.files.filter((candidate) => /(^|\/)\.env[^/]*$/.test(candidate))) {
      const text = yield* Fs.readOption(path.join(root, ...file.split("/")))
      if (text === undefined) continue
      for (const literal of environmentDbPaths(text)) candidates.add(literal)
    }

    const databases: Array<DatabaseFinding> = []
    const external: Array<ExternalDatabase> = []
    // Containment is judged on real paths: `/tmp` is itself a link on macOS,
    // and a project-relative `link.db` may name a database somewhere else.
    const realRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root))
    const outside = (from: string, to: string): boolean => {
      const inside = path.relative(from, to)
      return inside === "" || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)
    }
    for (const candidate of [...candidates].sort()) {
      const normalized = candidate.replace(/^\.\//, "")
      const absolute = path.isAbsolute(normalized)
        ? path.normalize(normalized)
        : path.resolve(root, ...normalized.split("/"))
      if (!(yield* Fs.exists(absolute))) continue
      // Containment is decided by where the path resolves, never by how it was
      // spelled. `dbPath: "/var/data/smithers.db"` and `SMITHERS_DB=../shared.db`
      // both name real 0.x run state this tool cannot checkpoint, deny, digest,
      // or archive, so they are reported and they block instead of being
      // recorded as a project-relative path that matches nothing.
      //
      // Where it resolves means with every link followed: `link.db` inside
      // the project may name a database outside it. A link that stays inside
      // is recorded at its target's own path, the file the checkpoint, the
      // archive, and the digest (none of which follow links) can protect.
      const real = yield* fs.realPath(absolute).pipe(Effect.orElseSucceed(() => absolute))
      if (outside(realRoot, real)) {
        external.push({ declared: candidate, resolved: real })
        continue
      }
      const relative = path.relative(realRoot, real).split(path.sep).join("/")
      const siblings = ["-wal", "-shm"]
        .map((suffix) => `${relative}${suffix}`)
        .filter((sibling) => fileSet.has(sibling))
      databases.push(readDatabase(absolute, relative, siblings, now, liveWindowMs))
    }

    // Postgres and PGlite: recorded from settings, never connected to.
    const postgresSources: Array<{ file: string; text: string }> = []
    const pgliteSources: Array<{ file: string; text: string }> = []
    const backendSourceFiles = detection.files.filter((file) =>
      /(^|\/)\.env[^/]*$/.test(file) ||
      /(^|\/)smithers\.config\.[tj]s$/.test(file) ||
      file.endsWith("package.json") ||
      file.endsWith(".sh") ||
      /^\.github\/workflows\/.+\.ya?ml$/.test(file)
    )
    for (const file of backendSourceFiles) {
      const text = detection.sources.get(file) ??
        (yield* Fs.readOption(path.join(root, ...file.split("/")))) ?? ""
      for (
        const pattern of [
          /backend\s*[:=]\s*["']postgres["']/,
          /createSmithersPostgres\s*\(/,
          /SMITHERS_BACKEND\s*=\s*["']?postgres/,
          /SMITHERS_POSTGRES_URL/,
          /SMITHERS_POSTGRES_POOL_MAX/,
          /SMITHERS_TEST_PG_URL/
        ]
      ) {
        const match = pattern.exec(text)
        if (match !== null) postgresSources.push({ file, text: match[0] })
      }
      for (
        const pattern of [
          /backend\s*[:=]\s*["']pglite["']/,
          /pgliteDataDir/,
          /SMITHERS_BACKEND\s*=\s*["']?pglite/
        ]
      ) {
        const match = pattern.exec(text)
        if (match !== null) pgliteSources.push({ file, text: match[0] })
      }
    }
    for (const marker of detection.files.filter((file) => file.endsWith("/PG_VERSION"))) {
      const directory = marker.slice(0, -"/PG_VERSION".length)
      if (/(^|\/)(\.smithers\/pg|pglite)$/.test(directory) || directory.endsWith(".pglite")) {
        pgliteSources.push({ file: marker, text: `${directory} is a PGlite data directory` })
      }
    }

    // Other persisted state.
    const stateDirs: Array<StateDir> = []
    for (const directory of stateDirectories) {
      const absolute = path.join(root, ...directory.split("/"))
      if (!(yield* Fs.isDirectory(absolute))) continue
      const contents = yield* Fs.walk(absolute)
      let bytes = 0
      let newest: number | undefined
      for (const file of contents) {
        const info = yield* fs.stat(path.join(absolute, ...file.split("/"))).pipe(Effect.option)
        if (info._tag === "None") continue
        bytes += Number(info.value.size)
        const mtime = info.value.mtime._tag === "Some" ? info.value.mtime.value.getTime() : undefined
        if (mtime !== undefined && (newest === undefined || mtime > newest)) newest = mtime
      }
      stateDirs.push({ path: directory, kind: "directory", files: contents.length, bytes, newestMtimeMs: newest })
    }
    const sized = (file: string): Effect.Effect<StateDir, never, FileSystem.FileSystem> =>
      Effect.gen(function*() {
        const info = yield* fs.stat(path.join(root, ...file.split("/"))).pipe(Effect.option)
        const bytes = info._tag === "Some" ? Number(info.value.size) : 0
        const mtime = info._tag === "Some" && info.value.mtime._tag === "Some"
          ? info.value.mtime.value.getTime()
          : undefined
        return { path: file, kind: "file", files: 1, bytes, newestMtimeMs: mtime }
      })
    for (const log of detection.files.filter((file) => /(^|\/)\.smithers\/workflows\/run-.*\.log$/.test(file))) {
      stateDirs.push(yield* sized(log))
    }
    for (const file of stateFiles) {
      if (!detection.files.includes(file)) continue
      stateDirs.push(yield* sized(file))
    }

    // Gateway state files that name this workspace.
    const gatewayState: Array<string> = []
    if (options.tmpdir !== undefined) {
      const gatewayDirectory = path.join(options.tmpdir, "smithers-gateway")
      if (yield* Fs.isDirectory(gatewayDirectory)) {
        for (const file of yield* Fs.walk(gatewayDirectory)) {
          if (!file.endsWith(".json")) continue
          const text = yield* Fs.readOption(path.join(gatewayDirectory, ...file.split("/")))
          if (text !== undefined && mentionsRoot(text, root)) gatewayState.push(path.join(gatewayDirectory, file))
        }
      }
    }

    const postgres = backendSetting("postgres", postgresSources)
    const pglite = backendSetting("pglite", pgliteSources)
    const live = databases.flatMap((database) => database.live)
    const parked = databases.flatMap((database) => database.parked)
    const unreadable = databases.filter((database) => !database.readable)
    // A 0.x database is history whether or not it holds a row. The file sits
    // at the conventional path or at the path the project's own configuration
    // names, and a 1.0 runtime can neither read nor move it, so the operator
    // has to say what happens to it even when every table is empty. Zero
    // rows, zero tables, and a zero-byte file all count; only an unreadable
    // one is worse, and that blocks.
    const history = databases.some((database) => database.readable) || stateDirs.length > 0

    const blocked = live.length > 0 ||
      parked.length > 0 ||
      unreadable.length > 0 ||
      external.length > 0 ||
      postgres !== undefined ||
      pglite !== undefined ||
      gatewayState.length > 0
    const verdict: RunStateReport["verdict"] = blocked ? "blocked" : history ? "history-only" : "clean"

    const instructions: Array<string> = []
    if (live.length > 0) {
      instructions.push(instructionText.live)
    }
    if (parked.length > 0) {
      instructions.push(instructionText.parked)
    }
    if (unreadable.length > 0) {
      instructions.push(
        `${
          unreadable.map((database) => database.path).join(", ")
        } could not be opened read only; close whatever holds it, then rerun the scan`
      )
    }
    for (const entry of external) {
      instructions.push(
        `${entry.declared} names a 0.x database at ${entry.resolved}, outside this project; the migration cannot protect a file it cannot reach, so archive it and remove the setting before migrating`
      )
    }
    if (history) instructions.push(instructionText.archive)
    if (postgres !== undefined || pglite !== undefined) instructions.push(instructionText.backend)
    if (gatewayState.length > 0) {
      instructions.push(
        `a 0.x gateway still names this workspace in ${
          gatewayState.join(", ")
        }; stop it with \`smithers down\` before migrating`
      )
    }

    return { databases, external, postgres, pglite, stateDirs, gatewayState, verdict, instructions }
  })
