import { Action } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as MemoryStore from "../../packages/smithers/agent/memory/src/MemoryStore.ts"
import * as TestMemory from "../../packages/smithers/agent/memory/src/test/TestMemory.ts"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { correctionLayers, CorrectPlan } from "../coding/correction.ts"
import { acceptedLearnings, failureSignatures, learningNote, learningNotes, namespace, recordLearning } from "../coding/learnings.ts"
import { NativeCoding } from "../coding/native.ts"
import {
  checkInputDigest,
  type Implementation,
  type Plan,
  type Receipt,
  type Result,
  type Revision
} from "../coding/schema.ts"
import { Implement, policyLayers, RunCheck } from "../coding/workflow.ts"

const revision = (name: string, parent?: string): Revision => ({
  changeId: `jj-${name}`,
  commitId: `commit-${name}`,
  treeId: `tree-${name}`,
  operationId: `op-${name}`,
  parentCommitIds: parent ? [`commit-${parent}`] : []
})
const plan: Plan = {
  prompt: "Record what failed",
  memoryRevision: "fixture",
  base: revision("base"),
  changes: ["prefix", "owner"].map((id) => ({
    id,
    title: `Title ${id}`,
    intent: id,
    implementation: "implementation",
    implementationDigest: "0".repeat(64),
    atoms: [{ changeId: null, message: `✨ feat: ${id}`, intent: id, reads: [], writes: [`${id}.txt`] }],
    checks: ["fast", "slow"].map((tier) => ({
      id: tier,
      target: tier,
      flow: tier,
      flowDigest: "0".repeat(64),
      tier: tier as "fast" | "slow",
      required: true
    }))
  }))
}
const implementation = (index: number, parent: Revision): Implementation => {
  const change = plan.changes[index]!, head = revision(change.id, index === 0 ? "base" : plan.changes[index - 1]!.id)
  return { change: change.id, parent, atoms: [head], head, reads: [], writes: [`${change.id}.txt`] }
}
const rejected = (message: string): Result => ({
  status: "changes-requested",
  changes: [],
  findings: [{ owner: "owner", sourceCommitId: "commit-owner", message }]
})

test("only a rejected round with findings yields a pending note, identified by its failure pattern", () => {
  assert.equal(learningNote(plan, "run", 1, { status: "validated", changes: [], findings: [] }), undefined)
  assert.equal(learningNote(plan, "run", 1, { ...rejected("x"), findings: [] }), undefined)
  const note = learningNote(plan, "run", 1, rejected("Handle the empty list"))!
  assert.equal(note.status, "pending")
  assert.deepEqual(note.namespace, namespace)
  assert.equal(note.text, "Request: Record what failed\n- Title owner: Handle the empty list")
  assert.deepEqual(note.provenance, { runId: "run", iteration: 1 })
  assert.equal(learningNote(plan, "run", 1, rejected("Handle the empty list"))!.id, note.id)
  assert.equal(learningNote(plan, "run", 2, rejected("Handle the empty list"))!.id, note.id)
  assert.equal(learningNote(plan, "other", 1, rejected("Handle the empty list"))!.id, note.id)
  const long = learningNote(plan, "run", 1, {
    ...rejected("y".repeat(5_000)),
    findings: Array.from({ length: 30 }, () => rejected("y".repeat(5_000)).findings[0]!)
  })!
  assert.equal(long.text.split("\n").length, 21, "at most twenty findings")
  assert.ok(long.text.split("\n")[1]!.endsWith("…"))
  assert.equal(learningNotes(plan, "run", 1, {
    ...rejected("x"), findings: Array.from({ length: 30 }, (_, index) => ({ ...rejected("x").findings[0]!, message: String(index) }))
  }).length, 20, "at most twenty pending patterns per round")
})

test("a failing store is logged and never fails the correction", async () => {
  const exit = await Effect.runPromiseExit(
    recordLearning(plan, "run", 1, rejected("x")).pipe(Effect.provide(MemoryStore.layerNoop()))
  )
  assert.ok(Exit.isSuccess(exit))
})

test("failed review lint has a literal signature, and infrastructure failures propose nothing", () => {
  const result: Result = {
    status: "changes-requested", findings: [], changes: [{
      implementation: { change: "owner", parent: revision("base"), atoms: [revision("owner")], head: revision("owner"), reads: [], writes: [] },
      receipts: [{ checkId: "Lint", target: "lint", tier: "slow", change: "owner", commitId: "commit-owner", treeId: "tree-owner",
        inputDigest: "fixture", status: "failed", evidence: "Unused import", findings: [] }]
    }]
  }
  assert.deepEqual(failureSignatures(result), ["check:lint@review"])
  assert.equal(learningNote(plan, "run", 1, result)!.id, "check:lint@review")
  assert.equal(learningNote(plan, "run", 1, result)!.text, "Request: Record what failed\n- Lint@review: Unused import")
  assert.deepEqual(learningNotes(plan, "run", 1, { ...result, findings: rejected("x").findings }).map(note => note.id), [
    "check:lint@review", "review:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
  ], "a review finding must not hide the literal lint pattern inside an aggregate key")
  const infra: Result = { ...result, changes: [{ ...result.changes[0]!, receipts: [{ ...result.changes[0]!.receipts[0]!, fault: "infra" }] }] }
  assert.equal(learningNote(plan, "run", 1, infra), undefined)
})

test("later runs preserve the original note's provenance and rejected status", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    yield* recordLearning(plan, "run-first", 1, rejected("Handle the empty list"))
    const notes = yield* store.listNotes({ namespace, status: "any" })
    const id = notes[0]!.id
    yield* store.setNoteStatus({ id, status: "rejected" })
    yield* recordLearning(plan, "run-second", 2, rejected("Handle the empty list"))
    const held = yield* store.getNote({ id })
    assert.equal(held!.status, "rejected")
    assert.deepEqual(held!.provenance, { runId: "run-first", iteration: 1 })
    assert.equal((yield* store.listNotes({ namespace, status: "any" })).length, 1)
  }).pipe(Effect.provide(TestMemory.layer)))
})

test("a rejected correction round records one pending note that planning reads once accepted", {
  timeout: 180_000
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-learnings-"))
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  await writeFile(join(root, ".gitignore"), ".flows/\n")
  let writes = 0, checks = 0
  // One store outlives both hosts, as the control database outlives a host restart.
  const memoryRuntime = ManagedRuntime.make(TestMemory.layer)
  const base = await memoryRuntime.runPromise(MemoryStore.MemoryStore)
  const memory = Layer.succeed(MemoryStore.MemoryStore, {
    ...base,
    putNote: (input: MemoryStore.PutNoteInput) =>
      Effect.suspend(() => {
        writes++
        return base.putNote(input)
      })
  })
  const HostRuntime = process.versions.bun ? await import("@smthrs/flows/BunRuntime") : NodeRuntime
  const runtime = HostRuntime.layerHost(
    { filename: join(root, ".flows", "engine.db"), workspaceRoot: root, owner: { hostId: "learnings" }, signals: [] },
    Layer.mergeAll(
      policyLayers,
      correctionLayers,
      Implement.toLayer(({ change, parent }) =>
        Effect.succeed(implementation(plan.changes.findIndex((value) => value.id === change.id), parent))
      ),
      RunCheck.toLayer(({ implementation, check }) =>
        Effect.sync((): Receipt => {
          checks++
          const receipt: Receipt = {
            change: implementation.change,
            checkId: check.id,
            target: check.target,
            tier: check.tier,
            commitId: implementation.head.commitId,
            treeId: implementation.head.treeId,
            inputDigest: checkInputDigest(implementation, check),
            status: "passed",
            evidence: "scripted check",
            findings: []
          }
          return check.tier === "slow" && implementation.change === "owner"
            ? {
              ...receipt,
              status: "failed",
              findings: [{
                owner: "owner",
                sourceCommitId: implementation.head.commitId,
                message: "Reject empty names"
              }]
            }
            : receipt
        })
      )
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provide(Layer.succeed(NativeCoding, {
        sourcePublication: "local-only",
        read: () => Effect.die("a single round never reads native history"),
        apply: () => Effect.die("a single round never edits"),
        publishOriginalSource: () => Effect.die("never publishes")
      }))
    )
  ).pipe(Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000)), Layer.provideMerge(memory))
  let host = ManagedRuntime.make(runtime)
  t.after(async () => {
    await host.dispose()
    await memoryRuntime.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const correct = () => CorrectPlan.execute({ plan, maxRounds: 1 }, { executionId: "learnings" })
  const first = await host.runPromise(correct())
  assert.equal(first.status, "changes-requested")
  const pending = await host.runPromise(
    Effect.flatMap(MemoryStore.MemoryStore, (store) => store.listNotes({ namespace, status: "any" }))
  )
  assert.equal(pending.length, 1)
  assert.equal(pending[0]!.status, "pending")
  assert.match(pending[0]!.text, /Title owner: Reject empty names/)
  assert.deepEqual(await host.runPromise(acceptedLearnings), [], "pending notes never reach planning")
  const recorded = { writes, checks }

  // Cold replay of the same execution returns the journaled round without a second write.
  await host.dispose()
  host = ManagedRuntime.make(runtime)
  assert.deepEqual(await host.runPromise(correct()), first)
  assert.deepEqual({ writes, checks }, recorded)
  const notes = await host.runPromise(
    Effect.flatMap(MemoryStore.MemoryStore, (store) => store.listNotes({ namespace, status: "any" }))
  )
  assert.equal(notes.length, 1)

  // The existing gate accepts it; the next planning read includes it.
  await host.runPromise(
    Effect.flatMap(MemoryStore.MemoryStore, (store) => store.setNoteStatus({ id: notes[0]!.id, status: "accepted" }))
  )
  assert.deepEqual(await host.runPromise(acceptedLearnings), [{ id: notes[0]!.id, text: notes[0]!.text }])
})
