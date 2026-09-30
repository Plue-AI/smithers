/**
 * The language servers a native agent host binds, so `edit`, `write` and
 * `apply_patch` return the errors they leave and `bash` keeps the files a
 * server holds open current.
 *
 * Only host copies are bound: a server whose program, or the TypeScript it
 * would run, resolves inside the workspace is left out, because files an
 * agent wrote would then choose what the host executes. Each server starts on
 * the first file it serves, so a run that never touches one never spawns it.
 *
 * @since 1.0.0
 * @private
 */

import type * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as LanguageServer from "@smthrs/std/LanguageServer"
import * as NodeLanguageServer from "@smthrs/std/NodeLanguageServer"
import { Context, Effect, type Scope } from "effect"
import { accessSync, constants, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { delimiter, isAbsolute, join, relative, resolve } from "node:path"

/**
 * The files typescript-language-server answers for.
 *
 * @since 1.0.0
 * @private
 */
export const TYPESCRIPT_EXTENSIONS: ReadonlyArray<string> = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs"
]

/**
 * How long an edit waits for typescript-language-server to publish. Measured
 * for #2884 with `@smthrs/std`'s `scripts/lsp-settle-bench.ts`: a change
 * was published after 360 to 520 ms in probes on a small project, and after
 * up to 2.35 s on this repository at load average 40 and above. A change that
 * leaves a file with no problems, which the server never publishes for, costs
 * this long.
 *
 * @since 1.0.0
 * @private
 */
export const TYPESCRIPT_SETTLE_MS = 3_000

/**
 * How long an edit waits after a publish for a later one. The server
 * publishes syntax errors before semantic ones on a file's first open, 110 to
 * 180 ms apart in the probes; under heavy load the gap passed this (up to
 * 1.4 s), and the answer is then the syntax errors alone.
 *
 * @since 1.0.0
 * @private
 */
export const TYPESCRIPT_QUIET_MS = 500

const realPath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const within = (root: string, path: string): boolean => {
  const inside = relative(root, path)
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))
}

/** The real path of the executable `name` on `PATH`, skipping relative entries. */
const onPath = (name: string, PATH: string): string | undefined => {
  for (const directory of PATH.split(delimiter)) {
    if (directory === "" || !isAbsolute(directory)) continue
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return realpathSync(candidate)
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * typescript-language-server from the host's `PATH`, pinned to the TypeScript
 * installed beside it, or `undefined` when either is missing or lies in the
 * workspace. Automatic type acquisition is off, so the server never runs npm.
 *
 * @since 1.0.0
 * @private
 */
export const typescript = (
  workspaceRoot: string,
  environment: Readonly<Record<string, string | undefined>>
): NodeLanguageServer.Config | undefined => {
  const roots = [resolve(workspaceRoot), realPath(workspaceRoot)]
  const inWorkspace = (path: string) => roots.some((root) => within(root, path))
  const program = onPath("typescript-language-server", environment.PATH ?? "")
  if (program === undefined || inWorkspace(program)) return undefined
  let tsserver: string
  try {
    tsserver = realpathSync(createRequire(program).resolve("typescript/lib/tsserver.js"))
  } catch {
    return undefined
  }
  if (inWorkspace(tsserver)) return undefined
  return {
    command: program,
    args: ["--stdio"],
    cwd: workspaceRoot,
    extensions: TYPESCRIPT_EXTENSIONS,
    initializationOptions: { tsserver: { path: tsserver }, disableAutomaticTypingAcquisition: true },
    settleMs: TYPESCRIPT_SETTLE_MS,
    quietMs: TYPESCRIPT_QUIET_MS
  }
}

/**
 * The host's language servers for `workspaceRoot`, started lazily in the
 * current scope through the given spawner, or `undefined` when the host has
 * none.
 *
 * @since 1.0.0
 * @private
 */
export const make = (
  workspaceRoot: string,
  environment: Readonly<Record<string, string | undefined>>
): Effect.Effect<
  LanguageServer.LanguageServer | undefined,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> => {
  const configs = [typescript(workspaceRoot, environment)].filter((config) => config !== undefined)
  if (configs.length === 0) return Effect.succeed(undefined)
  // `typescript` already refused every program the workspace supplies, which
  // is the only refusal `makeLazy` makes before a server starts.
  return Effect.orDie(NodeLanguageServer.makeLazy(configs))
}

/**
 * `services` with `server` bound, for the flows that keep it in step: the
 * file flows and `bash`.
 *
 * @since 1.0.0
 * @private
 */
export const bind = <S>(
  services: Context.Context<S>,
  server: LanguageServer.LanguageServer | undefined
): Context.Context<S> => server === undefined ? services : Context.add(services, LanguageServer.LanguageServer, server)
