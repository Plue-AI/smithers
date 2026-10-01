import { Cause, Effect, Fiber, Metric, Schema, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Health from "../src/Health.ts"

const observation = (overrides: Partial<Health.HealthObservation> = {}): Health.HealthObservation => ({
  subjectId: "session:one",
  state: "running",
  checkerId: "semantic",
  monitorId: "host-one",
  incarnation: "owner-one",
  evidenceSeq: 4,
  observedAt: 100,
  expiresAt: 200,
  durationMs: 1,
  outcome: "ok",
  report: { activity: "working" },
  ...overrides
})
const roll = (overrides: Partial<Health.RollupInput> = {}) =>
  Health.rollup({
    subjectId: "session:one",
    state: "running",
    incarnation: "owner-one",
    baseHealth: "healthy",
    now: 110,
    updatedAt: 50,
    latest: { observation: observation(), sequence: 9 },
    ...overrides
  })
const context: Health.ProbeContext = {
  subjectId: "session:one",
  state: "running",
  events: [],
  sinceCursor: 0,
  session: { alive: true, exitCode: null, outputCursor: 4 }
}
const stamp = { monitorId: "host-one", incarnation: "owner-one", evidenceSeq: 4 }
const configured = (probe: Health.HealthChecker["probe"], policy: Partial<Health.CheckPolicy> = {}) =>
  Health.makeRegistry(
    { checkers: [{ id: "custom", probe }], bindings: { role: { checkerId: "custom", policy } } },
    "session"
  ).resolve("role")

describe("Health authority and freshness", () => {
  it("never turns absence of an observation into work or healthy execution", () => {
    expect(roll({ latest: undefined })).toMatchObject({
      activity: "unknown",
      health: "unknown",
      freshness: "unobserved"
    })
  })
  it.each([
    { now: 200 },
    { now: 99 },
    { incarnation: "new-owner" },
    { evidenceSeq: 5 },
    { state: "spawning" as const }
  ])("expires reports at the authority/freshness boundary: %j", (change) => {
    expect(roll(change)).toMatchObject({ activity: "unknown", health: "unknown", freshness: "stale" })
  })
  it.each(["timeout", "error", "discarded", "interrupted"] as const)("does not reuse a report from %s", (outcome) => {
    expect(roll({ latest: { observation: observation({ outcome }), sequence: 10 } })).toMatchObject({
      activity: "unknown",
      freshness: "stale"
    })
  })
  it("keeps an exact TTL boundary fresh only before its expiry", () => {
    expect(roll({ now: 199 })).toMatchObject({ activity: "working", freshness: "fresh" })
  })
  it.each(["waiting-approval", "parked"] as const)(
    "an approval fence wins over working, errors and staleness: %s",
    (state) => {
      expect(roll({ state, waitingReason: "approval" })).toMatchObject({
        state,
        activity: "unknown",
        health: "awaiting-human",
        attention: "awaiting-approval"
      })
    }
  )
  it.each(["timer", "event", "quota"])("a declared %s wait is not a stall", (waitingReason) => {
    expect(roll({ state: "parked", waitingReason, latest: undefined, baseHealth: "stalled" })).toMatchObject({
      activity: "unknown",
      health: "healthy",
      attention: "none"
    })
  })
  it.each([
    { latest: undefined, baseHealth: undefined },
    { latest: { observation: observation({ state: "parked" }), sequence: 9 }, baseHealth: "healthy" as const }
  ])("a run parked over released executions needs a resume, whatever a probe said (#3328)", (input) => {
    expect(roll({ state: "parked", waitingReason: "released", incarnation: "owner-one", ...input })).toMatchObject({
      activity: "unknown",
      health: "awaiting-human",
      attention: "needs-resume",
      reason: "released"
    })
    // A released row that is not parked is mid-reclaim, not stuck.
    expect(roll({ state: "running", waitingReason: "released" }).attention).not.toBe("needs-resume")
  })
  it("an operator park remains awaiting-human", () => {
    expect(roll({ state: "parked", latest: undefined })).toMatchObject({ health: "awaiting-human" })
  })
  it.each(
    [
      ["completed", null, "healthy"],
      ["failed", null, "failing"],
      ["cancelled", null, "healthy"],
      ["exited", 0, "healthy"],
      ["exited", 3, "failing"],
      ["exited", null, "unknown"]
    ] as const
  )("terminal %s with code %s is %s regardless of callback", (state, exitCode, health) => {
    expect(roll({ state, exitCode })).toMatchObject({ state, activity: "unknown", health })
  })
  it("explicit idle is neutral, never inferred to need input", () => {
    expect(roll({ latest: { observation: observation({ report: { activity: "idle" } }), sequence: 9 } })).toMatchObject(
      { activity: "idle", health: "healthy", attention: "none" }
    )
  })
  it("explicit input requests and unreachable dependencies produce distinct attention", () => {
    expect(
      roll({
        latest: {
          observation: observation({ report: { activity: "needs-input", reason: "prompt-detected" } }),
          sequence: 9
        }
      })
    ).toMatchObject({ attention: "needs-input" })
    expect(
      roll({
        latest: { observation: observation({ report: { activity: "unknown", reason: "unreachable" } }), sequence: 9 }
      })
    ).toMatchObject({ health: "failing", attention: "unhealthy" })
  })
  it("working never overwrites independent failing or runaway evidence", () => {
    expect(roll({ baseHealth: "failing" }).health).toBe("failing")
    expect(roll({ baseHealth: "runaway-loop" }).health).toBe("runaway-loop")
  })
  it("fresh activity alone does not establish base health", () => {
    expect(roll({ baseHealth: undefined })).toMatchObject({
      activity: "working",
      health: "unknown",
      attention: "none",
      freshness: "fresh"
    })
  })
  it.each(
    [
      ["healthy", "stalled"],
      ["failing", "failing"],
      ["awaiting-human", "awaiting-human"]
    ] as const
  )("no-progress demotes %s to %s without erasing independent evidence", (baseHealth, health) => {
    expect(roll({
      baseHealth,
      latest: { observation: observation({ report: { activity: "unknown", reason: "no-progress" } }), sequence: 9 }
    })).toMatchObject({ health, reason: "no-progress", freshness: "fresh" })
  })
})

describe("Health ordering", () => {
  it("uses opaque owner equality, evidence order, and journal sequence ties, never wall clocks", () => {
    const candidates = [
      { observation: observation({ observedAt: 999, evidenceSeq: 3 }), sequence: 50 },
      { observation: observation({ observedAt: 800, incarnation: "owner-two", evidenceSeq: 900 }), sequence: 51 },
      { observation: observation({ observedAt: 100, evidenceSeq: 4 }), sequence: 49 },
      { observation: observation({ observedAt: 99, evidenceSeq: 4 }), sequence: 52 },
      { observation: observation({ outcome: "discarded", evidenceSeq: 5 }), sequence: 53 }
    ]
    expect(Health.latestObservation(candidates, "session:one", "owner-one")?.sequence).toBe(52)
    expect(Health.latestObservation([...candidates].reverse(), "session:one", "owner-one")?.sequence).toBe(52)
    expect(Health.latestObservation(candidates, "session:missing", "owner-one")).toBeUndefined()
  })
  it("fingerprints lifecycle/ownership changes without ordering opaque owner ids", () => {
    const run = {
      runId: "one",
      flowId: "test",
      status: "running" as const,
      createdAt: 1,
      updatedAt: 1,
      ownerId: "private-owner"
    }
    expect(Health.runIncarnation(run)).toBe(Health.runIncarnation({ ...run }))
    expect(Health.runIncarnation(run)).not.toContain("private-owner")
    expect(Health.runIncarnation(run)).not.toBe(Health.runIncarnation({ ...run, ownerId: "replacement" }))
  })
})

describe("Health configuration and Effect evaluation", () => {
  it("records successful, failed and timed-out probes in counters, latency and safe completed spans", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const metrics = new Map()
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* Health.evaluate(configured(() => Effect.succeed({ activity: "working" })), context, stamp)
        yield* Health.evaluate(configured(() => Effect.fail(new Error("secret-token"))), context, stamp)
        const timed = yield* Health.evaluate(configured(() => Effect.never, { timeoutMs: 20 }), context, stamp)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(20)
        yield* Fiber.join(timed)
        for (const outcome of ["ok", "error", "timeout"]) {
          const value = yield* Metric.value(
            Metric.counter("smithers.health.probes").pipe(Metric.withAttributes({ outcome }))
          )
          expect(value.count).toBe(1)
        }
        const latency = yield* Metric.value(Metric.histogram("smithers.health.probe_duration_ms", {
          boundaries: [1, 10, 100, 1_000, 5_000, 60_000]
        }))
        expect(latency.count).toBe(3)
        expect(latency.sum).toBe(20)
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provideService(Metric.MetricRegistry, metrics),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    )
    const probes = spans.filter((span) => span.name === "smithers.health.probe")
    expect(probes.map((span) => span.attributes.get("outcome"))).toEqual(["ok", "error", "timeout"])
    expect(probes.map((span) => span.attributes.get("activity"))).toEqual(["working", "unknown", "unknown"])
    expect(probes.every((span) => span.status._tag === "Ended")).toBe(true)
    expect(probes.every((span) => span.attributes.get("checkerId") === "custom")).toBe(true)
    expect(
      JSON.stringify(
        probes.map((span) => ({ attributes: [...span.attributes], status: span.status })),
        (_key, value) => typeof value === "bigint" ? String(value) : value
      )
    ).not
      .toContain("secret-token")
    expect(JSON.stringify([...metrics.keys()])).not.toContain("secret-token")
  })
  it("defaults remain unknown for both quiet and chatty sessions", async () => {
    const check = Health.makeRegistry({}, "session").resolve("anything")
    for (const outputCursor of [0, 1_000_000]) {
      const value = await Effect.runPromise(
        Health.evaluate(check, { ...context, session: { alive: true, exitCode: null, outputCursor } }, stamp)
      )
      expect(value.report?.activity).toBe("unknown")
    }
  })
  it("decodes checker-specific JSON config and strips unknown fields", async () => {
    const registry = Health.makeRegistry({
      checkers: [{
        id: "marker",
        configSchema: Schema.Struct({ enabled: Schema.Boolean }),
        probe: (_, value) => Effect.succeed({ activity: value.enabled ? "needs-input" : "unknown" })
      }],
      bindings: { role: { checkerId: "marker", config: { enabled: true, secret: "not-captured" } } }
    }, "session")
    expect(registry.resolve("role").config).toEqual({ enabled: true })
    expect((await Effect.runPromise(Health.evaluate(registry.resolve("role"), context, stamp))).report?.activity).toBe(
      "needs-input"
    )
  })
  it("unknown checker ids fall back to lifecycle without executing configuration", () => {
    expect(
      Health.makeRegistry({ bindings: { role: { checkerId: "missing", config: { code: "ignored" } } } }, "session")
        .resolve("role").checker.id
    ).toBe("lifecycle.session")
  })
  it.each([null, "invalid"])("refuses a non-object backoff from host configuration: %j", (backoff) => {
    expect(() =>
      Health.makeRegistry({
        bindings: { role: { checkerId: "lifecycle.run", policy: { backoff: backoff as never } } }
      })
    ).toThrow(new Health.HealthConfigurationError({ reason: "invalid-policy" }))
  })
  it("refuses malformed checker config at startup without exposing the rejected value", () => {
    let called = false
    const make = () =>
      Health.makeRegistry({
        checkers: [{
          id: "marker",
          configSchema: Schema.Struct({ enabled: Schema.Boolean }),
          probe: () => {
            called = true
            return Effect.succeed({ activity: "working" })
          }
        }],
        bindings: { role: { checkerId: "marker", config: { enabled: "private-config" } } }
      })
    expect(make).toThrow(new Health.HealthConfigurationError({ reason: "invalid-config" }))
    expect(called).toBe(false)
  })
  it.each([
    { limits: { maxSubjects: 0 } },
    { limits: { maxConcurrentProbes: 1000 } },
    { bindings: { one: { checkerId: "lifecycle.run", policy: { intervalMs: -1 } } } },
    { checkers: [{ id: "bad id", probe: () => Effect.succeed({ activity: "unknown" as const }) }] },
    { checkers: [Health.lifecycleRunChecker] },
    { bindings: { one: { checkerId: "lifecycle.run", config: {} } } }
  ])("refuses invalid host configuration safely: %j", (config) => {
    expect(() => Health.makeRegistry(config)).toThrow(Health.HealthConfigurationError)
  })
  it("sanitizes thrown and malformed reports to safe reason codes", async () => {
    for (
      const probe of [() => {
        throw new Error("secret-token")
      }, () => Effect.succeed({ activity: "bogus" } as never)]
    ) {
      const result = await Effect.runPromise(Health.evaluate(configured(probe), context, stamp))
      expect(result).toMatchObject({ outcome: "error", reason: "probe-error" })
      expect(JSON.stringify(result)).not.toContain("secret-token")
    }
  })
  it("ignores callback-supplied identity and metrics", async () => {
    const result = await Effect.runPromise(
      Health.evaluate(
        configured(() =>
          Effect.succeed({ activity: "working", observedAt: 999, evidenceSeq: 999, detail: "secret" } as never)
        ),
        context,
        stamp
      )
    )
    expect(result.evidenceSeq).toBe(4)
    expect(result.report).toEqual({ activity: "working" })
  })
  it("times out interruptible Effects and records no raw error", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Health.evaluate(configured(() => Effect.never, { timeoutMs: 20 }), context, stamp).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* TestClock.adjust(20)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(result).toMatchObject({ outcome: "timeout", reason: "probe-timeout", durationMs: 20 })
  })
  it("scope cancellation interrupts the checker and never manufactures a successful reading", async () => {
    let finalized = false
    const program = Health.evaluate(
      configured(() =>
        Effect.never.pipe(Effect.ensuring(Effect.sync(() => {
          finalized = true
        })))
      ),
      context,
      stamp
    )
    const value = await Effect.runPromise(Effect.gen(function*() {
      const fiber = yield* program.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Fiber.interrupt(fiber)
      return fiber.pollUnsafe()
    }))
    expect(finalized).toBe(true)
    expect(value?._tag).toBe("Failure")
  })
  it("propagates a checker's own interruption without publishing an error or success", async () => {
    const exit = await Effect.runPromise(Effect.exit(
      Health.evaluate(configured(() => Effect.interrupt), context, stamp)
    ))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })
  it("bounds exponential failure backoff and resets on success", () => {
    expect([0, 1, 2, 500].map((failures) => Health.nextDelay(Health.defaultPolicy, failures))).toEqual([
      5_000,
      5_000,
      10_000,
      60_000
    ])
  })
})
