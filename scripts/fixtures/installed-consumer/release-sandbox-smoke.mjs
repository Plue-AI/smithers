import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import { DirectorySandbox } from "@smthrs/sandbox"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Echo } from "./release-sandbox-entry.mjs"
import { assertInstalledConsumer } from "./consumer-boundary.mjs"

assertInstalledConsumer(import.meta.url)

const root = await mkdtemp(join(tmpdir(), "smithers-release-sandbox-"))
try {
  const platform = NodeHost.layerContained().pipe(
    Layer.provide(ProcessLedger.layerMemory({ hostId: "release-sandbox-smoke", ownerPid: process.pid }))
  )
  const formats = [
    ["esm", await import("@smthrs/flows/SandboxedFlow")],
    ["cjs", createRequire(import.meta.url)("@smthrs/flows/SandboxedFlow")]
  ]
  // Keep the contained host and its ledger alive until both guest executions
  // and their session cleanup have completed.
  await Effect.runPromise(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner
    const provider = DirectorySandbox.make({ fs, spawner, root })
    for (const [format, sandbox] of formats) {
      const result = yield* sandbox.execute(Echo, { value: `release-${format}` }, {
        provider,
        session: `release-${format}`,
        entry: new URL("./release-sandbox-entry.mjs", import.meta.url)
      })
      assert.equal(result.output, `release-${format}`)
      assert.equal(result.work, null)
      console.log(`sandbox smoke ok: ${format} bundles and executes its packaged guest runner`)
    }
  }).pipe(Effect.provide(platform), Effect.scoped))
} finally {
  await rm(root, { recursive: true, force: true })
}
