import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { type BackendLanding, Landing, type LocalLanding } from "../coding/landing.ts"
import { NativeCoding, NativeCodingError } from "../coding/native.ts"
import { checkInputDigest, type Implementation, type Plan, type Revision } from "../coding/schema.ts"
import { AdmitVibe, FenceVibeSource, fenceVibeSource, VerifyVibe } from "../coding/vibe-admission.ts"
import {
  messageRefusal,
  type Proposal,
  proposalRefusal,
  ProposeHistory,
  RepairHistory,
  ReviewHistory,
  validateProposalLayer
} from "../coding/vibe-cleanup.ts"
import { ReadVibeRequest, VibeEvidence } from "../coding/vibe-evidence.ts"
import { landerLayer } from "../coding/vibe-lander.ts"
import { publicationLayers, PublishVibeSource } from "../coding/vibe-publication.ts"
import type { VibeAdmission } from "../coding/vibe-schema.ts"
import { policyLayers } from "../coding/workflow.ts"

/** Admission reads only the lander's kind; every landing method refuses. */
const unusedLanding = () => Effect.die("admission must not land")
const backendLanding: BackendLanding = {
  kind: "backend",
  binding: { repositoryId: 42, workspaceId: "12345678-1234-1234-1234-123456789abc" },
  readMain: unusedLanding(),
  pinMain: unusedLanding(),
  readDelivery: unusedLanding(),
  prepare: unusedLanding,
  create: unusedLanding,
  queue: unusedLanding,
  observe: unusedLanding,
  openPull: unusedLanding
}
const localLanding: LocalLanding = {
  kind: "fast-forward",
  prepare: unusedLanding,
  fastForward: unusedLanding,
  abandon: unusedLanding,
  openPull: unusedLanding,
  observeChecks: unusedLanding,
  merge: unusedLanding
}

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

for (
  const mode of [
    "cloud",
    "local-only",
    "local-lander",
    "publication-unavailable",
    "original-missing",
    "source-moved"
  ] as const
) {
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
      landerLayer,
      ReadVibeRequest.toLayer(() =>
        Effect.sync(() => {
          events.push("evidence")
          return input
        })
      ),
      FenceVibeSource.toLayer(fenceVibeSource)
    ).pipe(Layer.provide([
      // A host without the backend admits without retention: there is nothing to retain with.
      Layer.succeed(Landing, mode === "local-lander" ? localLanding : backendLanding),
      Jj.layerNoop({
        snapshot: () =>
          Effect.sync(() => {
            events.push("snapshot")
            return { commitId: "a".repeat(40), changeId: "k".repeat(32) }
          })
      }),
      Layer.succeed(NativeCoding, {
        sourcePublication: mode === "local-only" || mode === "local-lander" ? "local-only" : "cloud",
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
    if (mode === "local-lander") {
      const result = await host.runPromise(
        AdmitVibe.execute({ requestExecutionId: "request" }, { executionId: "local-admission" })
      )
      assert.equal(result.validatedHead.commitId, implementations[1]!.head.commitId)
      assert.deepEqual(events, ["evidence", "snapshot", "read"], "a local lander never asks for cloud retention")
      assert.deepEqual(
        await host.runPromise(AdmitVibe.execute({ requestExecutionId: "request" }, { executionId: "local-admission" })),
        result
      )
      assert.equal(events.length, 3)
    } else if (mode === "cloud") {
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

const cleanupAdmission: VibeAdmission = { ...evidence, validatedHead: implementations[1]!.head }
const recorded = implementations.flatMap((implementation) => implementation.atoms)
const proposal = (descriptions: ReadonlyArray<string>, summary = "✨ feat: first and last"): Proposal => ({
  summary,
  atoms: descriptions.map((description, index) => ({ changeId: recorded[index]!.changeId, description }))
})

test("a final description is any clear one-line summary; the emoji conventional form is preferred, not required", () => {
  // claude-sonnet-4.5's subject on 2026-10-05, refused three attempts running.
  for (
    const message of ["✅ Add test for greet function", "✨ feat(greet): add a greet function", "Add greet\n\nWhy."]
  ) {
    assert.equal(messageRefusal(message), undefined, message)
  }
  assert.equal(messageRefusal(""), "its first line is empty")
  assert.equal(messageRefusal("\nAdd greet"), "its first line is empty")
  assert.equal(messageRefusal("✅ :"), "its first line has no words")
  assert.match(messageRefusal(`fix: ${"x".repeat(160)}`)!, /165 characters; the most is 160/)
  assert.equal(proposalRefusal(recorded, proposal(["✅ Add first", "Add last"])), undefined)
})

test("a refused proposal says what to fix: the recorded atoms, their order and each bad message", () => {
  const swapped = proposal(["✅ Add first", "Add last"])
  const reordered = { ...swapped, atoms: [...swapped.atoms].reverse() }
  assert.equal(
    proposalRefusal(recorded, reordered),
    "Final history refused: atom 1 is jj-last, but the recorded atom 1 is jj-first; " +
      "atom 2 is jj-first, but the recorded atom 2 is jj-last."
  )
  assert.equal(
    proposalRefusal(recorded, proposal(["✅", "Add last"], "")),
    "Final history refused: atom 1's description \"✅\": its first line has no words; " +
      "the summary \"\": its first line is empty."
  )
  assert.match(
    proposalRefusal(recorded, proposal(["✅ Add first"]))!,
    /it describes 1 atoms, but the request recorded 2: jj-first, jj-last/
  )
})

test("final history gets one repair turn that quotes the refusal, then fails", { timeout: 60_000 }, async (t) => {
  const reviewed: Array<Proposal> = [], repaired: Array<{ refusal: string; proposal: Proposal }> = []
  let answers: Array<Proposal> = []
  const layer = Layer.mergeAll(
    Interpreter.layer(ProposeHistory),
    validateProposalLayer,
    ReviewHistory.toLayer(() => Effect.sync(() => (reviewed.push(answers[0]!), answers[0]!))),
    RepairHistory.toLayer(({ refusal, proposal }) =>
      Effect.sync(() => (repaired.push({ refusal, proposal }), answers[1]!))
    )
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
  const host = ManagedRuntime.make(layer)
  t.after(() => host.dispose())
  const good = proposal(["✨ feat: first", "✨ feat: last"]), bad = proposal(["✅", "✨ feat: last"])
  const run = (executionId: string) => host.runPromiseExit(ProposeHistory.execute(cleanupAdmission, { executionId }))

  const value = (exit: Exit.Exit<Proposal, unknown>) => Exit.isSuccess(exit) ? exit.value : exit
  answers = [good, good]
  assert.deepEqual(value(await run("clean")), good)
  assert.equal(repaired.length, 0, "an accepted proposal is not repaired")

  answers = [bad, good]
  assert.deepEqual(value(await run("repaired")), good)
  assert.deepEqual(repaired, [{
    refusal: "Final history refused: atom 1's description \"✅\": its first line has no words.",
    proposal: bad
  }])

  answers = [bad, bad]
  const failed = await run("refused-twice")
  assert.ok(Exit.isFailure(failed))
  assert.match(JSON.stringify(failed.cause), /invalid_plan.*its first line has no words/)
  assert.equal(repaired.length, 2, "one repair turn per refused review, never a second")
})
