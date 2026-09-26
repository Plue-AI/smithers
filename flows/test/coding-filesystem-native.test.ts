import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as CodingFileSystem from "../coding/filesystem.ts"

const helper = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
test("packaged helper guards ignored files and unbounded mutation forms", {
  skip: helper === undefined ? "Build the workspace helper and set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY" : false,
  timeout: 120_000
}, async (t) => {
  assert.ok(helper)
  const directory = await mkdtemp(join(tmpdir(), "coding-file-policy-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, "repo")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  await writeFile(join(root, ".gitignore"), "*.ignore\n")
  await writeFile(join(root, "ordinary.txt"), "ordinary\n")
  await writeFile(join(root, "blocked.ignore"), "blocked\n")
  execFileSync("jj", ["-R", root, "status"], { stdio: "pipe" })
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const coding = CodingFileSystem.make(
        { repositoryPath: root, helperPath: helper },
        fs,
        spawner,
        yield* fs.realPath(root)
      )
      const denied = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.result,
          Effect.map((result) => {
            assert.equal(result._tag, "Failure")
          })
        )
      yield* denied(coding.writeFileString(join(root, "blocked.ignore"), "changed\n"))
      yield* denied(coding.rename(join(root, "ordinary.txt"), join(root, "destination.ignore")))
      yield* denied(coding.remove(root, { recursive: true }))
      yield* coding.writeFileString(join(root, "ordinary.txt"), "changed\n")
    }).pipe(Effect.provide(NodeServices.layer))
  )
  assert.equal(await readFile(join(root, "blocked.ignore"), "utf8"), "blocked\n")
  assert.equal(await readFile(join(root, "ordinary.txt"), "utf8"), "changed\n")
})
