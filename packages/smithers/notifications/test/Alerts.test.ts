/**
 * Alert policy over a real journal: which conditions a run's entries leave
 * open, when a policy raises them, and what makes a delivery happen exactly
 * once across a crash.
 *
 * The delay half runs on the test clock and the durability half on the real
 * SQLite journal. Both are the point: a policy that fired immediately would
 * page on every transient stall, and a delivery that lived in memory would
 * page twice after a restart.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Cause, Duration, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as Alerts from "../src/Alerts.ts"
import * as NotificationQueue from "../src/NotificationQueue.ts"

const runId = "run-1"

const policy: Alerts.Policy = {
  defaults: { severity: "warning", owner: "oncall" },
  rules: {
    "waiting-approval": { afterMs: 60_000, runbook: "https://runbook/approvals" },
    stalled: { afterMs: 30_000, severity: "critical" }
  }
}

const entry = (
  seq: number,
  emittedAtMs: number,
  eventType: string,
  payload: Record<string, unknown>
): JournalEvent.Entry =>
  new JournalEvent.Entry({
    runId: JournalEvent.RunId.make(runId),
    seq: JournalEvent.Seq.make(seq),
    eventId: `event-${seq}`,
    sourceId: JournalEvent.SourceId.make("/test"),
    sourceSeq: JournalEvent.SourceSeq.make(seq),
    emittedAtMs,
    eventType,
    payload,
    meta: {}
  })

describe("Alerts.conditions", () => {
  it("opens a condition at the entry that first reported it", () => {
    const open = Alerts.conditions(policy, runId, [
      entry(1, 1_000, "control.run.accepted", { status: "accepted" }),
      entry(2, 5_000, "control.run.parked", { status: "waiting-approval" }),
      entry(3, 9_000, "control.run.parked", { status: "waiting-approval" })
    ])

    // The SECOND report does not restart the clock: the run has been waiting
    // since the first one.
    expect(open).toEqual([{ runId, condition: "waiting-approval", since: 5_000 }])
  })

  it("closes a condition when the same field reports something else", () => {
    const open = Alerts.conditions(policy, runId, [
      entry(1, 5_000, "control.run.parked", { status: "waiting-approval" }),
      entry(2, 7_000, "control.run.resume", { status: "running" })
    ])

    expect(open).toEqual([])
  })

  it("keeps one condition's entries from closing another's", () => {
    const open = Alerts.conditions(policy, runId, [
      entry(1, 5_000, "control.run.parked", { status: "waiting-approval" }),
      entry(2, 6_000, "control.monitor.beat", { health: "stalled" }),
      entry(3, 7_000, "control.monitor.beat", { health: "healthy" })
    ])

    // The beat that cleared the stall says nothing about the approval.
    expect(open).toEqual([{ runId, condition: "waiting-approval", since: 5_000 }])
  })

  it("reads the default conditions only off control-plane entries", () => {
    const open = Alerts.conditions({ rules: { failed: { afterMs: 0 }, stalled: { afterMs: 0 } } }, runId, [
      entry(1, 1_000, "control.run.failed", { status: "failed" }),
      entry(2, 2_000, "control.monitor.beat", { health: "stalled" }),
      // A flow step or an agent trace shares the run's journal. A `status` or
      // `health` field it writes is not the control plane reporting the run.
      entry(3, 3_000, "flows.step.settled", { status: "succeeded" }),
      entry(4, 4_000, "agent.trace", { health: "healthy" }),
      entry(5, 5_000, "controlled.by.step", { status: "running" })
    ])

    expect(open).toEqual([
      { runId, condition: "failed", since: 1_000 },
      { runId, condition: "stalled", since: 2_000 }
    ])
  })

  it("ignores an entry that carries neither field", () => {
    const open = Alerts.conditions(policy, runId, [
      entry(1, 5_000, "control.run.parked", { status: "waiting-approval" }),
      entry(2, 6_000, "flows.engine.attempt-started", { action: "Review" })
    ])

    expect(open).toEqual([{ runId, condition: "waiting-approval", since: 5_000 }])
  })

  it("ignores a condition the policy has no rule for", () => {
    const open = Alerts.conditions(policy, runId, [entry(1, 5_000, "control.run.failed", { status: "failed" })])

    expect(open).toEqual([])
  })

  it("never reads its own delivery records as evidence about a condition", () => {
    const open = Alerts.conditions(policy, runId, [
      entry(1, 5_000, "control.run.parked", { status: "waiting-approval" }),
      // A refusal reports the HTTP status that refused the page. Read as
      // evidence it would close the very condition it paged about, and the
      // alert would fire again on the next tick, forever.
      entry(2, 6_000, Alerts.failedEventType, {
        runId,
        condition: "waiting-approval",
        code: "sink_rejected",
        status: 503
      }),
      entry(3, 7_000, Alerts.deliveredEventType, { runId, condition: "waiting-approval", status: 200 })
    ])

    expect(open).toEqual([{ runId, condition: "waiting-approval", since: 5_000 }])
  })

  it("reads a detector named after an Object.prototype member as an own property", () => {
    // `field in payload` is true for `toString` on every record `JSON.parse`
    // produced, so a detector named after a prototype member would treat every
    // entry in the run as evidence and close its condition on all of them.
    const inherited: Alerts.Policy = {
      rules: { "vendor-state": { afterMs: 0 } },
      detectors: { "vendor-state": { field: "toString", value: "degraded" } }
    }
    const open = Alerts.conditions(inherited, runId, [
      entry(1, 1_000, "vendor.report", { toString: "degraded" }),
      entry(2, 2_000, "vendor.report", { unrelated: true })
    ])

    expect(open).toEqual([{ runId, condition: "vendor-state", since: 1_000 }])
  })
})

describe("Alerts identity", () => {
  it("cannot let one run and condition forge another pair's key", () => {
    // Both halves are values a deployment chooses: a run id may contain a
    // colon and condition names come from the policy's own keys. Plain
    // concatenation would make these two the same key, and a sink obeying the
    // deduplication contract would suppress a page that belongs to nobody it
    // has heard from.
    expect(Alerts.coalescingKey("a:b", "c")).not.toBe(Alerts.coalescingKey("a", "b:c"))
    expect(Alerts.alertId({ coalescingKey: Alerts.coalescingKey("a:b", "c"), since: 1 })).not.toBe(
      Alerts.alertId({ coalescingKey: Alerts.coalescingKey("a", "b:c"), since: 1 })
    )
  })

  it("gives a condition that cleared and re-opened a key of its own", () => {
    const first = Alerts.alertId({ coalescingKey: Alerts.coalescingKey(runId, "stalled"), since: 1_000 })
    const second = Alerts.alertId({ coalescingKey: Alerts.coalescingKey(runId, "stalled"), since: 2_000 })

    expect(first).not.toBe(second)
  })
})

describe("Alerts.decide", () => {
  const open: Alerts.Open = { runId, condition: "waiting-approval", since: 1_000 }

  it("raises nothing one millisecond before the delay elapses", () => {
    expect(Alerts.decide(policy, [open], 60_999)).toEqual([])
  })

  it("raises the alert the instant the delay elapses", () => {
    expect(Alerts.decide(policy, [open], 61_000)).toEqual([{
      runId,
      condition: "waiting-approval",
      since: 1_000,
      firedAt: 61_000,
      severity: "warning",
      owner: "oncall",
      runbook: "https://runbook/approvals",
      coalescingKey: "run-1:waiting-approval"
    }])
  })

  it("lets a rule override the policy's default severity", () => {
    const raised = Alerts.decide(policy, [{ runId, condition: "stalled", since: 0 }], 30_000)

    expect(raised.map((alert) => alert.severity)).toEqual(["critical"])
  })

  it("stamps the same firing time however late the tick that reads it runs", () => {
    // `firedAt` is the instant the condition outlived its delay, not the
    // instant a process happened to look. A tick an hour late has to raise the
    // byte-identical alert, because the admitted notification's id is stable
    // and the queue refuses a reused id with different content.
    const onTime = Alerts.decide(policy, [open], 61_000)
    const late = Alerts.decide(policy, [open], 3_661_000)

    expect(onTime).toEqual(late)
    expect(late.map((alert) => alert.firedAt)).toEqual([61_000])
  })
})

/** A sink the test drives: it fails until told to succeed, and counts sends. */
const controllableSink = () => {
  const sent: Array<Alerts.Alert> = []
  let outcome: "ok" | "fail" | "die" = "ok"
  const layer = Layer.succeed(Alerts.Sink)({
    deliver: (alert) =>
      Effect.suspend(() => {
        if (outcome === "die") return Effect.die(new Error("the notifier crashed"))
        if (outcome === "fail") return Effect.fail(new Alerts.AlertError({ message: "pager refused" }))
        sent.push(alert)
        return Effect.void
      })
  })
  return {
    layer,
    sent,
    set: (next: "ok" | "fail" | "die") => {
      outcome = next
    }
  }
}

/** One durable read, and the cursor it paged from. */
interface Read {
  readonly runId: string
  readonly after: number | undefined
}

/**
 * A journal that records every durable read.
 *
 * A run the fold cache still holds pages from the sequence its last tick
 * stopped at; a run the cache dropped starts again with no cursor. Asserting
 * that an old alert stays suppressed cannot tell those apart, because keeping
 * every fold answers the same way.
 */
const recording = (reads: Array<Read>) =>
  Layer.effect(
    Journal.Journal,
    Effect.map(Journal.Journal, (journal) =>
      Journal.Journal.of({
        ...journal,
        entries: (options) =>
          Effect.tap(journal.entries(options), () =>
            Effect.sync(() => {
              reads.push({ runId: options.runId, after: options.after })
            }))
      }))
  ).pipe(Layer.provide(TestJournal.layer()))

/** Ticks `runs` parked runs, then sweeps them all again and reports the sweep. */
const tickSweep = (runs: number) => {
  const reads: Array<Read> = []
  const ids = Array.from({ length: runs }, (_, index) => `bulk-run-${index}`)
  return Effect.runPromise(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const alerts = yield* Alerts.AlertRuntime
      yield* Effect.forEach(
        ids,
        (id) =>
          journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: JournalEvent.RunId.make(id),
              sourceId: JournalEvent.SourceId.make("/control"),
              eventType: "control.run.parked",
              payload: { runId: id, status: "waiting-approval" }
            })
          ),
        { discard: true }
      )
      yield* TestClock.adjust("2 minutes")
      yield* Effect.forEach(ids, (id) => alerts.tick(id), { discard: true })
      reads.length = 0
      yield* Effect.forEach(ids, (id) => alerts.tick(id), { discard: true })
      const swept = reads.slice()
      return {
        reads: swept,
        retained: yield* alerts.tick("bulk-run-0"),
        refolded: yield* alerts.tick(ids[runs - 1]!)
      }
    }).pipe(
      Effect.provide(
        Alerts.layer(policy).pipe(
          Layer.provideMerge(Layer.mergeAll(NotificationQueue.layer, Alerts.layerNoop)),
          Layer.provideMerge(recording(reads)),
          Layer.provideMerge(TestClock.layer())
        )
      ),
      Effect.scoped,
      Effect.orDie
    )
  )
}

const stack = (sink: Layer.Layer<Alerts.Sink>) =>
  Alerts.layer(policy).pipe(
    Layer.provideMerge(Layer.mergeAll(NotificationQueue.layer, sink)),
    Layer.provideMerge(TestJournal.layer()),
    Layer.provideMerge(TestClock.layer())
  )

/** Journals the entry a control plane writes when a run parks for approval. */
const parkForApproval = Effect.flatMap(Journal.Journal, (journal) =>
  journal.emitDurableUnfenced(
    new JournalEvent.Input({
      runId: JournalEvent.RunId.make(runId),
      sourceId: JournalEvent.SourceId.make("/control"),
      eventType: "control.run.parked",
      payload: { runId, status: "waiting-approval" }
    })
  ))

const resumed = Effect.flatMap(Journal.Journal, (journal) =>
  journal.emitDurableUnfenced(
    new JournalEvent.Input({
      runId: JournalEvent.RunId.make(runId),
      sourceId: JournalEvent.SourceId.make("/control"),
      eventType: "control.run.resume",
      payload: { runId, status: "running" }
    })
  ))

const countEntries = (eventType: string) =>
  Effect.flatMap(
    Journal.Journal,
    (journal) =>
      journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 512 }).pipe(
        Effect.map((page) => page.entries.filter((item) => item.eventType === eventType).length)
      )
  )

describe("Alerts.layer over a real journal", () => {
  it("pages even when another producer journals a delivery record for the alert under its own source", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        // The alert id is derivable from the run and the park time, so a step
        // writing to the run's journal can name it. Only the alerter's own
        // record may suppress the page.
        const since = (yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1 })).entries[0]!
          .emittedAtMs
        const id = Alerts.alertId({ coalescingKey: Alerts.coalescingKey(runId, "waiting-approval"), since })
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(runId),
            sourceId: JournalEvent.SourceId.make("/flow/step"),
            eventType: Alerts.deliveredEventType,
            payload: { runId, alertId: id }
          })
        )
        const first = yield* alerts.tick(runId)
        const second = yield* alerts.tick(runId)
        return { first, second }
      }).pipe(Effect.provide(stack(Alerts.layerNoop)), Effect.scoped, Effect.orDie)
    )

    expect(observed.first.delivered.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.first.suppressed).toEqual([])
    // The alerter's own record does suppress the repeat.
    expect(observed.second.suppressed.map((alert) => alert.condition)).toEqual(["waiting-approval"])
  })

  it("stays quiet until the delay elapses and then admits one coalesced event", async () => {
    const sink = controllableSink()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        const queue = yield* NotificationQueue.NotificationQueue
        yield* parkForApproval
        yield* TestClock.adjust("59 seconds")
        const early = yield* alerts.tick(runId)
        const pendingEarly = yield* queue.pending(runId)
        yield* TestClock.adjust("1 second")
        const late = yield* alerts.tick(runId)
        return { early, pendingEarly, late, pending: yield* queue.pending(runId) }
      }).pipe(Effect.provide(stack(sink.layer)), Effect.scoped, Effect.orDie)
    )

    expect(observed.early.delivered).toEqual([])
    expect(observed.pendingEarly).toEqual([])
    expect(observed.late.delivered.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.pending).toHaveLength(1)
    expect(observed.pending[0]).toMatchObject({
      _tag: "system-event",
      delivery: "queue",
      coalescingKey: "run-1:waiting-approval",
      payload: { condition: "waiting-approval", severity: "warning", owner: "oncall" }
    })
    expect(sink.sent).toHaveLength(1)
  })

  it("never delivers the same alert twice, however often it ticks", async () => {
    const sink = controllableSink()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        const first = yield* alerts.tick(runId)
        const second = yield* alerts.tick(runId)
        const third = yield* alerts.tick(runId)
        return { first, second, third, delivered: yield* countEntries(Alerts.deliveredEventType) }
      }).pipe(Effect.provide(stack(sink.layer)), Effect.scoped, Effect.orDie)
    )

    expect(observed.first.delivered).toHaveLength(1)
    expect(observed.second.suppressed.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.third.delivered).toEqual([])
    expect(observed.delivered).toBe(1)
    expect(sink.sent).toHaveLength(1)
  })

  it("stops alerting once the run resumes", async () => {
    const sink = controllableSink()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("30 seconds")
        yield* resumed
        yield* TestClock.adjust("5 minutes")
        return yield* alerts.tick(runId)
      }).pipe(Effect.provide(stack(sink.layer)), Effect.scoped, Effect.orDie)
    )

    expect(observed).toEqual({ delivered: [], failed: [], refused: [], suppressed: [] })
    expect(sink.sent).toEqual([])
  })

  it("delivers once when the notifier crashes between the admission and the send", async () => {
    const sink = controllableSink()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        const queue = yield* NotificationQueue.NotificationQueue
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        // The admission committed; the process died before the page went out.
        sink.set("die")
        const crashed = yield* Effect.exit(alerts.tick(runId))
        const admittedAfterCrash = yield* countEntries("flows/notifications/Admitted")
        const deliveredAfterCrash = yield* countEntries(Alerts.deliveredEventType)
        // The replacement process ticks.
        sink.set("ok")
        const recovered = yield* alerts.tick(runId)
        return {
          crashed,
          admittedAfterCrash,
          deliveredAfterCrash,
          recovered,
          admitted: yield* countEntries("flows/notifications/Admitted"),
          delivered: yield* countEntries(Alerts.deliveredEventType),
          pending: yield* queue.pending(runId)
        }
      }).pipe(Effect.provide(stack(sink.layer)), Effect.scoped, Effect.orDie)
    )

    expect(observed.crashed._tag).toBe("Failure")
    expect(observed.admittedAfterCrash).toBe(1)
    expect(observed.deliveredAfterCrash).toBe(0)
    // The re-admission is idempotent on the alert id, so the crash cost a
    // duplicate admission the queue dropped, not a duplicate page.
    expect(observed.admitted).toBe(1)
    expect(observed.delivered).toBe(1)
    expect(observed.pending).toHaveLength(1)
    expect(observed.recovered.delivered).toHaveLength(1)
    expect(sink.sent).toHaveLength(1)
  })

  it("journals a refused delivery and retries it on the next tick", async () => {
    const sink = controllableSink()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        sink.set("fail")
        const refused = yield* alerts.tick(runId)
        const failedEntries = yield* countEntries(Alerts.failedEventType)
        const deliveredWhileFailing = yield* countEntries(Alerts.deliveredEventType)
        sink.set("ok")
        // The clock MOVES between the refusal and the retry, because in
        // production it always does. The retry re-admits the same alert id, so
        // an alert whose content varied with the reading time would be refused
        // by the queue as an idempotency conflict and never page at all.
        yield* TestClock.adjust("5 minutes")
        const retried = yield* alerts.tick(runId)
        return {
          refused,
          failedEntries,
          deliveredWhileFailing,
          retried,
          delivered: yield* countEntries(Alerts.deliveredEventType)
        }
      }).pipe(Effect.provide(stack(sink.layer)), Effect.scoped, Effect.orDie)
    )

    expect(observed.refused.failed.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.refused.delivered).toEqual([])
    expect(observed.failedEntries).toBe(1)
    expect(observed.deliveredWhileFailing).toBe(0)
    // A refused page is not a delivered page, so the next tick tries again.
    expect(observed.retried.delivered).toHaveLength(1)
    expect(observed.delivered).toBe(1)
    expect(sink.sent).toHaveLength(1)
  })
})

/** Every request one webhook sink made, with its JSON body already decoded. */
interface Sent {
  readonly url: string
  readonly method: string
  readonly authorization: string | undefined
  readonly idempotencyKey: string | undefined
  readonly body: unknown
}

/** Records requests at the Fetch boundary of the sink's owned transport. */
const recordingClient = (
  answer: (attempt: number) => Response | Error
) => {
  const sent: Array<Sent> = []
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const answered = answer(sent.length)
    const headers = new Headers(init?.headers)
    sent.push({
      url: String(url),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? undefined,
      idempotencyKey: headers.get("idempotency-key") ?? undefined,
      body: await new Response(init?.body).json()
    })
    if (answered instanceof Error) throw answered
    return answered
  }
  return { layer: Layer.succeed(FetchHttpClient.Fetch)(fetch), sent }
}

const webhookStack = (
  answer: (attempt: number) => Response | Error
) => {
  const client = recordingClient(answer)
  const sink = Alerts.layerWebhook({
    url: "https://pager.test/alerts",
    headers: { authorization: "Bearer token" }
  }).pipe(Layer.provide(client.layer))
  return { client, stack: stack(sink) }
}

describe("Alerts.layerWebhook", () => {
  it("refuses a 307 even when the supplied client follows redirects", async () => {
    const seen: Array<{ url: string; apiKey: string | null; method: string | undefined }> = []
    const fetch: typeof globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), apiKey: new Headers(init?.headers).get("x-api-key"), method: init?.method })
      return String(url) === "https://pager.test/alerts"
        ? new Response(null, { status: 307, headers: { location: "https://collector.test/stolen" } })
        : new Response(null, { status: 204 })
    }
    const followingClient = Layer.effect(HttpClient.HttpClient)(
      Effect.map(HttpClient.HttpClient, HttpClient.followRedirects())
    ).pipe(Layer.provide(FetchHttpClient.layer))
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sink = yield* Alerts.Sink
        return yield* Effect.result(sink.deliver({
          runId,
          condition: "stalled",
          since: 0,
          firedAt: 0,
          severity: "warning",
          coalescingKey: Alerts.coalescingKey(runId, "stalled")
        }))
      }).pipe(
        Effect.provide(
          Alerts.layerWebhook({
            url: "https://pager.test/alerts",
            headers: { "x-api-key": "SYNTHETIC_REVIEW_SECRET" }
          }).pipe(Layer.provide(followingClient))
        ),
        Effect.provideService(FetchHttpClient.Fetch, fetch)
      )
    )
    expect(seen).toEqual([{
      url: "https://pager.test/alerts",
      apiKey: "SYNTHETIC_REVIEW_SECRET",
      method: "POST"
    }])
    expect(result._tag === "Failure" ? result.failure : result).toMatchObject({
      code: "sink_rejected",
      status: 307
    })
  })

  it.each([200, 307, 503])("aborts an unfinished response body on delivery completion (%s)", async (status) => {
    let signal: AbortSignal | undefined
    // Retain responses from the old injected-client path so this regression
    // cannot pass on the unfixed sink because of GC cleanup.
    const retained: Array<HttpClientResponse.HttpClientResponse> = []
    const response = new Response(new ReadableStream(), { status })
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      signal = init?.signal ?? undefined
      return response
    }
    const client = Layer.effect(HttpClient.HttpClient)(
      Effect.map(
        HttpClient.HttpClient,
        HttpClient.tap((response) =>
          Effect.sync(() => {
            retained.push(response)
          })
        )
      )
    ).pipe(Layer.provide(FetchHttpClient.layer))
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          const sink = yield* Alerts.Sink
          const result = yield* Effect.result(sink.deliver({
            runId,
            condition: "stalled",
            since: 0,
            firedAt: 0,
            severity: "warning",
            coalescingKey: Alerts.coalescingKey(runId, "stalled")
          }))
          expect(result._tag).toBe(status === 200 ? "Success" : "Failure")
          // Assert while the enclosing layer scope is still open.
          expect(signal?.aborted).toBe(true)
        }).pipe(
          Effect.provide(Alerts.layerWebhook({ url: "https://pager.test/alerts" }).pipe(Layer.provide(client))),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.scoped
        )
      )
    } finally {
      await response.body?.cancel()
      retained.length = 0
    }
  })

  it.each(["timeout", "interruption"])("aborts a pending request on %s", async (completion) => {
    let signal: AbortSignal | undefined
    let started!: () => void
    const requested = new Promise<void>((resolve) => {
      started = resolve
    })
    const fetch: typeof globalThis.fetch = (_url, init) => {
      signal = init?.signal ?? undefined
      started()
      return new Promise<Response>(() => {})
    }
    const fiber = Effect.runFork(
      Effect.gen(function*() {
        const sink = yield* Alerts.Sink
        return yield* sink.deliver({
          runId,
          condition: "stalled",
          since: 0,
          firedAt: 0,
          severity: "warning",
          coalescingKey: Alerts.coalescingKey(runId, "stalled")
        })
      }).pipe(
        Effect.provide(Alerts.layerWebhook({
          url: "https://pager.test/alerts",
          timeout: Duration.millis(20)
        })),
        Effect.provideService(FetchHttpClient.Fetch, fetch)
      )
    )
    try {
      await requested
      if (completion === "interruption") await Effect.runPromise(Fiber.interrupt(fiber))
      const exit = await Effect.runPromise(Fiber.await(fiber))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        if (completion === "timeout") expect(Cause.squash(exit.cause)).toMatchObject({ code: "sink_timeout" })
        else expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      }
      expect(signal?.aborted).toBe(true)
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber))
    }
  })

  it("posts the alert to the endpoint and calls a 2xx answer a delivery", async () => {
    const webhook = webhookStack(() => new Response("", { status: 202 }))
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        return { tick: yield* alerts.tick(runId), failed: yield* countEntries(Alerts.failedEventType) }
      }).pipe(Effect.provide(webhook.stack), Effect.scoped, Effect.orDie)
    )

    expect(observed.tick.delivered.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.failed).toBe(0)
    expect(webhook.client.sent).toHaveLength(1)
    expect(webhook.client.sent[0]).toMatchObject({
      url: "https://pager.test/alerts",
      method: "POST",
      authorization: "Bearer token"
    })
    expect(webhook.client.sent[0]?.body).toMatchObject({
      runId,
      condition: "waiting-approval",
      severity: "warning",
      owner: "oncall",
      runbook: "https://runbook/approvals"
    })
  })

  it("calls a non-2xx answer a refused page and retries it once the endpoint recovers", async () => {
    const webhook = webhookStack((attempt) => new Response("", { status: attempt === 0 ? 503 : 200 }))
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        const journal = yield* Journal.Journal
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        const refused = yield* alerts.tick(runId)
        const entries = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 512 })
        const retried = yield* alerts.tick(runId)
        return {
          refused,
          retried,
          detail: entries.entries.find((entry) => entry.eventType === Alerts.failedEventType)?.payload
        }
      }).pipe(Effect.provide(webhook.stack), Effect.scoped, Effect.orDie)
    )

    // A page nobody accepted is not a page that went out.
    expect(observed.refused.delivered).toEqual([])
    expect(observed.refused.failed.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    // The journal records the code and the status, never the sink's prose: the
    // message is authored by whatever sink a deployment installed.
    expect(observed.detail).toMatchObject({ code: "sink_rejected", status: 503 })
    expect(observed.retried.delivered).toHaveLength(1)
    expect(webhook.client.sent).toHaveLength(2)
  })

  it("calls an unreachable endpoint a refused page", async () => {
    const webhook = webhookStack(() => new Error("connect ECONNREFUSED: authorization: Bearer token"))
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        const journal = yield* Journal.Journal
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        const refused = yield* alerts.tick(runId)
        const entries = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 512 })
        return {
          refused,
          detail: entries.entries.find((entry) => entry.eventType === Alerts.failedEventType)?.payload
        }
      }).pipe(Effect.provide(webhook.stack), Effect.scoped, Effect.orDie)
    )

    expect(observed.refused.failed.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.detail).toMatchObject({ code: "sink_unreachable" })
    // The transport error holds the request, and the request holds the bearer
    // token this sink was built with. Neither may reach the journal.
    expect(JSON.stringify(observed.detail)).not.toContain("Bearer")
    expect(JSON.stringify(observed.detail)).not.toContain("authorization")
  })

  it("sends the deduplication key the package requires the receiver to key on", async () => {
    const webhook = webhookStack(() => new Response("", { status: 200 }))
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        return yield* alerts.tick(runId)
      }).pipe(Effect.provide(webhook.stack), Effect.scoped, Effect.orDie)
    )

    const key = Alerts.alertId(observed.delivered[0]!)
    // A body without the id cannot be deduped by the receiver the package
    // requires to dedupe, and the header is what an HTTP receiver keys on.
    expect(webhook.client.sent[0]?.idempotencyKey).toBe(key)
    expect((webhook.client.sent[0]?.body as { alertId?: string }).alertId).toBe(key)
  })

  it("answers a hung endpoint within its bound instead of waiting forever", async () => {
    // The real clock, and a client that never answers. A paging path that can
    // hang is indistinguishable from a quiet system.
    const client = Layer.succeed(FetchHttpClient.Fetch)(() => new Promise<Response>(() => {}))
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        const journal = yield* Journal.Journal
        yield* parkForApproval
        const refused = yield* alerts.tick(runId)
        const entries = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 512 })
        return {
          refused,
          detail: entries.entries.find((entry) => entry.eventType === Alerts.failedEventType)?.payload
        }
      }).pipe(
        Effect.provide(
          Alerts.layer({ rules: { "waiting-approval": { afterMs: 0 } } }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                NotificationQueue.layer,
                Alerts.layerWebhook({ url: "https://pager.test/hung", timeout: Duration.millis(20) }).pipe(
                  Layer.provide(client)
                )
              )
            ),
            Layer.provideMerge(TestJournal.layer())
          )
        ),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(observed.refused.failed.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.detail).toMatchObject({ code: "sink_timeout" })
  })

  it("refuses an endpoint that is not an http: or https: URL when the layer is built", async () => {
    const client = recordingClient(() => new Response("", { status: 200 })).layer
    const build = (url: string) =>
      Effect.runPromise(
        Layer.build(Alerts.layerWebhook({ url })).pipe(Effect.provide(client), Effect.scoped, Effect.exit)
      )

    const accepted = await build("http://pager.test/alerts")
    expect(Exit.isSuccess(accepted)).toBe(true)
    const misconfiguration = (url: string) =>
      Effect.runPromise(
        Layer.build(Alerts.layerWebhook({ url })).pipe(
          Effect.provide(client),
          Effect.scoped,
          Effect.sandbox,
          Effect.flip
        )
      )
    for (
      const url of [
        "ftp://pager.test/alerts",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "ws://pager.test/alerts",
        "//pager.test/alerts",
        "not a url"
      ]
    ) {
      const error = Cause.squash(await misconfiguration(url))
      expect(error).toBeInstanceOf(Alerts.AlertError)
      expect((error as Alerts.AlertError).code).toBe("sink_misconfigured")
      // The url can carry basic-auth credentials; the refusal never echoes it.
      expect((error as Alerts.AlertError).message).not.toContain(url)
    }
  })

  it("answers a redirect with a refusal and never re-sends the credential headers", async () => {
    const seen: Array<{ url: string; redirect: string | undefined; credentials: string | undefined }> = []
    const client = Layer.succeed(FetchHttpClient.Fetch)(async (url, init) => {
      seen.push({ url: String(url), redirect: init?.redirect, credentials: init?.credentials })
      return new Response(null, { status: 302, headers: { location: "https://collector.test/credentials" } })
    })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sink = yield* Alerts.Sink
        return yield* Effect.result(sink.deliver({
          runId,
          condition: "waiting-approval",
          since: 0,
          firedAt: 0,
          severity: "warning",
          coalescingKey: Alerts.coalescingKey(runId, "waiting-approval")
        }))
      }).pipe(
        Effect.provide(
          Alerts.layerWebhook({
            url: "https://pager.test/alerts",
            headers: { authorization: "Bearer token", "x-api-key": "secret" }
          }).pipe(Layer.provide(client))
        ),
        // Fetch defaults the composition set survive; only the redirect mode
        // is forced.
        Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include", redirect: "follow" }),
        Effect.scoped
      )
    )

    // The request carries the deployment's credentials, so the transport is
    // told not to follow: a 3xx is a refused page, and the redirect target
    // never sees a request.
    expect(result._tag).toBe("Failure")
    expect(result._tag === "Failure" ? result.failure : undefined).toMatchObject({
      code: "sink_rejected",
      status: 302
    })
    expect(seen).toEqual([{
      url: "https://pager.test/alerts",
      redirect: "manual",
      credentials: "include"
    }])
  })

  it("takes a 2xx answer and nothing on either side of it", async () => {
    const deliver = (status: number) =>
      Effect.gen(function*() {
        const sink = yield* Alerts.Sink
        return yield* Effect.result(sink.deliver({
          runId,
          condition: "waiting-approval",
          since: 0,
          firedAt: 0,
          severity: "warning",
          coalescingKey: Alerts.coalescingKey(runId, "waiting-approval")
        }))
      }).pipe(
        Effect.provide(
          Alerts.layerWebhook({ url: "https://pager.test/alerts" }).pipe(
            Layer.provide(
              recordingClient(() => new Response("", { status })).layer
            )
          )
        ),
        Effect.scoped
      )

    // The web `Response` constructor refuses a status under 200, so 200 is the
    // lowest an HTTP sink can actually be handed; 299 and 300 are the boundary
    // a redirect or a misrouted proxy lands on.
    const observed = await Effect.runPromise(Effect.all([deliver(200), deliver(299), deliver(300)]))

    expect(observed.map((result) => result._tag)).toEqual(["Success", "Success", "Failure"])
    expect(observed[2]._tag === "Failure" ? observed[2].failure : undefined).toMatchObject({
      code: "sink_rejected",
      status: 300
    })
  })

  it("sends nothing at all through the noop sink", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        return yield* alerts.tick(runId)
      }).pipe(Effect.provide(stack(Alerts.layerNoop)), Effect.scoped, Effect.orDie)
    )

    expect(observed.delivered).toHaveLength(1)
    expect(observed.failed).toEqual([])
  })
})

describe("Alerts.tick over a journal and a queue that can refuse", () => {
  it("reads a condition out of a journal longer than one page", async () => {
    // `entriesOf` pages at 512. A run whose journal is one page long would
    // never take the second read, and the condition that opened on entry 1
    // would be the only one the alerter could ever see.
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const alerts = yield* Alerts.AlertRuntime
        yield* Effect.forEach(
          Array.from({ length: 600 }, (_, index) => index),
          (index) =>
            journal.emitDurableUnfenced(
              new JournalEvent.Input({
                runId: JournalEvent.RunId.make(runId),
                sourceId: JournalEvent.SourceId.make("/control"),
                eventType: "control.run.progress",
                payload: { runId, beat: index }
              })
            ),
          { discard: true }
        )
        // The condition opens PAST the first page, so only a paged read finds it.
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        return yield* alerts.tick(runId)
      }).pipe(
        Effect.provide(
          Alerts.layer(policy).pipe(
            Layer.provideMerge(Layer.mergeAll(NotificationQueue.layer, Alerts.layerNoop)),
            Layer.provideMerge(TestJournal.layer({ capacity: 4096 })),
            Layer.provideMerge(TestClock.layer())
          )
        ),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(observed.delivered.map((alert) => alert.condition)).toEqual(["waiting-approval"])
  })

  it("records one refusal per failure, however long the endpoint stays down", async () => {
    const sink = controllableSink()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        sink.set("fail")
        yield* alerts.tick(runId)
        yield* TestClock.adjust("30 seconds")
        yield* alerts.tick(runId)
        yield* TestClock.adjust("30 seconds")
        yield* alerts.tick(runId)
        return yield* countEntries(Alerts.failedEventType)
      }).pipe(Effect.provide(stack(sink.layer)), Effect.scoped, Effect.orDie)
    )

    // A webhook down for an hour on a 30 s tick would otherwise append 120
    // rows for one condition, and every later tick reads past all of them.
    expect(observed).toBe(1)
  })

  it("pages nobody about an alert the run has no room to receive", async () => {
    const sink = controllableSink()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        const queue = yield* NotificationQueue.NotificationQueue
        // One slot, already taken by an operator steer.
        yield* queue.admit(runId, {
          _tag: "human-steer",
          id: "occupant",
          delivery: "steer",
          targetLineageId: runId,
          provenance: {
            sourceRunId: "operator",
            sourceLineageId: "operator/root",
            sourceTurn: 0,
            sourceActor: "human:will"
          },
          payload: { body: "already here" }
        })
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        const full = yield* alerts.tick(runId)
        yield* queue.drain({ runId, targetLineageId: runId, boundary: "turn-1", wouldIdle: false })
        const drained = yield* alerts.tick(runId)
        return {
          full,
          drained,
          delivered: yield* countEntries(Alerts.deliveredEventType),
          failed: yield* countEntries(Alerts.failedEventType)
        }
      }).pipe(
        Effect.provide(
          Alerts.layer(policy).pipe(
            Layer.provideMerge(Layer.mergeAll(NotificationQueue.layerWith({ capacity: 1 }), sink.layer)),
            Layer.provideMerge(TestJournal.layer()),
            Layer.provideMerge(TestClock.layer())
          )
        ),
        Effect.scoped,
        Effect.orDie
      )
    )

    // Paging about an alert the run will never read tells an operator about
    // something that is not going to happen.
    expect(observed.full.refused.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.full.delivered).toEqual([])
    expect(sink.sent).toHaveLength(1)
    expect(observed.drained.delivered.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.delivered).toBe(1)
    expect(observed.failed).toBe(1)
  })

  it("ignores an entry whose payload is not a record while folding a run", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const alerts = yield* Alerts.AlertRuntime
        // A journal is written by whoever wrote it, and an array is not
        // evidence about any condition.
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(runId),
            sourceId: JournalEvent.SourceId.make("/foreign"),
            eventType: "foreign.list",
            payload: ["not", "a", "record"]
          })
        )
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        return yield* alerts.tick(runId)
      }).pipe(Effect.provide(stack(Alerts.layerNoop)), Effect.scoped, Effect.orDie)
    )

    expect(observed.delivered.map((alert) => alert.condition)).toEqual(["waiting-approval"])
  })

  it("forgets the least recently watched run rather than growing without bound", async () => {
    const runs = 65
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const alerts = yield* Alerts.AlertRuntime
        yield* Effect.forEach(
          Array.from({ length: runs }, (_, index) => `bulk-run-${index}`),
          (id) =>
            journal.emitDurableUnfenced(
              new JournalEvent.Input({
                runId: JournalEvent.RunId.make(id),
                sourceId: JournalEvent.SourceId.make("/control"),
                eventType: "control.run.parked",
                payload: { runId: id, status: "waiting-approval" }
              })
            ),
          { discard: true }
        )
        yield* TestClock.adjust("2 minutes")
        yield* Effect.forEach(
          Array.from({ length: runs }, (_, index) => `bulk-run-${index}`),
          (id) => alerts.tick(id),
          { discard: true }
        )
        // The first run was evicted, so this tick folds it again from the
        // beginning and must reach the same answer.
        return yield* alerts.tick("bulk-run-0")
      }).pipe(Effect.provide(stack(Alerts.layerNoop)), Effect.scoped, Effect.orDie)
    )

    expect(observed.suppressed.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.delivered).toEqual([])
  })

  it("pages every watched run from its cursor when the sweep fits what the cache holds", async () => {
    const { reads, retained } = await tickSweep(64)

    expect(reads).toHaveLength(64)
    expect(reads.filter((read) => read.after === undefined)).toEqual([])
    expect(retained.suppressed.map((alert) => alert.condition)).toEqual(["waiting-approval"])
  })

  it("evicts a watched run at one past the bound without replaying every other journal", async () => {
    const { reads, refolded, retained } = await tickSweep(65)
    const restarted = reads.filter((read) => read.after === undefined).map((read) => read.runId)

    // Eviction happened: keeping all 65 folds pages every one from its cursor.
    expect(restarted.length).toBeGreaterThan(0)
    // ...and it cost a fixed handful of refolds. Dropping the least recently
    // watched run drops the run the next tick wants, so all 65 would fold from
    // sequence zero on every sweep.
    expect(restarted.length).toBeLessThanOrEqual(2)
    expect(restarted).not.toContain("bulk-run-0")
    expect(retained.suppressed.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    // A refolded run reaches the same answer from the journal alone.
    expect(refolded.suppressed.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(refolded.delivered).toEqual([])
  })

  it("refuses a policy whose delay is not a whole number of milliseconds", async () => {
    const built = (afterMs: number) =>
      Effect.runPromise(
        Effect.exit(
          Effect.void.pipe(
            Effect.provide(
              Alerts.layer({ rules: { "waiting-approval": { afterMs } } }).pipe(
                Layer.provideMerge(Layer.mergeAll(NotificationQueue.layer, Alerts.layerNoop)),
                Layer.provideMerge(TestJournal.layer())
              )
            ),
            Effect.scoped
          )
        )
      )

    // A NaN delay fires on the first tick and stamps a `firedAt` that JSON
    // writes as null; a negative one fires before the condition it describes;
    // an infinite one never fires and looks exactly like a quiet system. All
    // three are policy typos, and a composition is where a typo should stop.
    for (const afterMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5]) {
      expect((await built(afterMs))._tag).toBe("Failure")
    }
    expect((await built(0))._tag).toBe("Success")
  })

  it("raises the queue's own refusal instead of calling it a journal failure", async () => {
    // A queue that will not take the admission is not the journal failing and
    // not the pager refusing. An operator reading `sink_failed` here would go
    // and check the webhook.
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        return yield* Effect.flip(alerts.tick(runId))
      }).pipe(
        Effect.provide(
          Alerts.layer(policy).pipe(
            Layer.provideMerge(Layer.mergeAll(NotificationQueue.layerNoop(), Alerts.layerNoop)),
            Layer.provideMerge(TestJournal.layer()),
            Layer.provideMerge(TestClock.layer())
          )
        ),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(failure._tag).toBe("/notifications/NotificationError")
  })
})

/** A policy that states delays and nothing else, plus one detector of its own. */
const bare: Alerts.Policy = {
  rules: {
    stalled: { afterMs: 0 },
    "condition-with-no-detector": { afterMs: 0 },
    "beat-only": { afterMs: 0 }
  },
  detectors: {
    "beat-only": { field: "health", value: "stalled", eventTypes: ["control.monitor.beat"] }
  }
}

describe("Alerts over a policy that states only delays", () => {
  it("skips an unreadable payload, a condition with no detector, and an entry the detector does not name", () => {
    const open = Alerts.conditions(bare, runId, [
      // A journal is written by whoever wrote it. A payload that is not a
      // record is not evidence about any condition.
      entry(1, 1_000, "control.monitor.beat", ["not", "a", "record"] as unknown as Record<string, unknown>),
      // `beat-only` names monitor beats, so a park saying the same thing is
      // not its evidence; the default `stalled` detector names the whole
      // `control.*` family and takes it.
      entry(2, 2_000, "control.run.parked", { health: "stalled" }),
      entry(3, 3_000, "control.monitor.beat", { health: "stalled" })
    ])

    expect(open).toEqual([
      { runId, condition: "stalled", since: 2_000 },
      { runId, condition: "beat-only", since: 3_000 }
    ])
  })

  it("raises nothing for a condition it has no rule for and falls back to a warning with no owner", () => {
    const raised = Alerts.decide(
      bare,
      [{ runId, condition: "stalled", since: 0 }, { runId, condition: "condition-nobody-declared", since: 0 }],
      1_000
    )

    expect(raised).toEqual([{
      runId,
      condition: "stalled",
      since: 0,
      firedAt: 0,
      severity: "warning",
      coalescingKey: `${runId}:stalled`
    }])
  })

  it("admits an ownerless alert and ignores a delivery record that names no alert", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const alerts = yield* Alerts.AlertRuntime
        const queue = yield* NotificationQueue.NotificationQueue
        // A delivery record with no alert id suppresses nothing: it is not
        // evidence that this alert, or any alert, went out.
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(runId),
            sourceId: JournalEvent.SourceId.make("/notifications/alerts/other"),
            eventType: Alerts.deliveredEventType,
            payload: { runId, condition: "stalled" }
          })
        )
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(runId),
            sourceId: JournalEvent.SourceId.make("/control"),
            eventType: "control.monitor.beat",
            payload: { runId, health: "stalled" }
          })
        )
        return { tick: yield* alerts.tick(runId), pending: yield* queue.pending(runId) }
      }).pipe(
        Effect.provide(
          Alerts.layer(bare).pipe(
            // No headers on the webhook: the sink posts the alert unadorned.
            Layer.provideMerge(
              Layer.mergeAll(
                NotificationQueue.layer,
                Alerts.layerWebhook({ url: "https://pager.test/bare" }).pipe(
                  Layer.provide(
                    recordingClient(() => new Response("", { status: 200 })).layer
                  )
                )
              )
            ),
            Layer.provideMerge(TestJournal.layer()),
            Layer.provideMerge(TestClock.layer())
          )
        ),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(observed.tick.delivered.map((alert) => alert.condition)).toEqual(["stalled", "beat-only"])
    expect(observed.pending).toHaveLength(2)
    expect(observed.pending[0]?.payload).toEqual({
      condition: "stalled",
      severity: "warning",
      since: 0,
      firedAt: 0
    })
  })
})

/** Journals the beat a monitor writes when a run stops making progress. */
const stalled = Effect.flatMap(Journal.Journal, (journal) =>
  journal.emitDurableUnfenced(
    new JournalEvent.Input({
      runId: JournalEvent.RunId.make(runId),
      sourceId: JournalEvent.SourceId.make("/monitor"),
      eventType: "control.monitor.beat",
      payload: { runId, health: "stalled" }
    })
  ))

const rollback = Effect.fail(new Journal.JournalError({ code: "unknown", message: "injected before commit" }))

/**
 * A tick reads the journal on the caller's connection, so one taken inside an
 * enclosing transaction folds rows that have not committed. The fold is a
 * cache, and a cache that keeps those rows outlives the rollback that erased
 * them.
 */
describe("Alerts commit ownership", () => {
  it("does not page about a condition whose transaction rolled back", async () => {
    const sink = controllableSink()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const alerts = yield* Alerts.AlertRuntime
        yield* journal.transact(Effect.gen(function*() {
          yield* parkForApproval
          // Before the delay: this tick reads and folds, but pages nothing and
          // writes nothing, so only the fold can survive the rollback.
          expect((yield* alerts.tick(runId)).delivered).toEqual([])
          return yield* rollback
        })).pipe(Effect.exit)
        const durable = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 512 })
        yield* TestClock.adjust("2 minutes")
        const tick = yield* alerts.tick(runId)
        return { durable: durable.entries.length, tick, pending: yield* countEntries(Alerts.deliveredEventType) }
      }).pipe(Effect.provide(stack(sink.layer)), Effect.scoped, Effect.orDie)
    )

    expect(observed.durable).toBe(0)
    expect(observed.tick.delivered).toEqual([])
    expect(observed.pending).toBe(0)
    expect(sink.sent).toEqual([])
  })

  it("folds a rolled-back tick's run from durable history alone", async () => {
    const sink = controllableSink()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const alerts = yield* Alerts.AlertRuntime
        let parked: number | undefined
        yield* journal.transact(Effect.gen(function*() {
          parked = (yield* parkForApproval).seq
          expect((yield* alerts.tick(runId)).delivered).toEqual([])
          return yield* rollback
        })).pipe(Effect.exit)
        // The rolled-back park does not free its sequence, so the beat lands
        // above the cursor the tick inside the transaction stopped at: what a
        // cached fold would carry forward is the condition, not a skipped row.
        const beat = yield* stalled
        yield* TestClock.adjust("2 minutes")
        const tick = yield* alerts.tick(runId)
        return { parked, beat: beat.seq, tick }
      }).pipe(Effect.provide(stack(sink.layer)), Effect.scoped, Effect.orDie)
    )

    expect(observed.beat).toBeGreaterThan(observed.parked!)
    expect(observed.tick.delivered.map((alert) => alert.condition)).toEqual(["stalled"])
    expect(sink.sent.map((alert) => alert.condition)).toEqual(["stalled"])
  })
})
