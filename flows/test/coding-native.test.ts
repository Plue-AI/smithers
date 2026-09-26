import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
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
