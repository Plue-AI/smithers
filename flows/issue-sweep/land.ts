/**
 * Landing one agent's change on `main`: rebase it onto the current `main`,
 * run the tests of the packages it touches, and push it when they pass.
 *
 * The burndown's merge queue calls {@link landChange} one change at a time.
 * Every repository write takes the machine-wide VCS lock other landing tools
 * on this Mac share, when it exists. The checks run inside `codex sandbox`, so
 * code the agent wrote can write only its own workspace and has no network.
 */
import { Duration, Effect, Option, Result, Schema } from "effect"
import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { matchesGlob } from "node:path"
import { type Exited, type HostFailed, output, repository, run, tail, workspaces } from "./host.ts"

export class LandFailed extends Schema.TaggedError<LandFailed>()("issue-sweep/LandFailed", {
  message: Schema.String
}) {}

// ---------------------------------------------------------------------------
// Decisions (pure)
// ---------------------------------------------------------------------------

/** The package directory of a target label: `//a/b:test` is `a/b`, `//:x` is the root, `""`. */
export const packageOf = (label: string): string => label.slice(2, label.indexOf(":"))

/**
 * The packages `files` belong to: for each file, the deepest package directory
 * that contains it. A file only the root package contains selects nothing,
 * because the root package's tests are the whole repository's.
 */
export const packagesOf = (files: ReadonlyArray<string>, packages: ReadonlyArray<string>): ReadonlyArray<string> => {
  const owners = new Set<string>()
  for (const file of files) {
    let owner = ""
    for (const directory of packages) {
      if (directory.length > owner.length && file.startsWith(`${directory}/`)) owner = directory
    }
    if (owner !== "") owners.add(owner)
  }
  return [...owners].sort()
}

/** One declared input as `smthrs index --format json` lists it; `git-diff` inputs carry no path. */
export interface IndexedInput {
  readonly kind: string
  readonly path?: string | undefined
  readonly pattern?: string | undefined
  readonly exclude?: ReadonlyArray<string> | undefined
}

/** One target as `smthrs index --format json` lists it. */
export interface IndexedTarget {
  readonly label: string
  readonly kinds: ReadonlyArray<string>
  /** The exclusive tier (browser and end-to-end suites) that wildcard `test` and `ci` omit. */
  readonly exclusive?: boolean | undefined
  readonly inputs?: ReadonlyArray<IndexedInput> | undefined
}

const isE2ePath = (path: string): boolean => path.split("/").includes("e2e")

/**
 * Whether `file` is one of `target`'s e2e inputs: it matches a declared input
 * whose path or pattern runs through an `e2e` directory (`apps/app/e2e/**`).
 */
const touchesE2eInput = (target: IndexedTarget, file: string): boolean =>
  (target.inputs ?? []).some((input) => {
    if (input.pattern !== undefined) {
      return isE2ePath(input.pattern) && matchesGlob(file, input.pattern) &&
        !(input.exclude ?? []).some((exclude) => matchesGlob(file, exclude))
    }
    return input.path !== undefined && isE2ePath(input.path) && file === input.path
  })

/**
 * The test targets of the packages `files` touch, in label order.
 *
 * An exclusive target (a browser or end-to-end tier, about 22 minutes for
 * `//apps/app:browserE2e`) runs only when a changed file is one of its e2e
 * inputs; CI runs every exclusive tier by label on `main`. Ordinary test
 * targets of a touched package always run.
 */
export const testTargets = (
  files: ReadonlyArray<string>,
  index: ReadonlyArray<IndexedTarget>
): ReadonlyArray<string> => {
  const packages = [...new Set(index.map((target) => packageOf(target.label)))]
  const touched = new Set(packagesOf(files, packages))
  return index
    .filter((target) => target.kinds.includes("test") && touched.has(packageOf(target.label)))
    .filter((target) => target.exclusive !== true || files.some((file) => touchesE2eInput(target, file)))
    .map((target) => target.label)
    .sort()
}

/** What one `smthrs test` run decided. */
export type Checked =
  | { readonly _tag: "Green" }
  | { readonly _tag: "Red"; readonly labels: ReadonlyArray<string> }
  | { readonly _tag: "Broken"; readonly message: string }

// `smthrs test --known-red` names each failure the list does not excuse:
// "newly red, no matching failure in .github/ci-known-red.json: //pkg:test".
const newlyRed = /^newly red\b[^:]*: (\/\/\S+)\s*$/

const Refusal = Schema.fromJsonString(Schema.Struct({ code: Schema.String, message: Schema.String }))
const Report = Schema.fromJsonString(Schema.Struct({ ok: Schema.Boolean }))

/**
 * Reads one `smthrs test --format json --known-red ...` run. A run that
 * reported `ok` is green. A `targets_failed` refusal is red, listing the
 * targets the known-red list does not excuse. Anything else, such as a
 * workspace that could not be planned, means the checks never ran.
 */
export const readChecks = (exited: Exited): Checked => {
  const report = Schema.decodeUnknownOption(Report)(exited.stdout)
  if (exited.code === 0 && Option.isSome(report) && report.value.ok) return { _tag: "Green" }
  const refusal = Schema.decodeUnknownOption(Refusal)(exited.stdout)
  if (Option.isSome(refusal) && refusal.value.code === "targets_failed") {
    const labels = exited.stderr.split("\n").flatMap((line) => {
      const match = newlyRed.exec(line.trim())
      return match === null ? [] : [match[1]!]
    })
    if (labels.length > 0) return { _tag: "Red", labels: [...new Set(labels)].sort() }
    return { _tag: "Broken", message: refusal.value.message }
  }
  return {
    _tag: "Broken",
    message: Option.isSome(refusal)
      ? `${refusal.value.code}: ${refusal.value.message}`
      : `exit ${exited.code}: ${tail(exited.stderr)}`
  }
}

/**
 * The failures that block a landing: the targets red on the change that are
 * not also red on `main` itself. A target red on both was red before the
 * agent touched anything.
 */
export const blocking = (onChange: ReadonlyArray<string>, onMain: ReadonlyArray<string>): ReadonlyArray<string> => {
  const preexisting = new Set(onMain)
  return onChange.filter((label) => !preexisting.has(label))
}

// ---------------------------------------------------------------------------
// The repository (host)
// ---------------------------------------------------------------------------

// The machine-wide lock ~/Smithers-Ops/dispatch/vcs_lock.py takes for this
// checkout. lockf(1) takes the same flock(2) lock.
const lockFile = `${homedir()}/Smithers-Ops/dispatch/locks/smithers.lock`

const fail = (message: string) => new LandFailed({ message })
const asLand = <A, R>(effect: Effect.Effect<A, HostFailed | LandFailed, R>) =>
  Effect.mapError(effect, (error) => error._tag === "issue-sweep/LandFailed" ? error : fail(error.message))

/** A jj command in `workspace`, reading only. */
// jj prints paths relative to the process's directory, so every command runs
// from the workspace root: from anywhere else `diff --name-only` names
// `../smithers-sweep/issue-N/...`, which selects no package and no test.
const jj = (workspace: string, args: ReadonlyArray<string>) =>
  asLand(output("jj", ["-R", workspace, ...args], { cwd: workspace }))

/** The repository-relative paths `change` touches. */
export const changedFiles = (workspace: string, change: string) =>
  Effect.map(
    jj(workspace, ["diff", "--name-only", "-r", change]),
    (text) => text.split("\n").filter((file) => file !== "")
  )

/** A jj command in `workspace` that writes the shared repository, under the VCS lock. */
const jjWrite = (workspace: string, args: ReadonlyArray<string>) =>
  asLand(
    existsSync(lockFile)
      ? output("lockf", ["-k", "-t", "900", lockFile, "jj", "-R", workspace, ...args], { cwd: workspace })
      : output("jj", ["-R", workspace, ...args], { cwd: workspace })
  )

const one = (workspace: string, revision: string, template: string) =>
  Effect.map(jj(workspace, ["log", "--no-graph", "-r", revision, "-T", template]), (text) => text.trim())

/** Shared Go build cache every sandbox may write, so Go tests stay warm across issues. */
export const goCache = `${tmpdir()}/issue-sweep-go-build`

/**
 * Runs `command` in `workspace` inside Codex's workspace sandbox: writes only
 * under the workspace and the temporary directory, no network. smthrs
 * contains its own targets behind Unix sockets under /tmp.
 */
export const sandboxed = (workspace: string, command: ReadonlyArray<string>) =>
  run("codex", [
    "sandbox",
    "-P",
    ":workspace",
    "-C",
    workspace,
    "--allow-unix-socket",
    "/private/tmp",
    "--allow-unix-socket",
    "/tmp",
    "--",
    ...command
  ], { cwd: workspace, env: { GOCACHE: goCache } })

/**
 * Installs the workspace's locked dependencies from the local pnpm store.
 *
 * It runs on the host, because pnpm must read and write its store and cache
 * outside the workspace (inside `codex sandbox` it exits 1). Lifecycle
 * scripts are off; the repository's pnpmfile runs, so a change that edits it
 * never reaches an install (see {@link landChange}).
 */
export const install = (workspace: string) =>
  Effect.flatMap(
    run("pnpm", ["install", "--prefer-offline", "--frozen-lockfile", "--ignore-scripts"], { cwd: workspace }),
    (exited) =>
      exited.code === 0
        ? Effect.void
        : Effect.fail(fail(`pnpm install: exit ${exited.code}: ${tail(`${exited.stdout}\n${exited.stderr}`)}`))
  )

/** Files whose code the host runs during an install; a change to one needs a person. */
export const installHooks = [".pnpmfile.cjs", ".npmrc", "pnpm-workspace.yaml"]

const IndexJson = Schema.fromJsonString(Schema.Struct({
  targets: Schema.Array(Schema.Struct({
    label: Schema.String,
    kinds: Schema.Array(Schema.String),
    exclusive: Schema.optional(Schema.Boolean),
    inputs: Schema.Array(Schema.Struct({
      kind: Schema.String,
      path: Schema.optional(Schema.String),
      pattern: Schema.optional(Schema.String),
      exclude: Schema.optional(Schema.Array(Schema.String))
    }))
  }))
}))

// The longest one landing's checks may take before the change fails to land.
const checkBudget = Duration.minutes(90)

/** Runs `labels`' tests in `workspace`, sandboxed, against the repository's known-red list. */
const test = (workspace: string, labels: ReadonlyArray<string>) =>
  sandboxed(workspace, [
    "pnpm",
    "exec",
    "smthrs",
    "test",
    ...labels,
    "--known-red",
    ".github/ci-known-red.json",
    "--jobs",
    "4",
    "--format",
    "json",
    // The workspace's result cache is the agent's to write: a check that
    // read it would accept a result the agent recorded, not one it earned.
    "--no-cache"
  ]).pipe(
    Effect.map(readChecks),
    Effect.timeoutOrElse({
      duration: checkBudget,
      orElse: () =>
        Effect.succeed<Checked>({
          _tag: "Broken",
          message: `tests did not finish within ${Duration.format(checkBudget)}`
        })
    })
  )

// The workspace kept at `main` for telling a new red from an old one.
const baseline = `${workspaces}/baseline`

/** The labels among `labels` that are red on `main` at `revision`. */
const redOnMain = (labels: ReadonlyArray<string>, revision: string) =>
  Effect.gen(function*() {
    if (!existsSync(baseline)) {
      yield* jjWrite(repository, ["workspace", "add", baseline, "--name", "sweep-baseline", "-r", revision])
    } else {
      yield* jjWrite(baseline, ["new", revision])
    }
    yield* install(baseline)
    const checked = yield* test(baseline, labels)
    return checked._tag === "Red" ? checked.labels : checked._tag === "Green" ? [] : labels
  })

/** Whether `file` is documentation `pnpm docs:sync` generates other files from. */
export const isDocsSource = (file: string) => /(^|\/)docs\//.test(file) && !file.startsWith("apps/")

/**
 * Regenerates the documentation mirrors a change's docs edits feed, folds
 * what changed into the change, and requires `pnpm docs:check` to pass, so
 * a landing never leaves the generated docs behind their sources.
 */
const syncDocs = (workspace: string, change: string, files: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    if (!files.some(isDocsSource)) return
    const synced = yield* asLand(sandboxed(workspace, ["pnpm", "docs:sync"]))
    if (synced.code !== 0) {
      return yield* fail(`pnpm docs:sync for ${change}: exit ${synced.code}: ${tail(synced.stderr)}`)
    }
    if ((yield* jj(workspace, ["diff", "--name-only", "-r", "@"])).trim() !== "") {
      yield* jjWrite(workspace, ["squash", "--from", "@", "--into", change, "-u"])
    }
    const checked = yield* asLand(sandboxed(workspace, ["pnpm", "docs:check"]))
    if (checked.code !== 0) {
      return yield* fail(
        `pnpm docs:check for ${change}: exit ${checked.code}: ${tail(`${checked.stdout}\n${checked.stderr}`)}`
      )
    }
  })

/**
 * Lands the change `change` (a jj change id) from `workspace` on `main`, and
 * answers the landed commit id.
 *
 * Re-landing a change `main` already contains answers its commit, so a round
 * replayed after a crash never pushes twice. A conflict, a red test the
 * known-red list and `main` do not explain, or checks that cannot run fail
 * with {@link LandFailed} and leave the change in the repository for
 * inspection.
 */
export const landChange = (workspace: string, change: string) =>
  Effect.gen(function*() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      yield* jjWrite(workspace, ["git", "fetch"])
      const landed = yield* one(workspace, `${change} & ::main@origin`, "commit_id")
      if (landed !== "") return landed
      const main = yield* one(workspace, "main@origin", "commit_id")
      yield* jjWrite(workspace, ["rebase", "-s", change, "-d", main])
      if ((yield* one(workspace, change, `if(conflict, "conflict", "")`)) !== "") {
        return yield* fail(`change ${change} conflicts with main ${main.slice(0, 12)}`)
      }
      const files = yield* changedFiles(workspace, change)
      if (files.length === 0) return yield* fail(`change ${change} is empty on main ${main.slice(0, 12)}`)
      const hooks = files.filter((file) => installHooks.includes(file))
      if (hooks.length > 0) {
        return yield* fail(`change ${change} edits install hooks (${hooks.join(" ")}); land it by hand`)
      }
      yield* install(workspace)
      yield* syncDocs(workspace, change, files)
      const index = yield* asLand(Effect.flatMap(
        output("pnpm", ["exec", "smthrs", "index", "//...", "--format", "json"], { cwd: workspace }),
        (text) =>
          Effect.mapError(
            Schema.decodeUnknownEffect(IndexJson)(text),
            (cause) => fail(`smthrs index: ${cause.message}`)
          )
      ))
      const labels = testTargets(files, index.targets)
      if (labels.length > 0) {
        const checked = yield* test(workspace, labels)
        if (checked._tag === "Broken") return yield* fail(`checks did not run for ${change}: ${checked.message}`)
        if (checked._tag === "Red") {
          const blockers = blocking(checked.labels, yield* redOnMain(checked.labels, main))
          if (blockers.length > 0) return yield* fail(`checks red for ${change}: ${blockers.join(" ")}`)
        }
      }
      // Only a fast-forward may move main; a main that moved on means rebase and check again.
      yield* jjWrite(workspace, ["git", "fetch"])
      if ((yield* one(workspace, "main@origin", "commit_id")) !== main) continue
      const moved = yield* Effect.result(jjWrite(workspace, ["bookmark", "set", "main", "-r", change]))
      if (Result.isFailure(moved)) continue
      const pushed = yield* Effect.result(jjWrite(workspace, ["git", "push", "-b", "main"]))
      if (Result.isSuccess(pushed)) return yield* one(workspace, change, "commit_id")
    }
    return yield* fail(`main kept moving; ${change} not landed after 3 attempts`)
  })
