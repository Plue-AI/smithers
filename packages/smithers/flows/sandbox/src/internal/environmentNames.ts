/**
 * Rejects environment names no guest shell would carry.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"

/**
 * The names a shell keeps: POSIX "name", a letter or underscore followed by
 * letters, digits, and underscores.
 */
const shellName = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Refuses a spawn whose environment holds a name a shell will not carry.
 *
 * Every provider runs the caller's command through a shell, because the
 * command is arbitrary shell text, and a shell rebuilds its environment from
 * the entries whose names are shell identifiers when it starts. `env(1)` and
 * a vendor's environment field both deliver `a-b=1` to the process they
 * start; the shell that process is then discards it, so the command runs
 * without the variable. Dash, which is `/bin/sh` on Debian and Ubuntu, drops
 * it. Bash, which is `/bin/sh` on macOS, keeps it. No arrangement of the
 * delivery fixes this, because the shell doing the dropping is the one that
 * has to interpret the command.
 *
 * The name is therefore refused before the command starts. A silent drop
 * would be worst: it is invisible to the host, so nothing downstream can
 * report it, and it lands only on the platform the machines actually run,
 * which is how one reached CI green on a developer's Mac and red on Linux.
 * Refusing fails closed, says which name and why, and gives every provider
 * and both platforms the same answer.
 *
 * Only names with a value are checked. An entry set to `undefined` asks for
 * no variable at all, so nothing can be lost by carrying it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const checkEnvironmentNames = (
  env: Readonly<Record<string, string | undefined>> | undefined
): Effect.Effect<void, ProviderError> => {
  const unusable = Object.entries(env ?? {})
    .filter((entry) => entry[1] !== undefined && !shellName.test(entry[0]))
    .map((entry) => entry[0])
  return unusable.length === 0 ? Effect.void : Effect.fail(
    new ProviderError({
      code: "spawn_error",
      message: `the environment cannot carry ${unusable.join(", ")}: a POSIX shell keeps only names ` +
        `matching [A-Za-z_][A-Za-z0-9_]* and drops the rest when it starts, so the command would run ` +
        `without them`
    })
  )
}
