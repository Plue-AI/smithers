import { EventTypes } from "@smthrs/engine-store/EventTypes"
import { describe, expect, test } from "vitest"
import {
  engineExecutionEvidence,
  engineProjectionPending,
  engineRunEvidence,
  engineTraceFromJournal
} from "../src/EngineTrace.js"
import type { JournalRecord } from "../src/RunTrace.js"
import { monitorFromJournal, traceFromJournal, turnNarratives } from "../src/RunTrace.js"

const nativeRecord = (eventType: string, payload: unknown) => ({ eventType, payload })

const run = { runId: "control", flowId: "coding", status: "running" }
const lineage = (id = "native") => ({
  kind: "root",
  runId: id,
  rootRunId: id,
  lineageId: id,
  round: 0,
  parentRunId: null
})
const wrap = (
  sequence: number,
  executionId: string,
  eventType: string,
  payload: unknown,
  generation = 0
): JournalRecord => ({
  sequence,
  occurredAt: 1000 + sequence,
  kind: "control.engine.event",
  payload: {
    version: 1,
    executionId,
    generation,
    sequence,
    eventId: `${executionId}/${generation}/${sequence}`,
    sourceId: "engine",
    sourceSequence: sequence,
    emittedAtMs: sequence + 100,
    eventType,
    payload,
    meta: { lineageId: executionId }
  }
})

/** The bridge envelopes carry the engine’s public event tag and encoded state/result contracts. */
const decision = (
  sequence: number,
  executionId: string,
  status?: string,
  value?: unknown,
  parentExecutionId?: string,
  generation = 0
) => {
  const record = nativeRecord(EventTypes.runDecision, {
    decision: status === undefined ? "created" : "transitioned",
    ...(status === undefined ? {} : { status }),
    state: {
      version: 1,
      flowName: executionId === "native" ? "coding/ImplementPlan" : "coding/Check",
      payload: { target: "typecheck" },
      ...(parentExecutionId === undefined ? {} : { parentExecutionId }),
      ...(status === "completed" ? { result: { _tag: "Complete", exit: { _tag: "Success", value } } } : {})
    }
  })
  return wrap(sequence, executionId, record.eventType, record.payload, generation)
}

describe("recorded engine evidence in the run trace", () => {
  test("native steps use their recorded action label and redacted result through the trace fold", () => {
    const scheduled = wrap(1, "native", "flows.engine.node-scheduled", {
      nodeId: "check",
      kind: "action",
      attempt: 1,
      action: "coding/check-command"
    })
    const settled = wrap(2, "native", "flows.engine.node-settled", {
      nodeId: "check",
      outcome: "built",
      attempts: 1,
      result: { preview: "{\"status\":\"failed\",\"findings\":[]}", bytes: 33, truncated: false }
    })
    const records = [scheduled, settled, settled]
    const model = traceFromJournal(run, records)
    const node = model.rows.find((row) => row.id.startsWith("engine-node:"))!
    expect(node).toMatchObject({
      kind: "call",
      label: "Ran checks",
      status: "completed",
      startedAt: 101,
      endedAt: 102,
      detail: { sequence: 1, output: "{\"status\":\"failed\",\"findings\":[]}" }
    })
    expect(model.rows.filter((row) => row.id.startsWith("engine-node:"))).toHaveLength(1)
    expect(traceFromJournal(run, records)).toEqual(model)
    expect(traceFromJournal(run, [scheduled]).rows.find((row) => row.id === node.id)?.status).toBe("running")
  })

  test("each native rescheduling retains its own step instance and generation", () => {
    const schedule = (seq: number, generation = 0) =>
      wrap(seq, "native", "flows.engine.node-scheduled", {
        nodeId: "check",
        kind: "action",
        attempt: seq,
        action: "coding/check-command"
      }, generation)
    const finish = (seq: number) =>
      wrap(seq, "native", "flows.engine.node-settled", {
        nodeId: "check",
        outcome: "failed",
        attempts: 1,
        result: { preview: "failure", bytes: 7, truncated: false }
      })
    const records = [schedule(1), finish(2), schedule(3), schedule(4, 1)]
    const model = traceFromJournal(run, records)
    const nodes = model.rows.filter((row) => row.id.startsWith("engine-node:"))
    expect(nodes).toHaveLength(3)
    expect(new Set(nodes.map((row) => row.id)).size).toBe(3)
    expect(nodes.map((row) => [row.status, row.detail.output, row.endedAt])).toEqual([
      ["failed", "failure", 102],
      ["running", undefined, undefined],
      ["running", undefined, undefined]
    ])
    expect(traceFromJournal(run, [...records, records[2]!]).rows).toEqual(model.rows)
  })

  test("native node outcomes retain missing and truncated evidence without executing it", () => {
    const cases = [
      ["failed", "failed"],
      ["clean", "completed"],
      ["skipped", "skipped"],
      ["deferred", "waiting"]
    ] as const
    for (const [outcome, status] of cases) {
      const record = wrap(1, "native", "flows.engine.node-settled", {
        nodeId: "edit",
        action: "coding/edit-atom",
        outcome,
        attempts: 1,
        result: { preview: "globalThis.monitorCanary = true", bytes: 9000, truncated: true }
      })
      const node = traceFromJournal(run, [record]).rows.find((row) => row.id.startsWith("engine-node:"))!
      expect(node.label).toBe("Edited the files")
      expect(node.status).toBe(status)
      expect(node.detail.output).toBe("globalThis.monitorCanary = true")
      expect(node.detail.fields?.payload).toMatchObject({ result: { truncated: true, bytes: 9000 } })
      expect(node.endedAt).toBe(outcome === "deferred" ? undefined : 101)
    }
    const malformed = wrap(1, "native", "flows.engine.node-settled", { nodeId: "edit", outcome: "invented" })
    expect(traceFromJournal(run, [malformed]).rows.some((row) => row.id.startsWith("engine-node:"))).toBe(false)
    const unknown = wrap(1, "native", "flows.engine.node-settled", {
      nodeId: "legacy-step",
      outcome: "built",
      attempts: 1
    })
    expect(traceFromJournal(run, [unknown]).rows.find((row) => row.id.startsWith("engine-node:"))).toMatchObject({
      label: "legacy-step"
    })
  })

  test("leaves unrelated journal records out of engine evidence", () => {
    expect(engineTraceFromJournal([{ sequence: 1, kind: "control.agent.turn-opened", payload: {} }])).toEqual([])
  })

  test("only the matching recorded projection generation settles observation", () => {
    const marker = (sequence: number, kind: string, generation: number) => ({
      sequence,
      kind,
      payload: { version: 1, executionId: "native", generation }
    })
    const records = [
      marker(1, "control.engine.projection-started", 0),
      marker(2, "control.engine.projection-settled", 0)
    ]
    expect(engineProjectionPending(records)).toBe(false)
    records.push(marker(3, "control.engine.projection-started", 1), marker(4, "control.engine.projection-settled", 0))
    expect(engineProjectionPending(records)).toBe(true)
    expect(engineProjectionPending([...records, { sequence: 5, kind: "control.engine.projection-gap", payload: {} }]))
      .toBe(false)
    expect(engineProjectionPending([...records, marker(5, "control.engine.projection-settled", 1)])).toBe(false)
  })
  test("reads durable handoff, lineage failures and cancellation without inventing outputs", () => {
    const terminal = (id: string, choice: string, status: string, result: unknown) => {
      const record = nativeRecord(EventTypes.runDecision, {
        decision: choice,
        status,
        state: { version: 1, flowName: "round", payload: {}, result }
      })
      return wrap(1, id, record.eventType, record.payload)
    }
    const failure = { _tag: "Complete", exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: "round refused" }] } }
    const cancelled = nativeRecord("flows.engine.interrupted", {
      outcome: "cancelled",
      interruptedAtMs: 40,
      owner: "driver"
    })
    const records = [
      terminal("handoff", "handed-off", "completed", { _tag: "Handoff", flow: "next", payload: { round: 2 } }),
      terminal("exhausted", "lineage-exhausted", "failed", failure),
      terminal("invalid", "round-invalid", "failed", failure),
      decision(2, "cancel"),
      wrap(3, "cancel", cancelled.eventType, cancelled.payload),
      wrap(4, "fenced", cancelled.eventType, { outcome: "fenced", interruptedAtMs: 45, owner: "driver" })
    ]
    const roots = traceFromJournal(run, records).root.children
    expect(roots.map((row) => row.status)).toEqual(["completed", "failed", "failed", "cancelled", "recorded"])
    expect(roots[1]?.detail.message).toContain("round refused")
    expect(roots[3]?.endedAt).toBe(40)
    expect(roots[3]?.detail.input).toEqual({ target: "typecheck" })
    expect(roots.every((row) => row.detail.output === undefined)).toBe(true)
    expect(roots[0]?.detail.fields?.payload).toMatchObject({ state: { result: { _tag: "Handoff" } } })
  })

  test("quarantine and host release preserve the writer’s recorded parked execution", () => {
    for (const chosen of [{ decision: "quarantined", status: "suspended" }, { decision: "interrupt-released" }]) {
      const record = nativeRecord(EventTypes.runDecision, {
        ...chosen,
        state: { version: 1, flowName: "native", payload: { input: "retained" } }
      })
      const root = traceFromJournal(run, [wrap(1, "native", record.eventType, record.payload)]).root.children[0]!
      expect(root.status).toBe("waiting")
      expect(root.detail.input).toEqual({ input: "retained" })
      expect(root.detail.output).toBeUndefined()
      expect(root.endedAt).toBeUndefined()
    }
  })

  test("observation lifecycle markers do not become work inside the open agent turn", () => {
    const model = traceFromJournal(run, [
      { sequence: 1, kind: "control.agent.turn-opened", occurredAt: 1, payload: { turn: 1 } },
      {
        sequence: 2,
        kind: "control.engine.projection-started",
        payload: { version: 1, executionId: "native", generation: 0 }
      },
      {
        sequence: 3,
        kind: "control.engine.projection-settled",
        payload: { version: 1, executionId: "native", generation: 0 }
      }
    ])
    expect(model.rows.some((row) => row.detail.event?.startsWith("control.engine.projection-"))).toBe(false)
  })

  test("uses recorded child ancestry and real terminal result bytes without making a check verdict from native completion", () => {
    const records = [
      decision(1, "native"),
      decision(2, "opaque-child", undefined, undefined, "native"),
      wrap(3, "opaque-child", "flows.engine.attempt-started", {
        runId: "opaque-child",
        stepKeyDigest: "step",
        attempt: 0,
        tier: "sealed"
      }),
      wrap(4, "opaque-child", "flows.engine.attempt-finished", {
        runId: "opaque-child",
        stepKeyDigest: "step",
        attempt: 0,
        state: "succeeded",
        value: "not an attempt result"
      }),
      decision(5, "opaque-child", "completed", { passed: false, target: "typecheck" }, "native")
    ]
    const model = traceFromJournal(run, records)
    const native = model.root.children[0]!
    expect(native).toMatchObject({
      kind: "execution",
      label: "Implemented the plan",
      status: "pending",
      startedAt: 101
    })
    expect(native.children[0]).toMatchObject({
      kind: "execution",
      label: "coding/Check",
      status: "completed",
      detail: { output: "{\"passed\":false,\"target\":\"typecheck\"}" }
    })
    const attempt = native.children[0]!.children[0]!
    expect(attempt).toMatchObject({ kind: "attempt", status: "completed", startedAt: 103, endedAt: 104 })
    expect(attempt.detail.output).toBeUndefined()
    expect(turnNarratives(model)).toEqual([])
    // A control completion does not invent a completion for this still-open execution.
    const completed = traceFromJournal({ ...run, status: "completed" }, [...records, {
      sequence: 6,
      kind: "control.run.completed",
      occurredAt: 106
    }])
    expect(completed.root.children[0]?.status).toBe("pending")
  })

  test("decodes v2 result and timing contracts, preserving failures and refusing live states with fabricated outputs", () => {
    const base = { version: 2, executionId: "native", lineage: lineage(), stepKeyDigest: "step", attempt: 0 }
    const records = [
      wrap(1, "native", "flows.engine.v2.attempt-lifecycle", {
        ...base,
        lifecycle: { state: "running", startedAtMs: 10 }
      }),
      wrap(2, "native", "flows.engine.v2.attempt-lifecycle", {
        ...base,
        lifecycle: {
          state: "failed",
          startedAtMs: 10,
          finishedAtMs: 30,
          result: { _tag: "Failure", reason: "error", detail: "typecheck failed" }
        }
      }),
      wrap(3, "native", "flows.engine.v2.attempt-lifecycle", {
        ...base,
        attempt: 1,
        lifecycle: { state: "running", startedAtMs: 35, result: { _tag: "Success", value: "invented" } }
      })
    ]
    const model = traceFromJournal(run, records)
    const attempts = model.rows.filter((row) => row.kind === "attempt")
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      status: "failed",
      startedAt: 10,
      endedAt: 30,
      detail: { message: "typecheck failed" }
    })
    expect(model.rows.every((row) => row.detail.output === undefined)).toBe(true)
    expect(model.rows.some((row) => row.kind === "event" && row.label === "flows.engine.v2.attempt-lifecycle")).toBe(
      true
    )
  })

  test("reuses native generation and attempt identity, without borrowing values across a rewind", () => {
    const event = (seq: number, generation: number, value: string) =>
      wrap(seq, "native", "flows.engine.v2.attempt-lifecycle", {
        version: 2,
        executionId: "native",
        lineage: lineage(),
        stepKeyDigest: "same-step",
        attempt: 0,
        lifecycle: { state: "succeeded", startedAtMs: 10, finishedAtMs: 20, result: { _tag: "Success", value } }
      }, generation)
    const model = traceFromJournal(run, [event(1, 0, "old"), event(1, 0, "old"), event(2, 1, "new")])
    const attempts = model.rows.filter((row) => row.kind === "attempt")
    expect(attempts.map((row) => row.detail.output)).toEqual(["old", "new"])
    expect(new Set(attempts.map((row) => row.id)).size).toBe(2)
    expect(model.root.children).toHaveLength(2)
  })

  test("keeps gaps, foreign nested IDs and unreadable versions as evidence without making a successful result", () => {
    const records = [
      {
        sequence: 1,
        kind: "control.engine.projection-gap",
        occurredAt: 1,
        payload: { reason: "compacted", throughSequence: 6 }
      },
      { sequence: 2, kind: "control.engine.event", occurredAt: 2, payload: { version: 99, result: "made up" } },
      wrap(3, "native", "flows.engine.v2.state-event", {
        version: 2,
        executionId: "foreign",
        lineage: lineage("foreign"),
        event: {
          _tag: "Execution",
          lifecycle: { state: "completed", result: { _tag: "Success", value: "foreign result" } }
        }
      })
    ]
    const model = traceFromJournal(run, records)
    expect(model.rows.filter((row) => row.status === "unknown")).toHaveLength(2)
    expect(model.rows.every((row) => row.detail.output === undefined)).toBe(true)
    expect(model.rows.find((row) => row.kind === "execution")?.status).toBe("recorded")
  })

  test("does not nest under an ambiguous parent generation or recurse through cyclic evidence", () => {
    const records = [
      decision(1, "native"),
      decision(2, "native", undefined, undefined, undefined, 1),
      decision(3, "child", undefined, undefined, "native")
    ]
    expect(traceFromJournal(run, records).root.children).toHaveLength(3)
    const cycle = [decision(1, "a", undefined, undefined, "b"), decision(2, "b", undefined, undefined, "a")]
    expect(traceFromJournal(run, cycle).root.children).toHaveLength(2)
  })
})

export { decision, wrap }

test("a native resumed decision preserves subsequent blocked coding results", () => {
  const resumed = nativeRecord(EventTypes.runDecision, {
    decision: "resumed",
    status: "running",
    state: { version: 1, flowName: "coding/ImplementPlan", payload: { target: "typecheck" } }
  })
  const blocked = { outcome: { status: "blocked", blocked: { message: "README check failed" } } }
  const evidence = engineExecutionEvidence([
    decision(1, "native"),
    wrap(2, "native", resumed.eventType, resumed.payload),
    decision(3, "native", "completed", blocked)
  ])
  expect(evidence).toHaveLength(1)
  expect(evidence[0]?.coherent).toBe(true)
  expect(evidence[0]?.result?.value).toEqual(blocked)
})

describe("native evidence boundaries", () => {
  test("projection generations ignore stale, malformed and unrelated markers", () => {
    expect(engineProjectionPending()).toBe(false)
    expect(engineProjectionPending([
      { kind: "unrelated" },
      { kind: "control.engine.projection-started", payload: {} },
      { kind: "control.engine.projection-settled", payload: { version: 1, executionId: "native", generation: 0 } },
      { kind: "control.engine.projection-started", payload: { version: 1, executionId: "native", generation: 2 } },
      { kind: "control.engine.projection-started", payload: { version: 1, executionId: "native", generation: 1 } }
    ])).toBe(true)
  })

  test("unreadable envelopes and gaps keep an honest unknown timestamp", () => {
    const rows = engineTraceFromJournal([
      { kind: "control.engine.projection-gap" },
      { kind: "control.engine.event", payload: null }
    ])
    expect(rows.map((row) => [row.id, row.status, row.startedAt])).toEqual([
      ["engine-gap:0", "unknown", 0],
      ["engine-invalid:1", "unknown", 0]
    ])
  })

  test("conflicting duplicates, parent changes and flow changes quarantine results", () => {
    const first = decision(1, "native")
    const conflict = decision(1, "native", "completed", "forged")
    expect(engineExecutionEvidence([first, conflict])[0]?.coherent).toBe(false)
    expect(engineExecutionEvidence([first, decision(2, "native", "running", undefined, "foreign")])[0]?.coherent).toBe(
      false
    )
    const renamed = wrap(2, "native", "flows.engine.run-decision", {
      decision: "resumed",
      state: { version: 1, flowName: "other", payload: {} }
    })
    expect(engineExecutionEvidence([first, renamed])[0]?.coherent).toBe(false)
  })

  test.each([null, "claim", {}, { decision: "claimed" }, { state: {} }, { decision: "created" }])(
    "nonstate decisions remain visible and broken state claims are incoherent: %j",
    (payload) => {
      const rows = [decision(1, "native"), wrap(2, "native", "flows.engine.run-decision", payload)]
      const isState = typeof payload === "object" && payload !== null &&
        ("state" in payload || payload.decision === "created")
      expect(engineExecutionEvidence(rows)[0]?.coherent).toBe(!isState)
      expect(engineTraceFromJournal(rows)[0]?.children.at(-1)?.label).toBe("flows.engine.run-decision")
    }
  )

  test.each([
    ["completed", undefined],
    ["failed", { _tag: "Complete", exit: { _tag: "Success", value: "wrong" } }],
    ["completed", { _tag: "Complete", exit: { _tag: "Failure", cause: [] } }],
    ["failed", { _tag: "Handoff", flow: "next", payload: {} }],
    ["completed", { _tag: "Handoff", flow: "next", payload: {} }]
  ])("terminal decision %s requires matching result bytes", (status, result) => {
    const rows = [wrap(1, "native", "flows.engine.run-decision", {
      decision: "transitioned",
      status,
      state: { version: 1, flowName: "native", payload: {}, ...(result ? { result } : {}) }
    })]
    expect(engineExecutionEvidence(rows)[0]).toMatchObject({ coherent: false, status: "unknown" })
  })

  test.each(["pending", "running", "suspended"])("live decision %s carries no terminal result", (status) => {
    expect(engineExecutionEvidence([decision(1, "native", status)])[0]).toMatchObject({
      status: status === "suspended" ? "waiting" : status,
      result: undefined
    })
  })

  test("legacy attempt markers retain failures and malformed or foreign markers stay generic", () => {
    const records = [
      wrap(1, "native", "flows.engine.attempt-started", {}),
      wrap(2, "native", "flows.engine.attempt-started", {
        runId: "other",
        stepKeyDigest: "step",
        attempt: 0,
        tier: "sealed"
      }),
      wrap(3, "native", "flows.engine.attempt-finished", {
        runId: "native",
        stepKeyDigest: "step",
        attempt: 0,
        state: "failed"
      })
    ]
    expect(engineTraceFromJournal(records)[0]?.children.map((row) => row.status)).toEqual([
      "recorded",
      "recorded",
      "failed"
    ])
  })

  const state = (seq: number, lifecycle: unknown, id = "native") =>
    wrap(seq, id, "flows.engine.v2.state-event", {
      version: 2,
      executionId: id,
      lineage: lineage(id),
      event: { _tag: "Execution", lifecycle }
    })
  test.each(["error", "defect", "interrupted", "encoding"])(
    "state failure preserves its %s classification",
    (reason) => {
      const records = [
        decision(1, "native"),
        state(2, { state: "completed", result: { _tag: "Failure", reason, detail: { message: "refused" } } })
      ]
      expect(engineExecutionEvidence(records)[0]).toMatchObject({
        status: "failed",
        failure: { kind: reason, sequence: 2, value: { message: "refused" } }
      })
      expect(engineTraceFromJournal(records)[0]?.detail.message).toBe("{\"message\":\"refused\"}")
    }
  )
  test("state transitions clear old result evidence and preserve exact success bytes", () => {
    const completed = state(2, { state: "completed", result: { _tag: "Success", value: { answer: 42 } } })
    const records = [decision(1, "native"), completed]
    expect(engineExecutionEvidence(records)[0]?.result).toEqual({ value: { answer: 42 }, sequence: 2 })
    expect(engineTraceFromJournal(records)[0]?.detail.output).toBe("{\"answer\":42}")
    for (
      const lifecycle of [{ state: "running", waits: [] }, {
        state: "suspended",
        waits: [{ _tag: "Deferred", waitId: "wait" }]
      }]
    ) {
      expect(engineExecutionEvidence([...records, state(3, lifecycle)])[0]).toMatchObject({
        result: undefined,
        failure: undefined,
        status: lifecycle.state === "running" ? "running" : "waiting"
      })
    }
    const clock = wrap(3, "native", "flows.engine.v2.state-event", {
      version: 2,
      executionId: "native",
      lineage: lineage(),
      event: { _tag: "ClockScheduled", clockId: "clock", waitId: "wait", dueAtMs: 42 }
    })
    expect(engineTraceFromJournal([clock])[0]?.children[0]?.label).toBe("flows.engine.v2.state-event")
  })
  test.each([undefined, -1, 1.5])("an invalid control cursor %s cannot certify a result or failure", (sequence) => {
    const success = { ...state(1, { state: "completed", result: { _tag: "Success", value: "ok" } }), sequence }
    const failed = {
      ...state(1, { state: "completed", result: { _tag: "Failure", reason: "error", detail: "no" } }),
      sequence
    }
    expect(engineExecutionEvidence([success])[0]?.result).toBeUndefined()
    expect(engineExecutionEvidence([failed])[0]?.failure).toBeUndefined()
  })
  test("suspended attempts wait, foreign attempts refuse ownership, and child lineage nests", () => {
    const payload = {
      version: 2,
      executionId: "child",
      lineage: {
        kind: "child",
        runId: "child",
        rootRunId: "native",
        lineageId: "native",
        parentRunId: "native",
        round: 0
      },
      stepKeyDigest: "step",
      attempt: 0,
      lifecycle: { state: "suspended", startedAtMs: 10 }
    }
    const child = wrap(2, "child", "flows.engine.v2.attempt-lifecycle", payload)
    expect(engineTraceFromJournal([decision(1, "native"), child])[0]?.children[0]?.children[0]?.status).toBe("waiting")
    expect(engineExecutionEvidence([wrap(2, "native", "flows.engine.v2.attempt-lifecycle", payload)])[0]?.coherent)
      .toBe(false)
    expect(engineExecutionEvidence([wrap(2, "native", "flows.engine.v2.state-event", {})])[0]?.coherent).toBe(false)
  })

  test("run evidence uses the cursor, explicit ancestry and current generation", () => {
    const records = [
      decision(1, "native"),
      decision(2, "child", "completed", "child result", "native"),
      decision(3, "foreign", "completed", "foreign result"),
      decision(4, "child", "running", undefined, "native", 1)
    ]
    const old = engineRunEvidence([...records].reverse(), "native", 2)
    expect(old.executions.map((row) => row.executionId)).toEqual(["native", "child"])
    expect(old.completed.map((row) => row.result?.value)).toEqual(["child result"])
    const current = engineRunEvidence(records, "native")
    expect(current.completed).toEqual([])
    expect(current.executions.map((row) => [row.executionId, row.generation])).toEqual([["native", 0], ["child", 1]])
    expect(current.belongs(current.executions[1]!, "child")).toBe(true)
    expect(
      engineRunEvidence([{ ...records[0]!, sequence: -1 }, { ...records[1]!, sequence: undefined }], "native")
        .executions
    ).toEqual([])
  })
  test("missing, cyclic, contradictory and generation-ambiguous ancestry cannot claim a run", () => {
    const cases = [
      [decision(1, "native", undefined, undefined, "parent")],
      [decision(1, "orphan", undefined, undefined, "absent")],
      [decision(1, "a", undefined, undefined, "b"), decision(2, "b", undefined, undefined, "a")],
      [
        decision(1, "native"),
        decision(2, "native", undefined, undefined, undefined, 1),
        decision(3, "child", "completed", "old", "native")
      ],
      [wrap(1, "unknown", "custom.event", {})],
      [decision(1, "native"), decision(1, "native", "completed", "contradiction")]
    ]
    for (const records of cases) {
      const result = engineRunEvidence(records, "native")
      expect(result.completed).toEqual([])
      for (const row of engineExecutionEvidence(records)) {
        if (row.executionId !== "native" || !row.coherent || row.parentExecutionId) {
          expect(result.belongs(row)).toBe(false)
        }
      }
    }
  })
})

test("a trace retains nested children when the ancestor's own parent is absent", () => {
  const model = engineTraceFromJournal([
    decision(1, "parent", undefined, undefined, "absent"),
    decision(2, "child", undefined, undefined, "parent")
  ])
  expect(model).toHaveLength(1)
  expect(model[0]?.children[0]?.label).toBe("coding/Check")
})

test("declared graph pages merge within one execution generation and reject malformed nodes", () => {
  const read = { id: "read", kind: "action", tier: "sealed", dependsOn: [], action: "agent/opening-instructions" }
  const check = { id: "check", kind: "action", tier: "sealed", dependsOn: ["read"], action: "coding/check-command" }
  const rows = [
    wrap(1, "native", "flows.engine.plan-recorded", { graph: { nodes: [read] } }),
    wrap(2, "native", "flows.engine.subgraph-appended", { graph: { nodes: [check] } }),
    wrap(3, "native", "flows.engine.subgraph-appended", { graph: { nodes: [{ id: "bad" }] } }),
    wrap(4, "native", "flows.engine.plan-recorded", { graph: { nodes: [check] } }, 1)
  ]
  const evidence = engineExecutionEvidence(rows)
  expect(evidence.map((row) => [row.generation, row.graph?.nodes])).toEqual([[0, [read, check]], [1, [check]]])
  expect(engineExecutionEvidence(rows)).toEqual(evidence)
})

test("native sleep waits retain registrations, explicit settlements and replay boundaries", () => {
  const clock = (sequence: number, generation = 0) =>
    wrap(sequence, "native", "flows.engine.v2.state-event", {
      version: 2,
      executionId: "native",
      lineage: lineage(),
      event: { _tag: "ClockScheduled", clockId: "clock", waitId: "sleep", dueAtMs: 9000 }
    }, generation)
  const settled = (sequence: number, waitId = "sleep", generation = 0) =>
    wrap(sequence, "native", "flows.engine.v2.state-event", {
      version: 2,
      executionId: "native",
      lineage: lineage(),
      event: { _tag: "DeferredCompleted", waitId, result: { _tag: "Success", value: null } }
    }, generation)
  const records = [settled(1, "foreign"), clock(2), clock(3), settled(4), settled(5), clock(6, 1)]
  const model = monitorFromJournal(run, records)
  expect(model.waits).toEqual([
    {
      id: "engine-wait:native%3A0:sleep",
      kind: "sleep",
      label: "Waited",
      since: "1970-01-01T00:00:00.102Z",
      settled: { by: { kind: "system", color_index: 7 }, at: "1970-01-01T00:00:00.104Z" }
    },
    { id: "engine-wait:native%3A1:sleep", kind: "sleep", label: "Waited", since: "1970-01-01T00:00:00.106Z" }
  ])
  expect(monitorFromJournal(run, records, 1).waits).toEqual([])
  expect(monitorFromJournal(run, records, 3).waits).toEqual([
    { id: "engine-wait:native%3A0:sleep", kind: "sleep", label: "Waited", since: "1970-01-01T00:00:00.102Z" }
  ])
  expect(monitorFromJournal(run, records)).toEqual(model)
})

test("lifecycle waits retain first observations, explicit completion and generation isolation", () => {
  const event = (sequence: number, event: unknown, generation = 0) =>
    wrap(sequence, "native", "flows.engine.v2.state-event", {
      version: 2,
      executionId: "native",
      lineage: lineage(),
      event
    }, generation)
  const suspended = {
    _tag: "Execution",
    lifecycle: {
      state: "suspended",
      waits: [
        { _tag: "Deferred", waitId: "answer" },
        { _tag: "Clock", waitId: "clock-wait", dueAtMs: 9000 }
      ]
    }
  }
  const records = [
    event(1, suspended),
    event(2, suspended),
    event(3, { _tag: "ClockScheduled", clockId: "clock", waitId: "clock-wait", dueAtMs: 9000 }),
    event(4, { _tag: "DeferredCompleted", waitId: "answer", result: { _tag: "Success", value: "yes" } }),
    event(5, { _tag: "Execution", lifecycle: { state: "running", waits: [] } }),
    event(6, suspended, 1)
  ]
  const model = monitorFromJournal(run, records)
  expect(model.waits).toEqual([
    {
      id: "engine-wait:native%3A0:answer",
      kind: "signal",
      label: "Waited",
      since: "1970-01-01T00:00:00.101Z",
      settled: { by: { kind: "system", color_index: 7 }, at: "1970-01-01T00:00:00.104Z" }
    },
    { id: "engine-wait:native%3A0:clock-wait", kind: "sleep", label: "Waited", since: "1970-01-01T00:00:00.101Z" },
    { id: "engine-wait:native%3A1:answer", kind: "signal", label: "Waited", since: "1970-01-01T00:00:00.106Z" },
    { id: "engine-wait:native%3A1:clock-wait", kind: "sleep", label: "Waited", since: "1970-01-01T00:00:00.106Z" }
  ])
  expect(monitorFromJournal(run, records, 3).waits).toEqual(
    model.waits.slice(0, 2).map(({ settled: _, ...wait }) => wait)
  )
  expect(monitorFromJournal(run, records, 0).waits).toEqual([])
  expect(monitorFromJournal(run, records)).toEqual(model)
})
