/**
 * Where a `smthrs` invocation decides it is running.
 *
 * Every command that touches durable state resolves the same project root the
 * same way, because 0.x's most reported operational surprise was two commands
 * in one repository disagreeing about which database they meant (`smthrs up`
 * from a subdirectory writing a second store). The rule:
 *
 * 1. an explicit `--root`, resolved against the invocation directory;
 * 2. otherwise the nearest ancestor that anchors a project (see
 *    {@link anchors});
 * 3. otherwise the invocation directory itself.
 *
 * The same module answers the 0.x state question: is there
 * Smithers 0.x state beside this project? rc.0 never loads it, and the
 * detector exists so the CLI can say so once instead of failing obscurely.
 *
 * @since 1.0.0
 */

import { Context, Layer } from "effect"
import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import * as CliError from "./CliError.ts"
import * as Environment from "./Environment.ts"

/**
 * Directory and file names that mark a Smithers 0.x project.
 *
 * @category constants
 * @since 1.0.0
 */
export const legacyMarkers: ReadonlyArray<string> = [
  ".smithers",
  "smithers.db",
  "smithers.db-wal",
  "smithers.db-shm"
]

/**
 * Names that end the upward walk.
 *
 * Both walks stop at the repository root, inclusive. Without that bound a
 * command run in a checkout under `$HOME` would keep climbing into the home
 * directory, where 0.x's global `~/.smithers` lives — and rc.0 does not read
 * global state at all, so reporting it would be a
 * false alarm on every invocation.
 */
const boundaryMarkers: ReadonlyArray<string> = [".git", ".jj"]

/** Names that make a directory a project in its own right. */
const projectMarkers: ReadonlyArray<string> = ["package.json", ".git", ".jj"]

/**
 * Whether a directory anchors the project root.
 *
 * `.flows/` anchors on its own: rc.0 writes that directory and nothing else
 * does, so finding one is proof of the project it belongs to.
 *
 * `flows/` anchors only beside a project marker. A directory called `flows` is
 * a source root in a Smithers project and an ordinary package directory
 * everywhere else, and this repository holds both: `packages/smithers/flows` is the
 * `@smthrs/flows` package, so the bare-name rule made every command run under
 * `packages/` resolve its root to `packages/` and write a second
 * `packages/.flows` database. Requiring `package.json`, `.git`, or `.jj` in
 * the same directory keeps the anchor on the directory a project actually
 * starts at.
 */
const anchors = (directory: string, exists: (path: string) => boolean): boolean => {
  if (exists(join(directory, ".flows"))) return true
  return exists(join(directory, "flows")) &&
    projectMarkers.some((marker) => exists(join(directory, marker)))
}

/**
 * Resolves the project root for one invocation.
 *
 * @category constructors
 * @since 1.0.0
 */
export const root = (
  explicit: string | undefined,
  cwd: string,
  exists: (path: string) => boolean = existsSync
): string => {
  if (explicit !== undefined && explicit !== "") {
    return isAbsolute(explicit) ? explicit : resolve(cwd, explicit)
  }
  let directory = resolve(cwd)
  for (;;) {
    if (anchors(directory, exists)) return directory
    const parent = dirname(directory)
    if (parent === directory || boundaryMarkers.some((marker) => exists(join(directory, marker)))) {
      return resolve(cwd)
    }
    directory = parent
  }
}

/**
 * Resolves the 0.x project one `smthrs migrate` invocation converts.
 *
 * This is deliberately not {@link root}. That walk anchors on `.flows/`, which
 * only an rc.0 project has, so a 0.x project without a `.git`/`.jj` marker of
 * its own resolved to whatever rc.0 project happened to sit above it and
 * `migrate --apply` rewrote the ancestor's tree. The project being migrated is
 * the one holding 0.x state, so the walk anchors on {@link legacyMarkers} and
 * falls back to the invocation directory. `--root` still wins, and so does the
 * verb's own path argument.
 *
 * @category constructors
 * @since 1.0.0
 */
export const legacyRoot = (
  explicit: string | undefined,
  cwd: string,
  exists: (path: string) => boolean = existsSync
): string => {
  if (explicit !== undefined && explicit !== "") {
    return isAbsolute(explicit) ? explicit : resolve(cwd, explicit)
  }
  let directory = resolve(cwd)
  for (;;) {
    if (legacyMarkers.some((marker) => exists(join(directory, marker)))) return directory
    const parent = dirname(directory)
    if (parent === directory || boundaryMarkers.some((marker) => exists(join(directory, marker)))) {
      return resolve(cwd)
    }
    directory = parent
  }
}

/**
 * Where this project keeps rc.0 state.
 *
 * @category getters
 * @since 1.0.0
 */
export const stateDirectory = (projectRoot: string): string => join(projectRoot, ".flows")

/**
 * Where a detached run writes its log.
 *
 * @category getters
 * @since 1.0.0
 */
export const logDirectory = (projectRoot: string): string => join(stateDirectory(projectRoot), "logs")

/**
 * Where a detached run with this id writes its log.
 *
 * @category getters
 * @since 1.0.0
 */
export const logFile = (projectRoot: string, runId: string): string => join(logDirectory(projectRoot), `${runId}.log`)

/**
 * Where a project's flow sources live.
 *
 * @category getters
 * @since 1.0.0
 */
export const flowsDirectory = (projectRoot: string): string => join(projectRoot, "flows")

/**
 * Every 0.x run database beside a project, newest ancestor first.
 *
 * Unlike {@link legacyState} this does not stop at a directory that holds
 * `.flows/`. The informational notice is gated only on
 * "no `.flows/` beside it"; the refusal that `smthrs migrate` and the
 * database listing that `smthrs doctor` perform are not gated, and they
 * must not be: the project an operator actually migrates is one that has
 * already run an rc.0 command, so it already has `.flows/`, and gating the
 * refusal there would answer "nothing to finish" for every real migration.
 *
 * @category getters
 * @since 1.0.0
 */
export const legacyDatabases = (
  cwd: string,
  exists: (path: string) => boolean = existsSync
): ReadonlyArray<string> => {
  const found: Array<string> = []
  let directory = resolve(cwd)
  for (;;) {
    const candidate = join(directory, "smithers.db")
    if (exists(candidate)) found.push(candidate)
    const parent = dirname(directory)
    if (parent === directory || boundaryMarkers.some((marker) => exists(join(directory, marker)))) return found
    directory = parent
  }
}

const buildDefinitionFiles = new Set([
  "WORKSPACE.ts",
  "FACTORY.ts",
  "factory.json",
  "home.json",
  "target-index.json",
  "environment.nix",
  "coding-project.json",
  "memory-thresholds.json",
  "memory-thresholds.receipt.json"
])

/**
 * What a directory-serving host keeps under `.smithers`: its database, the
 * sidecars an open database has, and the record naming the server that holds
 * the directory. All of it is a current server's state, not a 0.x run store,
 * so none of it makes the directory legacy state. A server that was killed
 * leaves its record behind, and the next command must not read that as 0.x.
 */
const currentDatabaseFiles = new Set([
  "opencode.sqlite",
  "opencode.sqlite-wal",
  "opencode.sqlite-shm",
  "opencode.server.json"
])

/**
 * Whether a `.smithers` directory holds only what 1.0 writes there: the
 * current build definitions, the opencode server's own files, or both. An empty
 * directory, an unknown file, a subdirectory and unreadable metadata all
 * still read as 0.x state.
 */
const onlyCurrentState = (directory: string, exists: (path: string) => boolean): boolean => {
  let entries: Array<{ readonly name: string; readonly isFile: () => boolean }>
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return false
  }
  if (!entries.every((entry) => entry.isFile())) return false
  const rest = entries.filter((entry) => !currentDatabaseFiles.has(entry.name))
  if (rest.length === 0) return entries.length > 0
  if (!exists(join(directory, "WORKSPACE.ts")) || !exists(join(directory, "FACTORY.ts"))) return false
  return rest.every((entry) => buildDefinitionFiles.has(entry.name))
}

/**
 * Smithers 0.x state found beside a project, newest ancestor first.
 *
 * A directory that already holds `.flows/` is an rc.0 project and reports
 * nothing: a repository mid-migration would otherwise print the notice on
 * every command forever.
 *
 * A `.smithers` directory containing only current build definitions, only
 * what a directory-serving host keeps there, or both, is also excluded. Unknown files, subdirectories and unreadable metadata remain
 * legacy markers.
 *
 * @category getters
 * @since 1.0.0
 */
export const legacyState = (
  cwd: string,
  exists: (path: string) => boolean = existsSync
): ReadonlyArray<string> => {
  const found: Array<string> = []
  let directory = resolve(cwd)
  for (;;) {
    if (!exists(join(directory, ".flows"))) {
      for (const marker of legacyMarkers) {
        const candidate = join(directory, marker)
        if (exists(candidate) && !(marker === ".smithers" && onlyCurrentState(candidate, exists))) {
          found.push(candidate)
        }
      }
    }
    const parent = dirname(directory)
    if (parent === directory || boundaryMarkers.some((marker) => exists(join(directory, marker)))) return found
    directory = parent
  }
}

/**
 * The one-line notice written to stderr when 0.x state
 * is found and rc.0 state is not.
 *
 * @category constructors
 * @since 1.0.0
 */
export const legacyNotice = (path: string): string =>
  `Found Smithers 0.x state at ${path}. 1.0.0-rc.0 does not load, resume, or migrate 0.x run databases. ` +
  `Finish, archive, or discard those runs with the 0.x CLI (bunx smthrs@0.35.0 ps), ` +
  `then run "smthrs migrate" to convert the project source. ` +
  `See https://smithers.sh/migration/1.0#run-data`

/**
 * The project root this invocation resolved, as a service.
 *
 * Commands read it from here rather than calling {@link root} again, so the
 * root a handler acts on is provably the same one the durable layers were
 * built over. `--root` is parsed before the layers are constructed, which is
 * why it cannot simply be a flag every handler reads.
 *
 * @category references
 * @since 1.0.0
 */
export const ProjectRoot: Context.Reference<string> = Context.Reference<string>(
  "/cli/ProjectRoot",
  { defaultValue: () => process.cwd() }
)

/**
 * The Smithers 0.x state found beside this project when the invocation
 * started, as a service.
 *
 * @category references
 * @since 1.0.0
 */
export const LegacyState: Context.Reference<ReadonlyArray<string>> = Context.Reference<ReadonlyArray<string>>(
  "/cli/LegacyState",
  { defaultValue: () => legacyState(Environment.ambientWorkingDirectory()) }
)

/**
 * The 0.x project `smthrs migrate` converts when no path is given, as a
 * service.
 *
 * Separate from {@link ProjectRoot} because the two answer different
 * questions: the durable layers are built over the rc.0 project, and the
 * migration reads the 0.x project the operator is standing in.
 *
 * @category references
 * @since 1.0.0
 */
export const MigrationRoot: Context.Reference<string> = Context.Reference<string>(
  "/cli/MigrationRoot",
  { defaultValue: () => legacyRoot(undefined, Environment.ambientWorkingDirectory()) }
)

/**
 * Provides the resolved project root, and the 0.x state found beside it.
 *
 * The 0.x sample is taken here, in an ordinary function call, rather than in
 * the handler that reports it. {@link legacyState} treats a `.flows/`
 * directory as proof the project already moved on, and opening the control
 * database creates `<root>/.flows`. A handler-time sample therefore inspected
 * a directory the same invocation had just written, and the runtime
 * the 0.x-project guard notice printed on no project it was written for. This function
 * runs while the layers are still being described, before any of them is
 * built, so the sample is of the directory as the operator left it.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  projectRoot: string,
  migrationRoot: string
): Layer.Layer<never> =>
  Layer.mergeAll(
    Layer.succeed(ProjectRoot, projectRoot),
    Layer.succeed(MigrationRoot, migrationRoot),
    Layer.succeed(LegacyState, legacyState(projectRoot))
  )

/**
 * Refuses an inaccessible project before a command creates durable state.
 * @category validation
 * @since 1.0.0
 */
export const assertRoot = (projectRoot: string): void => {
  try {
    if (!statSync(projectRoot).isDirectory()) {
      throw new CliError.UsageError({ message: `--root ${JSON.stringify(projectRoot)} must be a directory` })
    }
  } catch (cause) {
    if (cause instanceof CliError.UsageError) throw cause
    throw new CliError.UsageError({
      message: `--root ${JSON.stringify(projectRoot)} is not an accessible directory`
    })
  }
}

/**
 * Resolves and validates a local-only invocation using the canonical environment rules.
 * @category constructors
 * @since 1.0.0
 */
export const localRoot = (
  options: { readonly root?: string | undefined; readonly remote?: string | undefined },
  environment: Environment.Source
): string => {
  if (options.remote !== undefined || Environment.read(environment, "SMITHERS_REMOTE") !== undefined) {
    throw new CliError.UnsupportedError({
      message: "This command requires the host that owns the local project; --remote is not supported"
    })
  }
  const projectRoot = root(options.root, process.cwd())
  assertRoot(projectRoot)
  return projectRoot
}
