/**
 * The incremental trace fold is the batch fold.
 *
 * `traceFromJournal` is `traceFold` over the whole journal, so the claim under
 * test is the live one: a reader that steps each record onto the fold it holds
 * sees, at every prefix, exactly the model a refold of that prefix builds. The
 * generator covers every rule that reaches back past the newest record: out of
 * order sequences, native facts that supersede earlier telemetry, replayed
 * step facts, step-scoped records, and a verdict that closes open frames.
 */
import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"
import {
  type JournalRecord,
  traceFold,
  traceFoldModel,
  traceFoldStep,
  traceFoldSync,
  traceFromJournal,
  type TraceModel
} from "../src/RunTrace.js"
import { moduleRunJournal } from "./fixtures/module-run-journal.ts"

const run = { runId: "run", flowId: "agent" }
const statuses = ["running", "completed", "failed"] as const

const step = (scope: string) => ({
  executionId: "execution",
  stepId: scope.repeat(64).slice(0, 64),
  action: "coding/edit",
  attempt: 1,
  ask: 0,
  retry: 1,
  scope,
  generation: 0
})

const callId = (ordinal: number) => `cell-call-v1:${String(ordinal + 1).repeat(64)}`

const nativeCall = (sequence: number, phase: "invoked" | "settled", ordinal: number, failed: boolean) => ({
  runId: "run",
  sequence,
  kind: "control.engine.event",
  occurredAt: sequence,
  payload: {
    version: 1,
    executionId: "native",
    generation: 0,
    sequence,
    emittedAtMs: sequence * 10,
    sourceSequence: 0,
    sourceId: `call-fact-v1:${callId(ordinal)}:${phase}`,
    eventType: "flows.harness.call-fact.v1",
    payload: {
      version: 1,
      phase,
      callId: callId(ordinal),
      identity: { runId: "run", frame: 1, cell: "cell", ordinal, declaration: "declaration", layers: ["base"] },
      flowName: "write",
      ...(phase === "invoked" ? { input: { path: `f${ordinal}` } } : failed
        ? { outcome: "failure", value: "timeout" }
        : { outcome: "success", value: "done" })
    }
  }
})

const nativeStep = (sequence: number, scope: string, kind: string, source: number) => {
  const recorded = step(scope)
  return {
    runId: "run",
    sequence,
    kind: "control.engine.event",
    payload: {
      version: 1,
      executionId: recorded.executionId,
      generation: 1,
      sequence,
      emittedAtMs: sequence * 100,
      sourceId: `step-fact-v1:${recorded.stepId}:${recorded.attempt}:${recorded.ask}:${recorded.retry}`,
      sourceSequence: source,
      eventType: "flows.harness.step-fact.v1",
      payload: {
        version: 1,
        step: recorded,
        generation: 0,
        frame: 0,
        ordinal: 0,
        cell: "",
        at: sequence * 100,
        eventType: kind,
        sourceSequence: source,
        payload: { seat: "test" }
      }
    }
  }
}

/** Every record shape the fold has an arm for, plus the ones it must ignore. */
const agentPayloads: ReadonlyArray<(n: number) => readonly [string, Record<string, unknown>]> = [
  (n) => ["control.agent.turn-opened", { seat: n % 2 === 0 ? "anthropic:a" : "openai:b" }],
  (n) => ["control.agent.model-settled", { text: `t${n}`, usage: { inputTokens: n }, durationMillis: n % 5 }],
  (n) => ["control.agent.cell-produced", { text: `ctx.done(${n})`, language: "js" }],
  (n) => ["control.agent.cell-call-started", {
    callId: n % 3 === 0 ? undefined : callId(n % 4),
    flowName: ["write", "read", "bash", "checkpoint", "agent/spawn"][n % 5],
    input: n % 5 === 0 ? { path: `src/${n % 3}.ts`, content: "x" } : { command: `test ${n % 2}` }
  }],
  (n) => ["control.agent.cell-call-settled", {
    callId: n % 3 === 0 ? undefined : callId(n % 4),
    flowName: ["write", "read", "bash", "checkpoint", "agent/spawn"][n % 5],
    outcome: n % 4 === 0 ? "failure" : "success",
    value: n % 7 === 0 ? { approved: false } : n % 5 === 4 ? { child: `child-${n}` } : `v${n % 2}`,
    message: "no"
  }],
  (n) => ["control.agent.cell-printed", { text: `p${n}` }],
  (n) => ["control.agent.cell-settled", { outcome: n % 3 === 0 ? "failure" : "success" }],
  (n) => ["control.agent.resolved", { text: `done ${n}` }],
  (n) => ["control.agent.mutation-observed", { mutated: n % 2 === 0, basis: n % 3 === 0 ? "observed" : "declared" }],
  () => ["control.agent.permission-required", {}],
  () => ["control.agent.suspended", {}],
  (n) => ["control.agent.read-only-demanded", { streak: n % 4, cap: 3, nextFrame: n, nextAction: "edit" }],
  (n) => ["control.agent.steering-drained", { messages: n % 2 === 0 ? [] : [{ text: "go" }] }],
  (n) => ["control.agent.claim-demanded", { demanded: n % 2 === 0, refused: n % 3 === 0, complete: 1, overclaims: 2 }],
  (n) => ["control.agent.sufficiency-observed", { flow: "bash", nextFrame: n, failed: "a", passed: "b" }],
  (
    n
  ) => ["control.agent.turn-closed", {
    step: n % 2 === 0 ? "x" : undefined,
    outcome: ["suspended", "aborted", "ok"][n % 3]
  }],
  (n) => ["control.approval.requested", { requestId: `r${n % 2}`, question: "ok?" }],
  (n) => [n % 2 === 0 ? "control.approval.approved" : "control.approval.denied", { requestId: `r${n % 2}` }],
  (n) => ["control.agent.checkpoint-minted", { ref: `ref${n}` }],
  (n) => ["control.engine.projection-gap", { missing: n }],
  () => ["control.run.completed", {}],
  () => ["control.run.failed", { cause: "boom" }],
  () => ["control.agent.unknown-kind", { anything: 1 }],
  () => ["someone.else", {}]
]

/** One generated record: a shape, a scope, a sequence step and a clock. */
const recordArbitrary = FastCheck.record({
  shape: FastCheck.nat(agentPayloads.length + 3),
  n: FastCheck.nat(30),
  scope: FastCheck.constantFrom(undefined, undefined, "l", "r"),
  gap: FastCheck.constantFrom(1, 1, 1, 0, -2, undefined),
  clock: FastCheck.constantFrom("at", "occurred", "both", "none"),
  repeat: FastCheck.boolean()
})

type RecordSpec = typeof recordArbitrary extends FastCheck.Arbitrary<infer Value> ? Value : never

const journalOf = (specs: ReadonlyArray<RecordSpec>): Array<JournalRecord> => {
  const journal: Array<JournalRecord> = []
  let sequence = 0
  for (const spec of specs) {
    // A replayed record: the same object, or the same content under a new sequence.
    if (spec.repeat && journal.length > 0 && spec.n % 3 === 0) {
      const earlier = journal[spec.n % journal.length]!
      journal.push(spec.n % 2 === 0 ? earlier : { ...earlier, sequence: sequence + 1 })
      continue
    }
    sequence += spec.gap ?? 1
    const current = spec.gap === undefined ? undefined : sequence
    if (spec.shape === agentPayloads.length) {
      journal.push(nativeCall(current ?? 0, "invoked", spec.n % 4, false))
      continue
    }
    if (spec.shape === agentPayloads.length + 1) {
      journal.push(nativeCall(current ?? 0, "settled", spec.n % 4, spec.n % 2 === 0))
      continue
    }
    if (spec.shape >= agentPayloads.length + 2) {
      const kinds = ["control.agent.turn-opened", "control.agent.cell-call-started", "control.agent.resolved"]
      journal.push(nativeStep(current ?? 0, spec.scope ?? "l", kinds[spec.n % 3]!, spec.n % 4))
      continue
    }
    const [kind, payload] = agentPayloads[spec.shape]!(spec.n)
    const at = spec.n * 7 - (spec.n % 4) * 11
    journal.push({
      runId: "run",
      ...(current === undefined ? {} : { sequence: current }),
      kind,
      ...(spec.clock === "occurred" || spec.clock === "both" ? { occurredAt: at + 3 } : {}),
      payload: {
        ...payload,
        ...(spec.clock === "at" || spec.clock === "both" ? { at } : {}),
        ...(spec.scope === undefined ? {} : { step: step(spec.scope) })
      }
    })
  }
  return journal
}

/** Steps the fold one record at a time and checks every prefix against a refold of it. */
const replay = (journal: ReadonlyArray<JournalRecord>, status: string): ReadonlyArray<TraceModel> => {
  const fold = traceFold(run)
  const models: Array<TraceModel> = []
  const frozen: Array<string> = []
  journal.forEach((record, index) => {
    traceFoldStep(fold, record)
    const live = traceFoldModel(fold, status)
    expect(live).toEqual(traceFromJournal({ ...run, status }, journal.slice(0, index + 1)))
    models.push(live)
    frozen.push(JSON.stringify(live))
  })
  // A model taken earlier is a snapshot: stepping past it changed none of it.
  models.forEach((model, index) => expect(JSON.stringify(model)).toBe(frozen[index]))
  return models
}

describe("traceFoldStep", () => {
  it("keeps replayed call events from creating or settling a second call", () => {
    const started: JournalRecord = {
      sequence: 1,
      kind: "control.agent.cell-call-started",
      payload: { callId: "write-1", flowName: "write" }
    }
    const settled: JournalRecord = {
      sequence: 3,
      kind: "control.agent.cell-call-settled",
      payload: { callId: "write-1", flowName: "write", outcome: "success", value: "saved" }
    }
    const model = replay([started, { ...started, sequence: 2 }, settled, { ...settled, sequence: 4 }], "completed")
      .at(-1)!
    const calls = model.rows.filter((row) => row.kind === "call")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ status: "completed", detail: { output: "saved" } })
  })

  it.each(["success", "failure"] as const)(
    "settles an open cell and frame after a %s call when the run ends",
    (outcome) => {
      const journal: ReadonlyArray<JournalRecord> = [
        { sequence: 1, kind: "control.agent.turn-opened", payload: {} },
        { sequence: 2, kind: "control.agent.cell-produced", payload: { text: "await write()" } },
        { sequence: 3, kind: "control.agent.cell-call-started", payload: { callId: "write-1", flowName: "write" } },
        { sequence: 4, kind: "control.agent.cell-call-settled", payload: { callId: "write-1", outcome } }
      ]
      const status = outcome === "failure" ? "failed" : "completed"
      const model = replay(journal, status).at(-1)!
      expect(model.rows.find((row) => row.kind === "cell")?.status).toBe(status)
      expect(model.rows.find((row) => row.kind === "frame")?.status).toBe(status)
    }
  )

  it("equals a refold of every prefix of any journal", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.array(recordArbitrary, { maxLength: 40 }),
        FastCheck.constantFrom(...statuses),
        (specs, status) => {
          replay(journalOf(specs), status)
        }
      ),
      { numRuns: 300, seed: 1790 }
    )
  })

  it("equals a refold of every prefix of a recorded module run", () => {
    for (const status of statuses) replay(moduleRunJournal, status)
  })

  it("replays a native fact that supersedes earlier telemetry in place", () => {
    const telemetry = {
      runId: "run",
      sequence: 1,
      kind: "control.agent.cell-call-started",
      payload: { callId: callId(0), flowName: "write", input: { path: "stale" } }
    }
    const models = replay([telemetry, nativeCall(2, "invoked", 0, false)], "running")
    expect(models.at(-1)!.rows.find((row) => row.kind === "call")!.detail.input).toEqual({ path: "f0" })
  })
})

describe("traceFoldSync", () => {
  it("steps only the records a grown journal appended, and refolds a rewritten one", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.array(recordArbitrary, { maxLength: 30 }),
        FastCheck.nat(30),
        (specs, cut) => {
          const journal = journalOf(specs)
          const head = journal.slice(0, Math.min(cut, journal.length))
          const held = traceFoldSync(undefined, run, head)
          const grown = traceFoldSync(held, run, journal)
          expect(grown).toBe(held)
          expect(traceFoldModel(grown, "running")).toEqual(traceFromJournal({ ...run, status: "running" }, journal))
          // A journal that is not an extension of what the fold read starts over.
          const other = traceFoldSync(grown, run, [...journal].reverse())
          expect(traceFoldModel(other, "running")).toEqual(
            traceFromJournal({ ...run, status: "running" }, [...journal].reverse())
          )
        }
      ),
      { numRuns: 100, seed: 1791 }
    )
  })

  const opened = (seat: string): JournalRecord => ({
    sequence: 1,
    kind: "control.agent.turn-opened",
    payload: { seat }
  })
  const started: JournalRecord = {
    sequence: 2,
    kind: "control.agent.cell-call-started",
    payload: { callId: "review-call", flowName: "write", input: { path: "example.ts" } }
  }
  const batch = (records: ReadonlyArray<JournalRecord>) => traceFromJournal({ ...run, status: "running" }, records)

  it("steps records appended to the same array it last read", () => {
    const records: Array<JournalRecord> = [opened("review")]
    const held = traceFoldSync(undefined, run, records)
    const before = traceFoldModel(held, "running")
    records.push(started)
    const grown = traceFoldSync(held, run, records)
    expect(grown).toBe(held)
    const after = traceFoldModel(grown, "running")
    expect(after.journal).toHaveLength(2)
    expect(after.rows.filter((row) => row.kind === "call")).toHaveLength(1)
    expect(after).toEqual(batch(records))
    // The model read before the append is not mutated by it.
    expect(before.journal).toHaveLength(1)
  })

  it("refolds when a slot of the same array is rewritten in place", () => {
    const records: Array<JournalRecord> = [opened("review"), started]
    const held = traceFoldSync(undefined, run, records)
    expect(JSON.stringify(traceFoldModel(held, "running"))).toContain("review")
    records[0] = opened("revised")
    const rewritten = traceFoldSync(held, run, records)
    expect(rewritten).not.toBe(held)
    const model = traceFoldModel(rewritten, "running")
    expect(model).toEqual(batch(records))
    expect(JSON.stringify(model)).toContain("revised")
  })

  it("extends from a copied array and reuses the fold for an unchanged repeat", () => {
    const head = [opened("review")]
    const held = traceFoldSync(undefined, run, head)
    const copied = traceFoldSync(held, run, [...head, started])
    expect(copied).toBe(held)
    const model = traceFoldModel(copied, "running")
    expect(model).toEqual(batch([...head, started]))
    const repeat = traceFoldSync(copied, run, [...head, started])
    expect(repeat).toBe(copied)
    expect(traceFoldModel(repeat, "running")).toBe(model)
  })
})
