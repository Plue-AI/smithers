import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { Effect, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding, NativeCodingError } from "../coding/native.ts"
import { checkInputDigest, type Implementation, type Plan, type Revision } from "../coding/schema.ts"
import { AdmitVibe, FenceVibeSource, fenceVibeSource, VerifyVibe } from "../coding/vibe-admission.ts"
import { ReadVibeRequest, VibeEvidence } from "../coding/vibe-evidence.ts"
import { publicationLayers, PublishVibeSource } from "../coding/vibe-publication.ts"
import { policyLayers } from "../coding/workflow.ts"

const revision = (name: string, parent?: string): Revision => ({
  changeId: `jj-${name}`,
  commitId: `commit-${name}`,
  treeId: `tree-${name}`,
  operationId: `op-${name}`,
  parentCommitIds: parent ? [`commit-${parent}`] : []
})
const base = revision("base")
const plan: Plan = {
  prompt: "Vibe the validated work",
  memoryRevision: "wiki",
  base,
  observedHead: base,
  changes: ["first", "last"].map((id) => ({
    id,
    title: id,
    intent: id,
    implementation: "coding/implementation",
    implementationDigest: "0".repeat(64),
    atoms: [{ changeId: null, message: `✨ feat: ${id}`, intent: id, reads: [], writes: [id] }],
    checks: ["fast", "slow", "delivery"].map((tier) => ({
      id: tier,
      target: tier,
      flow: `checks/${tier}`,
      flowDigest: "0".repeat(64),
      tier: tier as "fast" | "slow" | "delivery",
      required: true
    }))
  }))
}
const implementations: Implementation[] = plan.changes.map((change, index) => ({
  change: change.id,
  parent: index === 0 ? base : revision("first", "base"),
  atoms: [revision(change.id, index === 0 ? "base" : "first")],
  head: revision(change.id, index === 0 ? "base" : "first"),
  reads: [],
  writes: [change.id]
}))
const evidence: VibeEvidence = {
  requestExecutionId: "request",
  controlRunId: "completed-control",
  planId: "approved",
  planDigest: "digest",
  pocExecutionId: "poc",
  originalSource: base,
  request: {
    plan,
    outcome: {
      status: "validated",
      rounds: 1,
      blocked: null,
      result: {
        status: "validated",
        findings: [],
        changes: implementations.map((implementation, index) => ({
          implementation,
          receipts: plan.changes[index]!.checks.filter((check) => check.tier !== "delivery").map((check) => ({
            change: implementation.change,
            checkId: check.id,
            target: check.target,
            tier: check.tier,
            commitId: implementation.head.commitId,
            treeId: implementation.head.treeId,
            inputDigest: checkInputDigest(implementation, check),
            status: "passed",
            findings: [],
            evidence: "real receipt fixture"
          }))
        }))
      }
    }
  }
}

for (
  const mode of [
    "valid",
    "missing-change",
    "missing-fast",
    "missing-slow",
    "failed-fast",
    "failed-slow",
    "stale-receipt",
    "wrong-parent",
    "wrong-native-id",
    "unhandled-finding",
    "source-moved"
  ] as const
) {
  test(`vibe policy graph: ${mode}`, async (t) => {
    // Policy graph inputs are explicitly scripted. Separate evidence tests use
    // actual control planning/approval and retained native ancestry.
    const input = structuredClone(evidence)
    const changes = input.request.outcome.result!.changes
    if (mode === "missing-change") (changes as unknown[]).pop()
    if (mode === "missing-fast" || mode === "missing-slow") {
      ;(changes[0]!.receipts as unknown[]).splice(mode === "missing-fast" ? 0 : 1, 1)
    }
    if (mode === "failed-fast" || mode === "failed-slow") {
      Object.assign(changes[0]!.receipts[mode === "failed-fast" ? 0 : 1]!, { status: "failed" })
    }
    if (mode === "stale-receipt") Object.assign(changes[0]!.receipts[1]!, { commitId: "stale" })
    if (mode === "wrong-parent") Object.assign(changes[1]!.implementation.parent, { commitId: "stale" })
    if (mode === "wrong-native-id") Object.assign(input.request.plan.changes[0]!.atoms[0]!, { changeId: "wrong-jj" })
    if (mode === "unhandled-finding") {
      Object.assign(changes[1]!.receipts[1]!, {
        findings: [{ owner: "first", sourceCommitId: implementations[1]!.head.commitId, message: "Unresolved review" }]
      })
    }
    let snapshots = 0, reads = 0
    const leaf = FenceVibeSource.toLayer(fenceVibeSource).pipe(Layer.provide([
      Jj.layerNoop({
        snapshot: () =>
          Effect.sync(() => {
            snapshots++
            return { commitId: "a".repeat(40), changeId: "k".repeat(32) }
          })
      }),
      Layer.succeed(NativeCoding, {
        sourcePublication: "local-only",
        publishOriginalSource: () => Effect.die("Admission fixture has no cloud publication capability"),
        read: () =>
          Effect.sync(() => {
            reads++
            return {
              status: "read" as const,
              operationId: "new-operation",
              head: {
                ...implementations[1]!.head,
                kind: "resolved" as const,
                operationId: "new-operation",
                ...(mode === "source-moved" ? { treeId: "changed" } : {})
              },
              revisions: []
            }
          }),
        apply: () => Effect.die("Admission must not rewrite or land")
      })
    ]))
    const host = ManagedRuntime.make(
      Layer.mergeAll(Interpreter.layer(VerifyVibe), policyLayers, leaf).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer)
      )
    )
    t.after(() => host.dispose())
    if (mode === "valid") {
      const result = await host.runPromise(VerifyVibe.execute(input, { executionId: "vibe-policy" }))
      assert.equal(result.validatedHead.operationId, "new-operation")
      assert.equal(result.validatedHead.commitId, implementations[1]!.head.commitId)
      assert.deepEqual([snapshots, reads], [1, 1])
      assert.deepEqual(await host.runPromise(VerifyVibe.execute(input, { executionId: "vibe-policy" })), result)
      assert.deepEqual(
        [snapshots, reads],
        [1, 1],
        "replay uses the action receipt; the later mutation must present this exact fence"
      )
    } else {
      await assert.rejects(host.runPromise(VerifyVibe.execute(input, { executionId: "vibe-policy" })))
      assert.deepEqual(
        [snapshots, reads],
        mode === "source-moved" ? [1, 1] : [0, 0],
        "all retained check and atomic policy gates precede final source observation"
      )
    }
  })
}

for (const mode of ["cloud", "local-only", "publication-unavailable", "original-missing", "source-moved"] as const) {
  test(`vibe retains original source before snapshot: ${mode}`, async (t) => {
    const events: string[] = []
    const original = {
      changeId: "k".repeat(32),
      commitId: "a".repeat(40),
      treeId: "b".repeat(40),
      operationId: "a".repeat(128),
      parentCommitIds: ["c".repeat(40)]
    }
    const input = { ...evidence, originalSource: original }
    const leaves = Layer.mergeAll(
      publicationLayers,
      ReadVibeRequest.toLayer(() =>
        Effect.sync(() => {
          events.push("evidence")
          return input
        })
      ),
      FenceVibeSource.toLayer(fenceVibeSource)
    ).pipe(Layer.provide([
      Jj.layerNoop({
        snapshot: () =>
          Effect.sync(() => {
            events.push("snapshot")
            return { commitId: "a".repeat(40), changeId: "k".repeat(32) }
          })
      }),
      Layer.succeed(NativeCoding, {
        sourcePublication: mode === "local-only" ? "local-only" : "cloud",
        publishOriginalSource: (request) =>
          Effect.gen(function*() {
            events.push("publish")
            assert.deepEqual(
              request.source,
              { ...original, kind: "resolved" },
              "retain the POC source, not the later plan or current tip"
            )
            if (mode === "publication-unavailable") {
              return yield* new NativeCodingError({
                code: "source_publication_unavailable",
                message: "No authoritative ACK"
              })
            }
            if (mode === "original-missing") {
              return yield* new NativeCodingError({
                code: "revision_conflict",
                message: "Original source has no retained pin and moved"
              })
            }
            const workspaceId = "12345678-1234-1234-1234-123456789abc"
            return {
              status: "retained" as const,
              requestId: request.requestId,
              workspaceId,
              repositoryId: 42,
              ref: `refs/smithers/workspaces/${workspaceId}/sources/${original.commitId}`,
              source: original
            }
          }),
        read: () =>
          Effect.sync(() => {
            events.push("read")
            return {
              status: "read" as const,
              operationId: "fresh",
              head: {
                ...implementations[1]!.head,
                kind: "resolved" as const,
                operationId: "fresh",
                ...(mode === "source-moved" ? { treeId: "changed" } : {})
              },
              revisions: []
            }
          }),
        apply: () => Effect.die("Admission must not rewrite or land")
      })
    ]))
    const host = ManagedRuntime.make(
      Layer.mergeAll(Interpreter.layer(AdmitVibe), Interpreter.layer(VerifyVibe), policyLayers, leaves).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer)
      )
    )
    t.after(() => host.dispose())
    if (mode === "cloud") {
      const result = await host.runPromise(
        AdmitVibe.execute({ requestExecutionId: "request" }, { executionId: "cloud-admission" })
      )
      assert.deepEqual(events, ["evidence", "publish", "snapshot", "read"])
      assert.deepEqual(
        await host.runPromise(AdmitVibe.execute({ requestExecutionId: "request" }, { executionId: "cloud-admission" })),
        result
      )
      assert.equal(events.length, 4, "action replay retains the original publication receipt")
      const cleaned = await host.runPromise(
        PublishVibeSource.execute({ source: original, phase: "cleaned" }, { executionId: "cleaned-source" })
      )
      assert.equal(cleaned.source.commitId, original.commitId)
      assert.deepEqual(
        await host.runPromise(
          PublishVibeSource.execute({ source: original, phase: "cleaned" }, { executionId: "cleaned-source" })
        ),
        cleaned
      )
      assert.deepEqual(events, ["evidence", "publish", "snapshot", "read", "publish"])
    } else {
      await assert.rejects(
        host.runPromise(AdmitVibe.execute({ requestExecutionId: "request" }, { executionId: "cloud-admission" }))
      )
      assert.deepEqual(
        events,
        mode === "local-only" ? ["evidence"] : mode === "publication-unavailable" || mode === "original-missing" ?
          ["evidence", "publish"]
          : ["evidence", "publish", "snapshot", "read"]
      )
    }
  })
}
