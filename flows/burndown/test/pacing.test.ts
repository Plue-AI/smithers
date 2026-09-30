import assert from "node:assert/strict"
import test from "node:test"
import type { Reading } from "../accounts.ts"
import { earliestReset, exhausted, learnRates, seedRates, slots } from "../pacing.ts"

const now = 1_000_000
function reading(used = 50, hours = 5, tool: "claude" | "codex" = "codex") {
  return {
    account: { id: "a", tool, email: "a@example.test", directory: "/tmp/a", aliases: [] },
    usage: {
      windows: [{
        name: (tool === "codex" ? "primary" : "five_hour") as "primary" | "five_hour" | "seven_day",
        used,
        resetsAt: now + hours * 3_600_000,
        durationHours: hours
      }],
      limitReached: false
    },
    error: null,
    observedAt: now
  }
}
test("seeds identify unmeasured model rates", () => {
  assert.deepEqual(seedRates("codex"), { primary: { pointsPerAgentHour: 2, source: "seed" } })
  assert.deepEqual(seedRates("claude"), {
    five_hour: { pointsPerAgentHour: 6, source: "seed" },
    seven_day: { pointsPerAgentHour: 1.2, source: "seed" }
  })
})
test("slots floor capacity and subtract in-flight workers", () => {
  assert.equal(slots(reading(), now), 4)
  assert.equal(slots(reading(), now, undefined, 2), 2)
  assert.equal(slots(reading(), now, undefined, 10), 0)
  assert.equal(slots(reading(0, 168), now), 0)
})
test("every window constrains capacity and the safety ceiling is inclusive", () => {
  const r = reading(0, 1, "claude")
  r.usage.windows.push({ name: "seven_day", used: 90, resetsAt: now + 3_600_000, durationHours: 168 })
  assert.equal(slots(r, now), 4)
  for (const used of [95, 96.99, 97, 100]) assert.equal(slots(reading(used), now), 0)
  r.usage.windows[1]!.used = 97
  assert.equal(slots(r, now), 0)
})
test("unavailable, limited and empty usage cannot authorize workers", () => {
  const r = reading()
  r.usage.limitReached = true
  assert.equal(slots(r, now), 0)
  r.usage = { windows: [], limitReached: false }
  assert.equal(slots(r, now), 0)
  assert.equal(slots({ ...r, usage: null }, now), 0)
})
test("expired windows stop blocking at the reset boundary", () => {
  const r = reading(100, 0)
  assert.equal(slots(r, now), 0)
  assert.equal(exhausted([r], now), false)
  assert.equal(earliestReset([r], now), null)
})
test("learning uses EWMA and isolates account/window resets and low activity", () => {
  const before = reading(10)
  const after = reading(18)
  after.observedAt += 1000
  const learned = learnRates([before], [after], { a: 2 })
  assert.ok(Math.abs(learned.a!.primary!.pointsPerAgentHour - 2.6) < 1e-12)
  assert.equal(learned.a!.primary!.source, "measured")
  assert.equal(learnRates([before], [after], { a: 0.249 }).a!.primary!.pointsPerAgentHour, 2)
  assert.equal(learnRates([before], [after], { a: 0.25 }, undefined, 1).a!.primary!.pointsPerAgentHour, 32)
  assert.equal(learnRates([after], [before], { a: 2 }).a!.primary!.pointsPerAgentHour, 2)
  const reset = reading(30)
  reset.observedAt += 1000
  reset.usage.windows[0]!.resetsAt += 3_600_000
  assert.equal(learnRates([before], [reset], { a: 2 }).a!.primary!.pointsPerAgentHour, 2)
})
test("exhaustion and earliest reset ignore failures and past reset times", () => {
  assert.equal(exhausted([reading(97)], now), true)
  assert.equal(exhausted([reading(97), reading(0, 1)], now), false)
  assert.equal(earliestReset([reading(97, 3), reading(97, 2)], now), now + 7_200_000)
  assert.equal(earliestReset([], now), null)
})
test("invalid pacing inputs fail closed and EWMA configuration rejects invalid alpha", () => {
  for (const clock of [NaN, Infinity]) assert.equal(slots(reading(), clock), 0)
  for (const inflight of [-1, NaN, Infinity]) assert.equal(slots(reading(), now, undefined, inflight), 0)
  for (const rate of [0, -1, NaN, Infinity]) {
    assert.equal(slots(reading(), now, { primary: { pointsPerAgentHour: rate, source: "seed" } }), 0)
  }
  assert.equal(slots(reading(), now, {}), 0)
  for (const used of [-1, NaN, Infinity]) assert.equal(slots(reading(used), now), 0)
  assert.equal(exhausted([], now), false)
  const failed = { ...reading(), usage: null, error: { _tag: "NoToken" as const, accountId: "a", message: "missing" } }
  assert.equal(exhausted([failed], now), false)
  assert.equal(earliestReset([failed], now), null)
  for (const alpha of [0, -1, NaN, Infinity, 1.01]) assert.throws(() => learnRates([], [], {}, {}, alpha), RangeError)
})
test("learning preserves inputs, ignores used drops and handles account ordering", () => {
  const before = reading(20)
  const after = { ...reading(10), observedAt: now + 1000 }
  assert.equal(learnRates([before], [after], { a: 1 }).a!.primary!.pointsPerAgentHour, 2)
  for (const hours of [0, -1, NaN, Infinity]) {
    assert.equal(learnRates([before], [after], { a: hours }).a!.primary!.pointsPerAgentHour, 2)
  }
  const original = { a: seedRates("codex") }
  const snapshot = structuredClone(original)
  const increasing = { ...reading(30), observedAt: now + 1000 }
  const learned = learnRates([before], [increasing], { a: 1 }, original)
  assert.deepEqual(original, snapshot)
  assert.notEqual(learned.a, original.a)
  assert.equal(learnRates([], [increasing], { a: 1 }).a!.primary!.source, "seed")
  assert.equal(learnRates([before], [{ ...increasing, usage: null }], { a: 1 }).a!.primary!.source, "seed")
})
test("learning unavailable windows and readings never overwrite measured rates", () => {
  const before = reading(10)
  const after = { ...reading(20), observedAt: now + 1000 }
  const failed = { ...before, error: { _tag: "NoToken" as const, accountId: "a", message: "missing" } }
  for (const prior of [{ ...before, usage: null }, failed]) {
    assert.equal(learnRates([prior], [after], { a: 1 }).a!.primary!.source, "seed")
  }
  assert.equal(learnRates([before], [{ ...after, error: failed.error }], { a: 1 }).a!.primary!.source, "seed")
  const unmatched = {
    ...after,
    usage: { windows: [{ ...after.usage.windows[0]!, name: "seven_day" as const }], limitReached: false }
  }
  assert.equal(learnRates([before], [unmatched], { a: 1 }).a!.primary!.source, "seed")
  for (const used of [NaN, Infinity]) {
    assert.equal(learnRates([reading(used)], [after], { a: 1 }).a!.primary!.source, "seed")
    assert.equal(
      learnRates([before], [{ ...reading(used), observedAt: now + 1000 }], { a: 1 }).a!.primary!.source,
      "seed"
    )
  }
  assert.equal(exhausted([{ ...before, usage: { windows: [], limitReached: false } }], now), false)
  assert.equal(earliestReset([{ ...before, usage: null }], now), null)
})

function idleReading() {
  const r = reading(0, 5, "claude")
  return {
    ...r,
    usage: {
      windows: [
        { name: "five_hour" as const, used: 0, resetsAt: null as number | null, durationHours: 5 },
        { name: "seven_day" as const, used: 0, resetsAt: null as number | null, durationHours: 168 }
      ],
      limitReached: false
    }
  }
}

test("idle pacing retains duration, weekly and in-flight bounds", () => {
  const idle = idleReading()
  assert.equal(slots(idle, now), 0, "weekly idle duration still constrains an unbounded launch")
  assert.equal(slots(idle, now, undefined, 0, 1), 15)
  assert.equal(slots(idle, now, undefined, 2, 1), 13)
  assert.equal(slots(idle, now, undefined, 20, 1), 0)
  assert.equal(exhausted([idle], now), false, "idle usage is never quota exhaustion")
  assert.equal(earliestReset([idle], now), null)
  const weeklyBound: Reading = {
    ...idle,
    usage: {
      windows: [
        idle.usage!.windows[0]!,
        { name: "seven_day", used: 94, resetsAt: now + 3_600_000, durationHours: 168 }
      ],
      limitReached: false
    }
  }
  assert.equal(slots(weeklyBound, now, undefined, 0, 1), 0)
  const expired: Reading = {
    ...idle,
    usage: {
      windows: [
        idle.usage!.windows[0]!,
        { name: "seven_day", used: 0, resetsAt: now, durationHours: 168 }
      ],
      limitReached: false
    }
  }
  assert.equal(slots(expired, now, undefined, 0, 1), 0)
})

test("idle pacing refuses ambiguous usage, invalid duration and invalid launch horizon", () => {
  const idle = idleReading()
  for (const used of [1, 97, 100, NaN]) {
    const bad = structuredClone(idle)
    bad.usage!.windows[0]!.used = used
    assert.equal(slots(bad, now, undefined, 0, 1), 0)
    assert.equal(exhausted([bad], now), false)
  }
  for (const durationHours of [0, -1, NaN, Infinity]) {
    const bad = structuredClone(idle)
    bad.usage!.windows[0]!.durationHours = durationHours
    assert.equal(slots(bad, now, undefined, 0, 1), 0)
  }
  for (const resetsAt of [NaN, Infinity, -Infinity]) {
    const bad = structuredClone(idle)
    bad.usage!.windows[0]!.resetsAt = resetsAt
    assert.equal(slots(bad, now, undefined, 0, 1), 0)
  }
  for (const horizonHours of [0, -1, NaN, -Infinity]) {
    assert.equal(slots(idle, now, undefined, 0, horizonHours), 0)
  }
})

test("fresh idle readings recover stale capped accounts without learning across a reset", () => {
  const stale: Reading = reading(100, 0, "claude")
  const idle = { ...idleReading(), observedAt: now + 1000 }
  assert.equal(slots(stale, now, undefined, 0, 1), 0)
  assert.equal(slots(idle, now + 1000, undefined, 0, 1), 15)
  assert.equal(exhausted([idle], now + 1000), false)
  const rates = { a: seedRates("claude") }
  assert.deepEqual(learnRates([stale], [idle], { a: 1 }, rates), rates)
  const laterIdle = { ...idleReading(), observedAt: now + 2000 }
  assert.deepEqual(learnRates([idle], [laterIdle], { a: 1 }, rates), rates)
  const active = { ...reading(6, 5, "claude"), observedAt: now + 3000 }
  assert.deepEqual(learnRates([idle], [active], { a: 1 }, rates), rates)
})

test("weekly caps remain proven exhaustion when the five-hour window is idle", () => {
  for (const used of [96, 100]) {
    const capped = idleReading()
    capped.usage.windows[1]!.used = used
    capped.usage.windows[1]!.resetsAt = now + 3 * 24 * 3_600_000
    assert.equal(slots(capped, now, undefined, 0, 1), 0)
    assert.equal(exhausted([capped], now, {}, {}, 1), true)
    assert.equal(earliestReset([capped], now), capped.usage.windows[1]!.resetsAt)
  }
  const bounded = idleReading()
  bounded.usage.windows[1]!.used = 90
  bounded.usage.windows[1]!.resetsAt = now + 3_600_000
  assert.equal(slots(bounded, now, undefined, 0, 1), 4)
  assert.equal(exhausted([bounded], now, {}, {}, 1), false)
  assert.equal(exhausted([bounded], now, {}, { a: 4 }, 1), true)
  assert.equal(exhausted([bounded, idleReading()], now, {}, { a: 4 }, 1), false)
})

test("mixed idle and active exhaustion requires valid usage and a real future reset", () => {
  const capped = idleReading()
  capped.usage.windows[1]!.used = 100
  capped.usage.windows[1]!.resetsAt = now + 3_600_000
  for (const used of [1, 100, NaN]) {
    const bad = structuredClone(capped)
    bad.usage.windows[0]!.used = used
    assert.equal(exhausted([bad], now), false)
  }
  for (const resetsAt of [now - 1, now, NaN, Infinity, -Infinity, null]) {
    const bad = structuredClone(capped)
    bad.usage.windows[1]!.resetsAt = resetsAt
    assert.equal(exhausted([bad], now), false)
  }
  for (const durationHours of [0, -1, NaN, Infinity]) {
    const bad = structuredClone(capped)
    bad.usage.windows[0]!.durationHours = durationHours
    assert.equal(exhausted([bad], now), false)
  }
  assert.equal(exhausted([{ ...capped, account: { ...capped.account, tool: "codex" } }], now), false)
  assert.equal(exhausted([idleReading()], now), false)
})
