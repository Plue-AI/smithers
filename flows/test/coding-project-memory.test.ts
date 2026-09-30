import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import * as MemorySource from "../../packages/smithers/agent/memory/src/Source.ts"
import { ApplyNative, EditAtom, Entry, Observe, Prepare } from "../coding/atoms.ts"
import { ownerRepair, repairContext } from "../coding/correction.ts"
import ImplementAtoms, { atomFlows } from "../coding/implementation/flow.ts"
import { finalize, type PlanningContext } from "../coding/planning.ts"
import {
  commitsBank,
  maxBytes,
  maxCommitNotes,
  projectMemory,
  stepMemory,
  wikiBank,
  withoutMemory
} from "../coding/project-memory.ts"
import { type Check, type Plan, ProjectMemory, type Revision } from "../coding/schema.ts"
import { recalled } from "../coding/workflow.ts"

/*
 * #2779: planning's evidence (accepted notes, commit notes, wiki pages) becomes
 * one bounded, cited block that the Plan keeps, so the implementation, repair
 * and correction steps open with the same bytes, only through the gate.
 */

const bytes = (rows: ProjectMemory) => new TextEncoder().encode(MemorySource.render(rows)).length
const revision = (name: string, parent?: Revision, description = `✨ feat: ${name}`) => ({
  changeId: `change-${name}`,
  commitId: `commit-${name}`,
  treeId: `tree-${name}`,
  operationId: "op",
  parentCommitIds: parent === undefined ? ["commit-root"] : [parent.commitId],
  description
})
const note = (id: string, markdown: string) => ({
  id,
  title: `Page ${id}`,
  kind: "current" as const,
  markdown,
  sourceRevision: "src-1",
  inputDigest: "d"
})

test("the block cites accepted notes, then the newest commit notes, then wiki pages", () => {
  const a = revision("a"), b = revision("b", a, "  "), c = revision("c", b, "🐛 fix: c\n\nbody")
  const rows = projectMemory({
    history: [a, b, c],
    memory: [note("arch", "Keep one backend")],
    learnings: [{ id: "coding-learning-1", text: "Reject empty names" }]
  })
  assert.deepEqual(rows, [
    { origin: "recall", bank: "flow:coding", key: "coding-learning-1", text: "Reject empty names" },
    // Newest first; a blank description is no note.
    { origin: "recall", bank: commitsBank, key: "change-c", text: "🐛 fix: c\n\nbody" },
    { origin: "recall", bank: commitsBank, key: "change-a", text: "✨ feat: a" },
    { origin: "recall", bank: wikiBank, key: "arch", text: "Page arch (source src-1)\nKeep one backend" }
  ])
  // Every row decodes as the Plan's block and renders with its citation label.
  assert.deepEqual(Schema.decodeUnknownSync(ProjectMemory)(rows), rows)
  const rendered = MemorySource.render(rows)
  assert.match(rendered, /\[flow\\u003acoding\/coding-learning-1\] Reject empty names/)
  assert.match(rendered, /\[wiki\/arch\] Page arch/)
  assert.deepEqual(projectMemory({ history: [revision("x", undefined, "")], memory: [] }), [])
})

test("the block keeps at most the newest commit notes and stays within its byte budget, rows whole", () => {
  const history: Array<ReturnType<typeof revision>> = []
  for (let index = 0; index < maxCommitNotes + 5; index++) history.push(revision(`n${index}`, history.at(-1)))
  const commits = projectMemory({ history, memory: [] })
  assert.equal(commits.length, maxCommitNotes)
  assert.equal(commits[0]!.key, `change-n${maxCommitNotes + 4}`)

  // A person-accepted note is kept before a page that would crowd it out; a
  // row that does not fit is left out whole and a smaller later row still fits.
  const big = note("big", "x".repeat(maxBytes)), small = note("small", "fits")
  const lesson = { id: "lesson", text: "y".repeat(2_000) }
  const rows = projectMemory({ history: [revision("a")], memory: [big, small], learnings: [lesson] })
  assert.deepEqual(rows.map((row) => row.key), ["lesson", "change-a", "small"])
  assert.ok(bytes(rows) <= maxBytes)
  assert.ok(rows.every((row) => row.text !== undefined && !row.text.endsWith("…")))

  // Exactly at the budget is kept; one byte under it is not.
  const one = projectMemory({ history: [], memory: [], learnings: [{ id: "k", text: "z" }] })
  assert.deepEqual(projectMemory({ history: [], memory: [], learnings: [{ id: "k", text: "z" }] }, bytes(one)), one)
  assert.deepEqual(projectMemory({ history: [], memory: [], learnings: [{ id: "k", text: "z" }] }, bytes(one) - 1), [])

  // Never more rows than the Plan's schema admits.
  const many = Array.from({ length: 100 }, (_, index) => ({ id: `l${index}`, text: "t" }))
  assert.equal(projectMemory({ history: [], memory: [], learnings: many }).length, 64)
})

const checks: ReadonlyArray<Check> = [
  { id: "fast", target: "flows", flow: "checks/fast", flowDigest: "f".repeat(64), tier: "fast", required: true },
  { id: "slow", target: "flows", flow: "checks/slow", flowDigest: "s".repeat(64), tier: "slow", required: true }
]
const planningContext = (overrides: Partial<PlanningContext>): PlanningContext => {
  const a = revision("a")
  return {
    head: a,
    history: [a],
    memory: [],
    memoryRevision: "memory",
    implementation: "coding/implementation",
    implementationDigest: "i".repeat(64),
    checks,
    sources: [],
    missing: [],
    ...overrides
  }
}
const draft = {
  rationale: "fixture",
  baseChangeId: "change-a",
  changes: [{
    id: "fix",
    title: "Fix",
    intent: "Fix it",
    atoms: [{ changeId: null, message: "🐛 fix: it", intent: "fix", reads: [], writes: ["a.ts"] }],
    checks: ["fast", "slow"]
  }]
}

test("a finalized plan keeps the block, and every implementation step recalls it", () => {
  const input = { prompt: "Fix it", feedback: "" }
  const plan = finalize(input, planningContext({ learnings: [{ id: "lesson", text: "Reject empty names" }] }), draft)
  assert.deepEqual(plan.memory?.map((row) => `${row.bank}/${row.key}`), ["flow:coding/lesson", "commits/change-a"])
  assert.deepEqual(recalled(plan), { memoryRevision: "memory", memory: plan.memory })
  // No evidence, no block: the plan and the step payload carry no memory key.
  const bare = finalize(input, planningContext({ history: [revision("a", undefined, "")] }), draft)
  assert.equal("memory" in bare, false)
  assert.deepEqual(recalled(bare), { memoryRevision: "memory" })
})

test("a step's prompt never carries its memory; the rows reach the model only as opening memory", () => {
  const memory = [{ origin: "recall" as const, bank: "flow:coding", key: "lesson", text: "Reject empty names" }]
  const payload = { atom: "a", memoryRevision: "m", memory }
  assert.deepEqual(withoutMemory(payload), { atom: "a", memoryRevision: "m" })
  assert.equal(JSON.stringify(withoutMemory(payload)).includes("Reject empty names"), false)
  assert.deepEqual(stepMemory(payload), memory)
  assert.deepEqual(stepMemory({}), [])
})

const hex = (length: number, seed: string) => seed.repeat(length).slice(0, length)
const native = (letter: string, parent?: string) => ({
  kind: "resolved" as const,
  changeId: hex(32, letter),
  commitId: hex(40, letter === "k" ? "a" : "b"),
  treeId: hex(40, "c"),
  operationId: hex(128, "d"),
  parentCommitIds: parent === undefined ? [] : [parent]
})

test("the implementation flow hands the plan's block to every edit step", async () => {
  const parent = native("k"), child = native("m", parent.commitId)
  const memory = [{ origin: "recall" as const, bank: "commits", key: "change-a", text: "✨ feat: a" }]
  const edits: Array<unknown> = []
  const operation = {
    operation: "snapshot" as const,
    requestId: "11111111-1111-4111-8111-111111111111",
    expectedOperationId: parent.operationId,
    target: parent
  }
  const stubs = Layer.mergeAll(
    Entry.toLayer(() => Effect.succeed(operation)),
    Prepare.toLayer(() => Effect.succeed(operation)),
    ApplyNative.toLayer(() =>
      Effect.succeed({ status: "unchanged" as const, operationId: parent.operationId, revision: child })
    ),
    Observe.toLayer(() => Effect.succeed(child)),
    EditAtom.toLayer((payload) =>
      Effect.sync(() => (edits.push(payload), { summary: "done", reads: [], writes: ["a.ts"] }))
    )
  )
  const change = {
    id: "fix",
    title: "Fix",
    intent: "Fix it",
    implementation: "coding/ImplementAtoms",
    implementationDigest: "i".repeat(64),
    atoms: [{ changeId: null, message: "🐛 fix: it", intent: "fix", reads: [], writes: ["a.ts"] }],
    checks: [...checks]
  }
  const run = (payload: Parameters<typeof ImplementAtoms.execute>[0], executionId: string) =>
    Effect.runPromise(
      ImplementAtoms.execute(payload, { executionId }).pipe(
        Effect.provide(
          Layer.mergeAll(stubs, atomFlows).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(FlowEngine.layerMemory),
            Layer.provideMerge(NodeCrypto.layer)
          )
        )
      )
    )
  const implemented = await run({ change, parent, memoryRevision: "m", memory }, "with-memory")
  assert.equal(implemented.head.changeId, child.changeId)
  assert.deepEqual((edits[0] as { memory?: unknown }).memory, memory)
  // A plan made before the block reaches the edit step without one.
  await run({ change, parent, memoryRevision: "m" }, "without-memory")
  assert.equal("memory" in (edits[1] as object), false)
})

test("a repair carries the plan's block from the correction context to the re-implementation", () => {
  const base = revision("base"), owner = revision("owner", base)
  const memory = [{ origin: "recall" as const, bank: "flow:coding", key: "lesson", text: "Reject empty names" }]
  const plan: Plan = {
    prompt: "Fix it",
    memoryRevision: "m",
    memory,
    base,
    changes: [{
      id: "owner",
      title: "Owner",
      intent: "owner",
      implementation: "coding/ImplementAtoms",
      implementationDigest: "i".repeat(64),
      atoms: [{ changeId: null, message: "✨ feat: owner", intent: "owner", reads: [], writes: ["a.ts"] }],
      checks: [...checks]
    }]
  }
  const resolved = (value: Revision) => ({ ...value, kind: "resolved" as const })
  const implementation = { change: "owner", parent: base, atoms: [owner], head: owner, reads: [], writes: ["a.ts"] }
  const previous = {
    status: "changes-requested" as const,
    changes: [{ implementation, receipts: [] }],
    findings: [{ owner: "owner", sourceCommitId: owner.commitId, message: "Reject empty names" }]
  }
  const read = {
    status: "read" as const,
    operationId: "op",
    head: resolved(owner),
    revisions: [resolved(base), resolved(owner)]
  }
  const context = repairContext({ plan, previous, read } as never)
  assert.deepEqual(context.memory, memory)
  const repair = ownerRepair({
    context,
    selection: { changeId: owner.changeId, intent: "handle empty" },
    memoryRevision: "m"
  })
  assert.deepEqual(repair.memory, memory)
  assert.match(repair.change.atoms[0]!.intent, /Correction: handle empty/)
  // A plan without a block repairs without one.
  const { memory: _, ...legacy } = plan
  const bare = repairContext({ plan: legacy, previous, read } as never)
  assert.equal("memory" in bare, false)
  assert.equal(
    "memory" in
      ownerRepair({ context: bare, selection: { changeId: owner.changeId, intent: "x" }, memoryRevision: "m" }),
    false
  )
})
