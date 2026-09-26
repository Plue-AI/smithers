import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding, NativeCodingError, nativeLayer, requestIdFor, type SourcePublication } from "../coding/native.ts"
import type { Plan } from "../coding/schema.ts"
import { admitSource } from "../coding/source-admission.ts"

const revision = {
  kind: "resolved" as const,
  changeId: "k".repeat(32),
  commitId: "a".repeat(40),
  treeId: "b".repeat(40),
  operationId: "c".repeat(128),
  parentCommitIds: ["0".repeat(40)]
}
const requestId = requestIdFor("request-execution", "publish-original")
const workspaceId = "0f8fad5b-d9cb-469f-a165-70867728950e"
const receipt: SourcePublication = {
  status: "retained",
  requestId,
  workspaceId,
  repositoryId: 200,
  ref: `refs/smithers/workspaces/${workspaceId}/sources/${revision.commitId}`,
  source: {
    changeId: revision.changeId,
    commitId: revision.commitId,
    treeId: revision.treeId,
    parentCommitIds: revision.parentCommitIds
  }
}
const plan: Plan = {
  prompt: "Add a feature",
  memoryRevision: "wiki@source",
  base: revision,
  observedHead: revision,
  changes: [{
    id: "feature",
    title: "Feature",
    intent: "Add a feature",
    implementation: "coding/atoms",
    implementationDigest: "sha256:atoms",
    atoms: [{
      changeId: null,
      message: "✨ feat: feature",
      intent: "Add a feature",
      reads: [],
      writes: ["feature.ts"]
    }],
    checks: ["fast", "slow"].map((tier) => ({
      id: tier,
      target: tier,
      flow: tier,
      flowDigest: `sha256:${tier}`,
      tier: tier as "fast" | "slow",
      required: true
    }))
  }]
}

test("cloud admission retains before any snapshot, then refuses source movement; local capability never claims an ACK", async () => {
  for (const mode of ["cloud", "unavailable", "moved", "local-only"] as const) {
    const calls: string[] = []
    let snapshots = 0
    const native = Layer.succeed(NativeCoding, {
      sourcePublication: mode === "local-only" ? "local-only" : "cloud",
      read: () =>
        Effect.sync(() => {
          calls.push("read")
          const head = mode === "moved" && snapshots > 0 ? { ...revision, commitId: "d".repeat(40) } : revision
          return { status: "read" as const, operationId: head.operationId, head, revisions: [head] }
        }),
      apply: () => Effect.die("admission must not implement a change"),
      publishOriginalSource: (request) =>
        Effect.gen(function*() {
          calls.push("publish")
          assert.equal(snapshots, 0)
          assert.deepEqual(request, { requestId, source: revision })
          if (mode === "unavailable") {
            return yield* new NativeCodingError({ code: "source_publication_unavailable", message: "No cloud ACK" })
          }
          return receipt
        })
    })
    const runtime = Layer.merge(
      native,
      Jj.layerNoop({
        snapshot: () =>
          Effect.sync(() => {
            calls.push("snapshot")
            snapshots++
            return { commitId: revision.commitId, changeId: revision.changeId }
          })
      })
    )
    const result = await Effect.runPromise(Effect.result(admitSource(plan, requestId)).pipe(Effect.provide(runtime)))
    if (mode === "cloud" || mode === "local-only") {
      assert.equal(result._tag, "Success")
      assert.deepEqual(calls, mode === "cloud" ? ["read", "publish", "snapshot", "read"] : ["read", "snapshot", "read"])
    } else {
      assert.equal(result._tag, "Failure")
      if (result._tag === "Failure") {
        assert.equal(result.failure.code, mode === "unavailable" ? "unavailable" : "stale_revision")
      }
      if (mode === "unavailable") assert.deepEqual(calls, ["read", "publish"])
    }
  }
})

test("Effect native publication validates exact receipts and sends only source identity to the provisioned adapter", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-publication-adapter-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const adapter = join(temporary, "adapter.mjs"), recorded = join(temporary, "request.json")
  const platform = process.versions.bun ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer
  for (const mode of ["accepted", "missing", "wrong-tree", "wrong-ref", "wrong-request", "local-only"] as const) {
    const output = mode === "missing" ? { status: "retained" } : {
      ...receipt,
      ...(mode === "wrong-ref" ? { ref: "refs/heads/main" } : {}),
      ...(mode === "wrong-request" ? { requestId: requestIdFor("other", "publish") } : {}),
      source: { ...receipt.source, ...(mode === "wrong-tree" ? { treeId: "d".repeat(40) } : {}) }
    }
    await writeFile(
      adapter,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const request = JSON.parse(readFileSync(0, "utf8"));
writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(request));
process.stdout.write(${JSON.stringify(JSON.stringify(output))});
`
    )
    await chmod(adapter, 0o755)
    const native = nativeLayer({
      repositoryPath: temporary,
      helperPath: adapter,
      sourcePublication: mode === "local-only" ? "local-only" : "cloud"
    }).pipe(Layer.provide(platform))
    const result = await Effect.runPromise(
      Effect.flatMap(
        NativeCoding,
        (service) => Effect.result(service.publishOriginalSource({ requestId, source: revision }))
      ).pipe(Effect.provide(native))
    )
    if (mode === "accepted") {
      assert.equal(result._tag, "Success")
      if (result._tag === "Success") assert.deepEqual(result.success, receipt)
      assert.deepEqual(JSON.parse(await readFile(recorded, "utf8")), {
        operation: "publish_source",
        requestId,
        source: revision,
        repositoryPath: temporary
      })
    } else {
      assert.equal(result._tag, "Failure")
      if (result._tag === "Failure") {
        assert.equal(
          result.failure.code,
          mode === "local-only" ? "source_publication_unavailable" : "source_publication_invalid_ack"
        )
      }
    }
  }
})
