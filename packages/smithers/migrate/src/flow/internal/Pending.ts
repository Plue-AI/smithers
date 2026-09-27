/**
 * Unresolved checkpoints survive every retry until operator recovery.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Fs from "../../internal/Fs.ts"
import { io, make, type MigrateError } from "../../MigrateError.ts"

/**
 * Checks presence without trusting or replacing a possibly incomplete record.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const assertClear = (
  reportDirectory: string
): Effect.Effect<void, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(reportDirectory, "pending-unit.json")
    const found = yield* Fs.optionalNotFound(fs.stat(file)).pipe(
      Effect.mapError(io(`could not inspect the pending checkpoint ${file}`))
    )
    if (Option.isNone(found)) return
    return yield* Effect.fail(make(
      "checkpoint-failed",
      `an earlier migration has an unresolved checkpoint at ${file}`,
      `inspect that recovery record and restore its checkpoint; verify the recovered project, then remove only ${file} and rerun. Keep its backups until recovery is complete. Choosing another report directory does not clear the checkpoint.`
    ))
  })
