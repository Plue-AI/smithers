/**
 * Explicit access to the build host's process environment.
 *
 * @since 0.1.0
 */

import * as NodePath from "node:path"

/**
 * Reads the ambient process environment by deliberate host choice.
 *
 * Using this gives up a caller-scoped, hermetic environment. Keep it at host
 * tool-discovery boundaries; execution paths with a configured environment
 * pass that value instead.
 *
 * @category accessors
 * @since 0.1.0
 */
export const ambientEnvironment = (): Readonly<Record<string, string | undefined>> => process.env

/**
 * Resolves relative `PATH` entries against the launch directory and drops
 * empty ones, in place.
 *
 * Launchers such as `pnpm exec` prepend `./node_modules/.bin`. Action-backed
 * targets refuse a relative lookup directory because package-directory probes
 * could select other executable bytes, so the process entry fixes each entry
 * to the directory the command was started in. Absolute entries, their order,
 * and a missing `PATH` stay unchanged.
 *
 * @category mutations
 * @since 1.0.0
 */
export const anchorSearchPath = (env: Record<string, string | undefined>, cwd: string): void => {
  const searchPath = env["PATH"]
  if (searchPath === undefined) return
  const entries = searchPath.split(NodePath.delimiter)
  if (entries.every((entry) => NodePath.isAbsolute(entry))) return
  env["PATH"] = entries
    .filter((entry) => entry !== "")
    .map((entry) => NodePath.isAbsolute(entry) ? entry : NodePath.resolve(cwd, entry))
    .join(NodePath.delimiter)
}
