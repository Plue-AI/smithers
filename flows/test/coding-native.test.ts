import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { NativeCoding, nativeLayer, type Operation, requestIdFor } from "../coding/native.ts"

test("native invocation UUIDs remain stable across retry and differ between durable actions", () => {
  const first = requestIdFor("execution-1", "create/database")
  assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.equal(requestIdFor("execution-1", "create/database"), first)
  assert.notEqual(requestIdFor("execution-1", "create/server"), first)
  assert.notEqual(requestIdFor("execution-2", "create/database"), first)
})

const helper = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
test("native file patches cannot bypass the unavailable atomic provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-native-file-gate-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, "a.txt")
  await writeFile(target, "original\n")
  const sentinel = join(root, "helper")
  // A real subprocess would leave this marker if the policy dispatched it.
  await writeFile(sentinel, "#!/bin/sh\nprintf ran > dispatched\nexit 1\n", { mode: 0o700 })
  const layer = nativeLayer({ repositoryPath: root, helperPath: sentinel }).pipe(Layer.provide(NodeServices.layer))
  const operationId = "a".repeat(128)
  const operation: Operation = {
    operation: "apply_files",
    requestId: requestIdFor("unqualified", "patch"),
    expectedOperationId: operationId,
    target: {
      changeId: "z".repeat(32),
      commitId: "b".repeat(40),
      treeId: "c".repeat(40),
      operationId,
      parentCommitIds: ["d".repeat(40)]
    },
    files: [{ path: "a.txt", beforeDigest: "e".repeat(64), content: "replacement\n" }]
  }
  const failure = await Effect.runPromise(
    Effect.flatMap(NativeCoding, (native) => Effect.flip(native.apply(operation))).pipe(Effect.provide(layer))
  )
  assert.equal(await readFile(target, "utf8"), "original\n")
  assert.deepEqual((await readdir(root)).sort(), ["a.txt", "helper"])
  assert.equal(failure.code, "host_unavailable")
  assert.match(failure.message, /atomic file mutation provider unavailable/i)
})

test("packaged helper accepts a native change and replays its JJ receipt", {
  skip: helper === undefined ? "Build the workspace helper and set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY" : false,
  timeout: 120_000
}, async (t) => {
  assert.ok(helper)
  const temporary = await mkdtemp(join(tmpdir(), "coding-native-helper-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const repo = join(temporary, "repo")
  execFileSync("jj", ["git", "init", repo], { stdio: "pipe" })
  const layer = nativeLayer({ repositoryPath: repo, helperPath: helper, sourcePublication: "local-only" }).pipe(
    Layer.provide(NodeServices.layer)
  )
  const run = <A, E>(f: (native: NativeCoding["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(NativeCoding, f).pipe(Effect.provide(layer)))
  const before = await run((native) => native.read())
  assert.equal(before.head.kind, "resolved")
  if (before.head.kind !== "resolved") return
  const request: Operation = {
    operation: "create",
    requestId: requestIdFor("acceptance", "first"),
    expectedOperationId: before.operationId,
    target: before.head,
    description: "first change"
  }
  const accepted = await run((native) => native.apply(request))
  assert.equal(accepted.status, "accepted")
  if (accepted.status !== "accepted") return
  assert.equal(accepted.parentOperationId, before.operationId)
  assert.equal(accepted.revision.description?.trim(), "first change")
  const replay = await run((native) => native.apply(request))
  assert.equal(replay.status, "accepted")
  if (replay.status === "accepted") {
    assert.equal(replay.replayed, true)
    assert.equal(replay.operationId, accepted.operationId)
  }
  const duplicate = await run((native) => Effect.result(native.apply({ ...request, description: "changed" })))
  assert.equal(duplicate._tag, "Failure")
  if (duplicate._tag === "Failure") assert.equal(duplicate.failure.code, "request_conflict")
})
