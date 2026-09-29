/**
 * The diagnosis fold and its rendering.
 *
 * These are the questions the old `whatHappened` route answered out of the
 * engine database, asked of the events instead: what happened, why it stopped,
 * and what the run actually did while it ran.
 */
import { ControlSchema } from "@smthrs/control"
import { describe, expect, it } from "vitest"
import * as Diagnosis from "../src/Diagnosis.ts"
import { lastStepResolvedText, moduleRunJournal, moduleRunOutput } from "./fixtures/module-run-journal.ts"

let sequence = 0

const event = (
  kind: string,
  payload: unknown,
  occurredAt = 0
): ControlSchema.ControlEvent => ({
  sequence: (sequence += 1),
  kind,
  runId: "run-1",
  occurredAt,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

const step = {
  stepId: "b".repeat(64),
  executionId: "execution-1",
  action: "repository/research",
  attempt: 1,
  ask: 0,
  retry: 1,
  scope: "execution-1/repository/research"
}

/** One step-scoped native fact, as a host that records step facts emits it. */
const stepFact = (eventType: string, payload: unknown, occurredAt = 0): ControlSchema.ControlEvent =>
  event("control.engine.event", {
    version: 1,
    executionId: step.executionId,
    generation: 0,
    sequence: 1,
    emittedAtMs: occurredAt,
    sourceId: `step-fact-v1:${step.stepId}:${step.attempt}:${step.ask}:${step.retry}`,
    sourceSequence: 7,
    eventType: "flows.harness.step-fact.v1",
    payload: {
      version: 1,
      step,
      generation: 0,
      frame: 0,
      ordinal: 0,
      cell: "",
      at: occurredAt,
      eventType,
      sourceSequence: 7,
      payload
    }
  }, occurredAt)

describe("Diagnosis.digest", () => {
  it("reports nothing at all from no events", () => {
    expect(Diagnosis.digest([])).toMatchObject({
      status: undefined,
      cause: undefined,
      seat: undefined,
      turns: 0,
      calls: 0,
      refusals: [],
      startedAt: undefined,
      endedAt: undefined
    })
  })

  it("counts turns, calls, edits, refusals, and tokens", () => {
    const digest = Diagnosis.digest([
      event("control.agent.turn-opened", { seat: "opus", at: 100 }),
      event("control.agent.turn-opened", {}),
      event("control.agent.cell-call-started", { flowName: "write" }),
      event("control.agent.cell-call-started", { flowName: "edit" }),
      event("control.agent.cell-call-started", { flowName: "apply_patch" }),
      event("control.agent.cell-call-started", { flowName: "read" }),
      event("control.agent.cell-call-started", {}),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "success" }),
      event("control.agent.cell-call-settled", { outcome: "failure" }),
      event("control.agent.cell-call-settled", { flowName: "edit", outcome: "success" }),
      event("control.agent.cell-call-settled", {
        flowName: "apply_patch",
        outcome: "failure",
        message: "denied\nsecond line"
      }),
      event("control.agent.cell-call-settled", { outcome: "failure", message: "denied\r\nthird line" }),
      event("control.agent.cell-call-settled", { outcome: "failure", message: "denied" }),
      event("control.agent.cell-call-settled", { flowName: "read", outcome: "success" }),
      event("control.agent.cell-call-settled", { outcome: "success" }),
      event("control.agent.model-settled", { usage: { inputTokens: 10, outputTokens: 5 } }),
      event("control.agent.model-settled", { usage: {} }),
      event("control.agent.model-settled", {}),
      event("control.agent.resolved", { text: "shipped" }),
      event("control.run.completed", {}, 900)
    ])

    expect(digest).toMatchObject({
      status: "completed",
      seat: "opus",
      turns: 2,
      calls: 5,
      callsFailed: 4,
      editsAttempted: 3,
      editsSucceeded: 2,
      inputTokens: 10,
      outputTokens: 5,
      finalOutput: "shipped"
    })
    // Refusals arrive least frequent first, but aggregate most frequent first.
    expect(digest.refusals).toEqual([
      { message: "denied", count: 3 },
      { message: "unknown refusal", count: 1 }
    ])
    // The payload's own stamp wins over journal admission time.
    expect(digest.startedAt).toBe(0)
    expect(digest.endedAt).toBe(900)
  })

  it("keeps a failure's recorded cause and a park's question", () => {
    const digest = Diagnosis.digest([
      event("control.approval.requested", { question: "Ship it?" }),
      event("control.run.failed", { cause: "the model refused" })
    ])
    expect(digest).toMatchObject({ status: "failed", cause: "the model refused", parkedQuestion: "Ship it?" })
  })

  it("keeps a failure's stamped fault, drops a malformed one, and clears it with the cause", () => {
    const fault = { class: "factory", tag: "coding/Error/stalled" }
    expect(Diagnosis.digest([event("control.run.failed", { cause: "stalled", fault })]).fault).toEqual(fault)
    expect(Diagnosis.digest([event("control.run.failed", { cause: "x", fault: { class: "nope", tag: "t" } })]).fault)
      .toBeUndefined()
    const earlier = Diagnosis.digest([event("control.run.failed", { cause: "stalled", fault })])
    const later = Diagnosis.digest([event("control.run.failed", { cause: "legacy" })])
    expect(Diagnosis.combine(earlier, later)).toMatchObject({ cause: "legacy", fault: undefined })
    expect(Diagnosis.combine(earlier, Diagnosis.digest([event("control.agent.turn-opened", {})])).fault).toEqual(fault)
    // A run resumed after the failure no longer carries its fault, in one window or across two.
    expect(Diagnosis.combine(earlier, Diagnosis.digest([event("control.run.running", {})])).fault).toBeUndefined()
    expect(
      Diagnosis.digest([event("control.run.failed", { cause: "x", fault }), event("control.run.running", {})]).fault
    ).toBeUndefined()
  })

  it("tolerates a payload that is not a record", () => {
    const digest = Diagnosis.digest([
      event("control.agent.turn-opened", "not a record"),
      event("control.agent.turn-opened", ["also", "not"]),
      event("control.run.failed", null)
    ])
    expect(digest).toMatchObject({ turns: 2, seat: undefined, status: "failed", cause: undefined })
  })

  it.each(["something.else", "__proto__", "hasOwnProperty", "toString"])(
    "ignores unknown kind %s without changing the digest or timestamps",
    (kind) => {
      const unknown = [event(kind, null, 0), event(kind, { at: 9_000 }, 10_000)] as const
      expect(() => Diagnosis.digest(unknown)).not.toThrow()
      expect(Diagnosis.digest(unknown)).toEqual(Diagnosis.digest([]))
      const known = [event("control.run.running", {}, 100), event("control.run.completed", {}, 900)]
      expect(Diagnosis.digest([unknown[0], ...known, unknown[1]])).toEqual(Diagnosis.digest(known))
    }
  )
})

describe("Diagnosis.digest over the run lifecycle", () => {
  it.each(ControlSchema.RunStatus.literals)("recognizes schema status %s", (status) => {
    expect(Diagnosis.digest([event(`control.run.${status}`, {}, 100)])).toMatchObject({
      status,
      startedAt: 100,
      endedAt: 100
    })
  })

  it("keeps the last STATUS, not the last `control.run.` event", () => {
    // `@smthrs/control` journals lineage, resume, cancel-requested, and
    // pending under the same prefix, and `Lineage.derive` adds one to every
    // followed stream. Reading a status off the prefix made a live run's
    // verdict read "lineage" or "resume".
    const digest = Diagnosis.digest([
      event("control.run.accepted", { runId: "run-1", status: "accepted" }),
      event("control.run.running", { runId: "run-1", status: "running" }),
      event("control.run.pending", { runId: "run-1", status: "accepted" }),
      event("control.run.cancel-requested", { runId: "run-1" }),
      event("control.run.resume", { runId: "run-1", status: "accepted" }),
      event("control.run.resumed", { runId: "run-1", status: "accepted" }),
      event("control.run.lineage", { runId: "run-1", origin: {} })
    ])
    expect(digest.status).toBe("running")
    expect(Diagnosis.verdict(digest)).toBe("running")
  })

  it("ignores a kind under another prefix entirely", () => {
    // The durable engine writes `flows.engine.*` into its own database's
    // journal, which a control watch never reads. A record under that prefix
    // reaching this fold is not a status, and must not become one.
    const digest = Diagnosis.digest([
      event("control.run.running", { runId: "run-1", status: "running" }),
      event("flows.engine.run-decision", { decision: "transitioned", status: "completed" })
    ])
    expect(digest.status).toBe("running")
  })
})

describe("Diagnosis.verdict", () => {
  const facts = (overrides: Partial<Diagnosis.Digest>): Diagnosis.Digest => ({
    ...Diagnosis.digest([]),
    ...overrides
  })

  it("names the unlaunched run", () => {
    expect(Diagnosis.verdict(facts({}))).toBe("unlaunched")
  })

  it("leads a failure with its cause and says so when there is none", () => {
    expect(Diagnosis.verdict(facts({ status: "failed", cause: "boom\nrest" }))).toBe("failed — boom")
    expect(Diagnosis.verdict(facts({ status: "failed" }))).toBe("failed — no cause recorded in the journal")
  })

  it("leads a park with the question it is asking", () => {
    expect(Diagnosis.verdict(facts({ status: "waiting-approval", parkedQuestion: "Ship?" }))).toBe(
      "waiting-approval — asks: Ship?"
    )
    expect(Diagnosis.verdict(facts({ status: "waiting-approval" }))).toBe(
      "waiting-approval — a permission gate is pending"
    )
  })

  it("surfaces the run that worked and never edited", () => {
    expect(Diagnosis.verdict(facts({ status: "completed", calls: 4, editsAttempted: 0 }))).toBe(
      "completed — but 0 of 4 calls attempted an edit; the run only read"
    )
  })

  it("leads a completion with its output, and falls back to the status", () => {
    expect(
      Diagnosis.verdict(facts({ status: "completed", calls: 1, editsAttempted: 1, finalOutput: "done\nmore" }))
    ).toBe("completed — done")
    expect(Diagnosis.verdict(facts({ status: "completed", calls: 1, editsAttempted: 1, finalOutput: "" }))).toBe(
      "completed"
    )
    expect(Diagnosis.verdict(facts({ status: "running" }))).toBe("running")
  })
})

describe("Diagnosis.duration", () => {
  const facts = (startedAt?: number, endedAt?: number): Diagnosis.Digest => ({
    ...Diagnosis.digest([]),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt })
  })

  it("reports nothing measurable as zero", () => {
    expect(Diagnosis.duration(facts())).toBe("0s")
    expect(Diagnosis.duration(facts(1))).toBe("0s")
  })

  it("reports seconds under a minute and minutes above it", () => {
    expect(Diagnosis.duration(facts(0, 42_000))).toBe("42s")
    expect(Diagnosis.duration(facts(0, 125_000))).toBe("2m 05s")
    // A clock that ran backwards is reported as zero, never as a negative.
    expect(Diagnosis.duration(facts(10_000, 0))).toBe("0s")
  })

  it("measures the run, not how long a client watched it", () => {
    // `GatewayServer.watchHeartbeatKind` is merged into every followed `Watch`
    // stream. A fold that let an unhandled kind widen the span reported this
    // run as having taken sixteen minutes.
    const watched = Diagnosis.digest([
      event("control.run.accepted", { at: 1_000 }),
      event("control.run.completed", { at: 2_000 }),
      event("control.gateway.heartbeat", null, 999_000)
    ])
    expect(Diagnosis.duration(watched)).toBe("1s")
    expect(watched.startedAt).toBe(1_000)
    expect(watched.endedAt).toBe(2_000)
  })

  it("measures nothing at all from kinds it does not handle", () => {
    const unknown = Diagnosis.digest([
      event("control.run.lineage", { at: 5 }),
      event("flows.engine.step.settled", { at: 9 })
    ])
    expect(unknown.startedAt).toBeUndefined()
    expect(unknown.endedAt).toBeUndefined()
    expect(unknown.status).toBeUndefined()
  })
})

describe("Diagnosis.clip", () => {
  it("leaves short text alone and marks a cut", () => {
    expect(Diagnosis.clip("short", 10)).toBe("short")
    expect(Diagnosis.clip("abcdefghij", 5)).toBe("abcd…")
  })

  it("cuts on code points rather than UTF-16 code units", () => {
    // A lone surrogate does not survive a UTF-8 round trip: every decoder
    // replaces it with U+FFFD, which is exactly the silent corruption slicing
    // code units used to put on the wire.
    const wellFormed = (text: string) => new TextDecoder().decode(new TextEncoder().encode(text)) === text

    const clipped = Diagnosis.clip("ab😀cd", 4)
    expect(clipped).toBe("ab😀…")
    expect(wellFormed(clipped)).toBe(true)
    expect([...clipped]).toHaveLength(4)
    // The old implementation is the counterexample this pins against.
    expect(wellFormed(`${"ab😀cd".slice(0, 3)}…`)).toBe(false)

    const family = Diagnosis.clip("👨‍👩‍👧‍👦 shipped", 3)
    expect(wellFormed(family)).toBe(true)
    expect(JSON.parse(JSON.stringify(family))).toBe(family)
  })

  it("never returns more than the width asked for", () => {
    expect(Diagnosis.clip("abc", 0)).toBe("")
    expect(Diagnosis.clip("abc", -1)).toBe("")
    expect(Diagnosis.clip("abc", 1)).toBe("…")
    expect(Diagnosis.clip("", 0)).toBe("")
  })

  it("reports the first line of a CRLF cause without its carriage return", () => {
    const digest = Diagnosis.digest([event("control.run.failed", { cause: "boom\r\nstack frame" })])
    expect(Diagnosis.verdict(digest)).toBe("failed — boom")
    const card = Diagnosis.render({ runId: "run-1" }, digest)
    expect(card).toContain("Cause     boom")
    expect(card).not.toContain("\r")
  })

  it("treats a bare carriage return as a line ending", () => {
    const digest = Diagnosis.digest([event("control.run.failed", { cause: "boom\rstack frame" })])
    expect(Diagnosis.verdict(digest)).toBe("failed — boom")
    const card = Diagnosis.render({ runId: "run-1" }, digest)
    expect(card).toContain("Cause     boom")
    expect(card).not.toContain("\r")
  })
})

describe("Diagnosis.render", () => {
  it("renders the whole card when every fact is present", () => {
    const card = Diagnosis.render(
      { runId: "run-1", flowId: "deploy" },
      Diagnosis.digest([
        event("control.agent.turn-opened", { seat: "opus", at: 0 }),
        event("control.agent.cell-call-started", { flowName: "write" }),
        event("control.agent.cell-call-settled", { outcome: "failure", message: "one" }),
        event("control.agent.cell-call-settled", { outcome: "failure", message: "two" }),
        event("control.agent.cell-call-settled", { outcome: "failure", message: "three" }),
        event("control.agent.cell-call-settled", { outcome: "failure", message: "four" }),
        event("control.agent.resolved", { text: "shipped" }),
        event("control.run.failed", { cause: "boom", at: 1_000 })
      ])
    )
    expect(card).toContain("Verdict   failed — boom")
    expect(card).toContain("Run       run-1 · deploy · opus · 1s")
    expect(card).toContain("Activity  1 turns")
    expect(card).toContain("Tokens    0 in / 0 out")
    expect(card).toContain("Cause     boom")
    expect(card).toContain("Output    shipped")
    // Only the three loudest refusals are shown; the rest are noise on a card.
    expect(card.split("\n").filter((line) => line.includes("1×"))).toHaveLength(3)
  })

  it("omits the facts a run does not have", () => {
    const card = Diagnosis.render({ runId: "run-1" }, Diagnosis.digest([]))
    expect(card).toContain("Run       run-1 · 0s")
    expect(card).not.toContain("Cause")
    expect(card).not.toContain("Output")
    expect(card).not.toContain("Refusals")
  })

  it("omits an empty final output", () => {
    const card = Diagnosis.render({ runId: "run-1" }, Diagnosis.digest([event("control.agent.resolved", { text: "" })]))
    expect(card).not.toContain("Output")
  })
})

describe("Diagnosis.combine", () => {
  /**
   * A run whose journal outgrows one window folds the events it drops into a
   * carry digest, so the counters a run card shows have to survive the fold:
   * combining the carry with the window it kept must equal one fold over the
   * concatenation.
   */
  it("adds counters, merges refusal counts, and keeps the latest reading", () => {
    const earlier = Diagnosis.digest([
      event("control.agent.turn-opened", { seat: "opus" }, 100),
      event("control.agent.cell-call-started", { flowName: "write" }, 110),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "failure", message: "denied" }, 120),
      event("control.agent.cell-call-settled", { outcome: "failure", message: "denied" }, 130),
      event("control.agent.cell-call-settled", { outcome: "failure", message: "timeout" }, 140),
      event("control.agent.model-settled", { usage: { inputTokens: 10, outputTokens: 5 } }, 150)
    ])
    const later = Diagnosis.digest([
      event("control.agent.turn-opened", { seat: "sonnet" }, 800),
      event("control.agent.cell-call-settled", { outcome: "failure", message: "denied" }, 810),
      event("control.agent.model-settled", { usage: { inputTokens: 1, outputTokens: 2 } }, 820),
      event("control.agent.resolved", { text: "shipped" }, 830),
      event("control.run.completed", {}, 900)
    ])

    const combined = Diagnosis.combine(earlier, later)
    expect(combined).toMatchObject({
      status: "completed",
      seat: "sonnet",
      turns: earlier.turns + later.turns,
      calls: earlier.calls + later.calls,
      callsFailed: earlier.callsFailed + later.callsFailed,
      editsAttempted: earlier.editsAttempted + later.editsAttempted,
      editsSucceeded: earlier.editsSucceeded + later.editsSucceeded,
      inputTokens: 11,
      outputTokens: 7,
      finalOutput: "shipped"
    })
    // One message counted in both ranges is one refusal counted across them,
    // and the aggregate is re-sorted most frequent first.
    expect(combined.refusals).toEqual([
      { message: "denied", count: 3 },
      { message: "timeout", count: 1 }
    ])
    expect(combined.startedAt).toBe(100)
    expect(combined.endedAt).toBe(900)
  })

  it("keeps the span of the only range that has one", () => {
    const measured = Diagnosis.digest([
      event("control.agent.turn-opened", { seat: "opus" }, 100),
      event("control.run.completed", {}, 900)
    ])
    const unmeasured = Diagnosis.digest([])

    // A window that measured nothing must not erase the span of the one that
    // did, in either order.
    expect(Diagnosis.combine(measured, unmeasured)).toMatchObject({ startedAt: 100, endedAt: 900 })
    expect(Diagnosis.combine(unmeasured, measured)).toMatchObject({ startedAt: 100, endedAt: 900 })
    expect(Diagnosis.combine(unmeasured, unmeasured)).toMatchObject({
      startedAt: undefined,
      endedAt: undefined,
      refusals: []
    })
  })
})

describe("Diagnosis.digest across step scopes", () => {
  it("reads a module run's answer from the root, not from its last step", () => {
    const digest = Diagnosis.digest(moduleRunJournal)

    // The two step agents each resolved with their own answer. Neither is the
    // run's, so the run-level field stays empty and the answer comes from the
    // root's committed decision.
    expect(digest.finalOutput).toBeUndefined()
    const output = Diagnosis.resolvedOutput(digest)
    expect(output).toBeDefined()
    expect(JSON.parse(output!)).toEqual(moduleRunOutput)
    expect(output).not.toContain(lastStepResolvedText)
    // The same excerpt still reports what the steps did: their turns and the
    // tokens they spent belong to the run that ran them.
    expect(digest).toMatchObject({
      status: "completed",
      seat: "repository/research",
      turns: 2,
      inputTokens: 8580,
      outputTokens: 502
    })
  })

  it("still reads a prompt run's answer from its own resolution", () => {
    const digest = Diagnosis.digest([
      event("control.agent.turn-opened", { seat: "opus" }, 100),
      event("control.agent.resolved", { text: "shipped" }, 200),
      event("control.run.completed", {}, 300)
    ])

    // A prompt run records one unscoped stream, so nothing changes for it.
    expect(digest.finalOutput).toBe("shipped")
    expect(Diagnosis.resolvedOutput(digest)).toBe("shipped")
  })
})

describe("Diagnosis handler classes", () => {
  it("documents a class for every handler the fold has", () => {
    // The table in `Diagnosis.ts` above the handler map, written down. A new
    // handler has to appear here, which is what stops one arriving without a
    // reader ever deciding whether a step may write its field.
    expect(Diagnosis.handlerReach).toEqual({
      "control.agent.turn-opened": "aggregate",
      "control.agent.model-settled": "aggregate",
      "control.agent.cell-call-started": "aggregate",
      "control.agent.resolved": "root",
      "control.approval.requested": "root"
    })
  })

  it("reads no run-level fact off a model request or a decision, from a step or from the run", () => {
    // Neither kind has a handler, and that is the decision: a request is what
    // a call was ASKED and a decision is what a classifier read, so neither
    // is a turn, a token, a call or an answer. The payloads below carry every
    // field a handler reads (`seat`, `usage`, `flowName`, `text`, `question`)
    // so a handler added for either kind by mistake moves this digest.
    const baseline = [
      event("control.agent.turn-opened", { seat: "opus" }, 100),
      event("control.agent.model-settled", { usage: { inputTokens: 10, outputTokens: 5 } }, 200),
      event("control.agent.resolved", { text: "the run's answer" }, 300),
      event("control.run.completed", {}, 400)
    ]
    const looksLikeEverything = {
      scope: step.scope,
      frame: 0,
      seat: "a step's seat",
      usage: { inputTokens: 9_999, outputTokens: 9_999 },
      flowName: "write",
      text: "a step's text",
      question: "a step's question",
      outcome: "failure",
      message: "a step's refusal"
    }
    for (const kind of ["control.agent.model-requested", "control.agent.decision-settled"]) {
      expect(Object.hasOwn(Diagnosis.handlerReach, kind)).toBe(false)
      // Recorded far outside the run's span, so widening it would show too.
      const scoped = stepFact(kind, looksLikeEverything, 9_000)
      expect(Diagnosis.nativeStepEvent(scoped)).toMatchObject({ kind, payload: { step: { scope: step.scope } } })
      const unscoped = event(kind, looksLikeEverything, 9_000)
      expect(Diagnosis.digest([...baseline, scoped, unscoped])).toEqual(Diagnosis.digest(baseline))
    }
  })

  it("cannot receive a run status or an approval from a step fact", () => {
    // `StepFact.Fact` accepts `^control\.agent\.[a-z-]+$` alone, so the
    // root-only status fields have no step-scoped reading to refuse.
    for (const eventType of ["control.run.completed", "control.approval.requested"]) {
      expect(Diagnosis.nativeStepEvent(stepFact(eventType, {}))).toBeUndefined()
    }
    expect(Diagnosis.nativeStepEvent(stepFact("control.agent.resolved", { text: "step" }))).toMatchObject({
      kind: "control.agent.resolved"
    })
  })
})
