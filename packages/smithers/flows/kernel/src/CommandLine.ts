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
 * The capability resource is the rendered line alone, so `cwd`, environment
 * overrides, and pipeline `from`/`to` routing remain outside the grant. The
 * spawner sends `cwd` and overridden environment names to attended surfaces as
 * display metadata only.
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
