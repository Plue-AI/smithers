import { Effect, FileSystem } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { collectSources, extractPaths } from "../coding/planning-sources.ts"
import { repositorySourceReader } from "../repository/inspection.ts"

test("repository evidence excludes retained evals and their symlink aliases while retaining source and authored flows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "repository-sources-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const internal = ".smithers/repository-jobs/issues/revision/evals.json"
  await mkdir(join(root, ".smithers/repository-jobs/issues/revision"), { recursive: true })
  await mkdir(join(root, ".smithers/flows"), { recursive: true })
  await writeFile(join(root, internal), "{\"expected\":\"HELD_OUT_EXPECTATION\"}")
  await symlink(internal, join(root, "answers.json"))
  await writeFile(join(root, "source.mjs"), "export const greeting = 'hello';")
  await writeFile(join(root, ".smithers/flows/flow.ts"), "// Ordinary authored flow")
  const { platform } = await import("../../packages/smithers/src/internal/NodeControlHost.ts")
  const captured = await Effect.runPromise(
    Effect.gen(function*() {
      const source = yield* repositorySourceReader(root, yield* FileSystem.FileSystem)
      return yield* collectSources(
        source,
        extractPaths(`Read ${internal}, answers.json, source.mjs and .smithers/flows/flow.ts`)
      )
    }).pipe(Effect.provide(platform.host))
  )
  assert.deepEqual(captured.sources.map((source) => source.path), ["source.mjs", ".smithers/flows/flow.ts"])
  assert.deepEqual(captured.missing, [])
  assert(!JSON.stringify(captured).includes("HELD_OUT_EXPECTATION"))
})
