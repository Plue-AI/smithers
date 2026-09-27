import { approvalQuestionKey } from "../cards/ApprovalQuestion"
import { describe, expect, test } from "bun:test"
import type { RunSummaryRow, ApprovalRow, TranscriptRow } from "@smthrs/gateway/GatewayProjection"
import type { ProjectionCursor } from "@smthrs/gateway/GatewaySchema"
import type { ControlEvent } from "@smthrs/control/ControlSchema"
import type { Card } from "./AppState"
import { createAppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"
import { emptyAppProjection, projectAppEvent, seedAppProjection } from "./AppProjection"
import { canonicalEventValue } from "./EventValue"
import {
  RuntimeRunSchema, RuntimeApprovalSchema, RuntimeProjectionIntegrityError,
  observeRuntimeRun, observedRuntimeApproval, submitRuntimeApproval, runtimeRunKey,
  projectRuntimeCard, snapshotRuntimeCard, changedRuntimeRunObservation, RuntimeRunObservationSchema
} from "./RuntimeProjection"

const scope = { repo: "owner/repo", workspaceId: "83e75ae5-0920-4000-8000-000000000001", runId: "run" }
const summary = (status: RunSummaryRow["status"] = "running"): RunSummaryRow => ({
  runId: scope.runId, flowId: "test", status, createdAt: 1, updatedAt: 10, turns: 1, calls: 2, callsFailed: 0,
  editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0, verdict: status, diagnosis: status
})
const cursor = (projection: "run-events" | "run-summary" | "transcript", value: number, offset = 0): ProjectionCursor => ({
  selector: { _tag: projection, runId: scope.runId }, projection, runId: scope.runId, value, offset
})
const event = (sequence: number, value = "fact"): ControlEvent => ({ sequence, kind: "control.signal.delivered", runId: scope.runId, occurredAt: sequence, payload: { value } })
const gate = (status: ApprovalRow["status"] = "pending"): ApprovalRow => ({
  runId: scope.runId, requestId: "gate", requestedAt: 1, title: "Deploy?", request: {}, status,
  payload: { target: { _tag: "Node", runId: scope.runId, requestId: "gate", digest: "reviewed", envelope: { capabilities: [], flows: [], budget: {} } }, scope: "once", idempotencyKey: "gate" }
})
const trace: Extract<Card, { kind: "run-trace" }> = { id: "trace", kind: "run-trace", title: "Test", createdAt: 1, ordinal: 1, status: "active",
  payload: { ...scope, workflow: "test", phase: "running", steps: [], result: null, lastSeq: 0 } }
const approval: Extract<Card, { kind: "approval" }> = { id: "approval", kind: "approval", title: "Deploy?", createdAt: 1, ordinal: 2, status: "active",
  payload: { ...scope, requestId: "gate", capability: "Deploy?", approval: gate().payload as Record<string, unknown> } }
const transcript = (text: string): TranscriptRow => ({ runId: scope.runId, sequence: 2, turn: 1, at: 3, kind: "call", text, callId: "call-a" })

describe("normalized runtime observations", () => {
  test("validated full reads reduce to exact transcript and journal suffixes and replay equally", () => {
    const initial = { scope, summary: summary(), transcript: [transcript("one")], transcriptCursor: cursor("transcript", 2),
      journal: { mode: "full" as const, events: [event(0), event(2)] } }
    const prior = observeRuntimeRun(undefined, initial, 10, 1)
    expect(changedRuntimeRunObservation(prior, initial, 11)).toBeUndefined()
    const full = { ...initial, transcript: [...initial.transcript, transcript("two")], transcriptCursor: cursor("transcript", 3),
      journal: { mode: "full" as const, events: [...initial.journal.events, event(2, "offset")] } }
    const reduced = changedRuntimeRunObservation(prior, full, 12)!
    expect(reduced.transcript).toEqual([transcript("two")])
    expect(reduced.transcriptAfter).toEqual({ length: 1, cursor: cursor("transcript", 2) })
    expect(reduced.journal).toEqual({ mode: "suffix", after: cursor("run-events", 2), events: [event(2, "offset")] })
    expect(RuntimeRunObservationSchema.safeParse(reduced).success).toBe(true)
    expect(observeRuntimeRun(prior, reduced, 12, 2)).toEqual(observeRuntimeRun(prior, full, 12, 2))
    expect(changedRuntimeRunObservation(observeRuntimeRun(prior, reduced, 12, 2), full, 13)).toBeUndefined()
  })

  test("transcript suffixes require the exact applied length, cursor, and scope", () => {
    const prior = observeRuntimeRun(undefined, { scope, transcript: [transcript("one")], transcriptCursor: cursor("transcript", 2) }, 10, 1)
    const before = canonicalEventValue(prior)
    for (const after of [
      { length: 0, cursor: prior.transcriptCursor }, { length: 2, cursor: prior.transcriptCursor },
      { length: 1, cursor: cursor("transcript", 1) }, { length: 1 },
      { length: 1, cursor: { ...cursor("transcript", 2), runId: "other" } }
    ]) expect(() => observeRuntimeRun(prior, { scope, transcript: [transcript("two")], transcriptAfter: after }, 11, 2)).toThrow("applied prefix")
    expect(() => observeRuntimeRun(prior, { scope, transcript: [{ ...transcript("foreign"), runId: "other" }], transcriptAfter: { length: 1, cursor: prior.transcriptCursor } }, 11, 2)).toThrow("Foreign")
    expect(RuntimeRunObservationSchema.safeParse({ scope, summary: summary(), transcriptAfter: { length: 1 } }).success).toBe(false)
    expect(canonicalEventValue(prior)).toBe(before)
    const replaced = observeRuntimeRun(prior, { scope, transcript: [transcript("newer equal-length prefix")], transcriptCursor: cursor("transcript", 3) }, 11, 2)
    expect(() => observeRuntimeRun(replaced, { scope, transcript: [transcript("two")], transcriptAfter: { length: 1, cursor: prior.transcriptCursor } }, 12, 3)).toThrow("applied prefix")
  })

  test("full conflicts validate before omission while newer transcript replacements retain full semantics", () => {
    const initial = { scope, summary: summary(), transcript: [transcript("one")], transcriptCursor: cursor("transcript", 2),
      journal: { mode: "full" as const, events: [event(0)] } }
    const prior = observeRuntimeRun(undefined, initial, 10, 1)
    expect(() => changedRuntimeRunObservation(prior, { ...initial, journal: { mode: "full", events: [event(0, "forged")] } }, 11)).toThrow("rewritten")
    expect(() => changedRuntimeRunObservation(prior, { ...initial, transcript: [transcript("replacement")] }, 11)).toThrow("newer projection evidence")
    const replacement = { ...initial, transcript: [transcript("replacement")], transcriptCursor: cursor("transcript", 3) }
    const reduced = changedRuntimeRunObservation(prior, replacement, 12)!
    expect(reduced.transcriptAfter).toBeUndefined()
    expect(reduced.transcript).toEqual(replacement.transcript)
    expect(observeRuntimeRun(prior, reduced, 12, 2)).toEqual(observeRuntimeRun(prior, replacement, 12, 2))
  })

  test("unchanged transcript content can acknowledge a newer cursor without repeating its rows", () => {
    const prior = observeRuntimeRun(undefined, { scope, transcript: [transcript("one")], transcriptCursor: cursor("transcript", 2) }, 10, 1)
    const reduced = changedRuntimeRunObservation(prior, { scope, transcript: prior.transcript, transcriptCursor: cursor("transcript", 3) }, 11)!
    expect(reduced.transcript).toEqual([])
    expect(reduced.transcriptAfter).toEqual({ length: 1, cursor: cursor("transcript", 2) })
    expect(observeRuntimeRun(prior, reduced, 11, 2).transcriptCursor).toEqual(cursor("transcript", 3))
  })

  test("unchanged health evidence records only its derived freshness boundary and observer recovery", () => {
    const row: RunSummaryRow = { ...summary(), statusRollup: {
      subjectId: `run:${scope.runId}`, state: "running", activity: "working", health: "healthy", freshness: "fresh", attention: "none", updatedAt: 1,
      provenance: { checkerId: "test", monitorId: "host", observedAt: 1, expiresAt: 100, evidenceSeq: 1, incarnation: "owner", version: 1 }
    } }
    const observation = { scope, summary: row, journal: { mode: "full" as const, events: [event(1)] } }
    const prior = observeRuntimeRun(undefined, observation, 10, 1)
    expect(changedRuntimeRunObservation(prior, observation, 99)).toBeUndefined()
    const expired = changedRuntimeRunObservation(prior, observation, 100)!
    expect(expired.journal).toBeUndefined()
    const stale = observeRuntimeRun(prior, expired, 100, 2)
    expect(projectRuntimeCard(trace, [stale], [])).toMatchObject({ payload: { phase: "running", statusRollup: { freshness: "stale", activity: "unknown" } } })
    expect(stale.cursor).toEqual(prior.cursor)
    expect(changedRuntimeRunObservation(stale, observation, 101)).toBeUndefined()
    const disconnected = { ...stale, observer: { state: "reconnecting" as const } }
    expect(changedRuntimeRunObservation(disconnected, observation, 102)?.journal).toBeUndefined()
    const recovered = observeRuntimeRun(disconnected, changedRuntimeRunObservation(disconnected, observation, 102)!, 102, 3)
    expect(recovered.observer?.state).toBe("connected")
    expect(recovered.summary).toEqual(row)
  })

  test("accepts legal sequence holes and same-sequence offsets, rejecting rewinds and foreign scopes as a whole", () => {
    const prior = observeRuntimeRun(undefined, { scope, summary: summary(), summaryCursor: cursor("run-summary", 2), journal: { mode: "full", events: [event(0), event(2)] } }, 10, 1)
    const bytes = canonicalEventValue(prior)
    const next = observeRuntimeRun(prior, { scope, journal: { mode: "suffix", after: prior.cursor, events: [event(2, "second")] } }, 11, 2)
    expect(next.events).toEqual([event(0), event(2), event(2, "second")])
    expect(next.cursor).toEqual(cursor("run-events", 2, 1))
    for (const journal of [
      { mode: "full" as const, events: [event(0)] },
      { mode: "full" as const, events: [event(0), event(2, "rewritten")] },
      { mode: "suffix" as const, after: cursor("run-events", 0), events: [event(3)] },
      { mode: "suffix" as const, after: { ...prior.cursor!, runId: "other" }, events: [event(3)] }
    ]) expect(() => observeRuntimeRun(prior, { scope, summary: summary("completed"), summaryCursor: cursor("run-summary", 3), journal }, 12, 3)).toThrow(RuntimeProjectionIntegrityError)
    expect(canonicalEventValue(prior)).toBe(bytes)
    expect(RuntimeRunSchema.safeParse({ ...prior, scope: { ...scope, repo: "other/repo" } }).success).toBe(false)
    expect(RuntimeRunSchema.safeParse({ ...prior, summary: { ...prior.summary!, runId: "other" } }).success).toBe(false)
    expect(RuntimeRunSchema.safeParse({ ...prior, cursor: cursor("run-events", 1) }).success).toBe(false)
  })

  test("equal timestamps do not allow a delayed summary to replace terminal evidence", () => {
    const prior = observeRuntimeRun(undefined, { scope, summary: summary("completed"), summaryCursor: cursor("run-summary", 8) }, 10, 1)
    expect(() => observeRuntimeRun(prior, { scope, summary: summary(), summaryCursor: cursor("run-summary", 7) }, 11, 2)).toThrow("cursor moved backwards")
    expect(() => observeRuntimeRun(prior, { scope, summary: summary(), summaryCursor: cursor("run-summary", 8) }, 11, 2)).toThrow("newer lifecycle evidence")
    const native = { source: "events" as const, rootExecutionId: "root", currentExecutionId: "root", generation: 0, throughSequence: 1 }
    const running = observeRuntimeRun(undefined, { scope, summary: { ...summary(), executionProvenance: native }, summaryCursor: cursor("run-summary", 8) }, 10, 1)
    const completed = observeRuntimeRun(running, { scope, summary: { ...summary("completed"), executionProvenance: { ...native, throughSequence: 3 } }, summaryCursor: cursor("run-summary", 8) }, 11, 2)
    expect(completed.summary?.status).toBe("completed")
    expect(() => observeRuntimeRun({ ...running, scope: { ...scope, repo: "foreign" } }, { scope, summary: summary() }, 12, 3)).toThrow("scope")
  })

  test("a newer transcript snapshot may upgrade telemetry; stale and same-cursor rewrites cannot", () => {
    const prior = observeRuntimeRun(undefined, { scope, transcript: [transcript("legacy")], transcriptCursor: cursor("transcript", 5) }, 10, 1)
    for (const value of [4, 5]) expect(() => observeRuntimeRun(prior, { scope, transcript: [transcript("native")], transcriptCursor: cursor("transcript", value) }, 11, 2)).toThrow(RuntimeProjectionIntegrityError)
    const next = observeRuntimeRun(prior, { scope, transcript: [transcript("native")], transcriptCursor: cursor("transcript", 6) }, 11, 2)
    expect(next.transcript).toEqual([transcript("native")])
    expect(() => observeRuntimeRun(next, { scope, transcript: [], transcriptCursor: cursor("transcript", 5) }, 12, 3)).toThrow(RuntimeProjectionIntegrityError)
  })

  test("approval observations and decision settlements bind exact gates and pending submission IDs", () => {
    const pending = observedRuntimeApproval(undefined, scope, gate(), 10, 1)
    const submitting = submitRuntimeApproval(pending, { id: pending.id, submissionId: "first", state: "pending" }, 11, 2)
    expect(submitRuntimeApproval(submitting, { id: pending.id, submissionId: "second", state: "pending" }, 12, 3)).toBe(submitting)
    expect(submitRuntimeApproval(submitting, { id: pending.id, submissionId: "second", state: "approved" }, 12, 3)).toBe(submitting)
    const decided = submitRuntimeApproval(submitting, { id: pending.id, submissionId: "first", state: "approved", decidedAt: 12 }, 12, 3)
    expect(observedRuntimeApproval(decided, scope, gate(), 13, 4)).toBe(decided)
    expect(() => observedRuntimeApproval(decided, scope, gate("denied"), 13, 4)).toThrow("conflict")
    expect(() => observedRuntimeApproval(pending, { ...scope, workspaceId: "other" }, gate(), 13, 4)).toThrow("authority")
    expect(RuntimeApprovalSchema.safeParse({ ...pending, id: "forged" }).success).toBe(false)
    const observed = observedRuntimeApproval(undefined, scope, gate("approved"), 20, 1)
    expect(observed.decidedAt).toBeUndefined()
  })

  test("a confirmed cancellation is settled, while an actual run failure remains an error", () => {
    for (const status of ["cancelled", "failed"] as const) {
      const run = observeRuntimeRun(undefined, { scope, summary: { ...summary(), status } }, 10, 1)
      expect(projectRuntimeCard(trace, [run], [])).toMatchObject({
        status: status === "cancelled" ? "acted" : "error", payload: { phase: status }
      })
    }
  })

  test("current cards join normalized facts while historical cards keep their explicit revision", () => {
    const before = observeRuntimeRun(undefined, { scope, summary: summary() }, 10, 1)
    const frozen = snapshotRuntimeCard(trace, [before], [], 5)
    const after = observeRuntimeRun(before, { scope, summary: { ...summary("completed"), updatedAt: 11 } }, 11, 6)
    expect(projectRuntimeCard(trace, [after], [])).toMatchObject({ status: "acted", payload: { phase: "completed" } })
    expect(projectRuntimeCard(frozen, [after], [])).toBe(frozen)
    expect(frozen).toMatchObject({ runtimeView: { version: 1, revision: 5 }, payload: { phase: "running" } })
    const historicGate = snapshotRuntimeCard(approval, [], [observedRuntimeApproval(undefined, scope, gate(), 10, 1)], 5)
    expect(projectRuntimeCard(historicGate, [], [observedRuntimeApproval(undefined, scope, gate("approved"), 20, 6)])).toBe(historicGate)
    expect(trace.payload.phase).toBe("running")
  })

  test("a completed run shows the output it produced, not the clipped verdict line", () => {
    const output = JSON.stringify({ repo: "owner/repo", job: "issues", reply: { body: "Research issue\nThe greeting is hello.", issueNumber: 42, state: "drafted" } })
    const produced = observeRuntimeRun(undefined, { scope, summary: { ...summary("completed"), verdict: `completed — ${output.slice(0, 100)}`, finalOutput: output } }, 11, 1)
    expect(projectRuntimeCard(trace, [produced], []).payload).toMatchObject({ result: output })
    const silent = observeRuntimeRun(undefined, { scope, summary: summary("completed") }, 11, 1)
    expect(projectRuntimeCard(trace, [silent], []).payload).toMatchObject({ result: "completed" })
  })

  test("a conflicting batch cannot partially update summary, gates, or app revision", () => {
    const seeded = seedAppProjection(emptyAppProjection(), { createdAt: 1, theme: "dark" })
    const state = projectAppEvent(seeded, { transition: { type: "gateway.approvals.observed", actor: "system", scope, rows: [gate("approved")] }, revision: 1, createdAt: 10, persistenceMode: "memory" })
    const bytes = canonicalEventValue(state)
    expect(() => projectAppEvent(state, { transition: { type: "gateway.approvals.observed", actor: "system", scope, rows: [{ ...gate(), requestId: "unrelated" }, gate("denied")] }, revision: 2, createdAt: 11, persistenceMode: "memory" })).toThrow(RuntimeProjectionIntegrityError)
    expect(canonicalEventValue(state)).toBe(bytes)
  })

  test("real store rebuilds shared views and immutable navigation history after reopen", async () => {
    const storage = memoryStorage()
    let store = await createAppStore({ kind: "localStorage", storage })
    await store.dispatch({ type: "card.upsert", actor: "system", card: trace }).isPersisted.promise
    await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: { scope, summary: summary(), summaryCursor: cursor("run-summary", 1), journal: { mode: "full", events: [event(0), event(2)] } } }).isPersisted.promise
    await store.dispatch({ type: "card.navigated", actor: "user", card: { id: trace.id, kind: "file", title: "File", status: "active", ordinal: 1, createdAt: 1, payload: { repo: scope.repo, path: "a.ts", content: "one", truncated: false } } }).isPersisted.promise
    await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: { scope, summary: summary("completed"), summaryCursor: cursor("run-summary", 3) } }).isPersisted.promise
    await store.dispatch({ type: "card.history.moved", actor: "user", id: trace.id, delta: -1 }).isPersisted.promise
    const historical = store.collections.cards.get(trace.id)!
    expect(historical).toMatchObject({ kind: "run-trace", payload: { phase: "running" } })
    expect(historical.runtimeView?.revision).toBeNumber()
    expect(store.collections.runtimeRuns.get(runtimeRunKey(scope))?.summary?.status).toBe("completed")
    await store.verifyState()
    await store.dispose?.()
    store = await createAppStore({ kind: "localStorage", storage })
    expect(store.collections.cards.get(trace.id)).toMatchObject({ runtimeView: historical.runtimeView, payload: { phase: "running" } })
    await store.verifyState()
    await store.dispose?.()
  })
})

test("question replacement retires draft and submission ownership; a late receipt cannot decide the new question", () => {
  const row = { ...gate(), waitRunId: "human-wait", request: { kind: "ask", prompt: "Who?", attempt: 1 } }
  const first = observedRuntimeApproval(undefined, scope, row, 10, 1)
  const seeded = { ...first, answerDraft: { question: approvalQuestionKey(row)!, text: "scheduler" } }
  expect(RuntimeApprovalSchema.safeParse(seeded).success).toBe(true)
  expect(RuntimeApprovalSchema.safeParse({ ...seeded, answerDraft: { question: "f".repeat(64), text: "foreign question" } }).success).toBe(false)
  expect(RuntimeApprovalSchema.safeParse({ ...seeded, row: { ...row, status: "approved" } }).success).toBe(false)
  const pending = submitRuntimeApproval(seeded, { id: first.id, submissionId: "old-answer", state: "pending" }, 11, 2)
  const changed = observedRuntimeApproval(pending, scope, { ...row, request: { ...row.request, prompt: "Which new owner?", attempt: 2 } }, 12, 3)
  expect(changed.answerDraft).toBeUndefined()
  expect(changed.pending).toBeUndefined()
  expect(changed.submissionId).toBeUndefined()
  expect(submitRuntimeApproval(changed, { id: first.id, submissionId: "old-answer", state: "approved", decidedAt: 13 }, 13, 4)).toBe(changed)
  expect(changed.row.status).toBe("pending")
})


test("durable expiry reaches projected run health without changing legacy event replay", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const now = Date.now()
  const health = { subjectId: "run:run", state: "running", activity: "working", health: "healthy", attention: "none", freshness: "fresh", updatedAt: now,
    provenance: { checkerId: "test", monitorId: "test", observedAt: now, expiresAt: now + 60_000, evidenceSeq: 1, incarnation: "test", version: 1 } } as const
  await store.dispatch({ type: "card.upsert", actor: "system", card: trace }).isPersisted.promise
  await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: { scope, summary: { ...summary(), statusRollup: health } } }).isPersisted.promise
  // The original event's meaning is immutable: the fix is opt-in in new facts.
  await store.dispatch({ type: "status.expired", actor: "system", now: now + 60_001 }).isPersisted.promise
  const read = () => store.collections.cards.get("trace") as typeof trace
  expect(read().payload.statusRollup?.freshness).toBe("fresh")
  await store.dispatch({ type: "status.expired", actor: "system", now: now + 60_001, runtime: true }).isPersisted.promise
  expect(read().payload.statusRollup?.freshness).toBe("stale")
  expect(read().payload.statusRollup?.activity).toBe("unknown")
  await store.verifyState()
  await store.dispose?.()
  const reopened = await createAppStore({ kind: "localStorage", storage })
  expect((reopened.collections.cards.get("trace") as typeof trace).payload.statusRollup?.freshness).toBe("stale")
  await reopened.dispose?.()
})
