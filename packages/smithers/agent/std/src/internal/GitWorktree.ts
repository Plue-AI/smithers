/**
 * Detached checkouts shared by checkpoint reads and baseline test runs.
 *
 * ## Host git never reads a file the agent can write that names a program
 *
 * The repository is the workspace's, and an agent can write its `.git`: a
 * containerised agent writes it through the bind mount. Git reads programs out
 * of that directory in more places than any list of `-c` overrides can close.
 * Hooks and `core.fsmonitor` can be overridden, but a filter driver
 * (`filter.<name>.clean`/`.smudge` in `.git/config`, selected by
 * `.git/info/attributes`) cannot: git has no switch that ignores repository
 * config or `$GIT_DIR/info/attributes`, and overriding each driver by name
 * races an agent that keeps rewriting the file.
 *
 * So the git that records and checks out trees runs against a **shadow**
 * `GIT_DIR`: a bare repository this module creates under the host's temporary
 * directory for one operation and deletes afterwards. Its config, hooks and
 * `info/attributes` are the ones `git init --template=` writes, which is none.
 * `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL=/dev/null` drop the host's own
 * config files too, so the only settings are the ones on the command line.
 * `GIT_OBJECT_DIRECTORY` points at the workspace's object store, because objects
 * are data: git hashes and inflates them and never runs anything they say.
 *
 * What still touches the workspace repository is plain data:
 *
 * - `rev-parse` in the workspace, which resolves refs and paths and runs no
 *   hook, filter, fsmonitor or other configured program;
 * - `git config --file <workspace config>`, which reads or writes that one file
 *   and follows no `include`;
 * - a copy of the workspace index into the shadow, so the recorded tree holds
 *   what the agent staged without the harness writing the agent's index; and
 * - a handful of `core.*` settings that change how bytes are hashed
 *   ({@link dataSettings}), each accepted only as a bare word.
 *
 * A materialized checkout gets its own standalone `.git`, written by this
 * module as files, so a container can still run git in it: `HEAD` names the
 * commit, `objects/info/alternates` points back at the workspace's objects by a
 * relative path, and `index` is the one the checkout was written from. Host git
 * never uses that directory; it is the container's.
 *
 * @since 1.0.0
 */

import type { ChildProcessSpawner } from "@smthrs/kernel/ChildProcessSpawner"
import { Effect } from "effect"
import * as StdError from "../StdError.ts"
import * as Exec from "./Exec.ts"

const failed = (message: string, code: StdError.Code = "command_failed") => new StdError.StdError({ code, message })

/**
 * Settings that stop the workspace repository from naming a program for the
 * `rev-parse` this module runs in it. `rev-parse` runs none of them; these keep
 * that true if a later call is added beside it.
 */
const hostGitSettings = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const

/** Host config files git would otherwise read, removed from every shadow command. */
const isolated = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } as const

/**
 * Workspace settings that change how a tree is hashed or compared, carried
 * onto the shadow so a checkpoint records what the agent's own git would.
 * None of them names a program.
 */
const dataSettings = /^core\.(autocrlf|eol|safecrlf|filemode|symlinks|ignorecase|precomposeunicode)$/

/** A setting value this module will repeat to git: a bare word, never a command. */
const bareWord = /^[A-Za-z0-9_-]+$/

const run = (command: string, args: ReadonlyArray<string>, env?: Readonly<Record<string, string>>) =>
  Exec.exec(command, { args, ...(env === undefined ? {} : { env }) }).pipe(
    Effect.mapError((error) => failed(`${command} could not run: ${error.message}`))
  )

/**
 * Runs host git in the workspace at `root`, for `rev-parse` only.
 *
 * @category utilities
 * @since 1.0.0
 */
const git = (root: string, args: ReadonlyArray<string>) => run("git", [...hostGitSettings, "-C", root, ...args])

const resolveCommit = (root: string, refs: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    for (const ref of refs) {
      const answer = yield* git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
      const commit = answer.stdout.trim()
      if (answer.exitCode === 0 && commit !== "") return { ref, commit }
    }
    return yield* Effect.fail(failed(`No commit resolves from ${refs.join(" or ")} in ${root}.`, "not_found"))
  })

/**
 * Where one workspace repository keeps what the shadow needs, as its own git
 * reports it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Repository {
  /** The root the caller named, without a trailing slash. */
  readonly root: string
  /** The same directory, as git canonicalizes it. */
  readonly toplevel: string
  /** The common git directory, which holds config and objects. */
  readonly common: string
  /** The workspace index. */
  readonly index: string
  readonly objectFormat: string
  /** {@link dataSettings} as `-c` arguments. */
  readonly settings: ReadonlyArray<string>
}

/**
 * Reads or writes the workspace's config file as a file, never as a repository.
 *
 * `--git-dir=/dev/null` stops git discovering any repository around the host's
 * working directory, and `--file` reads the one file without `include`s.
 *
 * @category utilities
 * @since 1.0.0
 */
const config = (repository: Pick<Repository, "common">, args: ReadonlyArray<string>) =>
  run("git", ["--git-dir=/dev/null", "config", "--file", `${repository.common}/config`, ...args], isolated)

const open = (root: string): Effect.Effect<Repository, StdError.StdError, ChildProcessSpawner> =>
  Effect.gen(function*() {
    const stripped = root.replace(/\/+$/, "")
    const answer = yield* git(stripped, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
      "--git-path",
      "index",
      "--show-object-format"
    ])
    const [toplevel, common, index, objectFormat] = answer.stdout.split("\n").map((line) => line.trim())
    if (
      answer.exitCode !== 0 || toplevel === undefined || toplevel === "" || common === undefined || common === "" ||
      index === undefined || index === "" || objectFormat === undefined || !bareWord.test(objectFormat)
    ) {
      return yield* Effect.fail(failed(`${stripped} is not a git work tree: ${answer.stderr.trim()}`))
    }
    const found = yield* config({ common }, ["--get-regexp", dataSettings.source])
    const settings = found.exitCode === 0
      ? found.stdout.split("\n").flatMap((line) => {
        const [key, value] = line.trim().split(/\s+/)
        return key !== undefined && value !== undefined && dataSettings.test(key) && bareWord.test(value)
          ? ["-c", `${key}=${value}`]
          : []
      })
      : []
    return { root: stripped, toplevel, common, index, objectFormat, settings }
  })

const temporaryRoot = (): string => {
  const configured = globalThis.process?.env?.TMPDIR?.replace(/\/+$/, "")
  return configured === undefined || configured === "" ? "/tmp" : configured
}

const remove = (path: string) =>
  run("rm", ["-rf", "--", path]).pipe(
    Effect.flatMap((removed) => removed.exitCode === 0 ? Effect.void : Effect.fail(failed(removed.stderr.trim())))
  )

/**
 * A harness-owned `GIT_DIR` over one workspace's objects.
 *
 * @category models
 * @since 1.0.0
 */
export interface Shadow {
  readonly path: string
  readonly repository: Repository
  /** Runs host git with the shadow as `GIT_DIR`, and `workTree` as its work tree when given. */
  readonly git: (
    args: ReadonlyArray<string>,
    workTree?: string
  ) => Effect.Effect<Exec.ExecResult, StdError.StdError, ChildProcessSpawner>
  /** Copies the workspace index into the shadow, so the shadow never writes the agent's own. */
  readonly adoptIndex: Effect.Effect<void, StdError.StdError, ChildProcessSpawner>
}

const shadowOf = (repository: Repository, path: string): Shadow => ({
  path,
  repository,
  git: (args, workTree) =>
    run(
      "git",
      [
        `--git-dir=${path}`,
        ...(workTree === undefined ? [] : [`--work-tree=${workTree}`]),
        ...hostGitSettings,
        ...repository.settings,
        ...args
      ],
      { ...isolated, GIT_OBJECT_DIRECTORY: `${repository.common}/objects` }
    ),
  adoptIndex: run("sh", [
    "-c",
    "set -C; if [ -e \"$1\" ]; then cat -- \"$1\" > \"$2\"; fi",
    "sh",
    repository.index,
    `${path}/index`
  ]).pipe(
    Effect.flatMap((copied) =>
      copied.exitCode === 0
        ? Effect.void
        : Effect.fail(failed(`Could not read the workspace index: ${copied.stderr.trim()}`))
    )
  )
})

/**
 * Runs `use` with a fresh {@link Shadow} over the repository at `root`, and
 * deletes the shadow however `use` ends.
 *
 * @category utilities
 * @since 1.0.0
 */
const withShadow = <A, E, R>(
  root: string | Repository,
  use: (shadow: Shadow) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | StdError.StdError, R | ChildProcessSpawner> =>
  Effect.gen(function*() {
    const repository = typeof root === "string" ? yield* open(root) : root
    const path = `${temporaryRoot()}/smithers-git-${globalThis.crypto.randomUUID()}`
    return yield* Effect.acquireUseRelease(
      Effect.succeed(path),
      () =>
        Effect.gen(function*() {
          const created = yield* run(
            "git",
            ["init", "--quiet", "--bare", "--template=", `--object-format=${repository.objectFormat}`, path],
            isolated
          )
          if (created.exitCode !== 0) {
            return yield* Effect.fail(failed(`Could not create a shadow repository: ${created.stderr.trim()}`))
          }
          return yield* use(shadowOf(repository, path))
        }),
      () =>
        remove(path).pipe(
          Effect.catch((error) =>
            Effect.logWarning("could not remove a shadow repository").pipe(
              Effect.annotateLogs({ path, reason: error.message })
            )
          )
        )
    )
  })

/** `to` relative to `from`, both absolute POSIX paths. */
const relative = (from: string, to: string): string => {
  const source = from.split("/").filter((part) => part !== "")
  const target = to.split("/").filter((part) => part !== "")
  let shared = 0
  while (shared < source.length && shared < target.length && source[shared] === target[shared]) shared++
  return [...source.slice(shared).map(() => ".."), ...target.slice(shared)].join("/") || "."
}

/**
 * The config of a checkout's own `.git`, for the container's git.
 *
 * Only {@link dataSettings}, already restricted to bare words, reach it.
 */
const checkoutConfig = (repository: Repository): string => {
  const sha1 = repository.objectFormat === "sha1"
  const lines = [
    "[core]",
    `\trepositoryformatversion = ${sha1 ? 0 : 1}`,
    "\tbare = false",
    ...repository.settings.filter((_, index) => index % 2 === 1).map((setting) => {
      const [key, value] = setting.split("=")
      return `\t${key?.slice("core.".length)} = ${value}`
    }),
    ...(sha1 ? [] : ["[extensions]", `\tobjectformat = ${repository.objectFormat}`])
  ]
  return `${lines.join("\n")}\n`
}

/**
 * Writes `commit`'s tree into the new directory `host` from the shadow, then
 * gives the directory a standalone `.git` the container's git can use.
 *
 * `set -C` and a plain `mkdir` make the preparation create-only, so a
 * directory the agent swaps in before it is refused. The `read-tree` that
 * follows is not create-only: a symlink swapped in between the two steps is
 * followed and existing files in its target are overwritten. docs/api.md
 * states this residual.
 */
const checkout = (shadow: Shadow, host: string, commit: string) =>
  Effect.gen(function*() {
    const repository = shadow.repository
    const parent = host.slice(0, host.lastIndexOf("/"))
    const objects = relative(
      `${repository.toplevel}${host.slice(repository.root.length)}/.git/objects`,
      `${repository.common}/objects`
    )
    const prepared = yield* run("sh", [
      "-c",
      [
        "set -eC",
        "mkdir -p -- \"$1\"",
        "mkdir -- \"$2\" \"$2/.git\" \"$2/.git/objects\" \"$2/.git/objects/info\" \"$2/.git/refs\"",
        "printf '%s\\n' \"$3\" > \"$2/.git/HEAD\"",
        "printf '%s\\n' \"$4\" > \"$2/.git/objects/info/alternates\"",
        "printf '%s' \"$5\" > \"$2/.git/config\""
      ].join("; "),
      "sh",
      parent,
      host,
      commit,
      objects,
      checkoutConfig(repository)
    ])
    if (prepared.exitCode !== 0) {
      return yield* Effect.fail(failed(`Could not check out ${commit}: ${prepared.stderr.trim()}`))
    }
    const written = yield* shadow.git(["read-tree", "--reset", "-u", commit], host)
    if (written.exitCode !== 0) {
      return yield* Effect.fail(failed(`Could not check out ${commit}: ${written.stderr.trim()}`))
    }
    const indexed = yield* run("sh", [
      "-c",
      "set -C; cat -- \"$1\" > \"$2\"",
      "sh",
      `${shadow.path}/index`,
      `${host}/.git/index`
    ])
    if (indexed.exitCode !== 0) {
      return yield* Effect.fail(failed(`Could not check out ${commit}: ${indexed.stderr.trim()}`))
    }
  })

const withDetachedWorktree = <A, E, R>(
  root: string,
  prefix: string,
  commit: string,
  use: (host: string) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | StdError.StdError, R | ChildProcessSpawner> =>
  Effect.gen(function*() {
    // Allocate on execution, including when the same Effect is run twice.
    // Never remove an existing checkout: another call may still be using it.
    const host = `${root.replace(/\/+$/, "")}/${prefix}-${globalThis.crypto.randomUUID()}`
    return yield* Effect.acquireUseRelease(
      Effect.succeed(host),
      () =>
        Effect.gen(function*() {
          yield* withShadow(root, (shadow) => checkout(shadow, host, commit))
          return yield* use(host)
        }),
      // A checkout left behind is a stale copy of the repository inside the
      // workspace. Walks prune it, but the operator must still hear about it.
      () =>
        remove(host).pipe(
          Effect.catch((error) =>
            Effect.logWarning("could not remove a scratch checkout").pipe(
              Effect.annotateLogs({ path: host, reason: error.message })
            )
          )
        )
    )
  })

/**
 * Internal Git operations used by both checkpoint and baseline leases.
 *
 * @category utilities
 * @since 1.0.0
 */
export const GitWorktree = { config, git, open, resolveCommit, withDetachedWorktree, withShadow }
