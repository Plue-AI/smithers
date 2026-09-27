/**
 * What one migration run was asked to do.
 *
 * The options are a schema rather than an interface because they are the
 * migration flow's payload: they cross the journal, and a replay decodes
 * exactly what the first attempt was given. The CLI decodes the same schema
 * from its flags, so a flag typo fails with a field path instead of a
 * `undefined` three steps later.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { isAbsolute, normalize, parse, sep } from "node:path"
import * as Fs from "../internal/Fs.ts"
import { make, type MigrateError } from "../MigrateError.ts"

/**
 * What a run is allowed to do to the project.
 *
 * `scan` reads. `plan` reads and writes the report. Only `apply` edits source,
 * and only `apply` is gated.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Mode = Schema.Literals(["scan", "plan", "apply"])

/**
 * What a run is allowed to do to the project.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Mode = typeof Mode.Type

/**
 * Command overrides for the verification step, when the project's own
 * manifests do not name the commands the operator wants run.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Commands = Schema.Struct({
  install: Schema.optional(Schema.String),
  format: Schema.optional(Schema.String),
  typecheck: Schema.optional(Schema.Array(Schema.String)),
  test: Schema.optional(Schema.String)
})

/**
 * Command overrides for the verification step.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Commands = typeof Commands.Type

/**
 * Where the migration writes and what it calls the target directory.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Layout = Schema.Struct({
  flowsDir: Schema.String
})

/**
 * The three places outside the project where 0.x keeps state, as the host
 * found them in its environment: `SMITHERS_HOME`, the home directory (whose
 * `.smithers` is the global state directory), and the temporary directory
 * (whose `smithers-gateway` holds gateway state).
 *
 * A payload field rather than the environment itself, because the payload
 * crosses the journal: these three are paths, never secrets, and they are the
 * only environment the scanners read.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const State = Schema.Struct({
  smithersHome: Schema.optional(Schema.String),
  home: Schema.optional(Schema.String),
  tmpdir: Schema.optional(Schema.String)
})

/**
 * The three state paths a host derives from its environment.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type State = typeof State.Type

/**
 * The state paths one environment names, or `undefined` when it names none.
 *
 * Only the three variables the scanners read leave the environment here; a
 * provider key stays with the seat resolver and never reaches a payload.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const stateOf = (
  environment: Readonly<Record<string, string | undefined>>
): State | undefined => {
  const state: State = {
    ...(environment["SMITHERS_HOME"] === undefined || environment["SMITHERS_HOME"] === ""
      ? {}
      : { smithersHome: environment["SMITHERS_HOME"] }),
    ...(environment["HOME"] === undefined || environment["HOME"] === "" ? {} : { home: environment["HOME"] }),
    ...(environment["TMPDIR"] === undefined || environment["TMPDIR"] === "" ? {} : { tmpdir: environment["TMPDIR"] })
  }
  return Object.keys(state).length === 0 ? undefined : state
}

/**
 * The environment the scanners read, rebuilt from a {@link State}: exactly
 * the three variables, spelled as the detector expects them.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const scanEnvironment = (state: State | undefined): Readonly<Record<string, string>> => ({
  ...(state?.smithersHome === undefined ? {} : { SMITHERS_HOME: state.smithersHome }),
  ...(state?.home === undefined ? {} : { HOME: state.home }),
  ...(state?.tmpdir === undefined ? {} : { TMPDIR: state.tmpdir.endsWith("/") ? state.tmpdir : `${state.tmpdir}/` })
})

/** The fields of {@link MigrateOptions}, before the layout check. */
const MigrateOptionsFields = Schema.Struct({
  root: Schema.String,
  mode: Mode,
  seat: Schema.optional(Schema.String),
  allowUnsafe: Schema.optional(Schema.Union([Schema.Literal("all"), Schema.Array(Schema.String)])),
  acknowledgeRunState: Schema.optional(Schema.Boolean),
  allowNoVcs: Schema.optional(Schema.Boolean),
  keepOldSources: Schema.optional(Schema.Boolean),
  units: Schema.optional(Schema.Array(Schema.String)),
  maxRepairRounds: Schema.optional(Schema.Int),
  commands: Schema.optional(Commands),
  reportDir: Schema.optional(Schema.String),
  layout: Schema.optional(Layout),
  state: Schema.optional(State)
})

/**
 * Directory names no layout path may name or live under.
 *
 * `.flows` is the 1.0 runtime's state; the other three are version control's
 * and the package manager's own storage, which the whole-tree manifest never
 * walks, so a report or a flow written there would be invisible to the very
 * check that guards the tree.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const reservedDirectories: ReadonlyArray<string> = [".flows", ".git", ".jj", "node_modules"]

/**
 * Everything the tool itself writes at the top of the report directory.
 *
 * The report directory is the tool's and nobody else's: the scan never reads
 * it, the archive and the backups live in it, and a second run over the same
 * project reads its unit artifacts back. A report directory that already
 * holds anything else is one that used to be, or still is, a project
 * directory, and writing into it would archive the project's own files next
 * to the copies the migration takes of them.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const reportDirEntries: ReadonlyArray<string> = [
  "apply.lock",
  "apply.lock.sqlite",
  "apply.lock.sqlite-journal",
  "archive",
  "backup",
  "pending-unit.json",
  "report.json",
  "report.md",
  "units"
]

/**
 * Why one project-relative layout path is not acceptable, or `undefined`
 * when it is.
 *
 * Acceptable means one thing: joined onto the root, the path names a place
 * inside the project and nowhere else. So it is nonempty, relative, made of
 * plain segments (no `.`, no `..`, no empty segment, no trailing slash), free
 * of NUL and backslash, and no segment of it is one of
 * {@link reservedDirectories}, at any depth.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const relativePathIssue = (label: string, value: string): string | undefined => {
  if (value === "") return `${label} must not be empty`
  if (value.includes("\0")) return `${label} must not contain a NUL byte`
  if (value.includes("\\")) return `${label} must not contain a backslash`
  if (value.startsWith("/")) return `${label} must be relative to the project root, not absolute ("${value}")`
  if (value.endsWith("/")) return `${label} must not end with a slash ("${value}")`
  const segments = value.split("/")
  if (segments.some((segment) => segment === "")) return `${label} must not contain an empty segment ("${value}")`
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return `${label} must not contain a "." or ".." segment ("${value}")`
  }
  const reserved = segments.find((segment) => reservedDirectories.includes(segment))
  if (reserved !== undefined) {
    return `${label} must not be "${reserved}" or live under it ("${value}")`
  }
  return undefined
}

/** Whether `inner` is `outer` or lives under it, both as normalized relative paths. */
const under = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(`${outer}/`)

/**
 * Why the root and the two layout paths of a run are not acceptable
 * together, or `undefined` when they are.
 *
 * The root has to be absolute and already normalized, so every later join is
 * lexically inside it. The report directory and the flows directory each
 * have to pass {@link relativePathIssue}, and neither may contain the other:
 * a report written under the flows directory is discovered as a flow, and a
 * flows directory under the report directory is archived with the backups.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const layoutIssue = (options: {
  readonly root: string
  readonly reportDir?: string | undefined
  readonly layout?: { readonly flowsDir: string } | undefined
}): string | undefined => {
  const root = options.root
  if (root.includes("\0")) return "root must not contain a NUL byte"
  if (!isAbsolute(root)) return `root must be an absolute path ("${root}")`
  if (normalize(root) !== root || (root !== parse(root).root && root.endsWith(sep))) {
    return `root must be a normalized absolute path ("${root}")`
  }
  const report = options.reportDir ?? defaultReportDir
  const flows = options.layout?.flowsDir ?? defaultFlowsDir
  const reportProblem = relativePathIssue("reportDir", report)
  if (reportProblem !== undefined) return reportProblem
  const flowsProblem = relativePathIssue("layout.flowsDir", flows)
  if (flowsProblem !== undefined) return flowsProblem
  if (under(flows, defaultReportDir)) {
    return `layout.flowsDir ("${flows}") must not overlap the fixed migration state directory "${defaultReportDir}"`
  }
  if (
    under(report.normalize("NFC"), flows.normalize("NFC")) || under(flows.normalize("NFC"), report.normalize("NFC"))
  ) {
    return `reportDir ("${report}") and layout.flowsDir ("${flows}") must not overlap`
  }
  return undefined
}

/**
 * Everything one migration run was asked to do.
 *
 * `seat` is a seat *id* the host's `SeatResolver` understands, not a model
 * name this package knows: the resolver owns that vocabulary. Absent means the
 * host decides, and a host with no answer refuses the run by name.
 *
 * The schema refuses a layout that could reach outside the project or fold
 * one of its directories into another, so a payload that decodes is one the
 * flow may join paths onto. {@link validateLayout} adds what a schema cannot
 * see: a symlink already on disk.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const MigrateOptions = MigrateOptionsFields.check(
  Schema.makeFilter((options) => layoutIssue(options) ?? true, { title: "containedLayout" })
)

/**
 * Everything one migration run was asked to do.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type MigrateOptions = typeof MigrateOptions.Type

/**
 * Where the report, the archive, and the no-VCS backups live, relative to the
 * project root.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const defaultReportDir = ".smithers-migrate"

/**
 * The directory the migrated flows are written to, relative to the project
 * root. It follows the registry's own project source layout.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const defaultFlowsDir = "flows"

/**
 * How many times a failing unit is handed back to the agent with the failing
 * command output before the run restores its checkpoint and moves on.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const defaultMaxRepairRounds = 3

/**
 * The report directory this run writes into.
 *
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const reportDir = (options: MigrateOptions): string => options.reportDir ?? defaultReportDir

/**
 * The flows directory this run migrates into.
 *
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const flowsDir = (options: MigrateOptions): string => options.layout?.flowsDir ?? defaultFlowsDir

/**
 * The repair budget this run allows, floored at zero.
 *
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const maxRepairRounds = (options: MigrateOptions): number =>
  Math.max(0, options.maxRepairRounds ?? defaultMaxRepairRounds)

/**
 * The path the deepest existing ancestor of `relative` really resolves to,
 * with every symlink followed, and `undefined` when not even the root exists.
 */
const realAncestor = (
  root: string,
  relative: string
): Effect.Effect<string | undefined, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    let deepest: string | undefined = undefined
    let current = root
    for (const segment of ["", ...relative.split("/")]) {
      const next = segment === "" ? current : path.join(current, segment)
      const info = yield* Fs.optionalNotFound(fs.stat(next)).pipe(
        Effect.mapError((cause) => make("io", `could not inspect "${next}"`, String(cause)))
      )
      if (Option.isNone(info)) break
      deepest = next
      current = next
    }
    if (deepest === undefined) return undefined
    return yield* fs.realPath(deepest).pipe(
      Effect.mapError((cause) => make("io", `could not resolve "${deepest}"`, String(cause)))
    )
  })

/**
 * Refuses a layout that the filesystem, rather than the text, lets escape the
 * project.
 *
 * {@link layoutIssue} settles what a string can settle. What it cannot see is
 * a symlink already on disk: a `.smithers-migrate` that points at the
 * operator's home directory passes every lexical test and receives every
 * backup. So the deepest existing ancestor of each layout path is resolved
 * with symlinks followed and has to land inside the resolved root. The root
 * itself is resolved the same way, because `/tmp` is a symlink on macOS and
 * a project under it is still a project.
 *
 * Runs before the first scan and before the first write, and never writes.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const validateLayout = (
  options: MigrateOptions
): Effect.Effect<void, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const issue = layoutIssue(options)
    if (issue !== undefined) return yield* Effect.fail(make("invalid-layout", issue))
    const fs = yield* FileSystem.FileSystem
    const rootInfo = yield* Fs.optionalNotFound(fs.stat(options.root)).pipe(
      Effect.mapError((cause) => make("io", `could not inspect the project root "${options.root}"`, String(cause)))
    )
    if (Option.isNone(rootInfo) || rootInfo.value.type !== "Directory") {
      return yield* Effect.fail(make("invalid-layout", `root "${options.root}" is not a directory`))
    }
    const realRoot = yield* fs.realPath(options.root).pipe(
      Effect.mapError((cause) => make("io", `could not resolve the project root "${options.root}"`, String(cause)))
    )
    for (
      const [label, relative] of [
        ["reportDir", reportDir(options)],
        ["layout.flowsDir", flowsDir(options)]
      ] as const
    ) {
      const resolved = yield* realAncestor(options.root, relative)
      if (resolved === undefined) continue
      if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${sep}`)) {
        return yield* Effect.fail(make(
          "invalid-layout",
          `${label} "${relative}" resolves outside the project: "${resolved}" is not under "${realRoot}"`,
          "a symlink on the path leads out of the project root; replace it with a directory or choose another path"
        ))
      }
    }
    // The report directory, when it already exists, holds the tool's own
    // files and nothing else. The scan skips it wholesale, so a project
    // directory named as the report directory would otherwise vanish from the
    // plan and then receive the archive. A leftover atomic-write temporary —
    // the tool's own file, interrupted mid-rename by a crash — is tolerated
    // rather than reported as foreign.
    const path = yield* Path.Path
    const report = path.join(options.root, ...reportDir(options).split("/"))
    const info = yield* Fs.optionalNotFound(fs.stat(report)).pipe(
      Effect.mapError((cause) => make("io", `could not inspect the report directory "${report}"`, String(cause)))
    )
    if (Option.isNone(info)) return
    if (info.value.type !== "Directory") {
      return yield* Effect.fail(
        make("invalid-layout", `reportDir "${reportDir(options)}" exists and is not a directory`)
      )
    }
    const entries = yield* fs.readDirectory(report).pipe(
      Effect.mapError((cause) => make("io", `could not list the report directory "${report}"`, String(cause)))
    )
    const foreign = entries.filter((entry) => !reportDirEntries.includes(entry) && !Fs.isStaleTemporary(entry)).sort()
    if (foreign.length > 0) {
      return yield* Effect.fail(make(
        "invalid-layout",
        `reportDir "${reportDir(options)}" already holds files that are not the tool's: ${
          foreign.map((entry) => `"${entry}"`).join(", ")
        }`,
        "the report directory is written by the migration alone; choose an empty or new directory"
      ))
    }
  })
