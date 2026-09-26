/**
 * The read path's own behaviour: what it does when the control plane refuses,
 * answers something else, or keeps producing events.
 *
 * The suites beside this one run the read path against a real SQLite control
 * plane and prove the rows. These drive a stub control service instead,
 * because the branches under test are the gateway's: a listing that fails, a
 * response of the wrong shape, a subscription that must keep following, and a
 * real control plane cannot be asked to produce them on demand.
 */
import { describe, expect, it } from "@effect/vitest"
import { ControlFacts } from "@smthrs/control"
import type { Service as ControlService } from "@smthrs/control/Control"
import { PersistenceError, Unavailable } from "@smthrs/control/ControlError"
import type { ControlEvent, ListResponse, RunSummary } from "@smthrs/control/ControlSchema"
import { Deferred, Effect, Logger, Schema, Stream } from "effect"
import { GatewayError } from "../src/GatewayError.ts"
import * as GatewayProjection from "../src/GatewayProjection.ts"
import * as GatewaySchema from "../src/GatewaySchema.ts"
import * as Projections from "../src/Projections.ts"

const die = () => Effect.die("the suite does not use this operation")

const run: RunSummary = {
  runId: "run-1",
  flowId: "deploy",
  status: "waiting-approval",
  createdAt: 1,
  updatedAt: 2
}

const numberedRun = (ordinal: number): RunSummary => ({
  ...run,
  runId: `run-${ordinal}`
})

const event = (sequence: number, kind: string, payload: unknown): ControlEvent => ({
  sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence,
  payload: payload as ControlEvent["payload"]
})

const approvalRequested = event(1, "control.approval.requested", {
  runId: "run-1",
  requestId: "gate",
  question: "Ship?",
  payload: {
    target: {
      _tag: "Node",
      runId: "run-1",
      requestId: "gate",
      digest: "d",
      envelope: { capabilities: [], flows: [], budget: {} }
    },
    scope: "run",
    idempotencyKey: "k"
  }
})

/** A control service answering exactly what a test needs and nothing else. */
const control = (overrides: Partial<ControlService>): ControlService => ({
  plan: die,
  run: die,
  approve: die,
  deny: die,
  steer: die,
  signal: die,
  cancel: die,
  pause: die,
  resume: die,
  list: () => Effect.succeed({ _tag: "runs", items: [] } satisfies ListResponse),
  watch: () => Stream.empty,
  ...overrides
} as ControlService)

const make = (
  service: ControlService,
  options: { readonly heartbeatMillis?: number | undefined } = {}
): Projections.Service => Effect.runSync(Projections.make(service, options))

const issuedCursor = (
  selector: GatewaySchema.ProjectionSelector,
  value: number,
  offset = 0
): GatewaySchema.ProjectionCursor => ({
  selector,
  projection: selector._tag,
  runId: "runId" in selector ? selector.runId ?? null : null,
  value,
  offset
})

describe("Projections run-list pagination", () => {
  it.effect("filters role runs before applying the workspace limit on every page", () =>
    Effect.gen(function*() {
      let pages = 0
      const projections = make(control({
        list: (request) => {
          if (request._tag === "runs" && request.filters?.runId) {
            return Effect.succeed({ _tag: "runs", items: [{ ...run, runId: request.filters.runId }] })
          }
          expect(request._tag).toBe("runs")
          if (request._tag === "runs") expect(request.filters?.flowId).toBe("deploy")
          pages++
          return Effect.succeed(
            pages === 1
              ? { _tag: "runs", items: [run], nextCursor: "second" }
              : { _tag: "runs", items: [{ ...run, runId: "run-2" }] }
          )
        }
      }))
      const snapshot = yield* projections.snapshot({ _tag: "workspace-runs", flowId: "deploy" })
      expect(snapshot.rows).toHaveLength(2)
      expect(pages).toBe(2)
    }))

  it.effect("folds workspace rows from every control-list page", () =>
    Effect.gen(function*() {
      const first = Array.from({ length: 100 }, (_, index) => numberedRun(index + 1))
      const second = [numberedRun(101)]
      let listCalls = 0
      const projections = make(control({
        list: (request) => {
          if (request._tag === "runs" && request.filters?.runId) {
            return Effect.succeed({
              _tag: "runs",
              items: [...first, ...second].filter((run) => run.runId === request.filters?.runId)
            })
          }
          listCalls += 1
          return Effect.succeed(
            listCalls === 1
              ? { _tag: "runs", items: first, nextCursor: "page-2" } satisfies ListResponse
              : { _tag: "runs", items: second } satisfies ListResponse
          )
        }
      }))

      const snapshot = yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(snapshot.rows.map((row) => (row as { readonly runId: string }).runId)).toEqual(
        [...first, ...second].map((item) => item.runId)
      )
      expect(listCalls).toBe(2)
    }))

  it.effect("stops a perpetually paginated listing at the workspace ceiling", () =>
    Effect.gen(function*() {
      let listCalls = 0
      const projections = make(control({
        list: (request) => {
          if (request._tag === "runs" && request.filters?.runId) {
            return Effect.succeed({
              _tag: "runs",
              items: [numberedRun(Number(request.filters.runId.slice(4)))]
            })
          }
          const page = listCalls
          listCalls += 1
          return Effect.succeed(
            {
              _tag: "runs",
              items: Array.from({ length: 100 }, (_, index) => numberedRun(page * 100 + index + 1)),
              nextCursor: `page-${page + 1}`
            } satisfies ListResponse
          )
        }
      }))

      const snapshot = yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(Projections.maxWorkspaceRuns).toBe(500)
      expect(snapshot.rows).toHaveLength(500)
      expect(listCalls).toBe(5)
    }))

  it.effect("passes an explicit numeric limit on every run-list request", () =>
    Effect.gen(function*() {
      const limits: Array<number | undefined> = []
      const projections = make(control({
        list: (request) => {
          if (request._tag === "runs" && request.filters?.runId) return Effect.succeed({ _tag: "runs", items: [run] })
          limits.push(request.limit)
          return Effect.succeed(
            limits.length === 1
              ? { _tag: "runs", items: [run], nextCursor: "page-2" } satisfies ListResponse
              : { _tag: "runs", items: [] } satisfies ListResponse
          )
        }
      }))

      yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(limits).toEqual([Projections.maxWorkspaceRuns, Projections.maxWorkspaceRuns - 1])
    }))

  it.effect("does not page a run-scoped lookup past its first match", () =>
    Effect.gen(function*() {
      let listCalls = 0
      const limits: Array<number | undefined> = []
      const projections = make(control({
        list: (request) => {
          listCalls += 1
          limits.push(request.limit)
          return Effect.succeed({ _tag: "runs", items: [run], nextCursor: "another-page" } satisfies ListResponse)
        }
      }))

      const snapshot = yield* projections.snapshot({ _tag: "run-summary", runId: run.runId })
      expect(snapshot.rows).toHaveLength(1)
      expect(listCalls).toBe(2)
      expect(limits).toEqual([1, 1])
    }))

  it.effect("maps and redacts a failure from a later run-list page", () =>
    Effect.gen(function*() {
      let listCalls = 0
      const persistence = new PersistenceError({
        operation: "list runs at /private/tmp/control.db",
        message: "SQL failed on the second page",
        cause: { statement: "select secret from runs" }
      })
      const projections = make(control({
        list: () => {
          listCalls += 1
          return listCalls === 1
            ? Effect.succeed({ _tag: "runs", items: [run], nextCursor: "page-2" } satisfies ListResponse)
            : Effect.fail(persistence)
        }
      }))

      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(listCalls).toBe(2)
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toBe("Listing runs failed")
      expect(failure.cause).toEqual({ _tag: "/control/PersistenceError", code: "persistence_failed" })
      expect(JSON.stringify(failure)).not.toContain("SQL failed")
      expect(JSON.stringify(failure)).not.toContain("select secret")
      expect(JSON.stringify(failure)).not.toContain("/private/tmp")
    }))
})

describe("Projections read-path failures", () => {
  it.effect("reports a failed run listing as a gateway refusal", () =>
    Effect.gen(function*() {
      const projections = make(
        control({ list: () => Effect.fail(new Unavailable({ code: "unavailable", feature: "list", ticket: "T-1" })) })
      )
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toBe("Listing runs failed")
      expect(failure.cause).toEqual({ _tag: "/control/Unavailable", code: "unavailable" })
    }))

  it.effect("redacts a persistence failure before it reaches a caller", () =>
    Effect.gen(function*() {
      const nested = new Error("nested driver detail at /private/tmp/control.db")
      nested.cause = nested
      const persistence = new PersistenceError({
        operation: "list runs",
        message: "SQL failed while reading /private/tmp/control.db",
        cause: { nested, statement: "select secret from runs", offset: 1n }
      })
      const projections = make(control({ list: () => Effect.fail(persistence) }))

      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(failure.cause).toEqual({ _tag: "/control/PersistenceError", code: "persistence_failed" })
      const json = JSON.stringify(failure)
      for (const privateText of ["SQL failed", "nested driver", "/private/tmp", "select secret"]) {
        expect(json).not.toContain(privateText)
      }
      expect(() => Schema.encodeUnknownSync(GatewayError)(failure)).not.toThrow()
    }))

  it.effect("carries no cause at all when the failure is not a tagged error", () =>
    Effect.gen(function*() {
      // A control plane is typed, but the wire is not: a transport that hands
      // back a string, a bare object, or nothing is still a read that failed,
      // and the client learns that much and nothing it cannot act on.
      for (
        const opaque of [
          "boom",
          { message: "boom", statement: "select secret from runs" },
          { _tag: 7 },
          null
        ]
      ) {
        const projections = make(
          control({ list: () => Effect.fail(opaque as unknown as Unavailable) })
        )
        const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
        expect(failure.code).toBe("run_unavailable")
        expect(failure.cause).toBeUndefined()
        expect(JSON.stringify(failure)).not.toContain("select secret")
      }
    }))

  it.effect("names a tagged failure that carries no code", () =>
    Effect.gen(function*() {
      const projections = make(
        control({ list: () => Effect.fail({ _tag: "/control/Mystery" } as unknown as Unavailable) })
      )
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(failure.cause).toEqual({ _tag: "/control/Mystery" })
    }))

  it.effect("reports a failed event read as a gateway refusal naming the run", () =>
    Effect.gen(function*() {
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: () => Stream.fail(new Unavailable({ code: "unavailable", feature: "watch", ticket: "T-2" }))
        })
      )
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "run-summary", runId: "run-1" }))
      expect(failure.message).toBe("Reading the events of run-1 failed")
    }))

  it.effect("treats a listing that answered about flows as no runs at all", () =>
    Effect.gen(function*() {
      const projections = make(
        control({ list: () => Effect.succeed({ _tag: "flows", items: [] } satisfies ListResponse) })
      )
      const snapshot = yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(snapshot.rows).toEqual([])
    }))
})

describe("Projections resource bounds", () => {
  it.effect(
    "stops reading at the scan ceiling instead of refusing a long journal",
    () =>
      Effect.gen(function*() {
        let produced = 0
        const projections = make(control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: () =>
            Stream.iterate(1, (sequence) => sequence + 1).pipe(
              Stream.take(Projections.maxEventsScanned + 50),
              Stream.map((sequence) => {
                produced += 1
                return event(sequence, "control.agent.turn-opened", { seat: "s" })
              })
            )
        }))

        const snapshot = yield* projections.snapshot({ _tag: "run-summary", runId: run.runId })
        expect(produced).toBe(Projections.maxEventsScanned)
        // Every scanned turn is counted, including the ones the window dropped.
        expect((snapshot.rows[0] as { readonly turns: number }).turns).toBe(Projections.maxEventsScanned)
      }), // Folding the real 100,000-event ceiling takes most of the default 30 s on a loaded runner.
    120_000
  )

  it.effect("pages run-events rather than answering one response per journal", () =>
    Effect.gen(function*() {
      const history = Array.from(
        { length: Projections.maxEventsPerPage * 2 + 7 },
        (_, index) => event(index + 1, "control.test", null)
      )
      const selector = { _tag: "run-events" as const, runId: run.runId }
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: (filter) => Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
      }))

      const collected: Array<ControlEvent> = []
      let page = yield* projections.snapshot(selector)
      let pages = 0
      while (page.rows.length > 0) {
        pages += 1
        expect(page.rows.length).toBeLessThanOrEqual(Projections.maxEventsPerPage)
        collected.push(...page.rows as ReadonlyArray<ControlEvent>)
        page = yield* projections.snapshot(selector, page.cursor)
      }
      expect(pages).toBe(3)
      expect(collected).toEqual(history)
    }))

  it.effect("keeps a run summary and a first events page for a twenty-mebibyte journal", () =>
    Effect.gen(function*() {
      // One wiki refresh whose planning attempt retried a model call nine
      // times: nine journaled request/response bodies of two mebibytes each.
      const body = "x".repeat(2 * 1024 * 1024)
      const history: Array<ControlEvent> = [event(1, "control.run.running", {})]
      for (let attempt = 0; attempt < 9; attempt += 1) {
        history.push(event(history.length + 1, "control.agent.turn-opened", { seat: "claude", body }))
        history.push(
          event(history.length + 1, "control.agent.model-settled", {
            usage: { inputTokens: 10, outputTokens: 5 },
            response: body
          })
        )
      }
      expect(new TextEncoder().encode(JSON.stringify(history)).byteLength)
        .toBeGreaterThan(20 * 1024 * 1024)
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: (filter) => Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
      }))

      const summary = yield* projections.snapshot({ _tag: "run-summary", runId: run.runId })
      const row = summary.rows[0] as { readonly turns: number; readonly inputTokens: number }
      expect(row.turns).toBe(9)
      expect(row.inputTokens).toBe(90)
      const page = yield* projections.snapshot({ _tag: "run-events", runId: run.runId })
      expect(page.rows).toHaveLength(history.length)
      for (const candidate of page.rows as ReadonlyArray<ControlEvent>) {
        expect(new TextEncoder().encode(JSON.stringify(candidate)).byteLength)
          .toBeLessThanOrEqual(Projections.maxEventBytes)
      }
    }))

  it.effect("folds the events a window drops into the counters a run card shows", () =>
    Effect.gen(function*() {
      // Each turn is inside the per-event budget, so nothing is clipped and the
      // window alone decides what is retained.
      const filler = "x".repeat(8_000)
      const history = Array.from(
        { length: 1_200 },
        (_, index) => event(index + 1, "control.agent.turn-opened", { seat: "claude", filler })
      )
      expect(new TextEncoder().encode(JSON.stringify(history)).byteLength)
        .toBeGreaterThan(Projections.maxProjectionBytes)
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: () => Stream.fromIterable(history)
      }))

      const summary = yield* projections.snapshot({ _tag: "run-summary", runId: run.runId })
      expect((summary.rows[0] as { readonly turns: number }).turns).toBe(history.length)
      expect(summary.cursor.value).toBe(history.length)
    }))

  it.effect("preserves native engine evidence across bounded journal pages", () =>
    Effect.gen(function*() {
      const payload = {
        version: 1,
        executionId: "native-request",
        payload: {
          result: { description: "x".repeat(3 * 1024 * 1024), status: "validated" }
        }
      }
      const history = [event(1, "control.engine.event", payload), event(2, "control.engine.event", payload)]
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: () => Stream.fromIterable(history)
      }))
      const selector = { _tag: "run-events" as const, runId: run.runId }
      const first = yield* projections.snapshot(selector)
      expect(first.rows).toEqual([history[0]])
      const second = yield* projections.snapshot(selector, first.cursor)
      expect(second.rows).toEqual([history[1]])
      expect(second.cursor.value).toBe(2)
    }))

  it.effect("refuses oversized native graph pages at the event byte limit without clipping topology", () =>
    Effect.gen(function*() {
      for (const eventType of ["flows.engine.plan-recorded", "flows.engine.subgraph-appended"]) {
        const projections = make(control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: () =>
            Stream.succeed(event(1, "control.engine.event", {
              eventType,
              payload: { graph: { nodes: [{ id: "界".repeat(Projections.maxEventBytes / 2) }], edges: [] } }
            }))
        }))
        expect((yield* Effect.flip(projections.snapshot({ _tag: "run-events", runId: run.runId }))).code)
          .toBe("resource_limit")
      }
    }))

  it.effect("refuses a native event too large for a page instead of corrupting its contract", () =>
    Effect.gen(function*() {
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: () =>
          Stream.succeed(event(1, "control.engine.event", { result: "x".repeat(Projections.maxProjectionBytes) }))
      }))
      expect((yield* Effect.flip(projections.snapshot({ _tag: "run-events", runId: run.runId }))).code)
        .toBe("resource_limit")
    }))

  it.effect("clips an oversized payload instead of refusing the projection", () =>
    Effect.gen(function*() {
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: () => Stream.succeed(event(1, "control.test", "x".repeat(Projections.maxProjectionBytes)))
      }))
      const oversizedRows = make(control({
        list: () =>
          Effect.succeed({
            _tag: "runs",
            items: [{ ...run, flowId: "x".repeat(Projections.maxProjectionBytes) }]
          })
      }))

      const page = yield* projections.snapshot({ _tag: "run-events", runId: run.runId })
      const row = page.rows[0] as ControlEvent
      expect(typeof row.payload).toBe("string")
      expect(String(row.payload).length).toBeLessThan(Projections.maxEventBytes)
      expect(String(row.payload).endsWith("\u2026")).toBe(true)
      // A row set too large for the wire is still a refusal: rows go out whole.
      expect((yield* Effect.flip(oversizedRows.snapshot({ _tag: "workspace-runs" }))).code)
        .toBe("resource_limit")
    }))

  it.effect("refuses malformed and backward event histories as unavailable", () =>
    Effect.gen(function*() {
      const malformedEvents = [
        [{}],
        [{ ...event(1, "control.test", null), sequence: -1 }],
        [event(2, "control.test", null), event(1, "control.test", null)]
      ]
      for (const history of malformedEvents) {
        const projections = make(control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: () => Stream.fromIterable(history as ReadonlyArray<ControlEvent>)
        }))
        const failure = yield* Effect.flip(projections.snapshot({ _tag: "run-events", runId: run.runId }))
        expect(failure.code).toBe("run_unavailable")
      }
    }))

  it.effect("refuses a projection row that violates its selector schema", () =>
    Effect.gen(function*() {
      const projections = make(control({
        list: () =>
          Effect.succeed({
            _tag: "runs",
            items: [{ ...run, flowId: undefined }] as unknown as ReadonlyArray<RunSummary>
          })
      }))
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toBe("Projection produced invalid rows")
    }))
})

describe("Projections approvals inbox", () => {
  it.effect("collects the pending gates of every waiting run", () =>
    Effect.gen(function*() {
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: () => Stream.fromIterable([approvalRequested])
        })
      )
      const snapshot = yield* projections.snapshot({ _tag: "approvals" })
      expect(snapshot.rows).toMatchObject([{ runId: "run-1", requestId: "gate", status: "pending" }])
      // The workspace inbox is not scoped to a run, so its cursor names none.
      expect(snapshot.cursor).toEqual({
        selector: { _tag: "approvals" },
        projection: "approvals",
        runId: null,
        value: 0,
        offset: 0
      })
    }))
})

describe("Projections node output", () => {
  it.effect("answers only the node the selector named", () =>
    Effect.gen(function*() {
      const calls = [
        event(1, "control.agent.cell-call-started", { flowName: "write" }),
        event(2, "control.agent.cell-call-settled", { flowName: "write", outcome: "success", value: "wrote it" }),
        event(3, "control.agent.cell-call-started", { flowName: "read" }),
        event(4, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "read it" })
      ]
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: () => Stream.fromIterable(calls)
      }))

      expect((yield* projections.snapshot({ _tag: "node-output", runId: "run-1", nodeId: "call-2" })).rows)
        .toMatchObject([{ nodeId: "call-2", output: "read it" }])
      // A node the run never opened is an empty answer, not a refusal: the run
      // exists, and a client asking about a node it has not seen settle yet is
      // asking a question with an answer.
      expect((yield* projections.snapshot({ _tag: "node-output", runId: "run-1", nodeId: "call-9" })).rows)
        .toEqual([])
    }))
})

describe("Projections subscriptions", () => {
  const movingLog = () => {
    let nonFollowingReads = 0
    let log: ReadonlyArray<ControlEvent> = []
    const service = control({
      list: () => Effect.succeed({ _tag: "runs", items: [run] }),
      watch: (filter) => {
        if (filter.follow !== true) {
          nonFollowingReads += 1
          log = [...log, event(log.length, "control.run.accepted", { runId: "run-1" })]
          return Stream.fromIterable(log)
        }
        log = [...log, event(log.length, "control.run.completed", { runId: "run-1" })]
        return Stream.fromIterable(log.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
      }
    })
    return { reads: () => nonFollowingReads, service }
  }

  for (const tag of ["run-events", "run-summary", "run-tree", "transcript", "approvals"] as const) {
    it.effect(`uses one moving-log read for a ${tag} subscription`, () =>
      Effect.gen(function*() {
        const moving = movingLog()
        const projections = make(moving.service, { heartbeatMillis: 60_000 })
        const frames = yield* Stream.runCollect(projections.subscribe({ _tag: tag, runId: "run-1" }))
        const snapshotEnd = frames.find((frame) => frame._tag === "snapshot-end")
        const deltas = frames.filter((frame) => frame._tag === "delta")

        expect(moving.reads()).toBe(1)
        expect(snapshotEnd?._tag).toBe("snapshot-end")
        if (snapshotEnd?._tag !== "snapshot-end") return
        expect(deltas.length).toBeGreaterThan(0)
        expect(deltas.every((frame) => frame.cursor.value > snapshotEnd.cursor.value)).toBe(true)

        if (tag === "run-events") {
          const snapshotSequences = frames.flatMap((frame) =>
            frame._tag === "row" ? [(frame.row as ControlEvent).sequence] : []
          )
          // The loop's selector is one of five tags, so this subscription's
          // frames carry the union of those five rows; only the run-events
          // arm of the loop reads a sequence.
          const deltaSequences = deltas.flatMap((frame) =>
            (frame.delta as ReadonlyArray<ControlEvent>).map((item) => item.sequence)
          )
          expect(snapshotSequences.filter((sequence) => deltaSequences.includes(sequence))).toEqual([])
        }
      }))
  }

  it.effect("uses one moving-log read for a unary snapshot cursor and rows", () =>
    Effect.gen(function*() {
      const moving = movingLog()
      const snapshot = yield* make(moving.service).snapshot({ _tag: "run-events", runId: "run-1" })
      const rows = snapshot.rows
      expect(moving.reads()).toBe(1)
      expect(snapshot.cursor.value).toBe(rows.at(-1)?.sequence)
    }))

  it.effect("reads each run's non-following log exactly once per snapshot", () =>
    Effect.gen(function*() {
      const second = { ...run, runId: "run-2" }
      const reads: Array<string> = []
      const projections = make(control({
        list: (request) => {
          const named = request._tag === "runs" ? request.filters?.runId : undefined
          return Effect.succeed(
            {
              _tag: "runs",
              items: named === undefined ? [run, second] : [run, second].filter((item) => item.runId === named)
            } satisfies ListResponse
          )
        },
        watch: (filter) => {
          if (filter.follow !== true && filter.runId !== undefined) reads.push(filter.runId)
          return Stream.empty
        }
      }))

      yield* projections.snapshot({ _tag: "run-summary", runId: "run-1" })
      expect(reads).toEqual(["run-1"])
      reads.length = 0
      yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(reads.sort()).toEqual(["run-1", "run-2"])
    }))

  it.effect("accumulates fifty run-tree deltas without re-reading history", () =>
    Effect.gen(function*() {
      const followed = Array.from({ length: 50 }, (_, index) =>
        event(index + 1, "control.agent.cell-call-started", { flowName: `call-${index + 1}` }))
      let history: ReadonlyArray<ControlEvent> = []
      let nonFollowingReads = 0
      let listCalls = 0
      const projections = make(
        control({
          list: () => {
            listCalls += 1
            return Effect.succeed({ _tag: "runs", items: [run] })
          },
          watch: (filter) => {
            if (filter.follow !== true) {
              nonFollowingReads += 1
              return Stream.fromIterable(history)
            }
            history = followed
            return Stream.fromIterable(followed)
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "run-tree", runId: "run-1" }))
      const deltas = frames.filter((frame) =>
        frame._tag === "delta"
      )
      expect(nonFollowingReads).toBe(1)
      expect(listCalls).toBe(52)
      expect(deltas).toHaveLength(50)

      const fresh = yield* projections.snapshot({ _tag: "run-tree", runId: "run-1" })
      expect(nonFollowingReads).toBe(2)
      expect(deltas.at(-1)?.delta).toEqual(fresh.rows)
    }))

  it.effect("delivers workspace deltas with the workspace cursor", () =>
    Effect.gen(function*() {
      const completed: RunSummary = { ...run, status: "completed", updatedAt: 3 }
      const planEvent: ControlEvent = {
        sequence: 1,
        kind: "control.plan.created",
        occurredAt: 1,
        payload: { planId: "plan-1" }
      }
      const changed = event(1, "control.run.completed", { runId: run.runId })
      const projections = make(
        control({
          list: (request) =>
            Effect.succeed({
              _tag: "runs",
              items: request._tag === "runs" && request.filters?.runId === run.runId ? [completed] : [run]
            }),
          watch: (filter) => filter.follow === true ? Stream.fromIterable([planEvent, changed]) : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      const delta = frames.find((frame) => frame._tag === "delta")
      // Without the unscoped follow, a dashboard keeps the snapshot's stale
      // waiting status after the control row has completed under a fence.
      expect(delta?._tag).toBe("delta")
      if (delta?._tag !== "delta") return
      expect(delta.cursor).toEqual({
        selector: { _tag: "workspace-runs" },
        projection: "workspace-runs",
        runId: null,
        value: 0,
        offset: 0
      })
      expect(delta.delta).toMatchObject([{ runId: "run-1", status: "completed", verdict: "completed" }])
    }))

  it.effect("admits a newly followed run with one journal read", () =>
    Effect.gen(function*() {
      const second = { ...numberedRun(2), status: "running" } satisfies RunSummary
      const accepted: ControlEvent = {
        ...event(1, "control.run.accepted", { runId: second.runId }),
        runId: second.runId
      }
      let nonFollowingReads = 0
      const projections = make(
        control({
          list: (request) =>
            Effect.succeed({
              _tag: "runs",
              items: request._tag === "runs" && request.filters?.runId === second.runId ? [second] : []
            }),
          watch: (filter) => {
            if (filter.follow === true) return Stream.fromIterable([accepted])
            nonFollowingReads += 1
            return Stream.fromIterable([accepted])
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      const delta = frames.find((frame) => frame._tag === "delta")
      // Re-listing or re-reading the whole workspace for one new run turns a
      // live dashboard into work proportional to workspace size per event.
      expect(delta?._tag).toBe("delta")
      if (delta?._tag !== "delta") return
      expect(delta.delta).toMatchObject([{ runId: "run-2", status: "running" }])
      expect(nonFollowingReads).toBe(1)
    }))

  it.effect("suppresses the replayed workspace prefix", () =>
    Effect.gen(function*() {
      const history = [
        event(1, "control.run.accepted", { runId: run.runId }),
        event(1, "control.lineage.disclosed", { runId: run.runId }),
        event(2, "control.run.running", { runId: run.runId })
      ]
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: () => Stream.fromIterable(history)
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      // An unscoped control follow replays every partition. Re-emitting that
      // prefix would send rows the snapshot already delivered.
      expect(frames.filter((frame) => frame._tag === "delta")).toEqual([])
    }))

  it.effect("skips an unlistable followed run without ending the workspace subscription", () =>
    Effect.gen(function*() {
      const second = { ...numberedRun(2), status: "running" } satisfies RunSummary
      const missing: ControlEvent = {
        ...event(1, "control.run.accepted", { runId: "run-missing" }),
        runId: "run-missing"
      }
      const accepted: ControlEvent = {
        ...event(1, "control.run.accepted", { runId: second.runId }),
        runId: second.runId
      }
      const projections = make(
        control({
          list: (request) =>
            Effect.succeed({
              _tag: "runs",
              items: request._tag === "runs" && request.filters?.runId === second.runId ? [second] : []
            }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable([missing, accepted])
              : filter.runId === second.runId
              ? Stream.fromIterable([accepted])
              : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      const deltas = frames.filter((frame) => frame._tag === "delta")
      // A journal notification can race visibility in the run listing. That
      // one row must not kill the subscription before the next visible run.
      expect(deltas).toHaveLength(1)
      expect(deltas[0]?.delta).toMatchObject([{ runId: "run-2" }])
    }))

  it.effect("reads the newest runs and admits a new run at the workspace ceiling by evicting the oldest", () =>
    Effect.gen(function*() {
      const dated = (ordinal: number): RunSummary => ({ ...numberedRun(ordinal), createdAt: ordinal })
      // The listing is newest first, as the control plane answers order: "newest".
      const initial = Array.from(
        { length: Projections.maxWorkspaceRuns },
        (_, index) => dated(Projections.maxWorkspaceRuns + 1 - index)
      )
      const extra = dated(Projections.maxWorkspaceRuns + 2)
      const older = dated(1)
      const acceptedOf = (runId: string): ControlEvent => ({
        ...event(1, "control.run.accepted", { runId }),
        runId
      })
      const orders: Array<string | undefined> = []
      const projections = make(
        control({
          list: (request) => {
            const named = request._tag === "runs" ? request.filters?.runId : undefined
            if (request._tag === "runs" && named === undefined) orders.push(request.order)
            return Effect.succeed({
              _tag: "runs",
              items: named === extra.runId
                ? [extra]
                : named === older.runId
                ? [older]
                : named === undefined
                ? initial
                : initial.filter((run) => run.runId === named)
            })
          },
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable([acceptedOf("missing-run"), acceptedOf(older.runId), acceptedOf(extra.runId)])
              : filter.runId === extra.runId
              ? Stream.fromIterable([acceptedOf(extra.runId)])
              : filter.runId === older.runId
              ? Stream.fromIterable([acceptedOf(older.runId)])
              : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      // Folding the oldest page would hide every run launched after it.
      expect(orders).toEqual(["newest"])
      const deltas = frames.filter((frame) => frame._tag === "delta")
      expect(deltas).toHaveLength(1)
      const ids = (deltas[0]?.delta as ReadonlyArray<{ readonly runId: string }>).map((row) => row.runId)
      // The ceiling still bounds the followed runs, and a new run displaces
      // the oldest one while a run older than every followed run stays out.
      expect(ids).toHaveLength(Projections.maxWorkspaceRuns)
      expect(ids).toContain(extra.runId)
      expect(ids).not.toContain(older.runId)
      expect(ids).not.toContain("missing-run")
      expect(ids).not.toContain("run-2")
    }))

  it.effect("delivers new gates to an unscoped approvals inbox", () =>
    Effect.gen(function*() {
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => filter.follow === true ? Stream.fromIterable([approvalRequested]) : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
      const delta = frames.find((frame) => frame._tag === "delta")
      // Without workspace deltas, an operator never sees a gate requested
      // after the approvals inbox snapshot was read.
      expect(delta?._tag).toBe("delta")
      if (delta?._tag !== "delta") return
      expect(delta.cursor).toEqual({
        selector: { _tag: "approvals" },
        projection: "approvals",
        runId: null,
        value: 0,
        offset: 0
      })
      expect(delta.delta).toMatchObject([{ runId: "run-1", requestId: "gate", status: "pending" }])
    }))

  it.effect("removes a resolved run from the live approvals inbox", () =>
    Effect.gen(function*() {
      const approved = event(2, "control.approval.approved", { tokenId: "gate" })
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable([approvalRequested, approved])
              : Stream.fromIterable([approvalRequested])
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
      const deltas = frames.filter((frame) => frame._tag === "delta")
      expect(deltas).toHaveLength(1)
      expect(deltas[0]?.delta).toEqual([])
    }))

  it.effect("remembers irrelevant histories and missing plan partitions during replay", () =>
    Effect.gen(function*() {
      for (const selector of [{ _tag: "approvals" }, { _tag: "workspace-runs" }] as const) {
        let reads = 0
        let missingLookups = 0
        const history = Array.from({ length: 20 }, (_, index) => event(index >> 1, "control.run.completed", null))
        const plans = history.map((item) => ({ ...item, runId: "plan:missing" }))
        const projections = make(control({
          list: (request) => {
            const named = request._tag === "runs" ? request.filters?.runId : undefined
            if (named === "plan:missing") missingLookups += 1
            return Effect.succeed({
              _tag: "runs",
              items: named === run.runId ? [{ ...run, status: "completed" }] : []
            })
          },
          watch: (filter) => {
            if (filter.follow) return Stream.fromIterable([...history, ...plans])
            reads += 1
            return Stream.fromIterable(history)
          }
        }))
        yield* Stream.runDrain(projections.subscribe(selector))
        expect(reads).toBe(1)
        expect(missingLookups).toBe(1)
      }
    }))

  it.effect("removes cancelled runs with pending gates and rejects them on admission", () =>
    Effect.gen(function*() {
      for (const seeded of [true, false]) {
        let following = false
        const cancelled = event(2, "control.run.cancelled", { runId: run.runId })
        const projections = make(control({
          list: (request) => {
            const named = request._tag === "runs" ? request.filters?.runId : undefined
            const current: RunSummary = following ? { ...run, status: "cancelled" } : run
            return Effect.succeed({
              _tag: "runs",
              items: named === undefined
                ? seeded && current.status === "waiting-approval" ? [current] : []
                : [current]
            })
          },
          watch: (filter) => {
            if (!filter.follow) return Stream.fromIterable([approvalRequested])
            following = true
            return Stream.fromIterable([approvalRequested, cancelled])
          }
        }))
        const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
        const deltas = frames.filter((frame) => frame._tag === "delta")
        expect(deltas.map((frame) => frame.delta)).toEqual(seeded ? [[]] : [])
        expect((yield* projections.snapshot({ _tag: "approvals" })).rows).toEqual([])
      }
    }))

  it.effect("checks reconciled status before admitting a snapshot gate", () =>
    Effect.gen(function*() {
      const projections = make(control({
        list: (request) =>
          Effect.succeed({
            _tag: "runs",
            items: [request._tag === "runs" && request.filters?.runId ? { ...run, status: "cancelled" } : run]
          }),
        watch: () => Stream.fromIterable([approvalRequested])
      }))
      expect((yield* projections.snapshot({ _tag: "approvals" })).rows).toEqual([])
    }))

  // Live clock: the parking event must arrive after the first coalesced batch
  // has judged the run, or the follower never holds a verdict to reconsider.
  it.live("reconsiders a judged run when it parks on a pending approval", () =>
    Effect.gen(function*() {
      let parked = false
      let reads = 0
      let lookups = 0
      const judged = yield* Deferred.make<void>()
      const waiting = event(2, "control.run.waiting-approval", { runId: run.runId })
      const projections = make(control({
        list: (request) =>
          Effect.gen(function*() {
            const named = request._tag === "runs" && request.filters?.runId !== undefined
            // The second named lookup is the reconciling re-read that ends the
            // first admission, so the verdict is settled before the run parks.
            if (named && (lookups += 1) === 2) yield* Deferred.succeed(judged, undefined)
            return {
              _tag: "runs",
              items: named ? [{ ...run, status: parked ? "waiting-approval" : "running" }] : []
            } satisfies ListResponse
          }),
        watch: (filter) => {
          if (!filter.follow) {
            reads += 1
            return Stream.fromIterable(parked ? [approvalRequested, waiting] : [approvalRequested])
          }
          return Stream.concat(
            Stream.succeed(approvalRequested),
            Stream.fromEffect(Effect.map(Deferred.await(judged), () => {
              parked = true
              return waiting
            }))
          )
        }
      }))
      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
      const deltas = frames.filter((frame) => frame._tag === "delta")
      expect(reads).toBe(2)
      expect(deltas).toHaveLength(1)
      expect(deltas[0]?.delta).toMatchObject([{ requestId: "gate", status: "pending" }])
    }))

  it.effect("bounds retained workspace state across ignored and removed runs", () =>
    Effect.gen(function*() {
      const count = Projections.maxWorkspaceRuns * 2 + 1
      const summaries = new Map<string, RunSummary>()
      const histories = new Map<string, ReadonlyArray<ControlEvent>>()
      const followed: Array<ControlEvent> = []
      for (let index = 0; index < count; index += 1) {
        const runId = `retained-${index}`
        const relevant = index % 2 === 0
        summaries.set(runId, { ...run, runId, status: relevant ? "waiting-approval" : "completed" })
        const first = relevant
          ? {
            ...approvalRequested,
            runId,
            payload: {
              ...approvalRequested.payload as Record<string, unknown>,
              runId,
              payload: {
                target: {
                  _tag: "Node",
                  runId,
                  requestId: "gate",
                  digest: "d",
                  envelope: { capabilities: [], flows: [], budget: {} }
                },
                scope: "run",
                idempotencyKey: "k"
              }
            } as ControlEvent["payload"]
          }
          : { ...event(1, "control.run.completed", null), runId }
        histories.set(runId, [first])
        followed.push(first)
        if (relevant) followed.push({ ...event(2, "control.approval.approved", { tokenId: "gate" }), runId })
      }
      const NativeMap = globalThis.Map
      let peak = 0
      class ObservedMap<K, V> extends NativeMap<K, V> {
        override set(key: K, value: V): this {
          super.set(key, value)
          if (typeof key === "string" && key.startsWith("retained-")) peak = Math.max(peak, this.size)
          return this
        }
      }
      const projections = make(control({
        list: (request) => {
          const named = request._tag === "runs" ? request.filters?.runId : undefined
          return Effect.succeed({ _tag: "runs", items: named === undefined ? [] : [summaries.get(named)!] })
        },
        watch: (filter) => Stream.fromIterable(filter.follow ? followed : histories.get(filter.runId!) ?? [])
      }))
      try {
        globalThis.Map = ObservedMap
        const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
        const deltas = frames.filter((frame) => frame._tag === "delta")
        // 1502 followed events span two coalesced batches of 1024, and every
        // admitted gate was approved by the end, so the inbox finishes empty.
        expect(deltas).toHaveLength(2)
        expect(deltas.at(-1)?.delta).toEqual([])
        expect(peak).toBeGreaterThan(0)
        expect(peak).toBeLessThanOrEqual(Projections.maxWorkspaceRuns)
      } finally {
        globalThis.Map = NativeMap
      }
    }))

  it.effect("checks workspace replay positions without scanning the retained history", () =>
    Effect.gen(function*() {
      const history = Array.from({ length: 200 }, (_, index) => event(index >> 1, "control.run.accepted", null))
      let following = false
      let visits = 0
      const originalMap = Array.prototype.map
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: (filter) => {
          if (filter.follow) following = true
          return Stream.fromIterable(history)
        }
      }))
      try {
        Array.prototype.map = function(this: Array<ControlEvent>, callback, thisArg) {
          if (following && this.length === history.length && this[0]?.kind === "control.run.accepted") {
            visits += this.length
          }
          return originalMap.call(this, callback, thisArg)
        } as typeof Array.prototype.map
        const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
        expect(frames.filter((frame) => frame._tag === "delta")).toEqual([])
        expect(visits).toBe(0)
      } finally {
        Array.prototype.map = originalMap
      }
    }))

  it.effect("does not let irrelevant followed runs exhaust the approvals inbox", () =>
    Effect.gen(function*() {
      const irrelevant = Array.from({ length: Projections.maxWorkspaceRuns }, (_, index) => {
        const runId = `completed-${index + 1}`
        return {
          run: { ...numberedRun(index + 1), runId, status: "completed" as const },
          event: { ...event(1, "control.run.completed", { runId }), runId }
        }
      })
      const waiting = { ...run, runId: "waiting-last" }
      const requested = {
        sequence: 1,
        kind: "control.approval.requested",
        runId: waiting.runId,
        occurredAt: 1,
        payload: {
          runId: waiting.runId,
          requestId: "gate",
          question: "Ship?",
          payload: {
            target: {
              _tag: "Node",
              runId: waiting.runId,
              requestId: "gate",
              digest: "d",
              envelope: { capabilities: [], flows: [], budget: {} }
            },
            scope: "run",
            idempotencyKey: "k"
          }
        }
      } satisfies ControlEvent
      const histories = new Map<string, ReadonlyArray<ControlEvent>>([
        ...irrelevant.map(({ event }) => [event.runId!, [event]] as const),
        [waiting.runId, [requested]]
      ])
      const summaries = new Map([
        ...irrelevant.map(({ run }) => [run.runId, run] as const),
        [waiting.runId, waiting]
      ])
      const projections = make(
        control({
          list: (request) => {
            const runId = request._tag === "runs" ? request.filters?.runId : undefined
            return Effect.succeed({
              _tag: "runs",
              items: runId === undefined ? [] : [summaries.get(runId)!]
            })
          },
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable([...irrelevant.map(({ event }) => event), requested])
              : Stream.fromIterable(histories.get(filter.runId ?? "") ?? [])
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
      const deltas = frames.filter((frame) => frame._tag === "delta")
      expect(deltas).toHaveLength(1)
      expect(deltas[0]?.delta).toMatchObject([{ runId: waiting.runId, requestId: "gate", status: "pending" }])
    }))

  it.effect("keeps the approvals inbox at its ceiling and shows the newest gate when every run is relevant", () =>
    Effect.gen(function*() {
      const requestFor = (runId: string): ControlEvent => ({
        sequence: 1,
        kind: "control.approval.requested",
        runId,
        occurredAt: 1,
        payload: {
          runId,
          requestId: `gate-${runId}`,
          question: "Ship?",
          payload: {
            target: {
              _tag: "Node",
              runId,
              requestId: `gate-${runId}`,
              digest: "d",
              envelope: { capabilities: [], flows: [], budget: {} }
            },
            scope: "run",
            idempotencyKey: `approve:${runId}`
          }
        }
      })
      const initial = Array.from({ length: Projections.maxWorkspaceRuns }, (_, index) => ({
        ...numberedRun(index + 1),
        status: "waiting-approval" as const
      }))
      const extra = { ...numberedRun(Projections.maxWorkspaceRuns + 1), status: "waiting-approval" as const }
      const histories = new Map(initial.map((item) => [item.runId, [requestFor(item.runId)]] as const))
      histories.set(extra.runId, [requestFor(extra.runId)])
      const projections = make(
        control({
          list: (request) => {
            const named = request._tag === "runs" ? request.filters?.runId : undefined
            return Effect.succeed({
              _tag: "runs",
              items: named === extra.runId
                ? [extra]
                : named === undefined
                ? initial
                : initial.filter((run) => run.runId === named)
            })
          },
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable(histories.get(extra.runId)!)
              : Stream.fromIterable(histories.get(filter.runId ?? "") ?? [])
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
      expect(frames.filter((frame) => frame._tag === "row")).toHaveLength(Projections.maxWorkspaceRuns)
      const deltas = frames.filter((frame) => frame._tag === "delta")
      expect(deltas).toHaveLength(1)
      const ids = (deltas[0]?.delta as ReadonlyArray<{ readonly runId: string }>).map((row) => row.runId)
      expect(ids).toHaveLength(Projections.maxWorkspaceRuns)
      expect(ids).toContain(extra.runId)
    }))

  it.effect("resumes after a run cursor without emitting snapshot frames", () =>
    Effect.gen(function*() {
      const history = [
        event(0, "control.run.accepted", { runId: "run-1" }),
        event(1, "control.run.running", { runId: "run-1" }),
        event(2, "control.run.completed", { runId: "run-1" })
      ]
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
              : Stream.fromIterable(history)
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe(
        { _tag: "run-events", runId: "run-1" },
        issuedCursor({ _tag: "run-events", runId: "run-1" }, 0)
      ))
      expect(frames.map((frame) => frame._tag)).toEqual(["delta", "delta"])
      expect(frames.flatMap((frame) => frame._tag === "delta" ? [frame.cursor.value] : [])).toEqual([1, 2])
      // The fold is seeded with the events up to the cursor, so a resumed
      // subscription is not a projection of the tail alone.
      expect(frames.flatMap((frame) => frame._tag === "delta" ? [frame.delta] : [])).toEqual([
        [history[1]],
        [history[2]]
      ])
    }))

  it.effect("resumes within one journal sequence without dropping derived events", () =>
    Effect.gen(function*() {
      const history = [
        event(0, "control.run.accepted", { runId: "run-1" }),
        event(0, "control.lineage.disclosed", { runId: "run-1" }),
        event(1, "control.run.running", { runId: "run-1" })
      ]
      const selector = { _tag: "run-events" as const, runId: "run-1" }
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
              : Stream.fromIterable(history)
        }),
        { heartbeatMillis: 60_000 }
      )

      const suffix = yield* projections.snapshot(selector, issuedCursor(selector, 0, 0))
      expect(suffix.rows).toEqual([history[1], history[2]])
      expect(suffix.cursor).toEqual(issuedCursor(selector, 1, 0))
      const summarySelector = { _tag: "run-summary" as const, runId: "run-1" }
      const refused = yield* Effect.flip(projections.snapshot(summarySelector, issuedCursor(summarySelector, 0, 0)))
      expect(refused.code).toBe("malformed_request")

      const frames = yield* Stream.runCollect(projections.subscribe(selector, issuedCursor(selector, 0, 0)))
      expect(frames.flatMap((frame) => frame._tag === "delta" ? [[frame.cursor.value, frame.cursor.offset]] : []))
        .toEqual([[0, 1], [1, 0]])
      expect(frames.flatMap((frame) => frame._tag === "delta" ? frame.delta : []))
        .toEqual([
          history[1],
          history[2]
        ])
    }))

  it.effect("refuses a node-output cursor for a different node in the same run", () =>
    Effect.gen(function*() {
      const history = [
        event(1, "control.agent.cell-call-started", { flowName: "one" }),
        event(2, "control.agent.cell-call-settled", { flowName: "one", outcome: "success", value: "one" }),
        event(3, "control.agent.cell-call-started", { flowName: "two" }),
        event(4, "control.agent.cell-call-settled", { flowName: "two", outcome: "success", value: "two" })
      ]
      let follows = 0
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: (filter) => {
          if (filter.follow === true) follows += 1
          return filter.follow === true ? Stream.empty : Stream.fromIterable(history)
        }
      }))
      const first = { _tag: "node-output" as const, runId: "run-1", nodeId: "call-1" }
      const second = { ...first, nodeId: "call-2" }
      const cursor = (yield* projections.snapshot(first)).cursor
      const failure = yield* Effect.flip(Stream.runCollect(projections.subscribe(second, cursor)))

      expect(failure.code).toBe("malformed_request")
      expect(failure.message).toContain("exact selector")
      expect(follows).toBe(0)
    }))

  it.effect("refuses negative and fractional resume cursor values before following", () =>
    Effect.gen(function*() {
      const history = [event(1, "control.run.accepted", { runId: "run-1" })]
      let follows = 0
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => {
            if (filter.follow !== true) return Stream.fromIterable(history)
            follows += 1
            return Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      for (const value of [-1, 0.5]) {
        const failure = yield* Effect.flip(Stream.runCollect(projections.subscribe(
          { _tag: "run-events", runId: "run-1" },
          issuedCursor({ _tag: "run-events", runId: "run-1" }, value)
        )))
        expect(failure.code).toBe("malformed_request")
        expect(failure.message).toContain(String(value))
      }
      expect(follows).toBe(0)
    }))

  it.effect("refuses invalid offsets and structurally incomplete cursors before following", () =>
    Effect.gen(function*() {
      let follows = 0
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: (filter) => {
          if (filter.follow === true) follows += 1
          return Stream.empty
        }
      }))
      const selector = { _tag: "run-events" as const, runId: "run-1" }
      const invalid = [
        { ...issuedCursor(selector, 0), offset: -1 },
        { projection: "run-events", runId: "run-1", value: 0, offset: 0 }
      ]
      const messages: Array<string> = []
      for (const cursor of invalid) {
        const failure = yield* Effect.flip(
          Stream.runCollect(projections.subscribe(selector, cursor as GatewaySchema.ProjectionCursor))
        )
        messages.push(failure.message)
      }
      expect(messages[0]).toContain("offset -1")
      expect(messages[1]).toContain("not a valid gateway cursor")
      expect(follows).toBe(0)
    }))

  it.effect("a snapshot row's cursor is the read position, so a cut mid-snapshot cannot resume the rest", () =>
    Effect.gen(function*() {
      // docs/guides/follow-a-run.md: buffer snapshot rows until snapshot-end
      // and commit the cursor only with the complete snapshot. This pins the
      // contract that makes the rule necessary: every snapshot frame carries
      // the position the whole read reached, not progress through delivery,
      // so a client that resumes from a row it received before the socket
      // dropped is answered with the deltas past the snapshot and never sees
      // the rows it missed.
      const history = [1, 2, 3].map((sequence) => event(sequence, "control.run.accepted", { runId: "run-1" }))
      const selector = { _tag: "run-events" as const, runId: "run-1" }
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
              : Stream.fromIterable(history)
        }),
        { heartbeatMillis: 60_000 }
      )

      const cut = yield* Stream.runCollect(Stream.take(projections.subscribe(selector), 2))
      const start = cut[0]
      const firstRow = cut[1]
      if (start?._tag !== "snapshot-start" || firstRow?._tag !== "row") return yield* Effect.die("expected a row")
      expect((firstRow.row as ControlEvent).sequence).toBe(1)
      expect(firstRow.cursor).toEqual(start.cursor)
      expect(firstRow.cursor.value).toBe(3)

      const resumed = yield* Stream.runCollect(projections.subscribe(selector, firstRow.cursor))
      expect(resumed.map((frame) => frame._tag)).toEqual([])

      const whole = yield* Stream.runCollect(Stream.take(projections.subscribe(selector), 5))
      expect(whole.map((frame) => frame._tag)).toEqual(["snapshot-start", "row", "row", "row", "snapshot-end"])
      const end = whole.at(-1)
      expect(end?._tag === "snapshot-end" ? end.cursor : undefined).toEqual(firstRow.cursor)
    }))

  it.effect("accepts the zero origin and refuses a position the run never issued", () =>
    Effect.gen(function*() {
      const history = [event(1, "control.run.accepted", { runId: "run-1" })]
      const selector = { _tag: "run-events" as const, runId: "run-1" }
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
              : Stream.fromIterable(history)
        }),
        { heartbeatMillis: 60_000 }
      )

      const resumed = yield* Stream.runCollect(projections.subscribe(selector, issuedCursor(selector, 0)))
      expect(resumed.flatMap((frame) => frame._tag === "delta" ? [frame.cursor.value] : [])).toEqual([1])
      const failure = yield* Effect.flip(
        Stream.runCollect(projections.subscribe(selector, issuedCursor(selector, 0, 1)))
      )
      expect(failure.code).toBe("malformed_request")
      expect(failure.message).toContain("was not issued")
    }))

  it.effect("refuses a resume cursor ahead of the run's last sequence", () =>
    Effect.gen(function*() {
      const history = [
        event(1, "control.run.accepted", { runId: "run-1" }),
        event(2, "control.run.running", { runId: "run-1" })
      ]
      let follows = 0
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => {
            if (filter.follow !== true) return Stream.fromIterable(history)
            follows += 1
            return Stream.empty
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      const failure = yield* Effect.flip(Stream.runCollect(projections.subscribe(
        { _tag: "run-events", runId: "run-1" },
        issuedCursor({ _tag: "run-events", runId: "run-1" }, 3)
      )))
      expect(failure.code).toBe("malformed_request")
      expect(failure.message).toContain("3")
      expect(failure.message).toContain("2")
      expect(follows).toBe(0)
    }))

  it.effect("refuses a positive resume cursor for a run with no events", () =>
    Effect.gen(function*() {
      let follows = 0
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => {
            if (filter.follow === true) follows += 1
            return Stream.empty
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      const failure = yield* Effect.flip(Stream.runCollect(projections.subscribe(
        { _tag: "run-events", runId: "run-1" },
        issuedCursor({ _tag: "run-events", runId: "run-1" }, 1)
      )))
      expect(failure.code).toBe("malformed_request")
      expect(failure.message).toContain("1")
      expect(failure.message).toContain("0")
      expect(follows).toBe(0)
    }))

  for (
    const [name, selector, after, message] of [
      [
        "a different projection",
        { _tag: "run-events", runId: "run-1" },
        issuedCursor({ _tag: "transcript", runId: "run-1" }, 1),
        "projection"
      ],
      [
        "a different run",
        { _tag: "run-events", runId: "run-1" },
        { ...issuedCursor({ _tag: "run-events", runId: "run-1" }, 1), runId: "run-2" },
        "run"
      ],
      [
        "a different selector tag with the same projection field",
        { _tag: "run-events", runId: "run-1" },
        { ...issuedCursor({ _tag: "transcript", runId: "run-1" }, 1), projection: "run-events" },
        "exact selector"
      ],
      [
        "a different approval selector with the same run field",
        { _tag: "approvals", runId: "run-1" },
        { ...issuedCursor({ _tag: "approvals", runId: "run-2" }, 1), runId: "run-1" },
        "exact selector"
      ],
      [
        "a workspace projection",
        { _tag: "workspace-runs" },
        issuedCursor({ _tag: "workspace-runs" }, 0),
        "workspace"
      ],
      [
        "a cursor that names no run",
        { _tag: "run-events", runId: "run-1" },
        { ...issuedCursor({ _tag: "run-events", runId: "run-1" }, 1), runId: null },
        "for run none"
      ]
    ] as const satisfies ReadonlyArray<
      readonly [
        string,
        GatewaySchema.ProjectionSelector,
        GatewaySchema.ProjectionCursor,
        string
      ]
    >
  ) {
    it.effect(`refuses a resume cursor for ${name}`, () =>
      Effect.gen(function*() {
        const projections = make(
          control({
            list: () => Effect.succeed({ _tag: "runs", items: [run] })
          }),
          { heartbeatMillis: 60_000 }
        )
        const failure = yield* Effect.flip(Stream.runCollect(Stream.take(projections.subscribe(selector, after), 1)))
        expect(failure.code).toBe("malformed_request")
        expect(failure.message).toContain(message)
      }))
  }

  it.live("keeps a workspace subscription open on keepalives alone", () =>
    Effect.gen(function*() {
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [] }),
          watch: (filter) => filter.follow === true ? Stream.never : Stream.empty
        }),
        { heartbeatMillis: 1 }
      )
      const frames = yield* Stream.runCollect(
        Stream.take(projections.subscribe({ _tag: "workspace-runs" }), 3)
      )
      // An empty workspace produces no delta, so the keepalive is what proves
      // its live follow remains connected while there is nothing to report.
      expect(frames.map((frame) => frame._tag)).toEqual(["snapshot-start", "snapshot-end", "heartbeat"])
      const heartbeat = frames[2]
      expect(heartbeat?._tag === "heartbeat" && typeof heartbeat.atMs).toBe("number")
    }))

  it.live("emits every declared gateway frame tag through subscriptions", () =>
    Effect.gen(function*() {
      const runFrames = yield* Stream.runCollect(
        make(
          control({
            list: () => Effect.succeed({ _tag: "runs", items: [run] }),
            watch: (filter) =>
              filter.follow === true
                ? Stream.fromIterable([event(2, "control.run.completed", { runId: "run-1" })])
                : Stream.fromIterable([approvalRequested])
          }),
          { heartbeatMillis: 60_000 }
        ).subscribe({ _tag: "run-summary", runId: "run-1" })
      )
      const workspaceFrames = yield* Stream.runCollect(Stream.take(
        make(
          control({
            list: () => Effect.succeed({ _tag: "runs", items: [] }),
            watch: (filter) => filter.follow === true ? Stream.never : Stream.empty
          }),
          { heartbeatMillis: 1 }
        ).subscribe({ _tag: "workspace-runs" }),
        3
      ))
      const emitted = new Set([...runFrames, ...workspaceFrames].map((frame) => frame._tag))
      const declared = new Set(
        GatewaySchema.GatewayFrame.members.map((member) => member.fields._tag.schema.literal)
      )
      expect(emitted).toEqual(declared)
    }))
})

describe("Projections delta failures", () => {
  it.effect("refuses backward sequences on run and workspace follows", () =>
    Effect.gen(function*() {
      const backward = [event(2, "control.test", null), event(1, "control.test", null)]
      for (
        const selector of [
          { _tag: "run-events" as const, runId: "run-1" },
          { _tag: "workspace-runs" as const }
        ]
      ) {
        const projections = make(
          control({
            list: () => Effect.succeed({ _tag: "runs", items: selector._tag === "workspace-runs" ? [] : [run] }),
            watch: (filter) => filter.follow === true ? Stream.fromIterable(backward) : Stream.empty
          }),
          { heartbeatMillis: 60_000 }
        )
        const failure = yield* Effect.flip(Stream.runCollect(projections.subscribe(selector)))
        expect(failure.code).toBe("run_unavailable")
        expect(failure.message).toContain("moved backward")
      }
    }))

  it.effect("reports a follow that broke mid-stream as a gateway refusal", () =>
    Effect.gen(function*() {
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fail(new Unavailable({ code: "unavailable", feature: "watch", ticket: "T-3" }))
              : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )
      const failure = yield* Effect.flip(
        Stream.runCollect(projections.subscribe({ _tag: "run-summary", runId: "run-1" }))
      )
      expect(failure.message).toBe("Following run-1 failed")
    }))

  it.effect("reports a workspace follow that broke mid-stream as a gateway refusal", () =>
    Effect.gen(function*() {
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fail(new Unavailable({ code: "unavailable", feature: "watch", ticket: "T-4" }))
              : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )
      // A broken workspace follow must become a typed refusal. Leaving the
      // snapshot open on keepalives would silently freeze every workspace view.
      const failure = yield* Effect.flip(
        Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      )
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toBe("Following the workspace failed")
      expect(failure.cause).toEqual({ _tag: "/control/Unavailable", code: "unavailable" })
    }))
})

describe("Projections keepalive cadence", () => {
  it("is the documented 30 seconds, twenty heartbeats inside the relay's idle cut", () => {
    // docs/api.md and docs/concepts/subscriptions.md publish both numbers: a
    // host sizing a relay's idle cut to them must not find the gateway
    // elsewhere. The relay drops an idle tunnel at 600 s.
    expect(Projections.heartbeatIntervalMillis).toBe(30_000)
    expect(600_000 / Projections.heartbeatIntervalMillis).toBeGreaterThanOrEqual(20)
  })
})

describe("snapshot read regressions", () => {
  for (
    const selector of [
      { _tag: "run-summary" as const, runId: "run-1" },
      { _tag: "workspace-runs" as const }
    ]
  ) {
    it.effect(`reconciles a completion during the ${selector._tag} history read`, () =>
      Effect.gen(function*() {
        let current: RunSummary = { ...run, status: "running" }
        const projections = make(control({
          list: () => Effect.succeed({ _tag: "runs", items: [current] }),
          watch: () =>
            Stream.unwrap(Effect.sync(() => {
              current = { ...current, status: "completed", updatedAt: 3 }
              return Stream.fromIterable([
                event(0, "control.run.running", { status: "running" }),
                event(1, "control.run.completed", { status: "completed" })
              ])
            }))
        }))
        const snapshot = yield* projections.snapshot(selector)
        expect(snapshot.rows[0]).toMatchObject({ status: "completed" })
        expect(snapshot.cursor.value).toBe(selector._tag === "run-summary" ? 1 : 0)
      }))
  }

  for (const resume of [false, true]) {
    it.effect(`delivers sequence zero from an empty seed (resume=${resume})`, () =>
      Effect.gen(function*() {
        const history = [event(0, "control.run.accepted", null), event(1, "control.run.running", null)]
        const selector = { _tag: "run-events" as const, runId: run.runId }
        const projections = make(control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow
              ? Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
              : Stream.empty
        }))
        const frames = yield* Stream.runCollect(
          projections.subscribe(selector, resume ? issuedCursor(selector, 0) : undefined)
        )
        expect(frames.flatMap<unknown>((frame) => frame._tag === "delta" ? frame.delta : [])).toEqual(history)
      }))
  }

  for (const mode of ["empty", "repeated", "cycle", "duplicate"] as const) {
    it.effect(`stops ${mode} list pagination`, () =>
      Effect.gen(function*() {
        let calls = 0
        const projections = make(control({
          list: (request) => {
            if (request._tag === "runs" && request.filters?.runId) {
              return Effect.succeed({
                _tag: "runs",
                items: [numberedRun(Number(request.filters.runId.slice(4)))]
              })
            }
            calls += 1
            return Effect.succeed({
              _tag: "runs",
              items: mode === "empty" ? [] : [numberedRun(mode === "duplicate" ? 1 : calls)],
              ...(calls >= 4
                ? {}
                : { nextCursor: (mode === "cycle" || mode === "duplicate") && calls === 2 ? "b" : "a" })
            })
          }
        }))
        yield* projections.snapshot({ _tag: "workspace-runs" })
        expect(calls).toBe(mode === "empty" ? 1 : mode === "repeated" || mode === "duplicate" ? 2 : 3)
      }))
  }

  it.effect("reads workspace journals with concurrency bounded at eight", () =>
    Effect.gen(function*() {
      const runs = Array.from({ length: 12 }, (_, index) => numberedRun(index + 1))
      let active = 0
      let peak = 0
      const projections = make(control({
        list: (request) =>
          Effect.succeed({
            _tag: "runs",
            items: request._tag === "runs" && request.filters?.runId
              ? runs.filter((run) => run.runId === request.filters?.runId) :
              runs
          }),
        watch: () =>
          Stream.unwrap(Effect.gen(function*() {
            active += 1
            peak = Math.max(peak, active)
            yield* Effect.yieldNow
            active -= 1
            return Stream.empty
          }))
      }))
      const snapshot = yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(snapshot.rows).toHaveLength(12)
      expect(peak).toBe(8)
    }))

  for (const operation of ["list", "history", "run-follow", "workspace-follow"] as const) {
    it.effect(`redacts ${operation} logger output`, () =>
      Effect.gen(function*() {
        const secret = "synthetic-private-credential"
        const failure = new PersistenceError({ operation: secret, message: secret, cause: { password: secret } })
        const messages: Array<unknown> = []
        const projections = make(control({
          list: () => operation === "list" ? Effect.fail(failure) : Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => operation === "history" || filter.follow ? Stream.fail(failure) : Stream.empty
        }))
        const selector = operation === "workspace-follow" ?
          { _tag: "workspace-runs" as const }
          : { _tag: "run-events" as const, runId: run.runId }
        const result = yield* Effect.flip(
          operation.endsWith("follow")
            ? Stream.runCollect(projections.subscribe(selector)).pipe(Effect.asVoid) :
            projections.snapshot(selector).pipe(Effect.asVoid)
        ).pipe(
          Effect.provide(Logger.layer([Logger.make(({ message }) => {
            messages.push(message)
          })]))
        )
        expect(result.code).toBe("run_unavailable")
        expect(messages).toHaveLength(1)
        expect(JSON.stringify(messages)).not.toContain(secret)
        expect(JSON.stringify(messages)).toContain("persistence_failed")
      }))
  }
})

describe("snapshot reconciliation bounds", () => {
  it.effect("refuses a run summary that changes throughout all eight attempts", () =>
    Effect.gen(function*() {
      let reads = 0
      const projections = make(control({
        list: () => Effect.sync(() => ({ _tag: "runs" as const, items: [{ ...run, updatedAt: reads++ }] }))
      }))
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "run-summary", runId: run.runId }))
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toContain("changed throughout")
      expect(reads).toBe(9)
    }))

  it.effect("does not log arbitrary backend tags or codes", () =>
    Effect.gen(function*() {
      const messages: Array<unknown> = []
      for (
        const failure of [
          { _tag: "private-tag", code: "private-code" },
          { _tag: "/control/PersistenceError", code: "private-code" },
          { _tag: "/control/Unavailable", code: "private-code" },
          "private-string"
        ]
      ) {
        yield* Effect.flip(
          make(control({ list: () => Effect.fail(failure as unknown as Unavailable) }))
            .snapshot({ _tag: "workspace-runs" })
        ).pipe(
          Effect.provide(Logger.layer([Logger.make(({ message }) => {
            messages.push(message)
          })]))
        )
      }
      expect(messages).toHaveLength(4)
      expect(JSON.stringify(messages)).not.toContain("private-")
    }))

  for (const listed of [false, true]) {
    it.effect(`admits sequence zero to an empty workspace journal (listed=${listed})`, () =>
      Effect.gen(function*() {
        const projections = make(control({
          list: (request) =>
            Effect.succeed({
              _tag: "runs",
              items: listed || request._tag === "runs" && request.filters?.runId ? [run] : []
            }),
          watch: (filter) =>
            filter.follow ? Stream.fromIterable([event(0, "control.run.accepted", null)]) : Stream.empty
        }))
        const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
        expect(frames.filter((frame) => frame._tag === "delta")).toHaveLength(1)
      }))
  }
})

describe("Projections delta cost", () => {
  it.effect("coalesces a workspace burst into one frame and re-reads only the changed runs", () =>
    Effect.gen(function*() {
      const runs = Array.from(
        { length: Projections.maxWorkspaceRuns },
        (_, index): RunSummary => ({ ...numberedRun(index + 1), status: "running" })
      )
      const byId = new Map(runs.map((candidate) => [candidate.runId, candidate]))
      const changedRuns = runs.slice(0, 5)
      const burst = changedRuns.flatMap((changed) =>
        Array.from({ length: 20 }, (_, index): ControlEvent => ({
          ...event(index + 1, "control.agent.turn-opened", { runId: changed.runId, seat: "opus" }),
          runId: changed.runId
        }))
      )
      let runLookups = 0
      let lookupsAtSnapshotEnd = 0
      const projections = make(
        control({
          list: (request) =>
            Effect.sync((): ListResponse => {
              if (request._tag !== "runs") return { _tag: "runs", items: [] }
              const runId = request.filters?.runId
              if (runId === undefined) return { _tag: "runs", items: runs }
              runLookups += 1
              const found = byId.get(runId)
              return { _tag: "runs", items: found === undefined ? [] : [found] }
            }),
          watch: (filter) => filter.follow === true ? Stream.fromIterable(burst) : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(
        projections.subscribe({ _tag: "workspace-runs" }).pipe(
          Stream.tap((frame) =>
            Effect.sync(() => {
              if (frame._tag === "snapshot-end") lookupsAtSnapshotEnd = runLookups
            })
          )
        )
      )
      const deltas = frames.filter((frame) => frame._tag === "delta")
      // A burst of a hundred events must not cost a hundred full-workspace
      // frames, and only the runs whose journals grew need their row re-read.
      expect(deltas).toHaveLength(1)
      const rows = deltas[0]?._tag === "delta" ? [...deltas[0].delta] : []
      expect(rows).toHaveLength(Projections.maxWorkspaceRuns)
      expect(rows.filter((row) => "turns" in row && row.turns === 20)).toHaveLength(changedRuns.length)
      expect(runLookups - lookupsAtSnapshotEnd).toBe(changedRuns.length)
    }))

  it.effect("starts transcript turns at one after non-transcript history and updates", () =>
    Effect.gen(function*() {
      const history = [event(1, "flow.step.started", {})]
      const following = [
        event(2, "flow.step.completed", {}),
        event(3, "control.agent.turn-opened", { runId: "run-1", seat: "opus" }),
        event(4, "control.agent.model-settled", { runId: "run-1", text: "first answer", usage: {} })
      ]
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => Stream.fromIterable(filter.follow === true ? following : history)
        }),
        { heartbeatMillis: 60_000 }
      )
      const selector = { _tag: "transcript", runId: "run-1" } as const
      const frames = yield* Stream.runCollect(projections.subscribe(selector, issuedCursor(selector, 1)))
      const sent = frames.flatMap((frame) => frame._tag === "delta" ? [...frame.delta] : [])
      expect(sent).toEqual(GatewayProjection.transcript([...history, ...following]))
      expect(sent).toHaveLength(2)
      expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ turn: 1 })]))
    }))

  it.effect("keeps resumed transcript deltas equivalent to a fold when identified calls repeat", () =>
    Effect.gen(function*() {
      const first = { runId: "run-1", flowName: "write", callId: "first", input: { path: "a" } }
      const second = { ...first, callId: "second", input: { path: "b" } }
      const history = [
        event(1, "control.agent.turn-opened", { runId: "run-1", seat: "opus" }),
        event(2, "control.agent.cell-call-started", first)
      ]
      const following = [
        event(3, "control.agent.cell-call-started", first),
        event(4, "control.agent.cell-call-started", second),
        event(5, "control.agent.cell-call-settled", { ...second, outcome: "failure", message: "denied" }),
        event(6, "control.agent.cell-call-settled", { ...first, outcome: "success", value: "done" }),
        event(7, "control.agent.cell-call-settled", { ...second, outcome: "failure", message: "denied" }),
        event(8, "control.agent.cell-call-started", { runId: "run-1", flowName: "read", input: {} }),
        event(9, "control.agent.cell-call-started", { runId: "run-1", flowName: "read", input: {} }),
        event(10, "control.agent.turn-opened", { runId: "run-1", seat: "opus" })
      ]
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => Stream.fromIterable(filter.follow === true ? following : history)
        }),
        { heartbeatMillis: 60_000 }
      )
      const selector = { _tag: "transcript", runId: "run-1" } as const
      const frames = yield* Stream.runCollect(projections.subscribe(selector, issuedCursor(selector, 2)))
      const deltas = frames.filter((frame) => frame._tag === "delta")
      const sent = deltas.flatMap((frame) => frame._tag === "delta" ? [...frame.delta] : [])
      expect([...GatewayProjection.transcript(history), ...sent])
        .toEqual(GatewayProjection.transcript([...history, ...following]))
      expect(deltas.map((frame) => frame._tag === "delta" ? frame.delta.length : -1))
        .toEqual([0, 1, 1, 1, 0, 1, 1, 1])
      expect(sent.at(-1)).toMatchObject({ turn: 2 })
    }))

  it.effect("resets a followed transcript when a committed call fact corrects already-delivered telemetry", () =>
    Effect.gen(function*() {
      const callId = `cell-call-v1:${"a".repeat(64)}`
      const history = [
        event(1, "control.agent.turn-opened", {}),
        event(2, "control.agent.cell-call-started", { callId, flowName: "write" }),
        event(3, "control.agent.cell-call-settled", {
          callId,
          flowName: "write",
          outcome: "success",
          value: "telemetry"
        })
      ]
      const following = [event(4, "control.engine.event", {
        version: 1,
        executionId: "native",
        generation: 0,
        sequence: 1,
        emittedAtMs: 40,
        sourceSequence: 0,
        sourceId: `call-fact-v1:${callId}:settled`,
        eventType: "flows.harness.call-fact.v1",
        payload: {
          version: 1,
          phase: "settled",
          callId,
          identity: { runId: "run-1", frame: 0, cell: "cell", ordinal: 0, declaration: "d", layers: [] },
          flowName: "write",
          outcome: "failure",
          value: null,
          message: "timeout"
        }
      })]
      const selector = { _tag: "transcript", runId: "run-1" } as const
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => Stream.fromIterable(filter.follow ? following : history)
        })
      )
      const frames = yield* Stream.runCollect(projections.subscribe(selector, issuedCursor(selector, 3)))
      let rows = [...GatewayProjection.transcript(history)]
      for (const frame of frames) {
        if (frame._tag === "snapshot-start") rows = []
        if (frame._tag === "row") rows.push(frame.row)
        if (frame._tag === "delta") rows.push(...frame.delta)
      }
      const fresh = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: () => Stream.fromIterable([...history, ...following])
        })
      )
      expect(rows).toEqual((yield* fresh.snapshot(selector)).rows)
      expect(rows.at(-1)?.text).toContain("FAIL timeout")
      expect(frames.map((frame) => frame._tag)).toEqual(["snapshot-start", "row", "row", "row", "snapshot-end"])
    }))

  it.effect("keeps native lifecycle replay and observations equal across resumed subscriptions and fresh snapshots", () =>
    Effect.gen(function*() {
      const accepted = { ...run, status: "accepted" as const, updatedAt: 1 }
      const nativeRoot = {
        executionId: "native" as never,
        flowName: "agent/run",
        status: "completed" as const,
        createdAtMs: 1 as never,
        startedAtMs: 2 as never,
        finishedAtMs: 3 as never,
        parentRunId: null,
        lineageId: "native" as never,
        roundOrdinal: 0 as never,
        cancelRequestedAtMs: null,
        waiting: null
      }
      const current = {
        ...nativeRoot,
        executionId: "round" as never,
        status: "suspended" as const,
        roundOrdinal: 1 as never,
        parentRunId: "native" as never,
        finishedAtMs: null,
        waiting: { reason: "approval", tokenDigest: "digest", wakeAtMs: null }
      }
      const observed = {
        ...accepted,
        status: "waiting-approval" as const,
        executionObservation: "observed" as const,
        executionView: { root: nativeRoot, current }
      }
      const nativeEvent = (sequence: number, observation: typeof nativeRoot | typeof current) =>
        event(sequence, "control.engine.event", {
          version: 1,
          executionId: observation.executionId,
          generation: 0,
          sequence: 0,
          eventType: "flows.engine.run-decision",
          payload: { decision: "created", executionFact: { version: 1, baseline: "created", observation } }
        })
      const history = [
        event(1, "control.run.accepted", ControlFacts.runFact(accepted, "created")),
        event(2, "control.engine.bound", { version: 1, controlRunId: run.runId, executionId: "native" }),
        nativeEvent(3, nativeRoot)
      ]
      const following = [nativeEvent(4, current)]
      let refreshed = false
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [observed] }),
          watch: (filter) =>
            Stream.fromIterable(filter.follow ? following : refreshed ? [...history, ...following] : history)
        }),
        { heartbeatMillis: 60_000 }
      )
      const selector = { _tag: "run-summary", runId: run.runId } as const
      const frames = yield* Stream.runCollect(projections.subscribe(selector, issuedCursor(selector, 3)))
      const deltas = frames.filter((frame) => frame._tag === "delta")
      refreshed = true
      const snapshot = yield* projections.snapshot(selector)
      expect(deltas.at(-1)?.delta).toEqual(snapshot.rows)
      expect(snapshot.rows[0]).toMatchObject({
        status: "waiting-approval",
        waitingReason: "approval",
        lineageId: "native",
        roundOrdinal: 0,
        lifecycleProvenance: { control: "events", execution: "engine-observed" },
        executionProvenance: { source: "events", rootExecutionId: "native", currentExecutionId: "round" }
      })
    }))

  it.effect("keeps current control lifecycle and approval deltas equal to fresh snapshots", () =>
    Effect.gen(function*() {
      const accepted = { ...run, status: "accepted" as const, updatedAt: 1 }
      const completed = { ...run, status: "completed" as const, updatedAt: 5 }
      const requestPayload = approvalRequested.payload as Record<string, unknown>
      const request = event(2, "control.approval.requested", { ...requestPayload, factVersion: 1 })
      const history = [event(1, "control.run.accepted", ControlFacts.runFact(accepted, "created")), request]
      const following = [
        event(3, "control.approval.approved", {
          factVersion: 1,
          tokenId: "gate",
          approvalTarget: (requestPayload.payload as { target: unknown }).target
        }),
        { ...request, sequence: 4 },
        event(5, "control.run.completed", ControlFacts.runFact(completed))
      ]
      let refreshed = false
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [completed] }),
          watch: (filter) =>
            Stream.fromIterable(filter.follow ? following : refreshed ? [...history, ...following] : history)
        }),
        { heartbeatMillis: 60_000 }
      )
      for (
        const selector of [{ _tag: "run-summary", runId: run.runId }, { _tag: "approvals", runId: run.runId }] as const
      ) {
        refreshed = false
        const frames = yield* Stream.runCollect(projections.subscribe(selector, issuedCursor(selector, 2)))
        const deltas = frames.filter((frame) => frame._tag === "delta")
        refreshed = true
        const snapshot = yield* projections.snapshot(selector)
        expect(deltas.at(-1)?.delta).toEqual(snapshot.rows)
        if (selector._tag === "run-summary") {
          expect(snapshot.rows[0]).toMatchObject({
            status: "completed",
            lifecycleProvenance: { control: "events", baseline: "created", throughSequence: 5 }
          })
        } else expect(snapshot.rows[0]).toMatchObject({ requestId: "gate", status: "approved" })
      }
    }))

  it.effect("appends transcript rows instead of re-sending the folded history", () =>
    Effect.gen(function*() {
      const history = Array.from({ length: 200 }, (_, index) =>
        index % 4 === 0
          ? event(index + 1, "control.agent.turn-opened", { runId: "run-1", seat: "opus" })
          : event(index + 1, "control.agent.model-settled", { runId: "run-1", text: "done", usage: {} }))
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            Stream.fromIterable(
              filter.follow === true ? history.filter((entry) => entry.sequence > (filter.afterSequence ?? 0)) : history
            )
        }),
        { heartbeatMillis: 60_000 }
      )
      const selector = { _tag: "transcript", runId: "run-1" } as const
      const after: GatewaySchema.ProjectionCursor = {
        selector,
        projection: "transcript",
        runId: "run-1",
        value: 50,
        offset: 0
      }

      const frames = yield* Stream.runCollect(projections.subscribe(selector, after))
      const deltas = frames.filter((frame) => frame._tag === "delta")
      expect(deltas).toHaveLength(150)
      // Each row is immutable once folded, so catching up on E events sends E
      // rows, not E squared, and the rows still fold to the same transcript.
      const sent = deltas.flatMap((frame) => frame._tag === "delta" ? [...frame.delta] : [])
      expect(sent).toHaveLength(150)
      expect(sent).toEqual(GatewayProjection.transcript(history).slice(50))
    }))
})

describe("Projections approvals inbox over nested human waits", () => {
  /**
   * The run tree run-3 actually had: the root and two executions between it
   * and the one holding the question. `@smthrs/control` rolls the wait onto
   * every ancestor, so an inbox that took each run's rows at face value listed
   * the same question three times.
   */
  const wait = {
    runId: "prepare-plan",
    reason: "approval",
    token: "wait-token",
    name: "coding-clarification",
    attempt: 1,
    createdAt: 42,
    request: { task: "human", name: "coding-clarification", kind: "ask", prompt: "Which service?", maxAttempts: 3 }
  } as const

  const tree: ReadonlyArray<RunSummary> = ["run-3", "request", "prepare-plan"].map((runId, index) => ({
    runId,
    flowId: `coding/${runId}`,
    status: "waiting-approval",
    createdAt: index,
    updatedAt: index,
    pendingWaits: [wait]
  }))

  /** A fourth run holding one decided gate beside one still open. */
  const decided: RunSummary = {
    runId: "run-1",
    flowId: "deploy",
    status: "waiting-approval",
    createdAt: 9,
    updatedAt: 9
  }
  const secondGate = event(2, "control.approval.requested", {
    runId: "run-1",
    requestId: "gate-2",
    question: "And this?",
    payload: {
      target: {
        _tag: "Node",
        runId: "run-1",
        requestId: "gate-2",
        digest: "d",
        envelope: { capabilities: [], flows: [], budget: {} }
      },
      scope: "run",
      idempotencyKey: "k2"
    }
  })
  const listed = [...tree, decided]

  const treeControl = control({
    list: (request) =>
      Effect.succeed(
        {
          _tag: "runs",
          items: request._tag === "runs" && request.filters?.runId !== undefined
            ? listed.filter((item) => item.runId === request.filters?.runId)
            : [...listed]
        } satisfies ListResponse
      ),
    watch: (filter) =>
      filter.runId === "run-1"
        ? Stream.fromIterable([
          approvalRequested,
          secondGate,
          event(3, "control.approval.approved", { tokenId: "gate" })
        ])
        : Stream.empty
  })

  it.effect("lists the nested gate for the run an operator opened", () =>
    Effect.gen(function*() {
      const rows = (yield* make(treeControl).snapshot({ _tag: "approvals", runId: "run-3" })).rows
      expect(rows).toMatchObject([{
        runId: "run-3",
        requestId: "coding-clarification#1",
        title: "Which service?",
        status: "pending"
      }])
    }))

  it.effect("lists one question in the workspace inbox, not one per ancestor", () =>
    Effect.gen(function*() {
      const rows = (yield* make(treeControl).snapshot({ _tag: "approvals" })).rows
      // The outermost run owns the question: the control plane lists runs in
      // creation order and an ancestor exists before what it spawned. The
      // decided gate beside it is not in the inbox at all — an inbox lists what
      // is still owed, and a run card is where a settled gate stays readable.
      expect(rows).toMatchObject([
        { runId: "run-3", requestId: "coding-clarification#1" },
        { runId: "run-1", requestId: "gate-2" }
      ])
    }))
})

/**
 * What the bounded window does with a payload it cannot hold, a journal that
 * moves backward, and a read that finds nothing at all. Each of these is a
 * control plane behaving badly or a run behaving unusually, so none of them
 * can be produced against the real plane beside this suite.
 */
describe("Projections window accounting", () => {
  it.effect("reports position zero for a run whose journal is still empty", () =>
    Effect.gen(function*() {
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: () => Stream.empty
      }))

      const page = yield* projections.snapshot({ _tag: "run-events", runId: run.runId })
      expect(page.rows).toEqual([])
      // Nothing was read and no cursor was given, so the next page starts at
      // the journal's beginning rather than at an invented position.
      expect(page.cursor).toMatchObject({ value: 0, offset: 0 })
    }))

  it.effect("refuses a journal that moves backward on every selector, not only the page", () =>
    Effect.gen(function*() {
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: () => Stream.fromIterable([event(2, "control.test", null), event(1, "control.test", null)])
      }))

      expect((yield* Effect.flip(projections.snapshot({ _tag: "run-summary", runId: run.runId }))).code)
        .toBe("run_unavailable")
    }))

  it.effect("clips inside an array without changing the payload's shape", () =>
    Effect.gen(function*() {
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: () =>
          Stream.succeed(event(1, "control.test", { lines: ["x".repeat(Projections.maxEventBytes * 2), "short"] }))
      }))

      const page = yield* projections.snapshot({ _tag: "run-events", runId: run.runId })
      const payload = (page.rows[0] as ControlEvent).payload as { readonly lines: ReadonlyArray<string> }
      // An array keeps its length and a clipped string is still a string, so
      // the retained payload is still decodable by every reader of it.
      expect(payload.lines).toHaveLength(2)
      expect(payload.lines[1]).toBe("short")
      expect(payload.lines[0]!.endsWith("…")).toBe(true)
      expect(new TextEncoder().encode(JSON.stringify(page.rows[0])).byteLength)
        .toBeLessThanOrEqual(Projections.maxEventBytes)
    }))

  it.effect("replaces a payload whose size is in its shape instead of its text", () =>
    Effect.gen(function*() {
      const wide = Object.fromEntries(Array.from({ length: 4_000 }, (_, index) => [`key-${index}`, index]))
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: () => Stream.succeed(event(1, "control.test", wide))
      }))

      const page = yield* projections.snapshot({ _tag: "run-events", runId: run.runId })
      // Clipping text cannot shrink tens of thousands of short keys, and no
      // projection reads such a shape, so the payload is replaced outright.
      expect((page.rows[0] as ControlEvent).payload).toMatchObject({ truncated: true })
      expect(new TextEncoder().encode(JSON.stringify(page.rows[0])).byteLength)
        .toBeLessThanOrEqual(Projections.maxEventBytes)
    }))

  it.effect("empties the window for one event larger than all of it, with exact byte accounting", () =>
    Effect.gen(function*() {
      // Clipping bounds a payload, not the envelope around it. A control plane
      // that names a kind larger than the whole window still must not corrupt
      // the accounting that decides what the next event evicts.
      const colossal = event(1, `control.${"x".repeat(Projections.maxProjectionBytes)}`, null)
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: () => Stream.fromIterable([colossal, event(2, "control.agent.turn-opened", { seat: "opus" })])
      }))

      const summary = yield* projections.snapshot({ _tag: "run-summary", runId: run.runId })
      // The colossal event is folded into the carry and dropped; the ordinary
      // event after it is retained, and the counters still describe both.
      expect((summary.rows[0] as { readonly turns: number }).turns).toBe(1)
      expect(summary.cursor.value).toBe(2)
    }))
})
