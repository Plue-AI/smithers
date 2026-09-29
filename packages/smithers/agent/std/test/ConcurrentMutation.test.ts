import { NodeServices } from "@effect/platform-node"
import { Cause, Effect, Exit, FileSystem, Option } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Edit from "../src/Edit.ts"

const readBarrier = () => {
  let arrivals = 0
  let release!: () => void
  const together = new Promise<void>((resolve) => {
    release = resolve
  })
  return () =>
    new Promise<void>((resolve) => {
      arrivals++
      if (arrivals === 2) release()
      // A correct lock permits only one read; this timeout prevents a deadlock.
      const timer = setTimeout(resolve, 200)
      void together.then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
}

describe("concurrent file mutation", () => {
  it("does not report two successful edits while losing one worker's change", async () => {
    const root = mkdtempSync(join(tmpdir(), "std-concurrent-edit-"))
    const path = join(root, "file.txt")
    writeFileSync(path, "alpha\nbeta\n")
    try {
      const pause = readBarrier()
      const results = await Effect.runPromise(
        Effect.gen(function*() {
          const native = yield* FileSystem.FileSystem
          const gated: FileSystem.FileSystem = {
            ...native,
            readFile: (file) => native.readFile(file).pipe(Effect.tap(() => Effect.promise(pause)))
          }
          return yield* Effect.all([
            Effect.exit(Edit.run({ path, oldString: "alpha", newString: "ALPHA" })),
            Effect.exit(Edit.run({ path, oldString: "beta", newString: "BETA" }))
          ], { concurrency: "unbounded" }).pipe(Effect.provideService(FileSystem.FileSystem, gated))
        }).pipe(Effect.provide(NodeServices.layer))
      )
      const content = readFileSync(path, "utf8")
      const successes = results.filter(Exit.isSuccess).length
      expect(successes).toBeGreaterThanOrEqual(1)
      for (const result of results) {
        if (Exit.isFailure(result)) {
          expect(Option.getOrUndefined(Cause.findErrorOption(result.cause))?.code).toBe("no_match")
        }
      }
      expect(successes === 2 && content !== "ALPHA\nBETA\n").toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
