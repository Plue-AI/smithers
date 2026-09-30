import { describe, expect, test } from "vitest"
import { type JournalRecord, runMemoryOf } from "../src/RunTrace.js"

type Verdict = readonly [id: string, p: number, kind?: string]

const reading = (sequence: number, kept: ReadonlyArray<Verdict>, withheld: ReadonlyArray<Verdict>): JournalRecord => ({
  sequence,
  kind: "control.agent.relevance-settled",
  occurredAt: sequence,
  payload: {
    scope: "s",
    frame: sequence,
    source: "run",
    withholdAt: 0.9,
    latencyMs: 3,
    kept: kept.map(([id, p, kind]) => ({ kind: kind ?? "memory", id, digest: `d-${id}`, p })),
    withheld: withheld.map(([id, p, kind]) => ({ kind: kind ?? "memory", id, digest: `d-${id}`, p }))
  }
})

describe("runMemoryOf", () => {
  test("a run Jev never read has no memory at all, even with other rows", () => {
    expect(runMemoryOf([])).toBeUndefined()
    expect(runMemoryOf([{ sequence: 1, kind: "control.agent.turn-opened", payload: {} }])).toBeUndefined()
  })

  test("a reading that weighed no memory still says Jev read: nothing in, nothing withheld", () => {
    expect(runMemoryOf([reading(1, [["lookup", 0.1, "flow"]], [["AGENTS.md#3", 0.95, "instruction"]])])).toEqual({
      kept: [],
      withheld: []
    })
  })

  test("an item any reading kept is in; one only ever withheld is withheld; both by relevance", () => {
    const memory = runMemoryOf([
      reading(1, [["wiki/auth/sessions", 0.18], ["rpc/Session.ts", 0.23]], [["wiki/billing", 0.95], [
        "wiki/auth/legacy",
        0.97
      ]]),
      reading(2, [["wiki/billing", 0.4]], [["app/Login.tsx", 0.92]])
    ])!
    expect(memory.kept.map((item) => [item.id, Number(item.relevance.toFixed(2))])).toEqual([
      ["wiki/auth/sessions", 0.82],
      ["rpc/Session.ts", 0.77],
      ["wiki/billing", 0.6]
    ])
    expect(memory.withheld.map((item) => item.id)).toEqual(["app/Login.tsx", "wiki/auth/legacy"])
    expect(memory.kept.every((item) => item.kind === "memory")).toBe(true)
  })

  test("equal relevance orders by id, and a later reading of the same id replaces the earlier one", () => {
    const memory = runMemoryOf([
      reading(1, [["note-c", 0.2], ["note-b", 0.2], ["note-a", 0.25]], []),
      reading(2, [["note-a", 0.2]], [["note-y", 0.95], ["note-x", 0.95]])
    ])!
    expect(memory.kept.map((item) => [item.id, item.relevance])).toEqual([
      ["note-a", 0.8],
      ["note-b", 0.8],
      ["note-c", 0.8]
    ])
    expect(memory.withheld.map((item) => item.id)).toEqual(["note-x", "note-y"])
  })

  test("a row whose verdicts were not retained is no reading, never an empty selection", () => {
    const truncated: JournalRecord = {
      sequence: 1,
      kind: "control.agent.relevance-settled",
      payload: { truncated: true, encodedBytes: 20_163 }
    }
    expect(runMemoryOf([truncated])).toBeUndefined()
    expect(runMemoryOf([{ sequence: 2, kind: "control.agent.relevance-settled" }])).toBeUndefined()
    expect(runMemoryOf([truncated, reading(3, [["note-a", 0.1]], [])])!.kept.map((item) => item.id)).toEqual([
      "note-a"
    ])
  })

  test("malformed items are skipped rather than failing the fold", () => {
    const records: ReadonlyArray<JournalRecord> = [
      { sequence: 1, kind: "control.agent.relevance-settled", payload: { kept: "none", withheld: [] } },
      {
        sequence: 2,
        kind: "control.agent.relevance-settled",
        payload: { kept: [null, 7, { kind: "memory", id: 1, p: 0.1 }, { kind: "memory", id: "ok", p: "x" }] }
      }
    ]
    expect(runMemoryOf(records)).toEqual({ kept: [], withheld: [] })
  })
})
