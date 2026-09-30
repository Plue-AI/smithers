/**
 * The served rows, as pure folds.
 *
 * Every fixture here is the payload a real emitter writes, field for field:
 *
 * - `control.agent.*` from `@smthrs/agent` `AgentSession`, which journals
 *   `{seat, contextDigest}`, `{flowName, input}`, and `{flowName, outcome,
 *   message, value}`. None of them carries a node id, a run id, or a stamp,
 *   so none appears in a fixture here either.
 * - `control.approval.approved` and `control.approval.denied` from
 *   `@smthrs/control` `ControlLive`, which journals `{tokenId, target, scope,
 *   envelope, principal}`.
 *
 * The suites against the real control plane prove these rows reach a client,
 * and `RealEngineRun.test.ts` proves a run the durable engine really executed
 * reads back through them. These prove what is in the rows, including what a
 * happy path never produces: a decision that names no token, a settlement with
 * no open call, a settled call whose value is not a string.
 */
import type { ControlSchema } from "@smthrs/control"
import { ExecutionFact } from "@smthrs/journal"
import * as Schema from "effect/Schema"
import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"
import * as Diagnosis from "../src/Diagnosis.ts"
import * as GatewayProjection from "../src/GatewayProjection.ts"

let sequence = 0

const event = (kind: string, payload: unknown, occurredAt = 0): ControlSchema.ControlEvent => ({
  sequence: (sequence += 1),
  kind,
  runId: "run-1",
  occurredAt,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

/** An event with no run id at all, which a malformed journal can produce. */
const orphan = (kind: string, payload: unknown): ControlSchema.ControlEvent => ({
  sequence: (sequence += 1),
  kind,
  occurredAt: 0,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

const run: ControlSchema.RunSummary = {
  runId: "run-1",
  flowId: "deploy",
  status: "running",
  createdAt: 10,
  updatedAt: 20
}

describe("GatewayProjection.runSummary", () => {
  it("returns a typed module's committed root result across bounded windows, never a child or unbound result", () => {
    const value = { requestId: "setup-1", receipt: { phase: "completed" } }
    const binding = event("control.engine.bound", { version: 1, controlRunId: run.runId, executionId: "native-root" })
    const completion = (executionId = "native-root", status = "completed", tag = "Success") =>
      event("control.engine.event", {
        version: 1,
        executionId,
        generation: 0,
        sequence: 10,
        eventType: "flows.engine.run-decision",
        payload: {
          decision: "transitioned",
          status,
          executionFact: {
            version: 1,
            baseline: "created",
            observation: { executionId, flowName: "agent/run", status }
          },
          state: {
            version: 1,
            flowName: "agent/run",
            payload: { runId: run.runId, planId: "plan-1" },
            result: { _tag: "Complete", exit: { _tag: tag, value } }
          }
        }
      })
    const settled = { ...run, status: "completed" as const }
    const root = completion()
    expect(GatewayProjection.runSummary(settled, [binding, root]).finalOutput).toBe(JSON.stringify(value))
    const carry = Diagnosis.combine(Diagnosis.digest([binding]), Diagnosis.digest([root]))
    expect(GatewayProjection.runSummary(settled, [], undefined, carry).finalOutput).toBe(JSON.stringify(value))
    expect(Diagnosis.resolvedOutput(carry)).toBe(Diagnosis.resolvedOutput(Diagnosis.digest([binding, root])))
    expect(GatewayProjection.runSummary(settled, [root], undefined, Diagnosis.digest([binding])).finalOutput).toBe(
      JSON.stringify(value)
    )
    for (
      const events of [
        [root],
        [binding, completion("child")],
        [binding, completion("native-root", "failed", "Failure")],
        [binding, completion("native-root", "cancelled")],
        [binding, event("control.engine.bound", { version: 1, controlRunId: run.runId, executionId: "another" }), root],
        [binding, event("control.engine.event", { ...(root.payload as object), version: 99 })]
      ]
    ) {
      expect(GatewayProjection.runSummary(settled, events).finalOutput).toBeUndefined()
    }
    const child = completion("child")
    const childBridge = child.payload as Record<string, unknown>
    const childDecision = childBridge.payload as Record<string, unknown>
    ;(childDecision.state as Record<string, unknown>).flowName = "repository/setup"
    expect(GatewayProjection.runSummary(settled, [binding, child, root]).finalOutput).toBe(JSON.stringify(value))
    expect(
      GatewayProjection.runSummary(settled, [
        binding,
        root,
        event("control.agent.resolved", { text: "existing assistant output" })
      ]).finalOutput
    )
      .toBe("existing assistant output")
  })

  it("maps the bound native round's pending, waiting and terminal state without inventing missing evidence", () => {
    const binding = event("control.engine.bound", { version: 1, controlRunId: run.runId, executionId: "native" })
    for (
      const [status, reason, expected] of [
        ["pending", null, "accepted"],
        ["suspended", "event", "parked"],
        ["suspended", null, "parked"],
        ["failed", null, "failed"]
      ] as const
    ) {
      const observation = Schema.decodeUnknownSync(ExecutionFact.Observation)({
        executionId: "native",
        flowName: "agent/run",
        status,
        createdAtMs: 1,
        startedAtMs: null,
        finishedAtMs: status === "failed" ? 2 : null,
        parentRunId: "parent",
        lineageId: "native",
        roundOrdinal: 0,
        cancelRequestedAtMs: null,
        waiting: reason === null ? null : { reason, wakeAtMs: null, tokenDigest: null }
      })
      const fact = event("control.engine.event", {
        version: 1,
        executionId: "native",
        generation: 0,
        sequence: 0,
        eventType: "flows.engine.run-decision",
        payload: { decision: "created", executionFact: { version: 1, baseline: "created", observation } }
      })
      const summary = GatewayProjection.runSummary({
        ...run,
        executionObservation: "observed",
        executionView: { root: observation, current: observation }
      }, [binding, fact])
      expect(summary).toMatchObject({
        status: expected,
        parentRunId: "parent",
        executionProvenance: { source: "events" }
      })
      expect(summary.waitingReason).toBe(reason ?? undefined)
    }
    const missing = GatewayProjection.runSummary({ ...run, executionObservation: "observed" }, [binding])
    expect(missing.status).toBe(run.status)
    expect(missing.executionProvenance?.source).toBe("legacy-observation")
    const unbound = GatewayProjection.runSummary({ ...run, executionObservation: "observed" }, [])
    expect(unbound.status).toBe(run.status)
    expect(unbound.executionProvenance).toBeUndefined()
  })

  it("marks a running round waiting while a person holds a wait in its tree", () => {
    const observed = (
      status: "running" | "suspended",
      executionId: string,
      waiting: unknown = null
    ) =>
      Schema.decodeUnknownSync(ExecutionFact.Observation)({
        executionId,
        flowName: "agent/run",
        status,
        createdAtMs: 1,
        startedAtMs: 1,
        finishedAtMs: null,
        parentRunId: null,
        lineageId: executionId,
        roundOrdinal: 0,
        cancelRequestedAtMs: null,
        waiting
      })
    const running = observed("running", "native")
    const held = observed("suspended", "prepare-plan", {
      reason: "approval",
      wakeAtMs: null,
      tokenDigest: "digest-of-wait"
    })
    const base = { ...run, executionObservation: "observed" as const }
    const statusOf = (summary: ControlSchema.RunSummary) => GatewayProjection.runSummary(summary, []).status

    // The round itself is running: only the tree says a person is holding it.
    expect(statusOf({ ...base, executionView: { root: running, current: running, humanWaits: [held] } }))
      .toBe("waiting-approval")
    // A fold that covered no tree falls back to the plane's own pending waits.
    expect(statusOf({
      ...base,
      executionView: { root: running, current: running },
      pendingWaits: [{ runId: "prepare-plan", reason: "approval", token: "wait-token", createdAt: 1 }]
    })).toBe("waiting-approval")
    // Neither source names a wait, so a running round is reported as running.
    expect(statusOf({ ...base, executionView: { root: running, current: running } })).toBe("running")
  })

  it("carries only the optional fields the run actually has", () => {
    const row = GatewayProjection.runSummary(run, [])
    expect(row).toMatchObject({ runId: "run-1", flowId: "deploy", status: "running", createdAt: 10, updatedAt: 20 })
    expect(Object.keys(row)).not.toContain("planId")
    expect(Object.keys(row)).not.toContain("cancellation")
    expect(Object.keys(row)).not.toContain("steeringPending")
    expect(Object.keys(row)).not.toContain("deadlineAt")
  })

  it("carries every optional field the run does have", () => {
    const row = GatewayProjection.runSummary(
      {
        ...run,
        planId: "plan-1",
        planDigest: "digest-1",
        parentRunId: "parent-1",
        lineageId: "lineage-1",
        roundOrdinal: 2,
        waitingReason: "approval",
        steering: { pending: 3 },
        cancellation: { requestedAt: 5, source: "control", reason: "stop" },
        deadlineAt: 1_800_010
      },
      [event("control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" })]
    )
    expect(row).toMatchObject({
      planId: "plan-1",
      planDigest: "digest-1",
      parentRunId: "parent-1",
      lineageId: "lineage-1",
      roundOrdinal: 2,
      waitingReason: "approval",
      steeringPending: 3,
      cancellation: { source: "control", reason: "stop" },
      deadlineAt: 1_800_010,
      seat: "opus"
    })
  })
})

describe("GatewayProjection.runTree", () => {
  it("correlates same-name overlapping calls that settle in reverse order, including failure", () => {
    const events = [
      event("control.agent.cell-call-started", { callId: "first", flowName: "write", input: { path: "a" } }, 1),
      event("control.agent.cell-call-started", { callId: "second", flowName: "write", input: { path: "b" } }, 2),
      event("control.agent.cell-call-settled", {
        callId: "second",
        flowName: "write",
        outcome: "failure",
        message: "b locked"
      }, 3),
      event("control.agent.cell-call-settled", {
        callId: "first",
        flowName: "write",
        outcome: "success",
        value: "a written"
      }, 4)
    ]
    expect(GatewayProjection.runTree(run, events)).toMatchObject([
      { nodeId: "call-1", label: "write", status: "completed", startedAt: 1, endedAt: 4 },
      { nodeId: "call-2", label: "write", status: "failed", startedAt: 2, endedAt: 3 }
    ])
    expect(GatewayProjection.nodeOutput(events)).toMatchObject([
      { nodeId: "call-2", outcome: "failure", output: "b locked", settledAt: 3 },
      { nodeId: "call-1", outcome: "success", output: "a written", settledAt: 4 }
    ])
    expect(GatewayProjection.transcript(events).map((row) => row.callId)).toEqual([
      "first",
      "second",
      "second",
      "first"
    ])
  })

  it("ignores identified duplicates without changing node keys, outputs, transcript or counts", () => {
    const first = event("control.agent.cell-call-started", { callId: "first", flowName: "write" }, 1)
    const failed = event("control.agent.cell-call-settled", {
      callId: "first",
      flowName: "write",
      outcome: "failure",
      message: "locked"
    }, 2)
    const second = event("control.agent.cell-call-started", { callId: "second", flowName: "write" }, 3)
    const events = [first, first, failed, second, failed, first]
    expect(GatewayProjection.runTree(run, events)).toMatchObject([
      { nodeId: "call-1", status: "failed", endedAt: 2 },
      { nodeId: "call-2", status: "running" }
    ])
    expect(GatewayProjection.nodeOutput(events)).toHaveLength(1)
    expect(GatewayProjection.transcript(events)).toHaveLength(3)
    expect(Diagnosis.digest(events)).toMatchObject({ calls: 2, callsFailed: 1, editsAttempted: 2 })
  })

  it("never lets unknown or idless settlements steal an identified same-name call", () => {
    const events = [
      event("control.agent.cell-call-started", { callId: "actual", flowName: "write" }),
      event("control.agent.cell-call-settled", { callId: "unknown", flowName: "write", outcome: "failure" }),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "success" })
    ]
    expect(GatewayProjection.runTree(run, events)).toMatchObject([{ nodeId: "call-1", status: "running" }])
    expect(GatewayProjection.nodeOutput(events)).toEqual([])
  })

  it("keeps legacy FIFO and allows a resumed identified settlement to close only a legacy start", () => {
    const events = [
      event("control.agent.cell-call-started", { callId: "current", flowName: "write" }, 1),
      event("control.agent.cell-call-started", { flowName: "write" }, 2),
      event("control.agent.cell-call-started", { flowName: "write" }, 3),
      event("control.agent.cell-call-settled", {
        callId: "resumed",
        flowName: "write",
        outcome: "success",
        value: "legacy first"
      }, 4),
      event("control.agent.cell-call-settled", {
        callId: "resumed",
        flowName: "write",
        outcome: "success",
        value: "duplicate"
      }, 5),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "failure", message: "legacy second" }, 6),
      event("control.agent.cell-call-settled", {
        callId: "current",
        flowName: "write",
        outcome: "success",
        value: "current"
      }, 7)
    ]
    expect(GatewayProjection.nodeOutput(events)).toMatchObject([
      { nodeId: "call-2", output: "legacy first", settledAt: 4 },
      { nodeId: "call-3", output: "legacy second", settledAt: 6 },
      { nodeId: "call-1", output: "current", settledAt: 7 }
    ])
  })

  it("keys each call by the ordinal it opened on, because the emitter names no node", () => {
    const rows = GatewayProjection.runTree(run, [
      event("control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" }),
      event("control.agent.cell-call-started", { flowName: "write", input: { path: "a" } }, 1),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "success", value: "ok" }, 2),
      event("control.agent.cell-call-started", { flowName: "read", input: {} }, 3),
      event("control.agent.cell-call-settled", { flowName: "read", outcome: "failure", message: "no" }, 4),
      event("control.agent.cell-call-started", { flowName: "grep", input: {} }, 5)
    ])
    expect(rows).toMatchObject([
      { nodeId: "call-1", label: "write", status: "completed", seat: "opus", startedAt: 1, endedAt: 2 },
      { nodeId: "call-2", label: "read", status: "failed", endedAt: 4 },
      { nodeId: "call-3", label: "grep", status: "running" }
    ])
    // A node still open has no end.
    expect(Object.keys(rows[2] ?? {})).not.toContain("endedAt")
  })

  it("settles the oldest open call of the settlement's flow, not the newest", () => {
    const rows = GatewayProjection.runTree(run, [
      event("control.agent.cell-call-started", { flowName: "write", input: {} }, 1),
      event("control.agent.cell-call-started", { flowName: "read", input: {} }, 2),
      event("control.agent.cell-call-started", { flowName: "write", input: {} }, 3),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "success" }, 4)
    ])
    expect(rows.map((row) => `${row.nodeId}:${row.status}`)).toEqual([
      "call-1:completed",
      "call-2:running",
      "call-3:running"
    ])
  })

  it("drops an unknown-flow settlement without stealing another flow's open call", () => {
    const events = [
      event("control.agent.cell-call-started", { flowName: "write", input: {} }, 1),
      event("control.agent.cell-call-started", { flowName: "read", input: {} }, 2),
      event("control.agent.cell-call-settled", { flowName: "grep", outcome: "failure", message: "missing" }, 3),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "success", value: "written" }, 4)
    ]

    expect(GatewayProjection.runTree(run, events)).toMatchObject([
      { nodeId: "call-1", label: "write", status: "completed", endedAt: 4 },
      { nodeId: "call-2", label: "read", status: "running" }
    ])
    expect(GatewayProjection.nodeOutput(events)).toMatchObject([
      { nodeId: "call-1", outcome: "success", output: "written", settledAt: 4 }
    ])
  })

  it("still closes a known call after a settlement names an unknown flow", () => {
    const rows = GatewayProjection.runTree(run, [
      event("control.agent.cell-call-started", { flowName: "read", input: {} }),
      event("control.agent.cell-call-settled", { flowName: "unknown", outcome: "failure" }),
      event("control.agent.cell-call-settled", { flowName: "read", outcome: "success" })
    ])

    expect(rows.map((row) => `${row.nodeId}:${row.label}:${row.status}`)).toEqual([
      "call-1:read:completed"
    ])
  })

  it("names a call whose flow name is missing after the ordinal it opened on", () => {
    const rows = GatewayProjection.runTree({ ...run, parentRunId: "parent-1" }, [
      event("control.agent.cell-call-started", {}),
      event("control.agent.cell-call-settled", {})
    ])
    expect(rows).toMatchObject([{ nodeId: "call-1", label: "call-1", status: "completed", parentRunId: "parent-1" }])
  })

  it("drops a settlement that matches no open call", () => {
    expect(GatewayProjection.runTree(run, [event("control.agent.cell-call-settled", { flowName: "write" })]))
      .toEqual([])
  })

  it("keeps the seat from the last turn that named one", () => {
    const rows = GatewayProjection.runTree(run, [
      event("control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" }),
      event("control.agent.turn-opened", { contextDigest: "ctx" }),
      event("control.agent.cell-call-started", { flowName: "write" })
    ])
    expect(rows[0]?.seat).toBe("opus")
  })
})

describe("GatewayProjection.approvals", () => {
  const payload = {
    target: { _tag: "Node", runId: "run-1", requestId: "gate", digest: "d", envelope: {} },
    scope: "run",
    idempotencyKey: "k"
  }

  /**
   * The nested `HumanTask` gate, as `@smthrs/control` rolls it onto the root.
   *
   * These rows come from the summary rather than the journal: a human wait
   * journals nothing, which is why folding the root's events alone reported an
   * empty inbox for a run whose whole tree was waiting on a person (run-3,
   * `coding-clarification`).
   */
  const humanWait: ControlSchema.PendingWait = {
    runId: "prepare-plan",
    flowId: "coding/PreparePlan",
    reason: "approval",
    token: "wait-token",
    name: "coding-clarification",
    attempt: 1,
    createdAt: 42,
    request: {
      task: "human",
      name: "coding-clarification",
      kind: "ask",
      prompt: "Which service owns the retry budget?",
      attempt: 1,
      maxAttempts: 3
    }
  }

  /**
   * A USD budget park, as `AgentSession` commits it: the dollar question, the
   * raised `usd` ceiling in the target envelope, and the frozen incident. The
   * row is what an inbox approves, so the raise must survive the projection
   * and the wire unchanged.
   */
  it("carries a USD park's dollar question and raised ceiling to the decision it submits", () => {
    const target = {
      _tag: "Node" as const,
      runId: "run-1",
      requestId: "budget/run-1/usd",
      digest: "d",
      envelope: { capabilities: [], flows: [], budget: { usd: 2.2, tokens: 5_000, onExceeded: "park" as const } }
    }
    const requested = event("control.approval.requested", {
      runId: "run-1",
      requestId: target.requestId,
      question: "Raise the USD budget from $1.00 to $2.20?",
      payload: { target, scope: "once", idempotencyKey: "approve:budget" },
      incident: {
        classification: "Runaway",
        source: "usd",
        message: "over",
        used: 0.6,
        max: 1,
        next: 0.6,
        allowance: 2.2
      }
    })

    const [row] = GatewayProjection.approvals([requested])
    expect(row).toMatchObject({ requestId: target.requestId, title: "Raise the USD budget from $1.00 to $2.20?" })
    expect(row!.payload.target.envelope.budget).toEqual({ usd: 2.2, tokens: 5_000, onExceeded: "park" })
    const wire = Schema.decodeUnknownSync(GatewayProjection.ApprovalRow)(
      JSON.parse(JSON.stringify(Schema.encodeSync(GatewayProjection.ApprovalRow)(row!)))
    )
    expect(wire.payload).toEqual(row!.payload)
    const approved = event("control.approval.approved", {
      factVersion: 1,
      tokenId: target.requestId,
      approvalTarget: target
    })
    expect(GatewayProjection.approvals([requested, approved])[0]?.status).toBe("approved")
  })

  it("lists a human wait held by a nested execution as a gate of the root run", () => {
    const rows = GatewayProjection.approvals([], { ...run, status: "waiting-approval", pendingWaits: [humanWait] })

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    // Addressed to the run a person opened; the execution holding the wait
    // travels in the request, because a client routes by run.
    expect(row.runId).toBe("run-1")
    expect(row.requestId).toBe("coding-clarification#1")
    expect(row.title).toBe("Which service owns the retry budget?")
    expect(row.status).toBe("pending")
    expect(row.requestedAt).toBe(42)
    expect(row.waitRunId).toBe("prepare-plan")
    expect(row.request).toMatchObject({
      kind: "ask",
      name: "coding-clarification",
      attempt: 1,
      maxAttempts: 3,
      waitFlowId: "coding/PreparePlan",
      token: "wait-token"
    })
    // Submitted back unchanged; `requestId` is what `Control.signal` routes on.
    expect(row.payload.target).toMatchObject({ _tag: "Node", runId: "run-1", requestId: "coding-clarification#1" })
  })

  /**
   * A loop that re-asks one question — `ContinueAuthor` publishing a second
   * consolidated reply, two `approved` steps parked at once — parks again under
   * the SAME run, name and attempt. Keying the answer by name alone made the
   * second answer `AlreadyApplied`: never delivered, stamped decided, parked
   * forever. The answer identity is the wait, not the name.
   */
  it("gives every park of one wait point its own answer identity", () => {
    const keyOf = (wait: ControlSchema.PendingWait) =>
      GatewayProjection.approvals([], { ...run, status: "waiting-approval", pendingWaits: [wait] })[0]!.payload
        .idempotencyKey
    const first = { ...humanWait, tokenDigest: "digest-of-first" }
    const second = { ...first, token: "second-token", tokenDigest: "digest-of-second", createdAt: 84 }

    expect(keyOf(first)).not.toBe(keyOf(second))
    expect(keyOf(first)).toContain("answer:run-1:coding-clarification#1")
    // A re-read of the same park is the same submission, so a duplicate
    // submit still deduplicates.
    expect(keyOf(first)).toBe(keyOf({ ...first, createdAt: 99 }))
    // A plane that named no digest still separates the two parks.
    expect(keyOf(humanWait)).not.toBe(keyOf({ ...humanWait, token: "second-token" }))
  })

  it("binds decisions over observed human waits to their exact request and digest", () => {
    const summary = { ...run, status: "waiting-approval" as const, pendingWaits: [humanWait] }
    const target = {
      _tag: "Node" as const,
      runId: "run-1",
      requestId: "coding-clarification#1",
      digest: humanWait.token,
      envelope: { capabilities: [], flows: [], budget: {} }
    }
    const decision = (digest: string) =>
      event("control.approval.approved", {
        factVersion: 1,
        tokenId: target.requestId,
        approvalTarget: { ...target, digest }
      })
    expect(GatewayProjection.approvals([decision("other-wait")], summary)[0]?.status).toBe("pending")
    expect(GatewayProjection.approvals([event("control.approval.denied", {})], summary)[0]?.status).toBe("pending")
    expect(GatewayProjection.approvals([decision(humanWait.token)], summary)[0]).toMatchObject({
      status: "approved",
      waitRunId: humanWait.runId,
      requestId: target.requestId
    })
  })

  it("still renders a wait that declared no question", () => {
    const rows = GatewayProjection.approvals([], {
      ...run,
      status: "waiting-approval",
      pendingWaits: [{ runId: "child", reason: "approval", token: "bare", name: "sign-off", createdAt: 1 }]
    })

    expect(rows[0]).toMatchObject({
      requestId: "sign-off",
      waitRunId: "child",
      title: "Answer needed — sign-off",
      request: { kind: "ask", name: "sign-off", token: "bare" }
    })
  })

  it("names a wait by its token when neither the token nor the question names it", () => {
    const rows = GatewayProjection.approvals([], {
      ...run,
      status: "waiting-approval",
      pendingWaits: [{ runId: "child", reason: "approval", token: "opaque", createdAt: 1 }]
    })

    expect(rows[0]?.requestId).toBe("opaque")
  })

  /**
   * A wait the event fold verified carries the question the execution really
   * asked, so the row states `events` and reads its request from the projected
   * observation. A wait the fold covered but could not match is still shown,
   * and still says so: its question is the plane's, not the journal's.
   */
  describe("over a verified execution tree", () => {
    const rootObservation = Schema.decodeUnknownSync(ExecutionFact.Observation)({
      executionId: "native",
      flowName: "agent/run",
      status: "running",
      createdAtMs: 1,
      startedAtMs: 1,
      finishedAtMs: null,
      parentRunId: null,
      lineageId: "native",
      roundOrdinal: 0,
      cancelRequestedAtMs: null,
      treeVersion: 1,
      parentPolicy: "cancel",
      waiting: null
    })
    const childObservation = Schema.decodeUnknownSync(ExecutionFact.Observation)({
      executionId: "prepare-plan",
      flowName: "coding/PreparePlan",
      status: "suspended",
      createdAtMs: 2,
      startedAtMs: 2,
      finishedAtMs: null,
      parentRunId: "native",
      lineageId: "prepare-plan",
      roundOrdinal: 0,
      cancelRequestedAtMs: null,
      treeVersion: 1,
      parentPolicy: "cancel",
      waiting: {
        reason: "approval",
        wakeAtMs: null,
        tokenDigest: "digest-of-wait",
        point: "coding-clarification",
        request: {
          task: "human",
          name: "coding-clarification",
          kind: "ask",
          prompt: "Which service owns the retry budget?",
          attempt: 1,
          maxAttempts: 3
        }
      }
    })
    const fact = (observation: ExecutionFact.Observation, sequence: number) =>
      event("control.engine.event", {
        version: 1,
        executionId: observation.executionId,
        generation: 0,
        sequence,
        eventType: "flows.engine.run-decision",
        payload: { decision: "created", executionFact: { version: 1, baseline: "created", observation } }
      })
    const events = [
      event("control.engine.bound", { version: 1, controlRunId: "run-1", executionId: "native" }),
      fact(rootObservation, 0),
      fact(childObservation, 0)
    ]
    const waiting = { ...run, status: "waiting-approval" as const }

    it("reads a matched wait's question from the observation the events verified", () => {
      const rows = GatewayProjection.approvals(events, {
        ...waiting,
        pendingWaits: [{
          runId: "prepare-plan",
          reason: "approval",
          token: "wait-token",
          tokenDigest: "digest-of-wait",
          createdAt: 42
        }]
      })

      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        questionProvenance: "events",
        waitRunId: "prepare-plan",
        requestId: "coding-clarification",
        title: "Which service owns the retry budget?"
      })
      expect(rows[0]?.request).toMatchObject({ kind: "ask", waitFlowId: "coding/PreparePlan", maxAttempts: 3 })
    })

    it("still renders a wait the verified tree does not account for, and says so", () => {
      const rows = GatewayProjection.approvals(events, {
        ...waiting,
        pendingWaits: [{
          runId: "prepare-plan",
          reason: "approval",
          token: "wait-token",
          tokenDigest: "digest-of-another-park",
          name: "sign-off",
          createdAt: 42
        }]
      })

      expect(rows[0]).toMatchObject({
        questionProvenance: "unverified-observation",
        requestId: "sign-off",
        title: "Answer needed \u2014 sign-off"
      })
    })
  })

  it("titles a request with its question and falls back to the request id", () => {
    const rows = GatewayProjection.approvals([
      event("control.approval.requested", { runId: "run-1", requestId: "gate", question: "Ship?", payload }),
      event("control.approval.requested", { runId: "run-1", requestId: "mute", payload })
    ])
    expect(rows.map((row) => row.title)).toEqual(["Ship?", "Approval needed — mute"])
  })

  it("takes the run from the event when the payload does not name one", () => {
    const rows = GatewayProjection.approvals([
      event("control.approval.requested", { requestId: "gate", payload })
    ])
    expect(rows[0]?.runId).toBe("run-1")
  })

  it("drops a request missing its request id, run, or payload", () => {
    expect(
      GatewayProjection.approvals([
        event("control.approval.requested", { runId: "run-1", payload }),
        orphan("control.approval.requested", { requestId: "gate", payload }),
        event("control.approval.requested", { runId: "run-1", requestId: "gate" })
      ])
    ).toEqual([])
  })

  it("decides only the gate the decision's token names", () => {
    // `SqlControlRuntime.lookupApproval` mints the token id from the target,
    // and for a Node target that is the request id, so one decision closes one
    // gate even while two are open.
    const rows = GatewayProjection.approvals([
      event("control.approval.requested", { runId: "run-1", requestId: "first", payload }),
      event("control.approval.requested", { runId: "run-1", requestId: "second", payload }),
      event("control.approval.approved", {
        tokenId: "second",
        target: "Node",
        scope: "run",
        envelope: {},
        principal: { id: "operator", kind: "cli", stampedAt: 1 }
      })
    ])
    expect(rows.map((row) => `${row.requestId}:${row.status}`)).toEqual(["first:pending", "second:approved"])
  })

  it("leaves pending gates unchanged when a decision names an unknown token", () => {
    const rows = GatewayProjection.approvals([
      event("control.approval.requested", { runId: "run-1", requestId: "gate-a", payload }),
      event("control.approval.approved", { tokenId: "gate-unknown", target: "Node", scope: "run" })
    ])

    expect(rows.map((row) => `${row.requestId}:${row.status}`)).toEqual(["gate-a:pending"])
  })

  it("closes the oldest pending gate when a decision names no token", () => {
    const rows = GatewayProjection.approvals([
      event("control.approval.requested", { runId: "run-1", requestId: "first", payload }),
      event("control.approval.requested", { runId: "run-1", requestId: "second", payload }),
      event("control.approval.denied", { target: "Node", scope: "run" }),
      event("control.approval.approved", { target: "Node", scope: "run" }),
      event("control.approval.approved", { target: "Node", scope: "run" })
    ])
    // Two decisions for two gates; a third finds nothing pending and changes
    // nothing, so the first decision on a gate stays the decision.
    expect(rows.map((row) => `${row.requestId}:${row.status}`)).toEqual(["first:denied", "second:approved"])
  })

  it("ignores an event that is neither a request nor a decision", () => {
    expect(GatewayProjection.approvals([event("control.run.accepted", { runId: "run-1", status: "accepted" })]))
      .toEqual([])
  })
})

describe("GatewayProjection.nodeOutput", () => {
  it("records a success value, a failure message, and a non-string value", () => {
    const rows = GatewayProjection.nodeOutput([
      event("control.agent.cell-call-started", { flowName: "a", input: {} }),
      event("control.agent.cell-call-settled", { flowName: "a", outcome: "success", value: "text" }),
      event("control.agent.cell-call-started", { flowName: "b", input: {} }),
      event("control.agent.cell-call-settled", { flowName: "b", outcome: "failure", message: "no" }),
      event("control.agent.cell-call-started", { flowName: "c", input: {} }),
      event("control.agent.cell-call-settled", { flowName: "c", outcome: "success", value: { ok: 1 } }),
      event("control.agent.cell-call-started", { flowName: "d", input: {} }),
      event("control.agent.cell-call-settled", { flowName: "d", outcome: "success" }),
      event("control.agent.cell-call-started", { flowName: "e", input: {} }),
      event("control.agent.cell-call-settled", { flowName: "e", outcome: "failure" })
    ])
    expect(rows).toMatchObject([
      { nodeId: "call-1", outcome: "success", output: "text" },
      { nodeId: "call-2", outcome: "failure", output: "no" },
      { nodeId: "call-3", outcome: "success", output: "{\"ok\":1}" },
      { nodeId: "call-4", outcome: "success", output: "null" },
      { nodeId: "call-5", outcome: "failure", output: "" }
    ])
  })

  it("drops a settlement with no open call and one with no run at all", () => {
    const rows = GatewayProjection.nodeOutput([
      event("control.agent.cell-call-started", {}),
      event("control.agent.cell-call-settled", { outcome: "success", value: "v" }),
      event("control.agent.cell-call-settled", { outcome: "success", value: "late" }),
      orphan("control.agent.cell-call-settled", { outcome: "success", value: "v" })
    ])
    expect(rows).toMatchObject([{ nodeId: "call-1", runId: "run-1", output: "v" }])
  })

  it("closes an open call whose settlement names no run, without emitting a row", () => {
    // A row has to name the run it belongs to. The call is still consumed, so
    // the next settlement of the same flow does not claim it a second time.
    const rows = GatewayProjection.nodeOutput([
      event("control.agent.cell-call-started", { flowName: "write" }),
      event("control.agent.cell-call-started", { flowName: "write" }),
      orphan("control.agent.cell-call-settled", { flowName: "write", outcome: "success", value: "orphaned" }),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "success", value: "kept" })
    ])
    expect(rows).toMatchObject([{ nodeId: "call-2", runId: "run-1", output: "kept" }])
  })

  it("keys a call the way runTree keys it even when an event names no run", () => {
    // Both folds number a call by the ordinal it opened on, so a UI can pass a
    // `run-tree` node id to `node-output`. Skipping an event before the ordinal
    // advanced shifted one fold's keys against the other's.
    const events = [
      orphan("control.agent.cell-call-started", { flowName: "read" }),
      event("control.agent.cell-call-started", { flowName: "write" }),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "success", value: "written" }),
      event("control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "read it" })
    ]
    const tree = GatewayProjection.runTree(run, events)
    const outputs = GatewayProjection.nodeOutput(events)

    expect(tree.map((row) => `${row.nodeId}:${row.label}`)).toEqual(["call-1:read", "call-2:write"])
    expect(outputs.map((row) => `${row.nodeId}:${row.output}`)).toEqual(["call-2:written", "call-1:read it"])
    const known = new Set(tree.map((row) => row.nodeId))
    expect(outputs.every((row) => known.has(row.nodeId))).toBe(true)
  })

  it("gives a tree row the output of the exact call it names, across interleaved calls", () => {
    // Two calls share a flow name and one settles before the next opens, so
    // agreeing on the set of node ids is not enough: a client reads
    // `node-output` by the id a `run-tree` row carries, and each id has to
    // carry that call's own payload.
    const events = [
      event("control.agent.turn-opened", { seat: "opus" }, 1),
      event("control.agent.cell-call-started", { flowName: "read" }, 2),
      event("control.agent.cell-call-started", { flowName: "write" }, 3),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "success", value: "wrote" }, 4),
      event("control.agent.cell-call-started", { flowName: "read" }, 5),
      event("control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "first read" }, 6),
      event("control.agent.cell-call-started", { flowName: "grep" }, 7),
      event("control.agent.cell-call-settled", { flowName: "read", outcome: "failure", message: "second read" }, 8)
    ]
    const tree = GatewayProjection.runTree(run, events)
    const outputs = GatewayProjection.nodeOutput(events)
    const byNode = new Map(outputs.map((row) => [row.nodeId, row]))

    // Tree rows read in the order the calls opened.
    expect(tree).toMatchObject([
      { nodeId: "call-1", label: "read", status: "completed", seat: "opus", startedAt: 2, endedAt: 6 },
      { nodeId: "call-2", label: "write", status: "completed", seat: "opus", startedAt: 3, endedAt: 4 },
      { nodeId: "call-3", label: "read", status: "failed", seat: "opus", startedAt: 5, endedAt: 8 },
      { nodeId: "call-4", label: "grep", status: "running", seat: "opus", startedAt: 7 }
    ])
    // Outputs read in the order the calls settled, and the still-open call has none.
    expect(outputs.map((row) => row.nodeId)).toEqual(["call-2", "call-1", "call-3"])
    // The oldest open `read` took the first `read` settlement, not the newest.
    expect(byNode.get("call-1")).toMatchObject({ outcome: "success", output: "first read", settledAt: 6 })
    expect(byNode.get("call-2")).toMatchObject({ outcome: "success", output: "wrote", settledAt: 4 })
    expect(byNode.get("call-3")).toMatchObject({ outcome: "failure", output: "second read", settledAt: 8 })
  })
})

/**
 * The invariants that must hold whatever order a journal arrives in.
 *
 * A real journal interleaves calls, decisions, and malformed payloads, and
 * these folds are the whole read contract, so the properties are stated over
 * generated sequences rather than over the handful of shapes a happy path
 * produces.
 */
describe("GatewayProjection fold invariants", () => {
  const flowNames = ["write", "read", "grep"]

  const generated = FastCheck.array(
    FastCheck.oneof(
      FastCheck.record({
        kind: FastCheck.constant("control.agent.cell-call-started"),
        flow: FastCheck.constantFrom(...flowNames)
      }),
      FastCheck.record({
        kind: FastCheck.constant("control.agent.cell-call-settled"),
        flow: FastCheck.constantFrom(...flowNames, "unopened")
      }),
      FastCheck.record({
        kind: FastCheck.constant("control.approval.requested"),
        flow: FastCheck.constantFrom("gate-a", "gate-b")
      }),
      FastCheck.record({
        kind: FastCheck.constant("control.approval.approved"),
        flow: FastCheck.constantFrom("gate-a", "gate-b", "gate-missing")
      }),
      FastCheck.record({
        kind: FastCheck.constant("control.approval.denied"),
        flow: FastCheck.constantFrom("gate-a", "gate-b", "gate-missing")
      })
    ),
    { maxLength: 40 }
  )

  const journal = (
    steps: ReadonlyArray<{ readonly kind: string; readonly flow: string }>
  ): ReadonlyArray<ControlSchema.ControlEvent> =>
    steps.map((step) => {
      if (step.kind === "control.approval.requested") {
        return event(step.kind, {
          runId: "run-1",
          requestId: step.flow,
          question: `Ship ${step.flow}?`,
          payload: {
            target: { _tag: "Node", runId: "run-1", requestId: step.flow, digest: "d", envelope: {} },
            scope: "run",
            idempotencyKey: step.flow
          }
        })
      }
      if (step.kind.startsWith("control.approval.")) return event(step.kind, { tokenId: step.flow })
      return event(step.kind, { flowName: step.flow, outcome: "success", value: step.flow })
    })

  it("emits exactly one tree row per opened call and agrees with nodeOutput on its id", () => {
    FastCheck.assert(
      FastCheck.property(generated, (steps) => {
        const events = journal(steps)
        const opened = steps.filter((step) => step.kind === "control.agent.cell-call-started").length
        const tree = GatewayProjection.runTree(run, events)
        const outputs = GatewayProjection.nodeOutput(events)
        const ids = new Set(tree.map((row) => row.nodeId))

        expect(tree).toHaveLength(opened)
        expect(ids.size).toBe(opened)
        expect(outputs.every((row) => ids.has(row.nodeId))).toBe(true)
        // A settled output belongs to a node the tree also reports as settled.
        const settled = new Set(tree.filter((row) => row.status !== "running").map((row) => row.nodeId))
        expect(outputs.every((row) => settled.has(row.nodeId))).toBe(true)
        // And it is that node's own output: every generated settlement carries
        // its flow name as its value, which is the label of the call it closed.
        const labels = new Map(tree.map((row) => [row.nodeId, row.label]))
        expect(outputs.every((row) => labels.get(row.nodeId) === row.output)).toBe(true)
      }),
      { numRuns: 200 }
    )
  })

  it("never loses a gate it opened, and no decision reopens one", () => {
    FastCheck.assert(
      FastCheck.property(generated, (steps) => {
        const events = journal(steps)
        let before = new Map(GatewayProjection.approvals([]).map((row) => [row.requestId, row.status]))
        for (let index = 1; index <= events.length; index++) {
          const rows = GatewayProjection.approvals(events.slice(0, index))
          const after = new Map(rows.map((row) => [row.requestId, row.status]))
          // The row set only grows, in the order the gates opened.
          expect([...after.keys()].slice(0, before.size)).toEqual([...before.keys()])
          if (events[index - 1]?.kind.startsWith("control.approval.") === true) {
            const decision = events[index - 1]?.kind !== "control.approval.requested"
            for (const [requestId, status] of before) {
              // Only a fresh request may put a gate back on the pending list.
              // A decision may correct another decision, never reopen a gate.
              if (decision && status !== "pending") expect(after.get(requestId)).not.toBe("pending")
            }
          }
          before = after
        }
      }),
      { numRuns: 200 }
    )
  })
})

describe("GatewayProjection.transcript", () => {
  it("numbers turns and renders each reported kind as one line", () => {
    const rows = GatewayProjection.transcript([
      event("control.run.accepted", { runId: "run-1", status: "accepted" }),
      event("control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" }),
      event("control.agent.model-settled", { text: "t", usage: { inputTokens: 3, outputTokens: 4 } }),
      event("control.agent.model-settled", {}),
      event("control.agent.cell-call-started", { flowName: "write", input: {} }),
      event("control.agent.cell-call-started", {}),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "success" }),
      event("control.agent.cell-call-settled", { outcome: "failure", message: "no" }),
      event("control.agent.resolved", { text: "done" }),
      event("control.approval.requested", { question: "Ship?" }),
      event("control.agent.turn-closed", {}),
      event("control.plan.created", {}),
      orphan("control.run.completed", {})
    ])
    expect(rows.map((row) => `${row.turn}:${row.text}`)).toEqual([
      "0:run.accepted",
      "1:turn opened · opus",
      "1:model 3 in / 4 out",
      "1:model 0 in / 0 out",
      "1:call write",
      "1:call ?",
      "1:  -> ok",
      "1:  -> FAIL no",
      "1:resolved done",
      "1:approval requested: Ship?",
      "1:agent.turn-closed"
    ])
  })

  it("renders a missing question and an empty resolution without inventing text", () => {
    const rows = GatewayProjection.transcript([
      event("control.approval.requested", {}),
      event("control.agent.resolved", {}),
      event("control.agent.turn-opened", {}),
      event("control.agent.cell-call-settled", { outcome: "failure" })
    ])
    expect(rows.map((row) => row.text)).toEqual([
      "approval requested: ",
      "resolved ",
      "turn opened · ",
      "  -> FAIL "
    ])
  })

  it("keeps every transcript row to one line", () => {
    const rows = GatewayProjection.transcript([
      event("control.agent.turn-opened", { seat: "opus\nignored" }),
      event("control.agent.cell-call-started", { flowName: "write\rignored" }),
      event("control.agent.cell-call-settled", { outcome: "failure", message: "denied\r\nstack frame" }),
      event("control.agent.resolved", { text: "done\nmore" }),
      event("control.approval.requested", { question: "Ship?\rnot this line" })
    ])

    expect(rows.map((row) => row.text)).toEqual([
      "turn opened · opus",
      "call write",
      "  -> FAIL denied",
      "resolved done",
      "approval requested: Ship?"
    ])
    expect(rows.every((row) => !/[\r\n]/.test(row.text))).toBe(true)
  })
})

describe("GatewayProjection.nodeDurations", () => {
  /** One engine node record, as the host's journal bridge copies it. */
  const record = (eventType: string, payload: unknown, emittedAtMs: number, executionId = "native") =>
    event("control.engine.event", {
      version: 1,
      executionId,
      generation: 0,
      sequence: 0,
      eventId: `${eventType}:${emittedAtMs}`,
      sourceId: `node-journal/${eventType}`,
      sourceSequence: 0,
      emittedAtMs,
      eventType,
      payload
    })

  const scheduled = (
    nodeId: string,
    emittedAtMs: number,
    options: { readonly attempt?: number; readonly executionId?: string } = {}
  ) =>
    record(
      "flows.engine.node-scheduled",
      { nodeId, kind: "step", attempt: options.attempt ?? 1, action: "build" },
      emittedAtMs,
      options.executionId
    )

  const settled = (
    nodeId: string,
    emittedAtMs: number,
    options: {
      readonly outcome?: string
      readonly action?: string | undefined
      readonly attempts?: number
      readonly executionId?: string
    } = {}
  ) =>
    record(
      "flows.engine.node-settled",
      {
        nodeId,
        outcome: options.outcome ?? "built",
        attempts: options.attempts ?? 1,
        ...("action" in options ? options.action === undefined ? {} : { action: options.action } : { action: "build" })
      },
      emittedAtMs,
      options.executionId
    )

  it("measures a built node from the schedule that started it", () => {
    expect(GatewayProjection.nodeDurations([scheduled("compile", 100), settled("compile", 340)]))
      .toEqual([{ actionTag: "build", durationMs: 240 }])
  })

  it("measures a retried node from its last schedule", () => {
    const events = [
      scheduled("compile", 100),
      scheduled("compile", 300, { attempt: 2 }),
      settled("compile", 340, { attempts: 2 })
    ]
    expect(GatewayProjection.nodeDurations(events)).toEqual([{ actionTag: "build", durationMs: 40 }])
  })

  it("keeps two executions of one node id apart", () => {
    const events = [
      scheduled("compile", 100, { executionId: "native" }),
      scheduled("compile", 200, { executionId: "child" }),
      settled("compile", 260, { executionId: "child" }),
      settled("compile", 500, { executionId: "native" })
    ]
    expect(GatewayProjection.nodeDurations(events)).toEqual([
      { actionTag: "build", durationMs: 60 },
      { actionTag: "build", durationMs: 400 }
    ])
  })

  it("counts only work the executor ran", () => {
    for (const outcome of ["clean", "failed", "skipped", "deferred"]) {
      expect(GatewayProjection.nodeDurations([scheduled("compile", 100), settled("compile", 340, { outcome })]))
        .toEqual([])
    }
  })

  it("measures nothing for a record that names no action", () => {
    expect(GatewayProjection.nodeDurations([scheduled("compile", 100), settled("compile", 340, { action: undefined })]))
      .toEqual([])
  })

  it("measures nothing for a settlement no schedule opened", () => {
    expect(GatewayProjection.nodeDurations([settled("compile", 340)])).toEqual([])
    expect(
      GatewayProjection.nodeDurations([scheduled("compile", 100), settled("compile", 340), settled("compile", 900)])
    )
      .toEqual([{ actionTag: "build", durationMs: 240 }])
  })

  it("drops a delta a backward clock produced", () => {
    expect(GatewayProjection.nodeDurations([scheduled("compile", 400), settled("compile", 340)])).toEqual([])
  })

  /** The record the host writes when it takes ownership of a native root. */
  const bound = (executionId: string) =>
    event("control.engine.bound", { version: 1, controlRunId: "run-1", executionId })

  it("measures a called flow once, on the caller's node rather than on the callee's root", () => {
    // What the engine records for one `FlowCall`: the caller admits and
    // settles the node that made the call, and the callee's own execution
    // admits and settles its `root` over the same span.
    const events = [
      bound("native"),
      scheduled("root.flow", 100, { executionId: "native" }),
      scheduled("root", 110, { executionId: "child" }),
      settled("root", 330, { executionId: "child" }),
      settled("root.flow", 340, { executionId: "native" })
    ]
    expect(GatewayProjection.nodeDurations(events)).toEqual([{ actionTag: "build", durationMs: 240 }])
  })

  it("measures the bound root, which is the one root no caller measured", () => {
    const events = [
      bound("native"),
      scheduled("root", 100, { executionId: "native" }),
      settled("root", 340, { executionId: "native" })
    ]
    expect(GatewayProjection.nodeDurations(events)).toEqual([{ actionTag: "build", durationMs: 240 }])
  })

  it("keeps every root when no host bound a native execution", () => {
    const events = [
      scheduled("root", 100, { executionId: "native" }),
      scheduled("root", 110, { executionId: "child" }),
      settled("root", 330, { executionId: "child" }),
      settled("root", 340, { executionId: "native" })
    ]
    expect(GatewayProjection.nodeDurations(events)).toEqual([
      { actionTag: "build", durationMs: 220 },
      { actionTag: "build", durationMs: 240 }
    ])
  })

  it("reads a binding the window evicted from the carried digest", () => {
    // The binding is written once, when the host takes the root up, so a run
    // long enough to outgrow the window is exactly the run whose binding is
    // only in the carry. Reading it there keeps one call one sample instead of
    // letting a long run count every flow twice.
    const events = [
      scheduled("root.flow", 100, { executionId: "native" }),
      scheduled("root", 110, { executionId: "child" }),
      settled("root", 330, { executionId: "child" }),
      settled("root.flow", 340, { executionId: "native" })
    ]
    expect(GatewayProjection.nodeDurations(events, Diagnosis.digest([bound("native")]))).toEqual([
      { actionTag: "build", durationMs: 240 }
    ])
  })

  it("keeps every root when two bindings disagree about which one is native", () => {
    const events = [
      bound("native"),
      bound("other"),
      scheduled("root", 100, { executionId: "native" }),
      settled("root", 340, { executionId: "native" })
    ]
    expect(GatewayProjection.nodeDurations(events)).toEqual([{ actionTag: "build", durationMs: 240 }])
  })

  it("ignores every envelope that is not a decodable node record", () => {
    const decodable = record("flows.engine.node-scheduled", { nodeId: "compile", kind: "step", attempt: 1 }, 100)
    const malformed = [
      event("control.agent.turn-opened", { seat: "opus" }),
      event("control.engine.event", "not an envelope"),
      event("control.engine.event", null),
      { ...decodable, payload: { ...decodable.payload as object, version: 2 } },
      { ...decodable, payload: { ...decodable.payload as object, executionId: 7 } },
      { ...decodable, payload: { ...decodable.payload as object, emittedAtMs: "soon" } },
      { ...decodable, payload: { ...decodable.payload as object, emittedAtMs: Number.NaN } },
      { ...decodable, payload: { ...decodable.payload as object, eventType: "flows.engine.node-reconciled" } },
      { ...decodable, payload: { ...decodable.payload as object, payload: { kind: "step", attempt: 1 } } },
      record("flows.engine.node-settled", { nodeId: "compile", outcome: "invented", attempts: 1 }, 340)
    ] as ReadonlyArray<ControlSchema.ControlEvent>

    expect(GatewayProjection.nodeDurations(malformed)).toEqual([])
    expect(GatewayProjection.nodeDurations([...malformed, decodable, settled("compile", 340)]))
      .toEqual([{ actionTag: "build", durationMs: 240 }])
  })
})

describe("GatewayProjection.flowDurations", () => {
  const samples = (actionTag: string, ...durations: ReadonlyArray<number>) =>
    durations.map((durationMs) => ({ actionTag, durationMs }))

  it("answers nothing for a flow that never ran", () => {
    expect(GatewayProjection.flowDurations("deploy", [])).toEqual([])
  })

  it("ranks each tag's samples nearest-rank, one row per tag", () => {
    const rows = GatewayProjection.flowDurations("deploy", [
      ...samples("build", 400, 100, 300, 200),
      ...samples("assay", 50)
    ])

    expect(rows).toEqual([
      { flowId: "deploy", actionTag: "assay", samples: 1, p50Ms: 50, p90Ms: 50 },
      { flowId: "deploy", actionTag: "build", samples: 4, p50Ms: 200, p90Ms: 400 }
    ])
  })

  it("ranks ten samples at the exact nearest-rank positions", () => {
    const rows = GatewayProjection.flowDurations("deploy", samples("build", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10))
    expect(rows).toEqual([{ flowId: "deploy", actionTag: "build", samples: 10, p50Ms: 5, p90Ms: 9 }])
  })
})
