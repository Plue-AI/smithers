import { describe, expect, test } from "bun:test"
import { traceFromJournal, type JournalRecord } from "./RunTrace"
import { traceStatus, traceGoals } from "./RunTraceStatus"
import { CODING_PLAN } from "./fixtures/CodingPlan"
import { codingDecision, preparedCodingJournal } from "./fixtures/CodingJournal"
import { checkInputDigest, Receipt } from "../../../../../flows/coding/schema"
import { Schema } from "effect"

const event = (sequence: number, kind: string, payload: Record<string, unknown> = {}): JournalRecord =>
  ({ sequence, kind: `control.${kind}`, occurredAt: sequence * 100, payload })
const model = (records: ReadonlyArray<JournalRecord>, status = "running") => traceFromJournal({ runId: "run-1", flowId: "coding", status }, records)
const call = (seq: number, flowName: string, input: unknown, value: unknown = { exitCode: 0 }) => [
  event(seq, "agent.cell-call-started", { callId: `c${seq}`, flowName, input }),
  event(seq + 1, "agent.cell-call-settled", { callId: `c${seq}`, flowName, outcome: "success", value })
]
const plan = { ...CODING_PLAN, changes: [{ ...CODING_PLAN.changes[0]!, checks: [
  { ...CODING_PLAN.changes[0]!.checks[0]!, target: "tests/memory" }, CODING_PLAN.changes[0]!.checks[1]!
] }] }
const goals = (records: ReadonlyArray<JournalRecord>, cursor?: number) => traceGoals(model(records), plan, cursor)
const checkState = (records: ReadonlyArray<JournalRecord>, cursor?: number) => goals(records, cursor)[0]!.checks[0]!.state

describe("current run status", () => {
  test("a late cell record cannot hide the native call that is still running", () => {
    const callId = `cell-call-v1:${"a".repeat(64)}`
    const native: JournalRecord = { sequence: 2, kind: "control.engine.event", runId: "run-1", payload: {
      version: 1, sequence: 10, eventType: "flows.harness.call-fact.v1", executionId: "run-1", generation: 0, emittedAtMs: 200,
      sourceSequence: 0, sourceId: `call-fact-v1:${callId}:invoked`, payload: {
        version: 1, phase: "invoked", callId, flowName: "bash", input: { command: "bun test marker.test.ts" },
        identity: { runId: "run-1", cell: "cell", declaration: "bash-v1", frame: 0, ordinal: 0, layers: [] }
      }
    } }
    const records = [event(1, "agent.turn-opened"), native,
      event(3, "agent.cell-produced", { digest: "cell", text: "recorded cell" }),
      event(4, "agent.cell-call-started", { callId, flowName: "bash", input: { command: "bun test marker.test.ts" } })]
    expect(traceStatus(model(records)).activity).toBe("Running bun test marker.test.ts")
    expect(traceStatus(model(records), 3).activity).toBe("Running bun test marker.test.ts")
    expect(traceStatus(model([...records, event(5, "agent.cell-call-settled", { callId, flowName: "bash", outcome: "success", value: { exitCode: 0 } })])).activity)
      .toBe("Ran bun test marker.test.ts")
  })
  test("activity remains independent of a recorded thrashing condition", () => {
    const records = [...call(1, "read", { path: "README.md" }), event(3, "agent.repeat-demanded", { frames: 3, cap: 3 })]
    expect(traceStatus(model(records))).toMatchObject({ activity: "Read README.md", condition: "thrashing" })
    expect(traceStatus(model(records), 1).activity).toBe("Reading README.md")
    expect(traceStatus(model(records), 2).condition).toBeUndefined()
    expect(traceStatus(model([...records, event(4, "agent.mutation-observed", { basis: "observed", mutated: true })])).condition).toBeUndefined()
    expect(traceStatus(model([...records, event(4, "agent.mutation-observed", { basis: "declared", mutated: true })])).condition).toBe("thrashing")
  })
  test("park and resume change the condition without erasing activity", () => {
    const records = [...call(1, "bash", { command: "bun test" }), event(3, "agent.suspended", { reason: "event" })]
    expect(traceStatus(model(records))).toMatchObject({ activity: "Ran bun test", condition: "blocked", action: "resume" })
    expect(traceStatus(model([...records, event(4, "run.resumed")])).condition).toBeUndefined()
  })
  test("only unresolved approvals request a human decision", () => {
    const records = [event(1, "approval.requested", { requestId: "q" }), event(2, "approval.approved", { requestId: "q" })]
    expect(traceStatus(model(records), 1)).toMatchObject({ condition: "approval", action: "approval" })
    expect(traceStatus(model(records)).action).toBeUndefined()
  })
  test.each(["completed", "failed", "cancelled", "no-capacity"])("%s clears live actions and conditions", status => {
    expect(traceStatus(model([event(1, "approval.requested", { requestId: "q" }), event(2, "agent.repeat-demanded")], status))).toEqual({ verdict: status })
  })
  test("prose, repetition and missing records cannot invent a condition", () => {
    expect(traceStatus(model([]))).toEqual({})
    expect(traceStatus(model([event(1, "agent.model-settled", { text: "I am thrashing and blocked" })])).condition).toBeUndefined()
    expect(traceStatus(model([...call(1, "read", { path: "README" }), ...call(3, "read", { path: "README" })])).condition).toBeUndefined()
  })
  test("settled calls use past tense and never replace another open call", () => {
    const first = call(1, "read", { path: "README.md" })
    const second = call(2, "write", { path: "src/file.ts" })
    // One subject and one verb: the header names what the row names, through
    // the declared `path` subject and the declared failure verb.
    expect(traceStatus(model([first[0]!, second[0]!, { ...first[1]!, sequence: 3 }])).activity).toBe("Writing file.ts")
    expect(traceStatus(model([first[0]!, { ...first[1]!, payload: { flowName: "read", callId: "c1", outcome: "failure" } }])).activity).toBe("Failed to read README.md")
  })
})

describe("recorded goal progress", () => {
  test("no plan means no goals; a write or prose never verifies one", () => {
    expect(traceGoals(model([]), undefined)).toEqual([])
    expect(checkState([...call(1, "write", { path: "src/memory.ts" }), event(3, "agent.resolved", { text: "All tests passed" })])).toBe("pending")
  })
  test("a check needs its result at the cursor; a successful call with nonzero exit fails", () => {
    const records = call(1, "bash", { command: "bun test tests/memory" }, { exitCode: 1 })
    expect(checkState(records, 0)).toBe("pending")
    expect(checkState(records, 1)).toBe("running")
    expect(checkState(records, 2)).toBe("failed")
    for (const target of ["tests/memory", '"tests/memory"', "'tests/memory'"]) {
      expect(checkState(call(1, "bash", { command: `bun test ${target}` }))).toBe("narrowed")
    }
    expect(checkState(call(1, "bash", { command: "bun test tests/memory" }, "passed"))).toBe("pending")
  })
  test.each(["echo bun test tests/memory", "cat tests/memory", "bun test tests/memory || true", "bun test tests/memory; echo ok", "bun test tests/memory-other"])("%s never verifies the target", command => {
    expect(checkState(call(1, "bash", { command }))).toBe("pending")
  })
  test.each(['bun test "tests/memory"Other', "bun test 'tests/memory'Other"])("%s cannot turn a quoted prefix into a matching target", command => {
    expect(checkState(call(1, "bash", { command }))).toBe("pending")
  })
  test.each(["bun test tests/memory/a.test.ts", "bun test tests/memory --test-name-pattern tiny", "pytest tests/memory -k tiny"])("%s records narrowed verification", command => {
    expect(checkState(call(1, "bash", { command }))).toBe("narrowed")
  })
  test("relevant changes invalidate results; unrelated paths do not; an earlier in-flight check stays stale", () => {
    const checked = call(1, "bash", { command: "bun test tests/memory" })
    expect(checkState([...checked, event(3, "agent.mutation-observed", { basis: "observed", mutated: true, paths: ["README.md"] })])).toBe("narrowed")
    const changed = [...checked, event(3, "agent.mutation-observed", { basis: "observed", mutated: true, paths: ["src/memory.ts"] })]
    expect(checkState(changed)).toBe("stale")
    expect(checkState([...checked, ...call(3, "apply_patch", { input: "*** Begin Patch\n*** Update File: README.md\n*** Move to: src/memory.ts\n*** End Patch" })])).toBe("stale")
    expect(checkState(changed, 2)).toBe("narrowed")
    expect(checkState([...changed, ...call(4, "bash", { command: "bun test tests/memory" })])).toBe("narrowed")
    expect(checkState([checked[0]!, event(2, "agent.mutation-observed", { basis: "observed", mutated: true }), { ...checked[1]!, sequence: 3 }])).toBe("stale")
  })
  test("recorded commands leave a goal partial however many of its checks they match", () => {
    expect(goals(call(1, "bash", { command: "bun test tests/memory" }))[0]!.state).toBe("narrowed")
    expect(goals([...call(1, "bash", { command: "bun test tests/memory" }), ...call(3, "bash", { command: "bun run check //memory:review" })])[0]!.state).toBe("narrowed")
  })
  test.each(["./src/memory.ts", "src/../src/memory.ts", "/workspace/src/memory.ts", "src\\memory.ts"])("a changed path spelled %s cannot retain a passing check", path => {
    expect(checkState([...call(1, "bash", { command: "bun test tests/memory" }),
      event(3, "agent.mutation-observed", { basis: "observed", mutated: true, paths: [path] })])).toBe("stale")
  })
  test("native receipts bind the exact plan check, implementation and ancestry", () => {
    const change = CODING_PLAN.changes[0]!, check = change.checks[0]!
    const implementation = { change: change.id, parent: CODING_PLAN.base, head: CODING_PLAN.base, atoms: [CODING_PLAN.base], reads: [], writes: ["src/memory.ts"] }
    const receipt = { checkId: check.id, target: check.target, tier: check.tier, change: change.id, commitId: implementation.head.commitId,
      treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status: "passed", evidence: "", findings: [] }
    const recorded = (value = receipt, parent = "correct") => [...preparedCodingJournal(),
      codingDecision(6, "check", "coding/CommandCheck", { parent, input: { flow: check.flow, input: { implementation, check } }, status: "completed", value })]
    const state = (records: ReadonlyArray<JournalRecord>, cursor?: number) => traceGoals(model(records), CODING_PLAN, cursor)[0]!.checks[0]!.state
    expect(state(recorded())).toBe("passed")
    expect(state(recorded(), 5)).toBe("pending")
    expect(state(recorded({ ...receipt, inputDigest: "other" }))).toBe("pending")
    expect(state(recorded(receipt, "unrelated"))).toBe("pending")
    expect(state(recorded({ ...receipt, status: "failed" }))).toBe("failed")
    expect(state(recorded({ ...receipt, status: "superseded" }))).toBe("stale")
    const started = [...preparedCodingJournal(), codingDecision(6, "check", "coding/CommandCheck", {
      parent: "correct", status: "running", input: { flow: check.flow, input: { implementation, check } }
    })]
    expect(state(started)).toBe("running")
    expect(state([...started, codingDecision(7, "check", "coding/CommandCheck", {
      parent: "correct", status: "failed", input: { flow: check.flow, input: { implementation, check } }
    })])).toBe("failed")
    expect(state([...recorded(), codingDecision(7, "implementation", "coding/ImplementAtoms", {
      parent: "correct", status: "completed", value: { ...implementation, head: { ...implementation.head, treeId: "new-tree" } }
    })])).toBe("stale")
    const concurrent = [...started, event(7, "agent.mutation-observed", { basis: "observed", mutated: true }),
      codingDecision(8, "check", "coding/CommandCheck", { parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } }, value: receipt })]
    expect(state(concurrent)).toBe("stale")
  })
  test("a receipt outranks a later command that only matched the same target", () => {
    const change = CODING_PLAN.changes[0]!, check = change.checks[0]!
    const implementation = { change: change.id, parent: CODING_PLAN.base, head: CODING_PLAN.base, atoms: [CODING_PLAN.base], reads: [], writes: ["src/memory.ts"] }
    const receipt = { checkId: check.id, target: check.target, tier: check.tier, change: change.id, commitId: implementation.head.commitId,
      treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status: "passed", evidence: "", findings: [] }
    const certified = [...preparedCodingJournal(), codingDecision(6, "check", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } }, value: receipt
    })]
    const ran = call(7, "bash", { command: `bun run check ${check.target}` })
    const state = (records: ReadonlyArray<JournalRecord>) => traceGoals(model(records), CODING_PLAN)[0]!.checks[0]!.state
    expect(state(certified)).toBe("passed")
    expect(state([...certified, ...ran])).toBe("passed")
    // A change the check covers still invalidates the receipt.
    expect(state([...certified, ...ran, event(9, "agent.mutation-observed", { basis: "observed", mutated: true, paths: ["src/memory.ts"] })])).toBe("stale")
  })
  test.each([
    { name: "a different input digest", changed: { inputDigest: "sha256:unrelated-input" }, validReceipt: true },
    { name: "a different target", changed: { target: "//other:typecheck" }, validReceipt: true },
    { name: "a different check id", changed: { checkId: "other-check" }, validReceipt: true },
    { name: "a different tier", changed: { tier: "slow" }, validReceipt: true },
    { name: "a different change id", changed: { change: "other-change" }, validReceipt: true },
    { name: "a different commit id", changed: { commitId: "other-commit" }, validReceipt: true },
    { name: "a different tree id", changed: { treeId: "other-tree" }, validReceipt: true },
    { name: "a malformed receipt", changed: { status: "completed" }, validReceipt: false }
  ])("a later unbound native answer with $name cannot replace an existing matching receipt", ({ changed, validReceipt }) => {
    const change = CODING_PLAN.changes[0]!, check = change.checks[0]!
    const implementation = { change: change.id, parent: CODING_PLAN.base, head: CODING_PLAN.base, atoms: [CODING_PLAN.base], reads: [], writes: ["src/memory.ts"] }
    const receipt = { checkId: check.id, target: check.target, tier: check.tier, change: change.id, commitId: implementation.head.commitId,
      treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status: "passed", evidence: "", findings: [] }
    const certified = [...preparedCodingJournal(), codingDecision(6, "bound-check", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } }, value: receipt
    })]
    const later = { ...receipt, ...changed }
    expect(Schema.is(Receipt)(later)).toBe(validReceipt)
    const unbound = codingDecision(7, "unbound-check", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } }, value: later
    })
    const state = (records: ReadonlyArray<JournalRecord>) => traceGoals(model(records), CODING_PLAN)[0]!.checks[0]!.state
    expect(state([...preparedCodingJournal(), unbound])).toBe("pending")
    expect(state(certified)).toBe("passed")
    expect(state([...certified, unbound])).toBe("passed")
  })
  test.each([
    { name: "a failed receipt", status: "failed" as const, mutation: false, expected: "failed" },
    { name: "a superseded receipt", status: "superseded" as const, mutation: false, expected: "stale" },
    { name: "a passed receipt invalidated by a write", status: "passed" as const, mutation: true, expected: "stale" }
  ])("an unbound native answer preserves $name", ({ status, mutation, expected }) => {
    const change = CODING_PLAN.changes[0]!, check = change.checks[0]!
    const implementation = { change: change.id, parent: CODING_PLAN.base, head: CODING_PLAN.base, atoms: [CODING_PLAN.base], reads: [], writes: ["src/memory.ts"] }
    const receipt = { checkId: check.id, target: check.target, tier: check.tier, change: change.id, commitId: implementation.head.commitId,
      treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status, evidence: "", findings: [] }
    const certified = [...preparedCodingJournal(), codingDecision(6, "bound-check", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } }, value: receipt
    }), ...(mutation ? [event(7, "agent.mutation-observed", { basis: "observed", mutated: true, paths: ["src/memory.ts"] })] : [])]
    const state = (records: ReadonlyArray<JournalRecord>) => traceGoals(model(records), CODING_PLAN)[0]!.checks[0]!.state
    expect(state(certified)).toBe(expected)
    expect(state([...certified, codingDecision(8, "unbound-check", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } },
      value: { ...receipt, inputDigest: "sha256:unrelated-input" }
    })])).toBe(expected)
  })
  test.each([
    { name: "passed", mutation: false, expected: "passed" },
    { name: "stale after an observed write", mutation: true, expected: "stale" }
  ])("a later unfinished native check retains the $name certificate", ({ mutation, expected }) => {
    const change = CODING_PLAN.changes[0]!, check = change.checks[0]!
    const implementation = { change: change.id, parent: CODING_PLAN.base, head: CODING_PLAN.base, atoms: [CODING_PLAN.base], reads: [], writes: ["src/memory.ts"] }
    const receipt = { checkId: check.id, target: check.target, tier: check.tier, change: change.id, commitId: implementation.head.commitId,
      treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status: "passed", evidence: "", findings: [] }
    const certified = [...preparedCodingJournal(), codingDecision(6, "bound-check", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } }, value: receipt
    }), ...(mutation ? [event(7, "agent.mutation-observed", { basis: "observed", mutated: true, paths: ["src/memory.ts"] })] : [])]
    const state = (records: ReadonlyArray<JournalRecord>) => traceGoals(model(records), CODING_PLAN)[0]!.checks[0]!.state
    expect(state(certified)).toBe(expected)
    expect(state([...certified, codingDecision(8, "running-check", "coding/CommandCheck", {
      parent: "correct", status: "running", input: { flow: check.flow, input: { implementation, check } }
    })])).toBe(expected)
  })
  test.each([
    { status: "passed" as const, expected: "passed" },
    { status: "failed" as const, expected: "failed" },
    { status: "superseded" as const, expected: "stale" }
  ])("a newer matching $status receipt remains authoritative after a verified check", ({ status, expected }) => {
    const change = CODING_PLAN.changes[0]!, check = change.checks[0]!
    const implementation = { change: change.id, parent: CODING_PLAN.base, head: CODING_PLAN.base, atoms: [CODING_PLAN.base], reads: [], writes: ["src/memory.ts"] }
    const receipt = { checkId: check.id, target: check.target, tier: check.tier, change: change.id, commitId: implementation.head.commitId,
      treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status: "passed", evidence: "", findings: [] }
    const certified = [...preparedCodingJournal(), codingDecision(6, "bound-check", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } }, value: receipt
    })]
    const state = (records: ReadonlyArray<JournalRecord>) => traceGoals(model(records), CODING_PLAN)[0]!.checks[0]!.state
    expect(state(certified)).toBe("passed")
    expect(state([...certified, codingDecision(7, "new-bound-check", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } },
      value: { ...receipt, status }
    })])).toBe(expected)
  })
  test("a new matching receipt certifies the changed tree after an observed write", () => {
    const change = CODING_PLAN.changes[0]!, check = change.checks[0]!
    const implementation = { change: change.id, parent: CODING_PLAN.base, head: CODING_PLAN.base, atoms: [CODING_PLAN.base], reads: [], writes: ["src/memory.ts"] }
    const receipt = { checkId: check.id, target: check.target, tier: check.tier, change: change.id, commitId: implementation.head.commitId,
      treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status: "passed", evidence: "", findings: [] }
    const changed = { ...implementation, head: { ...implementation.head, treeId: "changed-tree" } }
    const certified = [...preparedCodingJournal(), codingDecision(6, "bound-check", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } }, value: receipt
    }), event(7, "agent.mutation-observed", { basis: "observed", mutated: true, paths: ["src/memory.ts"] })]
    const state = (records: ReadonlyArray<JournalRecord>) => traceGoals(model(records), CODING_PLAN)[0]!.checks[0]!.state
    expect(state(certified)).toBe("stale")
    expect(state([...certified, codingDecision(8, "new-tree-check", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation: changed, check } },
      value: { ...receipt, treeId: "changed-tree", inputDigest: checkInputDigest(changed, check) }
    })])).toBe("passed")
  })
  test("a newer check execution failure remains authoritative after a verified check", () => {
    const change = CODING_PLAN.changes[0]!, check = change.checks[0]!
    const implementation = { change: change.id, parent: CODING_PLAN.base, head: CODING_PLAN.base, atoms: [CODING_PLAN.base], reads: [], writes: ["src/memory.ts"] }
    const receipt = { checkId: check.id, target: check.target, tier: check.tier, change: change.id, commitId: implementation.head.commitId,
      treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status: "passed", evidence: "", findings: [] }
    const certified = [...preparedCodingJournal(), codingDecision(6, "bound-check", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } }, value: receipt
    })]
    const state = (records: ReadonlyArray<JournalRecord>) => traceGoals(model(records), CODING_PLAN)[0]!.checks[0]!.state
    expect(state(certified)).toBe("passed")
    expect(state([...certified, codingDecision(7, "failed-check", "coding/CommandCheck", {
      parent: "correct", status: "failed", input: { flow: check.flow, input: { implementation, check } }, value: "Command failed"
    })])).toBe("failed")
  })
  test.each([
    { name: "absent", prior: false, result: "passed" as const, expected: "passed" },
    { name: "present", prior: true, result: "failed" as const, expected: "failed" }
  ])("an unbound later answer cannot suppress an earlier-open matching receipt (prior certificate $name)", ({ prior, result, expected }) => {
    const change = CODING_PLAN.changes[0]!, check = change.checks[0]!
    const implementation = { change: change.id, parent: CODING_PLAN.base, head: CODING_PLAN.base, atoms: [CODING_PLAN.base], reads: [], writes: ["src/memory.ts"] }
    const receipt = { checkId: check.id, target: check.target, tier: check.tier, change: change.id, commitId: implementation.head.commitId,
      treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status: "passed", evidence: "", findings: [] }
    const records = [...preparedCodingJournal(), ...(prior ? [codingDecision(6, "prior-check", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } }, value: receipt
    })] : []), codingDecision(7, "earlier-open", "coding/CommandCheck", {
      parent: "correct", status: "running", input: { flow: check.flow, input: { implementation, check } }
    }), codingDecision(8, "later-unbound", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } },
      value: { ...receipt, inputDigest: "sha256:unrelated-input" }
    }), codingDecision(9, "earlier-open", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } }, value: { ...receipt, status: result }
    })]
    const state = (cursor?: number) => traceGoals(model(records), CODING_PLAN, cursor)[0]!.checks[0]!.state
    expect(state(6)).toBe(prior ? "passed" : "pending")
    expect(state(9)).toBe(expected)
  })
  test.each([
    { latest: "passed" as const, older: "failed" as const, expected: "passed" },
    { latest: "failed" as const, older: "passed" as const, expected: "failed" }
  ])("a newer bound $latest answer outranks an older-open $older answer arriving afterward", ({ latest, older, expected }) => {
    const change = CODING_PLAN.changes[0]!, check = change.checks[0]!
    const implementation = { change: change.id, parent: CODING_PLAN.base, head: CODING_PLAN.base, atoms: [CODING_PLAN.base], reads: [], writes: ["src/memory.ts"] }
    const receipt = { checkId: check.id, target: check.target, tier: check.tier, change: change.id, commitId: implementation.head.commitId,
      treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), evidence: "", findings: [] }
    const records = [...preparedCodingJournal(), codingDecision(7, "earlier-open", "coding/CommandCheck", {
      parent: "correct", status: "running", input: { flow: check.flow, input: { implementation, check } }
    }), codingDecision(8, "later-bound", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } },
      value: { ...receipt, status: latest }
    }), codingDecision(9, "earlier-open", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } },
      value: { ...receipt, status: older }
    })]
    const state = (cursor: number) => traceGoals(model(records), CODING_PLAN, cursor)[0]!.checks[0]!.state
    expect(state(8)).toBe(expected)
    expect(state(9)).toBe(expected)
  })
  test("a goal is verified only when every required check carries its own matching receipt", () => {
    const change = CODING_PLAN.changes[0]!
    const implementation = { change: change.id, parent: CODING_PLAN.base, head: CODING_PLAN.base, atoms: [CODING_PLAN.base], reads: [], writes: ["src/memory.ts"] }
    const receipt = (check: (typeof change.checks)[number]) => ({
      checkId: check.id, target: check.target, tier: check.tier, change: change.id, commitId: implementation.head.commitId,
      treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status: "passed", evidence: "", findings: []
    })
    const checked = (...bound: ReadonlyArray<readonly [(typeof change.checks)[number], string]>) => [...preparedCodingJournal(),
      ...bound.map(([check, flow], index) => codingDecision(6 + index, `check-${check.id}`, "coding/CommandCheck", {
        parent: "correct", status: "completed", input: { flow, input: { implementation, check } }, value: receipt(check)
      }))]
    const goal = (records: ReadonlyArray<JournalRecord>) => traceGoals(model(records), CODING_PLAN)[0]!
    const [types, review] = change.checks
    expect(goal(checked([types!, types!.flow])).state).toBe("pending")
    expect(goal(checked([types!, types!.flow], [review!, review!.flow])).checks.map(check => check.state)).toEqual(["passed", "passed"])
    expect(goal(checked([types!, types!.flow], [review!, review!.flow])).state).toBe("passed")
    // The wrapper names the flow the check declared, or the receipt is not this check's.
    expect(goal(checked([types!, review!.flow], [review!, review!.flow])).checks.map(check => check.state)).toEqual(["pending", "passed"])
  })
  test("test selections, declaration-only mutations, and explicit narrowing preserve the evidence boundary", () => {
    const passed = call(1, "test", { selection: ["tests/memory"] })
    expect(checkState(passed)).toBe("narrowed")
    expect(checkState(call(1, "test", { selection: ["tests/memory/single.test.ts"] }))).toBe("narrowed")
    expect(checkState(call(1, "test", { selection: ["tests/memory"] }, { exitCode: 0, parsed: true, passed: 0, failed: [] }))).toBe("pending")
    expect(checkState(call(1, "bash", { command: "bun test tests/memory" }, { exitCode: 0, invalidProbe: {} }))).toBe("failed")
    expect(checkState([...passed, event(3, "agent.mutation-observed", { basis: "declared", mutated: true })])).toBe("narrowed")
    expect(checkState([...passed, event(3, "agent.narrowed-demanded", { flow: "test", broader: { selection: ["tests/memory"] }, narrower: { selection: ["tests/memory/one"] } })])).toBe("narrowed")
  })
  test("a baseline comparison uses the workspace result and unknown runner options make no scope claim", () => {
    expect(checkState(call(1, "test", { selection: ["tests/memory"], against: "base" }, { exitCode: 1, base: { exitCode: 0 } }))).toBe("failed")
    expect(checkState(call(1, "bash", { command: "bun test tests/memory --unknown-option" }))).toBe("pending")
    expect(checkState(call(1, "bash", { command: "bun test tests/memory --help" }))).toBe("pending")
  })
})

describe("a runaway guard's park", () => {
  const incident = {
    classification: "Runaway", source: "usd", message: "The run would spend past its $1.00 budget",
    used: 0.9, reserved: 0.1, max: 1, next: 0.25, allowance: 2
  }
  const parked = [event(1, "approval.requested", { requestId: "budget/run-1/usd", question: "Raise the USD budget?", incident })]
  test("an undecided request carrying the guard's facts is the run's incident", () => {
    expect(traceStatus(model(parked))).toMatchObject({
      incident: { requestId: "budget/run-1/usd", facts: incident }, condition: "approval", action: "approval"
    })
    expect(traceStatus(model([event(1, "approval.requested", { requestId: "t", incident: { ...incident, classification: "Stuck", source: "latency" } })]))
      .incident?.facts.classification).toBe("Stuck")
  })
  test("a request without valid facts is an approval, not an incident", () => {
    expect(traceStatus(model([event(1, "approval.requested", { requestId: "q" })])).incident).toBeUndefined()
    expect(traceStatus(model([event(1, "approval.requested", { requestId: "q", incident: { ...incident, classification: "Oops" } })])).incident).toBeUndefined()
  })
  test("a decision on the request settles it, by request id, token id or approval target", () => {
    for (const decided of [{ requestId: "budget/run-1/usd" }, { tokenId: "budget/run-1/usd" }, { approvalTarget: { requestId: "budget/run-1/usd" } }]) {
      expect(traceStatus(model([...parked, event(2, "approval.approved", decided)])).incident).toBeUndefined()
      expect(traceStatus(model([...parked, event(2, "approval.denied", decided)])).incident).toBeUndefined()
    }
    expect(traceStatus(model([...parked, event(2, "approval.approved", { requestId: "another" })])).incident).toBeDefined()
  })
  test("a recorded budget park is runaway until the same run resumes", () => {
    const park = event(1, "run.parked", { reason: "budget" })
    expect(traceStatus(model([park]))).toEqual({ condition: "runaway" })
    // Its request, when it arrives, is the decision the run waits on.
    expect(traceStatus(model([park, ...parked.map(row => ({ ...row, sequence: 2 }))]))).toMatchObject({
      incident: { requestId: "budget/run-1/usd" }, condition: "approval", action: "approval"
    })
    expect(traceStatus(model([park, event(2, "run.resumed")])).condition).toBeUndefined()
    // Another step's operator park still offers its resume.
    expect(traceStatus(model([park, event(2, "run.parked", { reason: "event" })]))).toMatchObject({ condition: "blocked", action: "resume" })
  })
  test("a stopped run reads its verdict and no incident", () => {
    expect(traceStatus(model([...parked, event(2, "run.cancelled")]))).toEqual({ verdict: "cancelled" })
    expect(traceStatus(model(parked, "cancelled"))).toEqual({ verdict: "cancelled" })
  })
})
