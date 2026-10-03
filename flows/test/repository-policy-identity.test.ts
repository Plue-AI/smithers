import { NodeServices } from "@effect/platform-node"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, FileSystem, Path } from "effect"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { bindRepositoryRegistry, provisionBuiltins, runningRepositoryPolicy } from "../repository/registry.ts"
import { systemFlows } from "./fixtures/system-flows.ts"

const platform = process.versions.bun ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer

const measuredPolicy = (changedFile?: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const source = {
      ...fs,
      readFileString: ((path: string, ...options: ReadonlyArray<unknown>) =>
        fs.readFileString(path, ...options as []).pipe(Effect.map((text) =>
          changedFile !== undefined && path.endsWith(`/repository/${changedFile}`) ?
            changedFile === "jev-checks.ts"
              ? text.replace("FLAG_PROBABILITY = 0.8", "FLAG_PROBABILITY = 0.7")
              : `${text}\n// Changed classifier policy.\n`
            : text
        ))) as typeof fs.readFileString
    }
    return yield* runningRepositoryPolicy.pipe(Effect.provideService(FileSystem.FileSystem, source))
  })

test("source repository policy fences an approved job after semantic judge code changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "repository-policy-identity-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    Effect.runPromise(effect.pipe(Effect.provide(platform)))
  const original = await run(measuredPolicy())
  assert.equal(await run(measuredPolicy()), original, "unchanged source keeps its identity")

  const builtins = await run(provisionBuiltins(root, original))
  const generated = await readFile(join(root, "builtin-flows", original, "repository", "setup", "flow.ts"), "utf8")
  assert.match(generated, /satisfies FlowBinding\.Declared/)
  assert.match(generated, /effects: undefined/)
  const base = await Effect.runPromise(
    Registry.make({ sources: [] }).pipe(Effect.provide(Discovery.layer), Effect.provide(platform))
  )
  const oldHost = bindRepositoryRegistry(base, builtins.registry, original, systemFlows)
  const approved = Descriptor.executionDigest(await Effect.runPromise(oldHost.get("repository/setup")))
  assert.ok(approved)
  assert.equal((await Effect.runPromise(oldHost.loadBody("repository/setup", approved)))._tag, "Module")

  for (const file of ["jev-checks.ts", "jev-duplicates.ts", "jev-reproduction.ts", "jev-score.ts"]) {
    const changed = await run(measuredPolicy(file))
    assert.notEqual(changed, original, `${file} must change the measured host policy`)
    const changedHost = bindRepositoryRegistry(base, builtins.registry, changed, systemFlows)
    const current = Descriptor.executionDigest(await Effect.runPromise(changedHost.get("repository/setup")))
    assert.notEqual(current, approved)
    await assert.rejects(
      Effect.runPromise(changedHost.loadBody("repository/setup", approved)),
      /Repository host policy changed after planning/
    )
  }
})
