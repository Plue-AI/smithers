import { createOperationalFailureReporter } from "../OperationalFailures"
import { observeRuntimeRun, projectRuntimeCard, runtimeRunKey, type RuntimeRun } from "../RuntimeProjection"
import { canonicalEventValue } from "../EventValue"
import type { RuntimeRunObservation } from "../RuntimeProjection"
import { expect, test } from "bun:test"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import { createGatewaySeam } from "./gateway"
import { createWorkflowPumpController } from "./workflow-pump"
import { RUN_BOX_GONE } from "../RepoContext"
import { AppEventIntegrityError } from "../AppEventStream"
import type { StatusRollup } from "@smthrs/rpc/Health"
import { readFileSync } from "node:fs"
import { runGraphOfCard } from "../../cards/FlowRunGraph"
import { runCause } from "../RunCause"

const event = (sequence: number) => ({ kind: "control.signal.delivered", sequence, occurredAt: sequence, payload: {} })
const failed = (sequence: number, cause: string) => ({ kind: "control.run.failed", sequence, occurredAt: sequence, payload: { cause } })
const summary = {
  runId: "run-1", flowId: "test", status: "running", createdAt: 1, updatedAt: 100,
  turns: 1, calls: 1, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0,
  inputTokens: 0, outputTokens: 0, verdict: "running", diagnosis: "moving"
}
const cursor = (projection: string, value: number, offset = 0) => ({
  selector: { _tag: projection, runId: "run-1" }, projection, runId: "run-1", value, offset
})
type Cycle = { events: ReturnType<typeof event>[]; revision?: number; journalFailure?: boolean; summaryFailure?: boolean; status?: string; verdict?: string; statusRollup?: StatusRollup; approvals?: unknown[]; stamp?: { failureFault: string; failureTag: string } }
const poll = async (cycles: Cycle[], options: {
  initialEvents?: ReturnType<typeof event>[]
  inspectAt?: number
  cloneStored?: boolean
  pageSize?: number
  pageCursor?: boolean
  failJournalRequest?: number
  initialRun?: RuntimeRun
  resumeOnBoot?: boolean
  flowId?: string
  /** A card recorded before every run named its box, in this phase. */
  boxless?: Extract<Card, { kind: "run-trace" }>["payload"]["phase"]
  /** Receipts this browser fails to save, in dispatch order, before saving the rest. */
  saveFailures?: Array<{ type: string; error: Error }>
  /** Transitions the store refuses synchronously, once each, as `AppStore.dispatch` throws. */
  refusals?: Array<{ type: string; error: Error }>
} = {}) => {
  const flowId = options.flowId ?? summary.flowId
  let card: Extract<Card, { kind: "run-trace" }> = {
    id: "run-card", kind: "run-trace", title: "test", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "o/r", ...(options.boxless === undefined ? { workspaceId: "box-1" } : {}), runId: "run-1", workflow: flowId, phase: options.boxless ?? "running", steps: [], result: null, lastSeq: 0, events: options.initialEvents }
  }
  const cards = new Map([[card.id, card]])
  const scope = { repo: "o/r", runId: "run-1", ...(options.boxless === undefined ? { workspaceId: "box-1" } : {}) }, key = runtimeRunKey(scope)
  const runtimeRuns = new Map<string, RuntimeRun>()
  if (options.initialRun) {
    runtimeRuns.set(key, options.initialRun)
    card = projectRuntimeCard(card, [options.initialRun], []) as typeof card
    cards.set(card.id, card)
  } else if (options.initialEvents) runtimeRuns.set(key, observeRuntimeRun(undefined, {
    scope, journal: { mode: "full", events: options.initialEvents }
  }, Date.now(), 0))
  let iteration = -1
  let rowsRequested = 0
  let eventRequests = 0
  const journalRequests: unknown[] = []
  const updates: typeof card[] = []
  const messages: string[] = []
  const dispatched: string[] = []
  const gateway = createGatewaySeam({
    baseUrl: "https://test", errorMessageOf: async (_, fallback) => fallback, bindingFor: () => ({ workspaceId: "box-1" }),
    fetch: async (_, init) => {
      const { payload } = JSON.parse(String(init?.body))
      const projection = payload.selector._tag
      if (projection === "run-summary") iteration++
      const cycle = cycles[iteration]!
      if (projection === "run-events") eventRequests++
      if ((projection === "run-events" && (cycle.journalFailure || eventRequests === options.failJournalRequest)) || (projection === "run-summary" && cycle.summaryFailure)) {
        if (projection === "run-events") journalRequests.push(payload.after)
        return Response.json({ ok: false, error: { message: "offline" } })
      }
      if (projection === "approvals") return Response.json({ ok: true, payload: { rows: cycle.approvals ?? [] } })
      let rows: unknown[] = [{ ...summary, flowId, updatedAt: cycle.status === undefined ? summary.updatedAt : summary.updatedAt + iteration + 1, status: cycle.status ?? "running", verdict: cycle.verdict ?? summary.verdict, statusRollup: cycle.statusRollup, ...cycle.stamp }]
      if (projection === "run-events") {
        journalRequests.push(payload.after)
        let offset = 0
        rows = cycle.events.filter((row, i) => {
          offset = i > 0 && cycle.events[i - 1]!.sequence === row.sequence ? offset + 1 : 0
          return payload.after === undefined || row.sequence > payload.after.value ||
            (row.sequence === payload.after.value && offset > payload.after.offset)
        })
        if (options.pageSize !== undefined) rows = rows.slice(0, options.pageSize)
        rowsRequested += rows.length
        if (options.inspectAt === iteration) {
          runtimeRuns.set(key, observeRuntimeRun(runtimeRuns.get(key), { scope, journal: { mode: "full", events: cycle.events } }, Date.now(), iteration + 1))
          card = projectRuntimeCard(card, [...runtimeRuns.values()], []) as typeof card
          cards.set(card.id, card)
        }
      }
      const last = options.pageCursor && projection === "run-events" ? (rows as ReturnType<typeof event>[]).at(-1) : cycle.events.at(-1)
      const offset = last === undefined ? 0 : cycle.events.findIndex((row) => row === last) - cycle.events.findIndex((row) => row.sequence === last.sequence)
      return Response.json({ ok: true, payload: {
        rows, ...(options.pageCursor && projection === "run-events" && last !== undefined
          ? { cursor: cursor(projection, last.sequence, offset) }
          : cycle.revision === undefined ? {} : { cursor: cursor(projection, cycle.revision, offset) })
      } })
    }
  })
  const ctx = {
    failures: createOperationalFailureReporter(),
    resumeFlowAuthoring: () => {},
    store: { committedRuntimeRun: (id: string) => runtimeRuns.get(id), committedRuntimeApproval: () => undefined, approvalRequest: () => undefined, collections: { cards, runtimeRuns, runtimeApprovals: new Map() }, dispatch: (action: any) => {
      const refused = options.saveFailures?.[0]?.type === action.type ? options.saveFailures!.shift()!.error : undefined
      if (refused !== undefined) return { isPersisted: { promise: Promise.reject(refused) } }
      const thrown = options.refusals?.findIndex((refusal) => refusal.type === action.type) ?? -1
      if (thrown >= 0) throw options.refusals!.splice(thrown, 1)[0]!.error
      dispatched.push(action.type)
      if (action.type === "message.appended") messages.push(action.text)
      const previous = runtimeRuns.get(key)
      let next = previous
      if (action.type === "gateway.run.observed") next = observeRuntimeRun(previous, action.observation as RuntimeRunObservation, Date.now(), iteration + 1)
      if (action.type === "gateway.run.observer.changed" && canonicalEventValue(previous?.observer) !== canonicalEventValue(action.observer)) {
        next = { ...(previous ?? { id: key, scope, events: [], steps: [], revision: 0 }), observer: action.observer, observedAt: Date.now() }
      }
      if (next !== undefined && next !== previous) {
        runtimeRuns.set(key, options.cloneStored ? structuredClone(next) : next)
        card = projectRuntimeCard(card, [...runtimeRuns.values()], []) as typeof card
        cards.set(card.id, card)
        updates.push(card)
      }
      return { isPersisted: { promise: Promise.resolve() } }
    } },
    gateway, runPumps: new Map<string, { stopped: boolean }>(), pumpPokes: new Map<string, () => void>(),
    workflowPollMs: 1, services: {},
    unref: (timer: ReturnType<typeof setTimeout>) => {
      clearTimeout(timer)
      queueMicrotask(() => {
        if (iteration === cycles.length - 1) for (const pump of ctx.runPumps.values()) pump.stopped = true
        ctx.pumpPokes.get(card.id)?.()
      })
    }
  }
  const pump = createWorkflowPumpController(ctx as unknown as ControllerContext, () => 1)
  if (options.resumeOnBoot) {
    pump.resumeWorkflowRuns()
    for (let tick = 0; tick < 100 && (iteration < 0 || ctx.runPumps.size > 0); tick++) await Bun.sleep(1)
  } else await pump.pumpWorkflowRun(card.id)
  return { card, run: runtimeRuns.get(key), updates, rowsRequested, journalRequests, messages, dispatched, failures: ctx.failures.recent(), runPumps: ctx.runPumps }
}

const notSaved = "This browser did not save the run's latest evidence. Retrying."
test.each([
  ["a storage failure", new Error("disk I/O error")],
  ["a conflict behind another failed write", new AppEventIntegrityError("conflict")]
])("%s saving the run's evidence reconnects and retries from the same cursor", async (_, error) => {
  const events = [event(1)]
  const result = await poll([{ events, revision: 1 }, { events, revision: 1 }, { events, revision: 1 }],
    { saveFailures: [{ type: "gateway.run.observed", error }] })
  expect(result.updates.map((card) => [card.payload.phase, card.payload.observationError])).toEqual([
    ["reconnecting", notSaved], ["running", undefined]
  ])
  expect(result.journalRequests).toEqual([undefined, undefined])
  expect(result.card.payload.events).toEqual(events)
})

test.each([
  ["the reconnecting receipt", "gateway.run.observer.changed", "stopped", [{ events: [], summaryFailure: true }, { events: [], summaryFailure: true }, { events: [] }]],
  ["the settled run's transcript line", "message.appended", "completed", [{ events: [event(1)], revision: 1, status: "completed", verdict: "done" }]]
] as const)("a store refusing %s stops watching with the reason instead of rejecting into its caller", async (_, type, phase, cycles) => {
  const result = await poll(cycles.map((cycle) => ({ ...cycle, events: [...cycle.events] })),
    { refusals: [{ type, error: new Error("The app state owner is closed.") }] })
  expect([result.card.payload.phase, result.card.payload.observationError]).toEqual([phase, "This browser did not save the run's latest evidence."])
  expect(result.runPumps.size).toBe(0)
  expect(result.failures).toEqual([expect.objectContaining({ seam: "run.pump", subject: "run-card" })])
})

test("an approval receipt this browser fails to save is retried until the gate is in hand", async () => {
  const gate = { runId: "run-1", requestId: "gate", requestedAt: 1, title: "Deploy?", request: {}, status: "pending",
    payload: { target: { _tag: "Node", runId: "run-1", requestId: "gate", digest: "reviewed",
      envelope: { capabilities: [], flows: [], budget: {} } }, scope: "once", idempotencyKey: "gate" } }
  const waiting = { events: [], revision: 1, status: "waiting-approval", approvals: [gate] }
  const result = await poll([waiting, waiting, waiting],
    { saveFailures: [{ type: "gateway.approvals.observed", error: new Error("disk I/O error") }] })
  // Each waiting summary carries a later `updatedAt`, so every saved cycle is a new receipt.
  expect(result.updates.map((card) => [card.payload.phase, card.payload.observationError])).toEqual([
    ["reconnecting", notSaved], ["waiting-approval", undefined], ["waiting-approval", undefined]
  ])
  // The refused receipt is never counted; the retry saves it and raises the gate's card.
  expect(result.dispatched.slice(0, 4)).toEqual([
    "gateway.run.observer.changed", "gateway.approvals.observed", "card.upsert", "gateway.run.observed"
  ])
})

test("an approval row naming another gate stops watching and keeps the verified evidence", async () => {
  const forged = { runId: "run-1", requestId: "gate", requestedAt: 1, title: "Deploy?", request: {}, status: "pending",
    payload: { target: { _tag: "Node", runId: "run-1", requestId: "other", digest: "reviewed",
      envelope: { capabilities: [], flows: [], budget: {} } }, scope: "once", idempotencyKey: "gate" } }
  const result = await poll([{ events: [], revision: 1, status: "waiting-approval", approvals: [forged] }, { events: [], revision: 1 }])
  expect(result.updates.map((card) => [card.payload.phase, card.payload.observationError])).toEqual([
    ["stopped", "The workspace returned conflicting recorded history. The last verified evidence was preserved."]
  ])
  expect(result.dispatched).not.toContain("card.upsert")
})

test("a failed run keeps raw evidence on its card and announces only typed human copy", async () => {
  const raw = "failed — Error: Error: git exited 1"
  const result = await poll([{ events: [], status: "failed", verdict: raw }])
  expect(result.card.payload.error).toBe(raw)
  expect(result.messages.join(" ")).toContain("Not your fault")
  expect(result.messages.join(" ")).not.toContain(raw)
})

test("a stamped failure reaches the card through the run row and is transcribed in its own words", async () => {
  const stamp = { failureFault: "dependency", failureTag: "flows/model/ModelError/transport" }
  const result = await poll([{ events: [], status: "failed", verdict: "failed — transport: socket closed", stamp }])
  expect(result.card.payload.failure).toEqual({ class: "dependency", tag: "flows/model/ModelError/transport" })
  expect(result.messages).toEqual([`The run failed: ${runCause("flows/model/ModelError/transport")}`])
})

test("a settled registrar refusal is transcribed as the sentence the card leads with", async () => {
  const refusal = 'Add a model to "nightly-lint" to schedule it.'
  const verdict = `failed — invalid_receipt: ${refusal}`
  const cause = `invalid_receipt: ${refusal}\n    at repository/trigger (flows/repository/triggers.ts:20:11)`
  const result = await poll([{ events: [failed(1, cause)], revision: 1, status: "failed", verdict }], { flowId: "repository/trigger" })
  expect(result.card.payload.error).toBe(verdict)
  expect(result.messages).toEqual([`The run failed: ${refusal}`])
})

test("a settled setup refusal is transcribed as the sentence the person has to answer", async () => {
  const refusal = "Run evals for this exact candidate before continuing"
  const verdict = `failed — invalid_receipt: ${refusal}`
  const cause = `invalid_receipt: ${refusal}\n    at repository/Setup (flows/repository/receipts.ts:109)`
  const result = await poll([{ events: [failed(1, cause)], revision: 1, status: "failed", verdict }], { flowId: "repository/setup" })
  expect(result.card.payload.error).toBe(verdict)
  expect(result.messages).toEqual([`The run failed: ${refusal}`])
})

test("another flow's invalid_receipt is still Smithers' in the transcript", async () => {
  const verdict = "failed — invalid_receipt: Native source creation returned an invalid receipt"
  const result = await poll([{ events: [failed(1, verdict.slice("failed — ".length))], revision: 1, status: "failed", verdict }], { flowId: "coding/request" })
  expect(result.card.payload.error).toBe(verdict)
  expect(result.messages.join(" ")).toContain("Not your fault")
})

test("four unchanged iterations read and dispatch a 20,000-row journal only once", async () => {
  const events = Array.from({ length: 20_000 }, (_, i) => event(i + 1))
  const result = await poll(Array.from({ length: 4 }, () => ({ events, revision: 20_000 })))
  expect(result.rowsRequested).toBe(20_000)
  // One call reads the page and a second confirms it was the whole suffix,
  // because a full-looking page means there may be another. The other three
  // iterations read nothing at all.
  expect(result.journalRequests).toHaveLength(2)
  expect(result.updates).toHaveLength(1)
  expect(result.card.payload.events).toHaveLength(20_000)
})
test("a completed run drains a gateway-capped 17,000-event journal over bounded cycles", async () => {
  const events = Array.from({ length: 17_000 }, (_, i) => event(i + 1))
  const result = await poll(Array.from({ length: 2 }, () => ({ events, revision: 17_000, status: "completed", verdict: "done" })),
    { pageSize: 1_000, pageCursor: true })
  expect(result.journalRequests).toHaveLength(18)
  expect(result.journalRequests[16]).toEqual(cursor("run-events", 16_000))
  expect(result.card.payload.phase).toBe("completed")
  expect(result.card.payload.events).toEqual(events)
  expect(result.run?.journalPending).toBe(false)
  expect(result.messages).toEqual(["done"])
})

test("a terminal run retries a later-page gateway failure without losing its prefix", async () => {
  const events = Array.from({ length: 17_000 }, (_, i) => event(i + 1))
  const result = await poll(Array.from({ length: 3 }, () => ({ events, revision: 17_000, status: "completed", verdict: "done" })),
    { pageSize: 1_000, pageCursor: true, failJournalRequest: 17 })
  expect(result.journalRequests).toHaveLength(19)
  expect(result.journalRequests[16]).toEqual(cursor("run-events", 16_000))
  expect(result.journalRequests[17]).toEqual(cursor("run-events", 16_000))
  expect(result.card.payload.events).toEqual(events)
  expect(result.run?.journalPending).toBe(false)
})

test("boot resumes a terminal card whose persisted journal has more pages", async () => {
  const events = Array.from({ length: 17_000 }, (_, i) => event(i + 1))
  const first = await poll([{ events, revision: 17_000, status: "completed", verdict: "done" }],
    { pageSize: 1_000, pageCursor: true })
  expect(first.card.payload.events).toHaveLength(16_000)
  expect(first.run?.journalPending).toBe(true)
  const resumed = await poll([{ events, revision: 17_000, status: "completed", verdict: "done" }],
    { pageSize: 1_000, pageCursor: true, initialRun: first.run, resumeOnBoot: true })
  expect(resumed.journalRequests[0]).toEqual(cursor("run-events", 16_000))
  expect(resumed.card.payload.events).toEqual(events)
  expect(resumed.run?.journalPending).toBe(false)
})
test("only new rows append, including distinct events sharing a sequence", async () => {
  const first = [event(1)]
  const second = [...first, event(1)]
  const third = [...second, event(2)]
  const result = await poll([
    { events: first, revision: 1 }, { events: second, revision: 1 },
    { events: third, revision: 2 }, { events: third, revision: 2 }
  ])
  expect(result.rowsRequested).toBe(3)
  expect(result.journalRequests).toEqual([undefined, cursor("run-events", 1), cursor("run-events", 1, 1)])
  expect(result.updates).toHaveLength(3)
  expect(result.card.payload.events).toEqual(third)
  expect(result.updates[0]!.payload.events![0]).toBe(result.card.payload.events![0])
  expect(result.updates[0]!.payload.events).toHaveLength(1)
})
test("without revisions polling still requests only the suffix and skips unchanged dispatches", async () => {
  const events = [event(1), event(2)]
  const result = await poll(Array.from({ length: 4 }, () => ({ events })))
  expect(result.rowsRequested).toBe(2)
  expect(result.journalRequests).toEqual([undefined, cursor("run-events", 2), cursor("run-events", 2), cursor("run-events", 2)])
  expect(result.updates).toHaveLength(1)
})
test("a full page without cursor metadata advances from recorded event positions", async () => {
  const events = Array.from({ length: 600 }, (_, index) => event(index))
  const result = await poll([{ events }, { events }], { pageSize: 256 })
  expect(result.journalRequests).toEqual([
    undefined, cursor("run-events", 255), cursor("run-events", 511), cursor("run-events", 599)
  ])
  expect(result.rowsRequested).toBe(600)
  expect(result.card.payload.events).toEqual(events)
  expect(result.updates).toHaveLength(1)
})
test("cursor-free pages keep duplicate-sequence offsets across page boundaries", async () => {
  const events = Array.from({ length: 600 }, () => event(0))
  const result = await poll([{ events }, { events }], { pageSize: 256 })
  expect(result.journalRequests).toEqual([
    undefined, cursor("run-events", 0, 255), cursor("run-events", 0, 511), cursor("run-events", 0, 599)
  ])
  expect(result.rowsRequested).toBe(600)
  expect(result.card.payload.events).toEqual(events)
  expect(result.updates).toHaveLength(1)
})
test("a failed journal read is retried at the same revision without losing the prefix", async () => {
  const first = [event(1)]
  const events = [...first, event(2)]
  const result = await poll([
    { events: first, revision: 1 }, { events, revision: 2, journalFailure: true },
    { events, revision: 2 }, { events, revision: 2 }
  ])
  expect(result.rowsRequested).toBe(2)
  expect(result.journalRequests).toHaveLength(3)
  expect(result.card.payload.events).toEqual(events)
})
test("unchanged journal revisions still recover reconnecting cards and render terminal status", async () => {
  const events = [event(1)]
  const result = await poll([
    { events, revision: 1 }, { events, revision: 1, summaryFailure: true },
    { events, revision: 1, summaryFailure: true }, { events, revision: 1 },
    { events, revision: 1, status: "completed" }
  ])
  expect(result.updates.map((card) => card.payload.phase)).toEqual(["running", "reconnecting", "running", "completed"])
  expect(result.rowsRequested).toBe(1)
  expect(result.card.status).toBe("acted")
})

test("a resumed pump starts after the journal already retained on the card", async () => {
  const initialEvents = [event(0), event(0)]
  const events = [...initialEvents, event(1)]
  const result = await poll([{ events, revision: 1 }], { initialEvents })
  expect(result.journalRequests).toEqual([cursor("run-events", 0, 1)])
  expect(result.rowsRequested).toBe(1)
  expect(result.card.payload.events).toEqual(events)
  expect(result.card.payload.events![0]).toEqual(initialEvents[0])
})

test("a full inspection arriving during a suffix read does not duplicate events", async () => {
  const initialEvents = [event(1)]
  const events = [...initialEvents, event(2)]
  const result = await poll([{ events, revision: 2 }, { events, revision: 2 }], { initialEvents, inspectAt: 0 })
  expect(result.card.payload.events).toEqual(events)
  expect(result.journalRequests).toEqual([cursor("run-events", 1), cursor("run-events", 2)])
})

test("store validation copying a payload does not invalidate its journal revision", async () => {
  const events = [event(1)]
  const result = await poll(Array.from({ length: 4 }, () => ({ events, revision: 1 })), { cloneStored: true })
  expect(result.journalRequests).toHaveLength(1)
  expect(result.updates).toHaveLength(1)
})

test("an empty journal does not hide its first sequence-zero event at the same cursor", async () => {
  const events = [event(0)]
  const result = await poll([{ events: [], revision: 0 }, { events, revision: 0 }, { events, revision: 0 }])
  expect(result.journalRequests).toEqual([undefined, undefined])
  expect(result.rowsRequested).toBe(1)
  expect(result.card.payload.events).toEqual(events)
})

test("run health uses the existing summary projection, expires old working and refuses another run or lifecycle", async () => {
  const now = Date.now()
  const statusRollup: StatusRollup = { subjectId: "run:run-1", state: "running", activity: "working", health: "healthy",
    freshness: "fresh", attention: "none", updatedAt: now,
    provenance: { checkerId: "test", monitorId: "host", observedAt: now - 100, expiresAt: now - 1,
      evidenceSeq: 1, incarnation: "owner", version: 2 } }
  const expired = await poll([{ events: [], revision: 1, statusRollup }])
  expect(expired.card.payload.statusRollup).toMatchObject({ freshness: "stale", activity: "unknown", health: "unknown" })
  expect(expired.card.payload.phase).toBe("running")
  expect((await poll([{ events: [], statusRollup: { ...statusRollup, subjectId: "run:other" } }])).card.payload.statusRollup).toBeUndefined()
  expect((await poll([{ events: [], statusRollup: { ...statusRollup, state: "completed" } }])).card.payload.statusRollup).toBeUndefined()
  const terminal = await poll([{ events: [], status: "failed", statusRollup: { ...statusRollup, state: "failed", health: "failing" } }])
  expect(terminal.card.payload.statusRollup?.health).toBe("failing")
  expect(terminal.card.payload.phase).toBe("failed")
})

/*
 * The graph the run card draws is folded from the same journal this pump
 * appends to, so a node's state moves when a page lands and not before. The
 * rows are the recorded ones (cards/fixtures/GraphRunJournal.json), cut at the
 * point the engine scheduled a node and again at the point it settled it.
 */
const RECORDED: {
  readonly flow: string
  readonly rows: ReadonlyArray<{ kind: string; sequence: number; occurredAt: number; payload: Record<string, unknown> }>
} = JSON.parse(readFileSync(new URL("../../cards/fixtures/GraphRunJournal.json", import.meta.url), "utf8"))

const FLOW = RECORDED.flow

const NODE = "root.flow.then.map.all.steady"
const engineRows = RECORDED.rows.map((row) => ({
  kind: row.kind,
  sequence: row.sequence,
  occurredAt: row.occurredAt,
  payload: row.payload
}))
const through = (eventType: string): ReturnType<typeof event>[] => {
  const index = engineRows.findIndex((row) =>
    row.kind === "control.engine.event" &&
    (row.payload as { eventType?: string; payload?: { nodeId?: string } }).eventType === eventType &&
    (row.payload as { payload?: { nodeId?: string } }).payload?.nodeId === NODE
  )
  if (index < 0) throw new Error(`the recording has no ${eventType} for ${NODE}`)
  return engineRows.slice(0, index + 1) as unknown as ReturnType<typeof event>[]
}

test("two pump cycles move a recorded node from running to settled", async () => {
  const scheduled = through("flows.engine.node-scheduled")
  const settled = through("flows.engine.node-settled")
  const first = await poll([{ events: scheduled, revision: scheduled.at(-1)!.sequence }], { flowId: FLOW })
  expect(runGraphOfCard(first.card)?.status.get(NODE)).toMatchObject({ status: "running", attempts: 1 })

  const second = await poll([
    { events: scheduled, revision: scheduled.at(-1)!.sequence },
    { events: settled, revision: settled.at(-1)!.sequence }
  ], { flowId: FLOW })
  expect(runGraphOfCard(second.card)?.status.get(NODE)).toMatchObject({ status: "settled", outcome: "built" })
  // The second cycle asked for the suffix, not the whole journal again.
  expect(second.journalRequests.at(-1)).toMatchObject({ value: scheduled.at(-1)!.sequence })
})

test("a page that repeats rows the card already holds changes no node's state", async () => {
  const settled = through("flows.engine.node-settled")
  const once = await poll([{ events: settled, revision: settled.at(-1)!.sequence }], { flowId: FLOW })
  const twice = await poll([
    { events: settled, revision: settled.at(-1)!.sequence },
    { events: settled, revision: settled.at(-1)!.sequence }
  ], { flowId: FLOW })
  const stateOf = (card: typeof once.card) =>
    [...runGraphOfCard(card)?.status ?? []].map(([id, run]) => [id, run.status, run.outcome])
  expect(stateOf(twice.card)).toEqual(stateOf(once.card))
})

test("boot keeps an old completed box-less card's verdict while its engine evidence is pending", async () => {
  const started = { sequence: 1, kind: "control.engine.projection-started", occurredAt: 1, payload: { version: 1, executionId: "native", generation: 0 } }
  for (const phase of ["completed", "running"] as const) {
    const result = await poll([], { boxless: phase, initialEvents: [started], resumeOnBoot: true })
    expect(result.journalRequests).toEqual([])
    expect(result.run?.observer).toEqual(phase === "completed" ? { state: "connected", error: RUN_BOX_GONE } : { state: "stopped", error: RUN_BOX_GONE })
    expect(result.card.payload.phase).toBe(phase === "completed" ? "completed" : "stopped")
  }
})
