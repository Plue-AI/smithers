/** Private control persistence over the selected native SQL adapter.
 * @since 1.0.0
 */

import * as DurableWriter from "@smthrs/database/DurableWriter"
import { Effect, FileSystem, Layer, Path } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Migrations from "./ControlDatabaseMigrations.ts"

/** Uses injected filesystem and path services, and opens only the supplied SQL adapter.
 * @since 1.0.0
 * @private
 */
export const make = (database: (filename: string) => Layer.Layer<SqlClient>) => (file: string) => {
  // Memoize the entire asynchronous adapter construction. Layer.unwrap only
  // memoizes its factory effect; its generated dependency graph can otherwise
  // acquire a distinct client for the journal, writer and runtime.
  const sql = Layer.suspend(() =>
    Layer.unwrap(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = path.dirname(file)
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
      if (process.platform !== "win32") yield* fs.chmod(directory, 0o700)
      return database(file)
    }))
  )
  return Layer.provideMerge(Migrations.layer, Layer.provideMerge(DurableWriter.layer(), sql)).pipe(
    Layer.tap(() =>
      Effect.gen(function*() {
        if (process.platform === "win32") return
        const fs = yield* FileSystem.FileSystem
        for (const filename of [file, `${file}-wal`, `${file}-shm`]) {
          if (yield* fs.exists(filename)) yield* fs.chmod(filename, 0o600)
        }
      })
    )
  )
}

/** Opens an existing store with the supplied read-only SQL adapter: no directory,
 * migration or permission change.
 * @since 1.0.0
 * @private
 */
export const observe = (database: (filename: string) => Layer.Layer<SqlClient>) => (file: string) =>
  Layer.provideMerge(DurableWriter.layer(), database(file))
