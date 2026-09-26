import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ControlEvent } from "@smthrs/control/ControlSchema"
import type { ApprovalRow, RunSummaryRow, TranscriptRow } from "@smthrs/gateway/GatewayProjection"
import { createAppStore, PERSISTED_COLLECTION_SPECS, type AppStore } from "./AppStore"
import type { Card } from "./AppState"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { openSqliteRowStorage, ROW_TABLE_NAME } from "../chain/SqliteRowStorage"
import { decodeEventValue } from "./EventValue"
import { runtimeRunKey, type RuntimeRunObservation } from "./RuntimeProjection"
import { createControllerContext, type ControllerContext } from "./controller/context"
import { createWorkflowPumpController } from "./controller/workflow-pump"
import { reconcileRunApprovals } from "./controller/approval-reconciliation"
import { unavailableAgent } from "./TestFixtures"
import * as Y from "yjs"
import { encodeWikiState, wikiDocumentId } from "../wiki/CloudWiki"
import { createCloudWikiController } from "./controller/cloud-wiki"

// Accepted commands remain immutable facts. Idle transport reads must never
// manufacture those facts; diagnostic truncation cannot bound the event stream.
const stores: AppStore[] = [], contexts: ControllerContext[] = []
const directories: string[] = []
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.dispose()
  for (const store of stores.splice(0)) await store.dispose?.()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const open = async (path?: string) => {
  if (path === undefined) {
    const directory = mkdtempSync(join(tmpdir(), "smithers-journal-growth-"))
    directories.push(directory)
    path = join(directory, "state.sqlite")
  }
  const db = new Database(path)
  let writes = 0
  let held: { enter(): void; wait: Promise<void> } | undefined
  const pauseNextWrite = () => {
    let enter!: () => void, release!: () => void, fail!: (error: Error) => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const wait = new Promise<void>((resolve, reject) => { release = resolve; fail = reject })
    held = { enter, wait }
    return { entered, release, fail }
  }
  const adapter = await openSqliteRowStorage({
    execute: async <Row>(sql: string, params: ReadonlyArray<unknown> = []) => {
      if (held !== undefined && /^\s*INSERT INTO/i.test(sql) && sql.includes(ROW_TABLE_NAME)) {
        const pause = held; held = undefined; pause.enter(); await pause.wait
      }
      const statement = db.query(sql)
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<Row>
      statement.run(...params as [])
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) writes++
      return []
    }, close: () => db.close()
  }, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
  const store = await createAppStore({ kind: "opfs", ...adapter,
    storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} }
  }, { seedWiki: false })
  stores.push(store)
  const footprint = () => ({
    rowBytes: (db.query(`SELECT SUM(LENGTH(CAST(value AS BLOB))) AS bytes FROM ${ROW_TABLE_NAME}`).get() as { bytes: number }).bytes,
    pages: (db.query("PRAGMA page_count").get() as { page_count: number }).page_count,
    freePages: (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count,
    pageSize: (db.query("PRAGMA page_size").get() as { page_size: number }).page_size,
    writes
  })
  return { store, db, path, footprint, pauseNextWrite }
}
const scope = { repo: "owner/repo", workspaceId: "83e75ae5-0920-4000-8000-000000000001", runId: "run-growth" }
const card: Extract<Card, { kind: "run-trace" }> = {
  id: "growth-run-card", kind: "run-trace", title: "Coding", status: "active", ordinal: 1, createdAt: 1,
  payload: { ...scope, gatewayBindingVersion: 1, workflow: "coding", phase: "launching", steps: [], result: null, lastSeq: 0, follow: true }
}
const summary: RunSummaryRow = { runId: scope.runId, flowId: "coding", status: "running", createdAt: 1, updatedAt: 2,
  turns: 1, calls: 1, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0,
  verdict: "running", diagnosis: "moving" }
const event = (sequence: number): ControlEvent => ({ sequence, kind: "control.signal.delivered", runId: scope.runId,
  occurredAt: sequence, payload: { text: "t".repeat(400) } })
const line = (sequence: number): TranscriptRow => ({ sequence, runId: scope.runId, turn: 1, at: sequence, kind: "model", text: "x".repeat(400) })
const gate = (status: ApprovalRow["status"] = "pending"): ApprovalRow => ({ runId: scope.runId, requestId: "gate", requestedAt: 1,
  title: "Deploy?", request: {}, status, payload: { target: { _tag: "Node", runId: scope.runId, requestId: "gate", digest: "reviewed",
    envelope: { capabilities: [], flows: [], budget: {} } }, scope: "once", idempotencyKey: "gate" } })
type Snapshot = { events: ReadonlyArray<ControlEvent>; transcript: ReadonlyArray<TranscriptRow>; summary?: RunSummaryRow; approvals?: ReadonlyArray<ApprovalRow> }
const poll = async (store: AppStore, snapshots: ReadonlyArray<Snapshot>, afterCycle: () => void, journalAfter: unknown[] = [], beforeJournal?: (cycle: number) => Promise<void>) => {
  let cycle = -1, transcriptReads = 0, approvalReads = 0
  const base = createControllerContext(store, unavailableAgent, {
    baseUrl: "https://gateway.test", workflowPollMs: 1, workflowQuietMs: 60_000,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { payload: { selector: { _tag: string }; after?: { value: number; offset: number } } }
      const projection = request.payload.selector._tag
      if (projection === "run-summary") cycle++
      const snapshot = snapshots[cycle]!
      let rows: ReadonlyArray<unknown> = [snapshot.summary ?? summary]
      if (projection === "transcript") { transcriptReads++; rows = snapshot.transcript }
      if (projection === "approvals") { approvalReads++; rows = snapshot.approvals ?? [] }
      if (projection === "run-events") {
        journalAfter.push(request.payload.after)
        rows = snapshot.events.filter(row => request.payload.after === undefined || row.sequence > request.payload.after.value)
        await beforeJournal?.(cycle)
      }
      // No revision hint: idle cycles exercise full transcript reads through
      // the real gateway decoder, plus suffix requests for the event journal.
      return Response.json({ ok: true, payload: { rows } })
    }
  })
  const context: ControllerContext = { ...base, get disposed() { return base.disposed }, unref: timer => {
    clearTimeout(timer)
    queueMicrotask(() => {
      afterCycle()
      if (cycle === snapshots.length - 1) for (const active of context.runPumps.values()) active.stopped = true
      context.pumpPokes.get(card.id)?.()
    })
  } }
  const pump = createWorkflowPumpController(context, () => 2)
  base.onDispose(() => { pump.stopWorkflowPumps() })
  // Match the AppController lifetime: a poisoned SQLite writer stops the
  // observer instead of claiming it can persist a retry through that writer.
  base.onDispose(store.onStorageFailure(() => { void base.dispose().catch(() => {}) }))
  contexts.push(base)
  await pump.pumpWorkflowRun(card.id)
  return { journalAfter, transcriptReads, approvalReads }
}

describe("normalized run polling has no idle SQLite growth", () => {
  test.each([
    { name: "identical pending evidence", append: false, fail: false },
    { name: "a suffix beyond pending evidence", append: true, fail: false },
    { name: "a rejected pending observation", append: false, fail: true }
  ])("committed cursor and receipt survive $name", async scenario => {
    const fixture = await open()
    await fixture.store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    const first: Snapshot = { events: [event(0)], transcript: [line(0)] }
    const second: Snapshot = { events: [...first.events, event(1)], transcript: [...first.transcript, line(1)] }
    const response: Snapshot = scenario.append ? { events: [...second.events, event(2)], transcript: [...second.transcript, line(2)] } : second
    await fixture.store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
      scope, summary, transcript: [...first.transcript], journal: { mode: "full", events: [...first.events] }
    } }).isPersisted.promise
    const before = await fixture.store.eventHistory()
    const failures: Error[] = []
    fixture.store.onStorageFailure(error => { failures.push(error) })
    const pause = fixture.pauseNextWrite()
    const owner = fixture.store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
      scope, summary, transcript: [...second.transcript], journal: { mode: "full", events: [...second.events] }
    } }).isPersisted.promise.then(() => true, () => false)
    await pause.entered
    expect(fixture.store.collections.runtimeRuns.get(runtimeRunKey(scope))?.events).toHaveLength(2)
    expect(fixture.store.committedRuntimeRun(runtimeRunKey(scope))?.events).toHaveLength(1)
    const queried: unknown[] = []
    let finished = false
    const watching = poll(fixture.store, [response], () => {}, queried).then(() => { finished = true; return true }, () => { finished = true; return false })
    for (let turn = 0; queried.length === 0 && turn < 100; turn++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(queried[0]).toMatchObject({ value: 0, offset: 0 })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(finished).toBe(false)
    expect(fixture.store.committedRuntimeRun(runtimeRunKey(scope))?.events).toHaveLength(1)
    if (scenario.fail) pause.fail(new Error("held observation failed"))
    else pause.release()
    expect(await owner).toBe(!scenario.fail)
    // The observer shuts down without rejecting into its unawaited caller.
    expect(await watching).toBe(true)
    if (scenario.fail) {
      expect(failures).toMatchObject([{ message: "Changes could not be saved." }])
      expect(queried).toHaveLength(1)
      expect(fixture.store.committedRuntimeRun(runtimeRunKey(scope))?.events).toEqual([...first.events])
    }
    if (!scenario.fail) {
      expect(fixture.store.committedRuntimeRun(runtimeRunKey(scope))?.events).toEqual([...response.events])
      expect((await fixture.store.eventHistory()).head.sequence).toBe(before.head.sequence + 2)
    }
    if (scenario.fail) await expect(Promise.resolve(fixture.store.dispose?.())).rejects.toThrow("held observation failed")
    else await fixture.store.dispose?.()
    stores.splice(stores.indexOf(fixture.store), 1)
    const reopened = await open(fixture.path)
    expect(reopened.store.committedRuntimeRun(runtimeRunKey(scope))?.events).toEqual([...(scenario.fail ? first.events : response.events)])
    if (scenario.fail) expect((await reopened.store.eventHistory()).head).toEqual(before.head)
    expect((await reopened.store.verifyState()).valid).toBe(true)
  }, 120_000)

  test("a terminal observation racing a journal read retries from committed evidence", async () => {
    const fixture = await open()
    await fixture.store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    const first: Snapshot = { events: [event(0)], transcript: [line(0)] }
    const terminal: RunSummaryRow = { ...summary, status: "completed", updatedAt: 3, verdict: "done" }
    const final: Snapshot = { events: [...first.events, event(1)], transcript: [...first.transcript, line(1)], summary: terminal }
    await fixture.store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
      scope, summary, transcript: [...first.transcript], journal: { mode: "full", events: [...first.events] }
    } }).isPersisted.promise
    const reads = await poll(fixture.store, [first, final], () => {}, [], async cycle => {
      if (cycle !== 0) return
      await fixture.store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
        scope, summary: terminal
      } }).isPersisted.promise
      expect(fixture.store.collections.cards.get(card.id)).toMatchObject({ payload: { phase: "completed" } })
    })
    expect(reads.journalAfter).toHaveLength(2)
    for (const after of reads.journalAfter) expect(after).toMatchObject({ value: 0, offset: 0 })
    expect(reads.transcriptReads).toBe(2)
    expect(fixture.store.committedRuntimeRun(runtimeRunKey(scope))).toMatchObject({
      summary: terminal, events: final.events, transcript: final.transcript
    })
    expect((await fixture.store.verifyState()).valid).toBe(true)
    await fixture.store.dispose?.()
    const reopened = await open(fixture.path)
    expect(reopened.store.committedRuntimeRun(runtimeRunKey(scope))).toMatchObject({
      summary: terminal, events: final.events, transcript: final.transcript
    })
    expect((await reopened.store.verifyState()).valid).toBe(true)
  }, 120_000)

  test("full idle reads write nothing; real appends store suffixes and reopen identically", async () => {
    const first = await open()
    await first.store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    const initial: Snapshot = { events: Array.from({ length: 600 }, (_, index) => event(index)), transcript: Array.from({ length: 600 }, (_, index) => line(index)) }
    const appended: Snapshot = { events: [...initial.events, event(600)], transcript: [...initial.transcript, line(600)] }
    expect(JSON.stringify(initial).length).toBeGreaterThan(500_000)
    const snapshots = [...Array.from({ length: 20 }, () => initial), ...Array.from({ length: 20 }, () => appended)]
    const measured: ReturnType<typeof first.footprint>[] = []
    const reads = await poll(first.store, snapshots, () => measured.push(first.footprint()))
    expect(measured).toHaveLength(40)
    for (const size of measured.slice(1, 20)) expect(size).toEqual(measured[0]!)
    for (const size of measured.slice(21)) expect(size).toEqual(measured[20]!)
    expect(reads.transcriptReads).toBe(40)
    expect(reads.journalAfter[0]).toBeUndefined()
    expect(reads.journalAfter[1]).toMatchObject({ value: 599, offset: 0 })
    // The first full-looking page needs one extra empty read to close it;
    // subsequent cycles continue from persisted cursors without idle writes.
    expect(reads.journalAfter).toHaveLength(41)
    for (const after of reads.journalAfter.slice(1, 22)) expect(after).toMatchObject({ value: 599, offset: 0 })
    for (const after of reads.journalAfter.slice(22)) expect(after).toMatchObject({ value: 600, offset: 0 })
    const history = await first.store.eventHistory()
    const observations = history.events.map(row => decodeEventValue(row.input))
      .filter((value): value is { type: "gateway.run.observed"; observation: RuntimeRunObservation } =>
        typeof value === "object" && value !== null && "type" in value && value.type === "gateway.run.observed")
    expect(observations).toHaveLength(2)
    expect(observations[0]!.observation.journal?.events).toHaveLength(600)
    expect(observations[0]!.observation.transcript).toHaveLength(600)
    expect(observations[1]!.observation.journal).toMatchObject({ mode: "suffix", after: { value: 599, offset: 0 }, events: [event(600)] })
    expect(observations[1]!.observation.transcriptAfter).toMatchObject({ length: 600 })
    expect(observations[1]!.observation.transcript).toEqual([line(600)])
    expect(JSON.stringify(observations[1]).length).toBeLessThan(4_000)
    const retained = await first.store.verifyState()
    expect(retained.valid).toBe(true)
    await first.store.dispose?.()
    const reopened = await open(first.path)
    expect(reopened.store.collections.runtimeRuns.get(runtimeRunKey(scope))).toMatchObject({ events: appended.events, transcript: appended.transcript, summary })
    expect((await reopened.store.eventHistory()).head).toEqual(history.head)
    const restored = await reopened.store.verifyState()
    expect(restored.valid).toBe(true)
    expect(restored.actualHash).toBe(retained.actualHash)
    const resumed: ReturnType<typeof reopened.footprint>[] = []
    const again = await poll(reopened.store, Array.from({ length: 5 }, () => appended), () => resumed.push(reopened.footprint()))
    expect(again.journalAfter[0]).toMatchObject({ value: 600, offset: 0 })
    for (const size of resumed.slice(1)) expect(size).toEqual(resumed[0]!)
    expect((await reopened.store.eventHistory()).head).toEqual(history.head)
  }, 120_000)

  test("waiting approval polls write nothing; learned decisions and conflicting batches remain meaningful", async () => {
    const fixture = await open()
    await fixture.store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    const waiting: Snapshot = { events: [event(1)], transcript: [], approvals: [gate()], summary: { ...summary, status: "waiting-approval", waitingReason: "approval" } }
    const measured: ReturnType<typeof fixture.footprint>[] = []
    const result = await poll(fixture.store, Array.from({ length: 12 }, () => waiting), () => measured.push(fixture.footprint()))
    expect(result.approvalReads).toBe(12)
    for (const size of measured.slice(1)) expect(size).toEqual(measured[0]!)
    const before = await fixture.store.eventHistory()
    await reconcileRunApprovals(fixture.store, scope, [gate("approved")])
    const accepted = await fixture.store.eventHistory()
    expect(accepted.head.sequence).toBe(before.head.sequence + 1)
    await reconcileRunApprovals(fixture.store, scope, [gate("approved"), gate()])
    expect((await fixture.store.eventHistory()).head).toEqual(accepted.head)
    await expect(reconcileRunApprovals(fixture.store, scope, [gate(), gate("denied")])).rejects.toThrow("conflict")
    expect((await fixture.store.eventHistory()).head).toEqual(accepted.head)
    expect((await fixture.store.verifyState()).valid).toBe(true)
  }, 120_000)

  test("explicit repeated commands remain complete accepted facts", async () => {
    const { store } = await open()
    const before = await store.eventHistory()
    for (let index = 0; index < 2; index++) await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const after = await store.eventHistory()
    expect(after.head.sequence).toBe(before.head.sequence + 2)
    expect(after.events.slice(-2).map(row => decodeEventValue(row.input))).toEqual([
      { type: "theme.changed", actor: "user", theme: "dark" }, { type: "theme.changed", actor: "user", theme: "dark" }
    ])
    expect((await store.verifyState()).valid).toBe(true)
  })
})

test("identical repository-import polls do not grow the committed journal or SQLite rows", async () => {
  const { createRepoImportSeam, repoImportPolling } = await import("./seams/RepoImportSeam")
  const fixture = await open()
  const store = fixture.store
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  const previousDelay = repoImportPolling.delayMs
  repoImportPolling.delayMs = 1
  let disposed = false
  const reads: Array<ReturnType<typeof Promise.withResolvers<Response>>> = []
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2_000
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Import observation did not settle")
      await new Promise(resolve => setTimeout(resolve, 1))
    }
  }
  const answer = (stage = "cloning_github", status = "cloning") => Response.json({
    importJobId: "import-growth", repoOwner: "owner", repoName: "repo", status, stage,
    target_bookmark: "main", created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z"
  })
  const seam = createRepoImportSeam({ store, dispatch: store.dispatch, baseUrl: "", actor: () => "user", nextOrdinal: () => 1,
    isDisposed: () => disposed, http: async (_input, init) => {
      if (init?.method === "POST") return answer()
      const read = Promise.withResolvers<Response>(); reads.push(read); return read.promise
    }
  })
  try {
    await seam.importRepository("owner/repo")
    await waitFor(() => reads.length === 1)
    reads[0]!.resolve(answer())
    await waitFor(() => reads.length === 2)
    const before = await store.eventHistory(), physical = fixture.footprint()
    for (let index = 1; index <= 10; index++) {
      reads[index]!.resolve(answer())
      await waitFor(() => reads.length === index + 2)
    }
    expect((await store.eventHistory()).head).toEqual(before.head)
    expect(fixture.footprint()).toEqual(physical)
    const held = fixture.pauseNextWrite()
    reads[11]!.resolve(answer("pushing_mirror"))
    await held.entered
    expect(store.committedCard("repo-import-owner/repo")).toMatchObject({ payload: { stage: "cloning_github" } })
    expect(reads).toHaveLength(12)
    held.release()
    await waitFor(() => reads.length === 13)
    expect((await store.eventHistory()).head.sequence).toBe(before.head.sequence + 1)
    reads[12]!.resolve(answer("provisioning_workspace", "ready"))
    await waitFor(() => {
      const card = store.collections.cards.get("repo-import-owner/repo")
      return card?.kind === "repo-import" && card.payload.phase === "done"
    })
    await store.settled?.()
    expect((await store.eventHistory()).head.sequence).toBe(before.head.sequence + 2)
    const reopened = await open(fixture.path)
    expect(reopened.store.collections.cards.get("repo-import-owner/repo")).toMatchObject({ payload: { phase: "done", stage: "provisioning_workspace" } })
    expect((await reopened.store.verifyState()).valid).toBe(true)
  } finally {
    disposed = true
    for (const read of reads) read.resolve(answer())
    repoImportPolling.delayMs = previousDelay
  }
})

for (const action of ["message", "status", "repair"] as const) test(`replayed agent-session ${action} observations do not grow SQLite`, async () => {
  const { createAgentSessionSeam } = await import("./seams/AgentSessionSeam")
  const { AGENT_SESSION_WIRE: wire, sseFrame } = await import("./seams/fixtures/AgentSessionWire")
  const fixture = await open(), store = fixture.store
  await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "owner", expiresAt: null, scopes: null }).isPersisted.promise
  const session = wire.session({ message_count: 1 }), message = wire.message()
  let channel!: ReadableStreamDefaultController<Uint8Array>, pulls = 0, repairReads = 0
  const body = new ReadableStream<Uint8Array>({ start(controller) { channel = controller }, pull() { pulls++ } }, { highWaterMark: 0 })
  const seam = createAgentSessionSeam({ store, dispatch: store.dispatch, baseUrl: "", actor: () => "user", nextOrdinal: () => 1,
    stream: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    http: async input => {
      if (!input.includes("/messages") && !input.split("?")[0]!.endsWith("/sessions")) repairReads++
      return Response.json(input.includes("/messages") ? [message] : input.split("?")[0]!.endsWith("/sessions") ? [session] : session)
    }
  }, { repairIntervalMs: action === "repair" ? 2 : 60_000 })
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2_000
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Agent stream did not request its next frame")
      await new Promise(resolve => setTimeout(resolve, 1))
    }
  }
  const send = async (data: unknown, id?: number) => {
    const next = pulls + 1
    channel.enqueue(new TextEncoder().encode(sseFrame(data, id === undefined ? {} : { id })))
    // With no stream buffer, the next read follows the prior save receipt.
    await waitFor(() => pulls === next)
  }
  try {
    await seam.listSessions("owner/repo")
    expect(store.committedCard("agent-sessions-owner/repo")).toMatchObject({ kind: "agents" })
    await seam.viewSession(session.id, "owner/repo")
    await waitFor(() => pulls === 1)
    const before = await store.eventHistory(), physical = fixture.footprint()
    if (action === "repair") {
      const observed = repairReads
      await waitFor(() => repairReads >= observed + 10)
    } else for (let index = 0; index < 10; index++) {
      if (action === "message") await send(wire.messageEvent(message), message.id)
      else await send(wire.statusEvent("active"))
    }
    expect((await store.eventHistory()).head).toEqual(before.head)
    expect(fixture.footprint()).toEqual(physical)
    const changed = wire.message({ id: 42, sequence: 2, role: "assistant", parts: [{ part_index: 0, type: "text", content: { value: "A new observation" } }] })
    await send(wire.messageEvent(changed), 42)
    expect((await store.eventHistory()).head.sequence).toBe(before.head.sequence + 1)
    channel.enqueue(new TextEncoder().encode(sseFrame(wire.statusEvent("completed"))))
    await waitFor(() => {
      const card = store.committedCard(`agent-session-${session.id}`)
      return card?.kind === "agent" && "cloud" in card.payload && card.payload.state === "completed"
    })
    await store.settled?.()
    const reopened = await open(fixture.path)
    expect(reopened.store.committedCard(`agent-session-${session.id}`)).toMatchObject({ payload: { state: "completed", transcript: [{ id: 41 }, { id: 42 }] } })
    expect(reopened.store.committedCard("agent-sessions-owner/repo")).toMatchObject({ payload: { sessions: [{ status: "completed" }] } })
    expect((await reopened.store.verifyState()).valid).toBe(true)
  } finally { seam.dispose() }
})

test.each(["eof", "unavailable"] as const)("Wiki reconnects after %s retain their failure without growing SQLite", async (failure) => {
  const fixture = await open(), { store } = fixture
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null })
  const doc = new Y.Doc(), id = wikiDocumentId("owner/repo", 42)
  doc.getText("markdown").insert(0, "# Page")
  let revision = 1
  const streams: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  const ctx = createControllerContext(store, unavailableAgent, { fetchImpl: async (input) => {
    if (String(input).includes("/stream?")) {
      const stream = Promise.withResolvers<Response>(); streams.push(stream); return stream.promise
    }
    return Response.json({ page: { id: 42, slug: "home", title: "Page", body: doc.getText("markdown").toString(), revision,
      author: { id: 1, login: "will" }, created_at: "2026-09-08T00:00:00Z", updated_at: "2026-09-08T00:00:00Z" },
      state: encodeWikiState(Y.encodeStateAsUpdate(doc)), state_vector: encodeWikiState(Y.encodeStateVector(doc)) })
  } })
  contexts.push(ctx)
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 4_000
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Wiki reconnect did not settle")
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  const failed = () => failure === "eof"
    ? new Response("", { headers: { "content-type": "text/event-stream" } })
    : Response.json({ message: "Wiki maintenance" }, { status: 503 })
  try {
    const wiki = createCloudWikiController(ctx, () => 1)
    await wiki.openCloudWiki("owner/repo", "home")
    await until(() => streams.length === 1)
    streams[0]!.resolve(failed())
    await until(() => streams.length === 2)
    const before = await store.eventHistory(), physical = fixture.footprint()
    for (let index = 1; index <= 2; index++) {
      streams[index]!.resolve(failed())
      await until(() => streams.length === index + 2)
    }
    expect((await store.eventHistory()).head).toEqual(before.head)
    expect(fixture.footprint()).toEqual(physical)
    expect(store.collections.worldDocuments.get(id)?.cloud).toMatchObject({ phase: "offline",
      error: failure === "eof" ? "Reconnecting to Wiki revisions…" : "Wiki maintenance" })
    let channel!: ReadableStreamDefaultController<Uint8Array>
    streams[3]!.resolve(new Response(new ReadableStream({ start(value) { channel = value } }), { headers: { "content-type": "text/event-stream" } }))
    doc.getText("markdown").insert(6, "\n\nRecovered")
    revision = 2
    channel.enqueue(new TextEncoder().encode(`event: wiki.update\nid: 2\ndata: ${JSON.stringify({ id: 2, page_id: 42, revision: 2, deleted: false, slug: "home" })}\n\n`))
    await until(() => store.collections.worldDocuments.get(id)?.cloud?.remoteRevision === 2)
    await store.settled?.()
    expect((await store.eventHistory()).head.sequence).toBe(before.head.sequence + 1)
    const reopened = await open(fixture.path)
    expect(reopened.store.collections.worldDocuments.get(id)).toMatchObject({ body: "# Page\n\nRecovered", cloud: { remoteRevision: 2, phase: "live", error: null } })
    expect((await reopened.store.verifyState()).valid).toBe(true)
  } finally {
    await ctx.dispose()
    for (const stream of streams) stream.resolve(failed())
    doc.destroy()
  }
}, 15_000)
