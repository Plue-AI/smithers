import { describe, expect, test } from "vitest"
import {
  callSemantics,
  callSubject,
  type JournalRecord,
  spanMatches,
  traceFromJournal,
  turnNarratives
} from "../src/RunTrace.js"

const run = { runId: "run", flowId: "test", status: "running" }
const event = (kind: string, payload: Record<string, unknown> = {}, sequence?: number): JournalRecord => ({
  kind: `control.${kind}`,
  payload,
  ...(sequence === undefined ? {} : { sequence })
})
const trace = (rows: ReadonlyArray<JournalRecord>) => traceFromJournal(run, rows)

describe("partial and older trace records", () => {
  test("subject formats use only recorded fields, including legacy fallbacks", () => {
    for (const format of ["none", "path", "command", "patch", "pattern", "selection"] as const) {
      expect(callSubject({}, format)).toBe("")
    }
    expect(callSubject({ path: "///" }, "path")).toBe("///")
    expect(callSubject({ script: "bun test" })).toBe("bun test")
    expect(callSubject({ input: "*** Add File: src/a.ts" })).toBe("a.ts")
    expect(callSubject({ input: "not a patch", selection: [2, "suite", false] })).toBe("suite")
    expect(callSubject({ selection: [], pattern: "needle" })).toBe("needle")
    expect(callSubject({ selection: [false] })).toBe("")
  })
  test("empty and invalid display metadata never invent activity", () => {
    expect(callSemantics("read", { descriptor: { name: "read" } }).activity).toBe("reads")
    expect(callSemantics("read", { descriptor: { name: "read", activity: "invalid", presentation: {} } })).toEqual({})
    expect(callSemantics("read", { descriptor: { name: "read", activity: "reads" } })).toEqual({ activity: "reads" })
    for (const command of ["python -m", "pnpm exec", "npm run", "", "echo ok"]) {
      expect(callSemantics("bash", { input: { command } }).activity).toBe("other")
    }
  })
  test("missing sequence, timestamps and identifiers remain readable without fabricated matches", () => {
    const model = trace([
      {},
      { payload: [] },
      event("agent.cell-printed", { text: "outside" }),
      event("agent.resolved", { text: "answer" }),
      event("agent.model-started"),
      event("agent.model-settled", { text: "response" }),
      event("agent.cell-produced", { text: "cell" }),
      event("agent.cell-settled", { outcome: "failure" }),
      event("agent.cell-call-started"),
      event("agent.cell-call-settled", { outcome: "unknown" }),
      event("approval.requested"),
      event("approval.approved"),
      event("approval.approved"),
      event("approval.requested", { requestId: "named" }),
      event("approval.approved", { requestId: "named" }),
      event("unknown")
    ])
    expect(model.root.startedAt).toBe(0)
    expect(model.rows.find((row) => row.kind === "resolved")?.detail.output).toBe("answer")
    expect(model.rows.find((row) => row.label === "printed")?.detail.printed).toBe("outside")
    expect(model.rows.filter((row) => row.kind === "approval").map((row) => row.status)).toEqual([
      "approved",
      "approved"
    ])
    expect(model.rows.find((row) => row.kind === "cell")?.status).toBe("failed")
  })
  test("standalone discipline records omit missing facts and retain recorded zero values", () => {
    const kinds = [
      "mutation-observed",
      "permission-required",
      "suspended",
      "checkpoint-minted",
      "read-only-demanded",
      "repeat-demanded",
      "narrowed-demanded",
      "unmoved-demanded",
      "unresolved-demanded",
      "claim-demanded"
    ]
    const rows = kinds.map((kind) => event(`agent.${kind}`, { mutated: true, demanded: true }))
    const model = trace(rows)
    expect(model.notes.find((note) => note.title === "changed")?.body).toBe("")
    expect(model.notes.find((note) => note.title === "claim")?.body).toBe("")
    expect(model.milestones.every((pin) => pin.spanId === model.root.id)).toBe(true)
    const full = trace([event("agent.claim-demanded", { refused: true, complete: 0, overclaims: 0, nextFrame: 0 })])
    expect(full.notes[0]?.body).toBe("complete 0, overclaims 0. Frame 0.")
  })
  test("writes outside a frame keep a pin and repeated paths count only once", () => {
    const write = (
      path: string
    ) => [
      event("agent.cell-call-started", { flowName: "write", input: { path } }),
      event("agent.cell-call-settled", { flowName: "write", outcome: "success" })
    ]
    const model = trace([
      ...write("a.ts"),
      event("agent.turn-opened"),
      ...write("b.ts"),
      ...write("b.ts"),
      event("agent.cell-call-started", { flowName: "write" }),
      event("agent.cell-call-settled", { flowName: "write", outcome: "failure" })
    ])
    expect(model.milestones.map((pin) => pin.label)).toEqual(["a.ts", "b.ts"])
    expect(model.rows.some((row) => row.kind === "call" && row.status === "failed")).toBe(true)
  })
  test.each(["suspended", "aborted"])("scoped turn closure records %s", (outcome) => {
    const step = {
      executionId: "run",
      stepId: "a".repeat(64),
      action: "edit",
      attempt: 1,
      ask: 0,
      retry: 0,
      scope: "step",
      generation: 0
    }
    const model = trace([event("agent.turn-opened", { step }), event("agent.turn-closed", { step, outcome })])
    expect(model.root.children[0]?.status).toBe(outcome === "suspended" ? "waiting" : "cancelled")
  })
  test("unserializable legacy text stays inspectable", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(trace([event("agent.cell-printed", { text: circular })]).rows[1]?.detail.printed).toBe("[object Object]")
  })
  test.each([
    ["grep", { matches: [1] }, "1 match"],
    ["grep", {}, ""],
    ["glob", {}, ""],
    ["ls", {}, ""],
    ["read", "", ""]
  ])("%s summaries do not invent missing result fields", (flowName, value, result) => {
    const model = trace([
      event("agent.turn-opened"),
      event("agent.cell-call-started", { flowName }),
      event("agent.cell-call-settled", { flowName, outcome: "success", value })
    ])
    expect(model.lines[0]?.result).toBe(result)
  })
  test("a fork filter and incomplete narratives remain truthful", () => {
    const waiting = trace([event("agent.turn-opened")])
    expect(turnNarratives(waiting)[0]?.text).toContain("The turn started")
    const script = trace([event("agent.turn-opened"), event("agent.cell-produced")])
    expect(turnNarratives(script)[0]?.text).toContain("produced a script")
    for (const text of [undefined, "const x = 1", "```js\ncode\n~~~\n```", "word ".repeat(80)]) {
      const model = trace([
        event("agent.turn-opened"),
        event("agent.model-started"),
        event("agent.model-settled", { text })
      ])
      const narrative = turnNarratives(model)[0]!
      expect(narrative.text.length).toBeLessThanOrEqual(180)
      expect(narrative.source).toBe(text?.startsWith("word") ? "model" : "journal")
    }
    const calls = trace([
      event("agent.turn-opened"),
      ...["a", "b", "c", "d"].map((flowName) => event("agent.cell-call-started", { flowName }))
    ])
    expect(turnNarratives(calls)[0]?.text).toBe("The agent called a, b, c and 1 other flows.")
    const fork = { ...waiting.root, kind: "fork" as const }
    expect(spanMatches(fork, "all")).toBe(true)
    expect(spanMatches(fork, "flow")).toBe(false)
  })
})

test("partial calls close failed cells and standalone scoped notes keep root ownership", () => {
  const step = {
    executionId: "run",
    stepId: "a".repeat(64),
    action: "edit",
    attempt: 1,
    ask: 0,
    retry: 0,
    scope: "left",
    generation: 0
  }
  const rows = [
    event("agent.steering-drained", { step, messages: [{ role: "user", text: "one" }, { role: "user", text: "two" }] }),
    event("agent.turn-opened", { step }),
    event("agent.cell-produced", { step, text: "script" }),
    event("agent.cell-call-started", { step, flowName: "write" }),
    event("agent.cell-call-settled", { step, flowName: "write", outcome: "success" }),
    event("agent.cell-call-started", { step, flowName: "bash" }),
    event("agent.cell-call-settled", { step, flowName: "bash", outcome: "failure" }),
    event("agent.turn-closed", { step, outcome: "resolved" }),
    event("agent.turn-opened", { step: { ...step, scope: "right" } }),
    event("run.failed")
  ]
  const model = trace(rows)
  expect(model.rows.find((row) => row.kind === "cell")?.status).toBe("failed")
  expect(model.notes[0]).toMatchObject({ spanId: model.root.id, body: "2 steers." })
  expect(model.milestones[0]?.spanId).toBe(model.root.id)
  const failed = trace([
    event("agent.turn-opened"),
    event("agent.cell-call-started", { flowName: "bash" }),
    event("agent.cell-call-settled", { flowName: "bash", outcome: "failure" })
  ])
  expect(failed.lines[0]).toMatchObject({ failed: true, result: "" })
})
