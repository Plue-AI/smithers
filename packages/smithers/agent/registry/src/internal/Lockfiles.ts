/**
 * Shared dependency measurement for discovery and execution snapshots.
 * @since 1.0.0-rc.1
 */

import * as Digest from "@smthrs/core/Digest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"

const lockfiles = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"]
/** Measure the repository dependency environment without executing it.
 * @category utilities
 * @since 1.0.0-rc.1
 */
export const measureLockfiles = (root: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem, path = yield* Path.Path
    const measured: Array<readonly [string, string]> = []
    for (const name of lockfiles) {
      const bytes = yield* fs.readFile(path.join(root, name)).pipe(
        Effect.map(Option.some),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none()))
      )
      if (Option.isSome(bytes)) measured.push([name, Digest.digest(bytes.value)])
    }
    return Digest.digest(new TextEncoder().encode(JSON.stringify(measured)))
  })
