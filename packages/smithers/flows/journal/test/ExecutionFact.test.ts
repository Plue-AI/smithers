import { describe, expect, it } from "vitest"
import * as Facts from "../src/ExecutionFact.ts"

const row = (executionId = "root", change: Partial<Facts.Observation> = {}): Facts.Observation => ({
  executionId: executionId as never,
  flowName: "agent/run",
  status: "pending",
  createdAtMs: 1 as never,
  startedAtMs: null,
  finishedAtMs: null,
  parentRunId: null,
  lineageId: "root" as never,
  roundOrdinal: 0 as never,
  cancelRequestedAtMs: null,
  waiting: null,
  ...change
})
const entry = (observation: Facts.Observation, sequence = 0, generation = 0, baseline = "created"): Facts.Input => ({
  executionId: observation.executionId,
  generation,
  sequence,
  eventType: "flows.engine.run-decision",
  payload: { decision: "created", executionFact: { version: 1, baseline, observation } }
})
const bound = {
  kind: "control.engine.bound",
  runId: "control",
  payload: { version: 1, controlRunId: "control", executionId: "root" }
}
const bridge = (input: Facts.Input) => ({
  kind: "control.engine.event",
  runId: "control",
  payload: { version: 1, ...input }
})

describe("native execution fact fold", () => {
  it("derives nested human waits from attached facts and verifies question equality", () => {
    const root = row("root", { status: "running", treeVersion: 1, parentPolicy: "cancel" })
    const child = row("child", {
      status: "suspended",
      treeVersion: 1,
      parentPolicy: "cancel",
      parentRunId: "root" as never,
      lineageId: "child" as never,
      waiting: {
        reason: "approval",
        tokenDigest: "digest",
        wakeAtMs: null,
        point: "clarification#1",
        request: { kind: "ask", prompt: "Which service?", attempt: 1 }
      }
    })
    const events = [entry(root), entry(child)]
    const observed = { root, current: root, humanWaits: [child] }
    const folded = Facts.fold(events, "root", observed)
    expect(folded.view).toEqual(observed)
    expect(folded.provenance).toMatchObject({ source: "events", humanWaits: "events" })
    expect(Facts.fold(events, "root").view?.humanWaits).toEqual([child])
    const changed = { ...child, waiting: { ...child.waiting!, request: { prompt: "A different question" } } }
    expect(Facts.fold(events, "root", { ...observed, humanWaits: [changed] }).provenance)
      .toMatchObject({ source: "unverified-observation", humanWaits: "unverified-observation" })
    const answered = { ...child, status: "completed" as const, waiting: null }
    expect(Facts.fold([...events, entry(answered, 2)], "root", { ...observed, humanWaits: [] }).view?.humanWaits)
      .toEqual([])
    const detached = { ...child, parentPolicy: "detach" as const }
    expect(Facts.fold([entry(root), entry(detached)], "root").view?.humanWaits).toEqual([])
    expect(Facts.fold([entry(root)], "root", observed).provenance.humanWaits).toBe("unverified-observation")
    expect(
      Facts.fold([entry(root), entry(child), { ...entry(child), gap: true }], "root", observed)
        .provenance.humanWaits
    ).toBe("unverified-observation")
  })

  it("keeps verified observation coverage after a lease reconfirm diagnostic", () => {
    const root = row("root", { status: "running", treeVersion: 1, parentPolicy: "cancel" })
    const observed = { root, current: root, humanWaits: [] }
    const diagnostic: Facts.Input = {
      executionId: root.executionId,
      generation: 0,
      sequence: 1,
      eventType: "flows.engine.run-decision",
      payload: { decision: "lease-reconfirmed", unconfirmedMs: 25_000 }
    }
    const folded = Facts.fold([entry(root), diagnostic], "root", observed)
    expect(folded.view).toEqual(observed)
    expect(folded.provenance).toMatchObject({ source: "events", humanWaits: "events" })
    // A release changes lifecycle state; diagnostic acceptance must not
    // silently cover a real mutation without an execution fact.
    expect(
      Facts.fold([entry(root), { ...diagnostic, payload: { decision: "interrupt-released" } }], "root", observed)
        .provenance.source
    )
      .toBe("unverified-observation")
  })

  it("does not grant old v1 facts tree-wait coverage merely because their own wait matches", () => {
    const old = row("root", { status: "running" })
    const observed = { root: old, current: old, humanWaits: [] }
    expect(Facts.fold([entry(old)], "root", observed).provenance)
      .toMatchObject({ source: "unverified-observation", humanWaits: "legacy-observation" })
    const upgraded = { ...old, treeVersion: 1 as const, parentPolicy: "cancel" as const }
    expect(
      Facts.fold([entry(old), entry(upgraded, 2)], "root", {
        root: upgraded,
        current: upgraded,
        humanWaits: []
      }).provenance
    ).toMatchObject({
      source: "events",
      humanWaits: "events",
      humanWaitSources: [{
        executionId: "root",
        generation: 0,
        baseline: "legacy",
        fromSequence: 2,
        throughSequence: 2
      }]
    })
  })

  it("compares human waits by execution identity independently of store ordering", () => {
    const root = row("root", { status: "running", treeVersion: 1, parentPolicy: "cancel" })
    const child = (id: string) =>
      row(id, {
        status: "suspended",
        treeVersion: 1,
        parentPolicy: "cancel",
        parentRunId: "root" as never,
        lineageId: id as never,
        waiting: {
          reason: "approval",
          wakeAtMs: null,
          tokenDigest: `digest:${id}`,
          point: `${id}#1`,
          request: { prompt: id }
        }
      })
    const first = child("A-child")
    const second = child("a-child")
    const events = [entry(root), entry(first), entry(second)]
    const observed = { root, current: root, humanWaits: [second, first] }
    const folded = Facts.fold(events, "root", observed)
    expect(folded.provenance).toMatchObject({ source: "events", humanWaits: "events" })
    expect(Facts.fold(events, "root", { ...observed, humanWaits: [first, second] }).provenance)
      .toMatchObject({ source: "events", humanWaits: "events" })
    expect(folded.view?.humanWaits).toEqual([first, second])
    expect(Facts.fold(events, "root", { ...observed, humanWaits: [first, first] }).provenance.humanWaits)
      .toBe("unverified-observation")
    expect(
      Facts.fold(events, "root", {
        ...observed,
        humanWaits: [{ ...second, waiting: first.waiting }, first]
      }).provenance.humanWaits
    ).toBe("unverified-observation")
  })

  it("keeps missing-generation and unbound corrupt envelopes uncovered without adopting a guessed root", () => {
    const observed = { root: row(), current: row() }
    expect(Facts.fold([{ ...entry(row()), generation: null }], "root").view).toBeUndefined()
    const gaps = [
      { ...entry(row()), gap: true, generation: null },
      { ...entry(row()), gap: true, generation: 2 },
      entry(row(), 4, 2)
    ]
    expect(Facts.fold(gaps, "root").provenance).toMatchObject({ source: "events", baseline: "legacy", generation: 2 })
    for (
      const payload of [null, [], {}, { version: 2 }, { ...bound.payload, executionId: "" }, {
        ...bound.payload,
        controlRunId: "other"
      }]
    ) {
      expect(Facts.foldControl([{ ...bound, payload }], "control", observed)?.provenance.source).toBe(
        "unverified-observation"
      )
    }
    expect(
      Facts.foldControl([bound, { kind: "control.engine.event", runId: "control", payload: {} }], "control", observed)
        ?.provenance.source
    )
      .toBe("unverified-observation")
    expect(
      Facts.foldControl(
        [bound, { kind: "control.engine.projection-gap", runId: "control", payload: { executionId: "root" } }],
        "control",
        observed
      )?.provenance.source
    )
      .toBe("unverified-observation")
    expect(
      Facts.foldControl(
        [bound, {
          kind: "control.engine.projection-gap",
          runId: "control",
          payload: { executionId: "root", generation: 3 }
        }],
        "control",
        observed
      )?.provenance.source
    )
      .toBe("unverified-observation")
  })
  it("compares both sides of every semantic field and rejects facts on unrelated producer kinds", () => {
    const original = row()
    const differences: Array<Partial<Facts.Observation>> = [
      { executionId: "other" as never },
      { flowName: "other" },
      { status: "failed" },
      { createdAtMs: 2 as never },
      { startedAtMs: 2 as never },
      { finishedAtMs: 2 as never },
      { parentRunId: "other" as never },
      { lineageId: "other" as never },
      { roundOrdinal: 2 as never },
      { cancelRequestedAtMs: 2 as never },
      { waiting: { reason: "approval", wakeAtMs: null, tokenDigest: null } }
    ]
    for (const change of differences) {
      expect(Facts.equal(original, { ...original, ...change })).toBe(false)
      expect(Facts.equal({ ...original, ...change }, original)).toBe(false)
    }
    const parked = { ...original, waiting: { reason: "approval", wakeAtMs: null, tokenDigest: "digest" } }
    expect(Facts.equal(parked, parked)).toBe(true)
    for (
      const waiting of [{ ...parked.waiting, reason: "timer" }, { ...parked.waiting, wakeAtMs: 5 as never }, {
        ...parked.waiting,
        tokenDigest: "other"
      }]
    ) expect(Facts.equal(parked, { ...parked, waiting })).toBe(false)
    expect(Facts.fold([entry(original), { ...entry(original, 1), eventType: "other" }], "root").provenance.source)
      .toBe("unverified-observation")
    expect(
      Facts.fold(
        [entry(original), { ...entry(original, 1), eventType: "flows.engine.interrupted", payload: {} }],
        "root"
      ).provenance.source
    )
      .toBe("unverified-observation")
    expect(
      Facts.fold([entry(original), entry(row("current", { roundOrdinal: 1 as never }))], "root", {
        root: original,
        current: original
      }).provenance.source
    )
      .toBe("unverified-observation")
  })
  it("replays wait, resume, intent and terminal observations; numeric reservation gaps and exact duplicates are harmless", () => {
    const running = row("root", { status: "running", startedAtMs: 2 as never })
    const parked = {
      ...running,
      status: "suspended" as const,
      waiting: { reason: "approval", tokenDigest: "digest", wakeAtMs: null }
    }
    const requested = { ...parked, cancelRequestedAtMs: 9 as never }
    const terminal = { ...requested, status: "cancelled" as const, waiting: null, finishedAtMs: 10 as never }
    const events = [entry(row()), entry(running, 2), entry(parked, 4), entry(requested, 7), entry(terminal, 9)]
    const observed = { root: terminal, current: terminal }
    expect(Facts.fold([...events, events[4]!], "root", observed)).toEqual({
      view: observed,
      provenance: {
        source: "events",
        rootExecutionId: "root",
        currentExecutionId: "root",
        generation: 0,
        baseline: "created",
        fromSequence: 0,
        throughSequence: 9
      }
    })
  })
  it("follows only the bound root's lineage, preserving requested-root identity", () => {
    const root = row("root", { status: "completed" })
    const current = row("round", { parentRunId: "root" as never, roundOrdinal: 1 as never, status: "suspended" })
    const child = row("child", { lineageId: "child" as never, roundOrdinal: 90 as never })
    expect(Facts.fold([entry(root), entry(child), entry(current)], "root").view).toEqual({ root, current })
    expect(Facts.fold([entry(root, 0, 0, "legacy"), entry(current)], "root").provenance.baseline).toBe("legacy")
    expect(Facts.foldControl([bound, bridge(entry(root)), bridge(entry(current))], "control")?.view).toEqual({
      root,
      current
    })
  })
  it("never infers a binding from a matching run ID, foreign envelope or conflicting root", () => {
    const observed = { root: row(), current: row() }
    expect(Facts.foldControl([bridge(entry(row()))], "control", observed)?.provenance.source).toBe("legacy-observation")
    expect(Facts.foldControl([{ ...bound, runId: "other" }, bridge(entry(row()))], "control")).toBeUndefined()
    expect(
      Facts.foldControl([bound, { ...bound, payload: { ...bound.payload, executionId: "other" } }], "control", observed)
        ?.provenance.source
    ).toBe("unverified-observation")
    expect(Facts.foldControl([bound], "control", { root: row("other"), current: row("other") })?.provenance.source)
      .toBe("unverified-observation")
    expect(
      Facts.foldControl(
        [bound, bridge(entry(row())), { ...bridge(entry(row())), payload: { version: 2, executionId: "root" } }],
        "control",
        observed
      )?.provenance.source
    ).toBe("unverified-observation")
  })
  it("marks actual gaps, generation changes and unknown facts unverified, then resets an explicit legacy baseline", () => {
    const initial = entry(row())
    const gap = { ...initial, gap: true }
    expect(Facts.fold([initial, gap], "root").provenance.source).toBe("unverified-observation")
    expect(Facts.fold([initial, { ...initial, generation: 1, sequence: 3, payload: {} }], "root").provenance.source)
      .toBe("unverified-observation")
    const recovered = Facts.fold(
      [initial, gap, entry(row(), 8, 1), entry(row("root", { status: "failed" }), 10, 0)],
      "root"
    )
    expect(recovered.provenance).toMatchObject({ source: "events", baseline: "legacy", generation: 1, fromSequence: 8 })
    expect(recovered.view?.current.status).toBe("pending")
    for (const candidate of [{ version: 2 }, { version: 1, baseline: "created", observation: row("foreign") }]) {
      expect(
        Facts.fold([initial, { ...initial, sequence: 1, payload: { executionFact: candidate } }], "root").provenance
          .source
      ).toBe("unverified-observation")
    }
  })
  it("compares every semantic field against native observation, and refuses uncovered legacy mutations", () => {
    const original = row()
    const changed = row("root", { cancelRequestedAtMs: 55 as never })
    expect(Facts.fold([entry(original)], "root", { root: changed, current: changed }).provenance.source).toBe(
      "unverified-observation"
    )
    expect(
      Facts.fold([entry(original), { ...entry(original, 1), payload: { decision: "wake-scheduled" } }], "root")
        .provenance.source
    ).toBe("events")
    expect(
      Facts.fold([entry(original), { ...entry(original, 1), payload: { decision: "transitioned" } }], "root").provenance
        .source
    ).toBe("unverified-observation")
    expect(Facts.fold([], "root", { root: original, current: original }).provenance.source).toBe("legacy-observation")
  })
})

describe("semantic observation equality", () => {
  const asking = (request: unknown): Facts.Observation =>
    row("root", {
      waiting: {
        reason: "approval",
        wakeAtMs: null,
        tokenDigest: "digest",
        point: "clarification#1",
        request
      } as never
    })
  const sameQuestion = (left: unknown, right: unknown) => Facts.equal(asking(left), asking(right))

  it("compares recorded questions by JSON value, so writer key order is not a change", () => {
    expect(sameQuestion(
      { kind: "ask", prompt: "Which service?", attempt: 1 },
      { attempt: 1, prompt: "Which service?", kind: "ask" }
    )).toBe(true)
    expect(sameQuestion({ ask: { options: [1, "two", null, { deep: true }] } }, {
      ask: { options: [1, "two", null, { deep: true }] }
    })).toBe(true)
    expect(sameQuestion([], [])).toBe(true)
    expect(sameQuestion("text", "text")).toBe(true)
    expect(sameQuestion(null, null)).toBe(true)
  })

  it("treats a differing question shape, length, or leaf as a different question", () => {
    // Same member count, different member name.
    expect(sameQuestion({ prompt: "a" }, { question: "a" })).toBe(false)
    // Same member name, different leaf value.
    expect(sameQuestion({ prompt: "a" }, { prompt: "b" })).toBe(false)
    expect(sameQuestion({ prompt: "a" }, { prompt: "a", attempt: 1 })).toBe(false)
    expect(sameQuestion([1, 2], [1, 2, 3])).toBe(false)
    expect(sameQuestion([1, 2], [1, 3])).toBe(false)
    // An array and a record are never the same question, in either position.
    expect(sameQuestion([1], { "0": 1 })).toBe(false)
    expect(sameQuestion({ "0": 1 }, [1])).toBe(false)
    for (const scalar of [null, 7, "text", true]) {
      expect(sameQuestion(scalar, { prompt: "a" })).toBe(false)
      expect(sameQuestion({ prompt: "a" }, scalar)).toBe(false)
    }
  })

  it("orders equally deep, equally aged siblings by execution id", () => {
    const parent = row("root", { status: "running", treeVersion: 1, parentPolicy: "cancel" })
    const sibling = (id: string) =>
      row(id, {
        status: "running",
        treeVersion: 1,
        parentPolicy: "cancel",
        parentRunId: "root" as never,
        lineageId: id as never
      })
    const events = [parent, sibling("child-c"), sibling("child-a"), sibling("child-b")].map((observation) =>
      entry(observation)
    )
    expect(Facts.fold(events, "root").provenance.humanWaitSources?.map((source) => source.executionId))
      .toEqual(["root", "child-a", "child-b", "child-c"])
  })
})
