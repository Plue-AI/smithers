/**
 * `smthrs update`: the registry check, after the shared guard.
 *
 * @since 1.0.0
 */

import { Effect } from "effect"
import * as CliError from "../CliError.ts"
import * as Update from "../Update.ts"
import { packageVersion } from "../Version.ts"
import * as Globals from "./Globals.ts"

/**
 * Compares the installed version with the registry's dist-tags.
 * @category constructors
 * @since 1.0.0
 */
export const check = (
  globals: Globals.Options
): Effect.Effect<Update.Status, CliError.UnsupportedError> =>
  Effect.gen(function*() {
    yield* Globals.guard(globals)
    const tags = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(Update.registryUrl, { signal: AbortSignal.timeout(10_000) })
        return await response.json() as Record<string, string>
      },
      catch: (error) =>
        new CliError.UnsupportedError({
          message: `Could not reach the npm registry: ${error instanceof Error ? error.message : String(error)}`
        })
    })
    return Update.compare(packageVersion, tags)
  })
