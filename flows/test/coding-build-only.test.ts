import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { layerWired } from "../../packages/smithers/flows/flow/test/MemoryFlowRuntime.ts"
import { checkDelegate, checkLayers } from "../coding/checks.ts"
import { CodingError } from "../coding/schema.ts"

test("a registered build-only check refuses before any source export or process", async () => {
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const guarded: FileSystem.FileSystem = {
    ...fs,
    realPath: () => Effect.die(new Error("must not export an unconfigured build")),
    makeTempDirectoryScoped: () => Effect.die(new Error("must not export an unconfigured build"))
  }
  const revision = {
    changeId: "change",
    commitId: "commit",
    treeId: "tree",
    operationId: "operation",
    parentCommitIds: []
  }
  const invocation = {
    flow: "checks/build-only",
    prompt: "{\"argv\":[],\"cwd\":\".\",\"timeoutMs\":1800000}",
    model: null,
    placement: null,
    placementOptions: null,
    capabilities: ["fs:read:**"],
    flows: ["coding/CommandCheck"],
    input: {
      implementation: { change: "build", parent: revision, atoms: [revision], head: revision, reads: [], writes: [] },
      check: {
        id: "build-only",
        target: ".",
        flow: "checks/build-only",
        flowDigest: "literal-digest",
        tier: "fast",
        required: true
      }
    }
  }
  // Unit runtime: validation must fail before any filesystem/native dependency.
  const error = await Effect.runPromise(
    checkDelegate.execute(invocation, { executionId: "unconfigured-build" }).pipe(
      Effect.flip,
      Effect.scoped,
      Effect.provide(
        layerWired(
          checkLayers({ repositoryPath: "/must-not-export", fs: guarded }).pipe(Layer.provide(NodeServices.layer))
        ).pipe(Layer.provideMerge(NodeServices.layer))
      )
    )
  )
  assert.ok(error instanceof CodingError)
  assert.equal(error.code, "check_configuration")
  assert.equal(error.message, "no checks detected: configure an executable build command")
})
