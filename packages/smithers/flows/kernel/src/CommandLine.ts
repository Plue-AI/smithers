/**
 * @since 1.0.0-rc.0
 *
 * Rendering an `effect/unstable/process` `Command` back to a shell command
 * line.
 *
 * Two callers need the same string and must agree on it exactly:
 *
 *  1. `@smthrs/kernel/ChildProcessSpawner` uses it as the `proc:spawn`
 *     capability resource, so a grant reads the way an operator wrote it; and
 *  2. `@smthrs/platform-browser/BrowserChildProcessSpawner` uses it as the line
 *     it hands to the in-browser bash interpreter, which has no `argv` to spawn
 *     with.
 *
 * A single renderer keeps a granted capability and the command a browser
 * actually runs from drifting apart.
 *
 * The module is pure string handling — no host access — so it stays on the
 * browser-safe side of the package.
 */

import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { isInheritedName } from "./ChildProcessEnvironment.ts"

/** Tokens made only of these characters need no quoting in a POSIX shell. */
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * Quotes one token for a POSIX shell, leaving obviously safe tokens alone.
 *
 * @category rendering
 * @since 1.0.0-rc.0
 */
export const quote = (token: string): string =>
  token !== "" && SAFE.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`

/**
 * Renders a `Command` as a single shell command line.
 *
 * A standard command with `shell: true` renders its tokens verbatim, matching
 * the line Node and the browser interpreter hand to the default shell. A
 * custom shell renders as an explicit `<shell> -c <line>` invocation so the
 * selected executable is part of the permission resource. Without `shell`,
 * every token is POSIX-quoted to preserve literal argv semantics. These
 * distinctions are security-sensitive: the rendered value is also the
 * `proc:spawn` capability resource, so it must describe what will execute.
 * The rendering is POSIX-only by contract: on Windows, Node invokes the shell
 * with `/d /s /c` rather than `-c`, so the rendered line describes the POSIX
 * invocation, not a cmd.exe one.
 *
 * The `proc:spawn` capability resource is {@link resource}, which starts from
 * this line and adds what the line alone cannot show.
 *
 * A `PipedCommand` renders with `|` between its sides. That is a faithful
 * rendering of what the pipeline does, and it is the only form an interpreter
 * that takes a command line rather than an `argv` can be given. `from`/`to`
 * pipe options are *not* expressible this way; rendering ignores them, so a
 * pipeline that redirects `stderr` renders like one that pipes `stdout`.
 * Capability checks therefore see the commands, never the plumbing.
 *
 * @category rendering
 * @since 1.0.0-rc.0
 */
export const render = (command: ChildProcess.Command): string =>
  command._tag === "StandardCommand"
    ? command.options.shell === undefined || command.options.shell === false
      ? [command.command, ...command.args].map(quote).join(" ")
      : command.options.shell === true
      ? [command.command, ...command.args].join(" ")
      : `${quote(command.options.shell)} -c ${quote([command.command, ...command.args].join(" "))}`
    : `${render(command.left)} | ${render(command.right)}`

/**
 * Shell syntax that chains, substitutes, groups, or redirects: everything that
 * lets one shell line run or write more than a single simple command.
 */
const shellControl = /[;&|`$<>()\n\r]/

/**
 * Redirections that neither run nor write anything a grant should see: an fd
 * duplication such as `2>&1` and a discard to `/dev/null`. They are removed
 * before {@link shellControl} is tested, so `git status 2>&1` keeps its
 * verbatim resource. Only a space or tab may sit between `>` and `/dev/null`:
 * `>` followed by a line break is not a discard, so it stays control syntax.
 */
const harmlessRedirect = /(^|\s)(?:\d*>&\d+|\d*>[ \t]*\/dev\/null)(?=\s|$)/g

/**
 * What {@link resource} compares a stage against, supplied by the spawner that
 * checks it.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface ResourceContext {
  /**
   * The environment the spawning process itself holds. A bootstrap name
   * (`PATH`, `HOME`, ...) whose declared value equals the ambient value is the
   * inherited default and stays out of the resource; one set to anything else
   * is named. Omitted, every declared bootstrap name is named.
   */
  readonly ambient?: Readonly<Record<string, string | undefined>> | undefined
  /**
   * Whether a stage's working directory is inside the directory the flow
   * already governs. A `cwd` it rejects is named in the resource. Omitted,
   * every `cwd` a stage sets is named.
   */
  readonly contains?: ((directory: string) => boolean) | undefined
  /**
   * The stage `cwd` with every symlink resolved, when the host could resolve
   * it. It replaces the lexical `cwd` both for `contains` and in the
   * `cwd <path> -- ` prefix, so a symlink inside the governed directory that
   * leads out of it is judged, and shown, by where the command really runs.
   */
  readonly resolvedCwd?: string | undefined
}

/**
 * Names of the environment variables a stage sets that the child would not
 * otherwise inherit: every name outside the bootstrap set, and a bootstrap
 * name whose value differs from the ambient one.
 */
const overriddenNames = (
  command: ChildProcess.StandardCommand,
  ambient: Readonly<Record<string, string | undefined>>
): ReadonlyArray<string> =>
  Object.entries(command.options.env ?? {})
    .filter(([name, value]) => value !== undefined && (!isInheritedName(name) || ambient[name] !== value))
    .map(([name]) => name)
    .sort()

/**
 * The stages of a command in execution order: the command itself, or every
 * `StandardCommand` of a pipeline from left to right. The spawner checks each
 * stage as its own `proc:spawn` capability.
 *
 * @category rendering
 * @since 1.0.0-rc.1
 */
export const stages = (command: ChildProcess.Command): ReadonlyArray<ChildProcess.StandardCommand> =>
  command._tag === "StandardCommand" ? [command] : [...stages(command.left), ...stages(command.right)]

/**
 * The `proc:spawn` capability resource for one stage: {@link render}, with
 * three additions that keep a prefix grant from authorizing code the stage
 * never named.
 *
 *  - A `shell: true` stage whose line holds shell control syntax (`;`, `&`,
 *    `|`, `` ` ``, `$`, `<`, `>`, `(`, `)`, or a line break) is marked as the
 *    explicit `sh -c '<line>'` it is. A grant such as `git status *` then
 *    cannot match `git status; curl x | sh`, while a simple shell line such as
 *    `git status --short` keeps its verbatim resource. An fd duplication such
 *    as `2>&1` and a discard to `/dev/null` do not count as control syntax.
 *  - A stage that sets an environment variable the child would not otherwise
 *    inherit is prefixed with `env <NAME>… -- `, sorted names only. That is
 *    every name outside the bootstrap set `ChildProcessEnvironment` inherits
 *    (`PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`, `SHELL`, `LC_*`), and a
 *    bootstrap name whose value differs from `context.ambient`. A grant for
 *    `git status` covers neither `env GIT_SSH_COMMAND -- git status` nor
 *    `env PATH -- git status`. Values never enter the resource because they
 *    often carry credentials.
 *  - A stage whose `cwd` `context.contains` rejects is prefixed with
 *    `cwd <path> -- `, so a grant does not follow the command into a
 *    directory whose configuration the flow does not govern. When
 *    `context.resolvedCwd` is given, that real path is judged and named
 *    instead of the lexical `cwd`.
 *
 * A pipeline has no single resource: the spawner checks every one of its
 * {@link stages}, so `git status | sh` needs a grant for `sh` too.
 *
 * The `env` and `cwd` prefixes share their spelling with a literal command:
 * `make("env", ["PATH", "--", "git", "status"])` renders as
 * `env PATH -- git status`, the resource of `git status` with `PATH`
 * overridden. The alias grants nothing extra. The literal command runs a
 * program named `PATH` (or `cwd`) from the ambient `PATH`, not `git`. A grant
 * with `*` inside the prefix, such as `env * -- git status`, also matches
 * `env -C /x -- git status`, but it already admits any variable name,
 * including `GIT_SSH_COMMAND` and `LD_PRELOAD`, which run arbitrary code.
 * Grant a prefixed resource exactly as the request shows it.
 *
 * @category rendering
 * @since 1.0.0-rc.1
 */
export const resource = (command: ChildProcess.StandardCommand, context: ResourceContext = {}): string => {
  const line = render(command)
  const shown = command.options.shell === true && shellControl.test(line.replace(harmlessRedirect, "$1"))
    ? `sh -c ${quote(line)}`
    : line
  const names = overriddenNames(command, context.ambient ?? {})
  const withEnv = names.length === 0 ? shown : `env ${names.map(quote).join(" ")} -- ${shown}`
  const directory = command.options.cwd === undefined ? undefined : context.resolvedCwd ?? command.options.cwd
  return directory === undefined || context.contains?.(directory) === true
    ? withEnv
    : `cwd ${quote(directory)} -- ${withEnv}`
}

/** The leading token of a shell line, which is the program the line runs. */
const program = (line: string): string => {
  const trimmed = line.trimStart()
  const end = trimmed.search(/\s/)
  return end === -1 ? trimmed : trimmed.slice(0, end)
}

/**
 * The executable a command runs, without its arguments.
 *
 * A durable record of a spawned process names its program with this rather
 * than with {@link render}: arguments carry credentials (`curl -u user:pass`,
 * `mysql -phunter2`), and a journal that keeps them keeps them permanently.
 * Nothing that reads such a record needs more than the program name; a reaper
 * matches processes by pid and process group.
 *
 * Without `shell`, `command` is the executable itself, spaces and all. With a
 * shell, the line is what runs, so the program is its first token: both
 * `make("mysql -phunter2", [], { shell: true })` and
 * `make("mysql", ["-phunter2"])` yield `mysql`. A pipeline names one
 * executable per stage, joined the way {@link render} joins the stages.
 *
 * @category rendering
 * @since 1.0.0-rc.0
 */
export const executable = (command: ChildProcess.Command): string =>
  command._tag === "StandardCommand"
    ? command.options.shell === undefined || command.options.shell === false
      ? command.command
      : program(command.command)
    : `${executable(command.left)} | ${executable(command.right)}`

/**
 * The working directory a command runs in, taking the leftmost stage of a
 * pipeline, which is the stage `setCwd` and the spawners agree to treat as the
 * pipeline's own directory.
 *
 * @category rendering
 * @since 1.0.0-rc.0
 */
export const cwd = (command: ChildProcess.Command): string | undefined =>
  command._tag === "StandardCommand" ? command.options.cwd : cwd(command.left)

/**
 * The environment overrides a command runs with, taking the leftmost stage of
 * a pipeline for the same reason {@link cwd} does.
 *
 * @category rendering
 * @since 1.0.0-rc.0
 */
export const env = (
  command: ChildProcess.Command
): Record<string, string | undefined> | undefined =>
  command._tag === "StandardCommand" ? command.options.env : env(command.left)
