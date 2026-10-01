import { describe, expect, it } from "vitest"
import {
  begin,
  currentBudget,
  DEFAULT_LIMITS,
  earliestStart,
  emptyState,
  finish,
  isWrite,
  type Limits,
  reserveWrites,
  resolveLimits,
  resourceOf,
  type State
} from "../src/github/internal/rateBudget.ts"

const T0 = 1_800_000_000_000
const limits: Limits = DEFAULT_LIMITS
const headers = (values: Record<string, string>) => (name: string) => values[name]
const resetIn = (ms: number) => String((T0 + ms) / 1000)

describe("GitHub's documented limits", () => {
  it("default to the numbers docs.github.com publishes", () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxConcurrent: 50,
      writeSpacingMs: 1_000,
      writesPerMinute: 80,
      writesPerHour: 500,
      minPauseMs: 60_000,
      maxPauseMs: 3_600_000
    })
  })

  it("take explicit values, then the environment, then the defaults", () => {
    expect(resolveLimits({ writesPerMinute: 10 }, { SMITHERS_GITHUB_WRITES_PER_MINUTE: "20" }).writesPerMinute)
      .toBe(10)
    expect(resolveLimits({}, { SMITHERS_GITHUB_WRITES_PER_MINUTE: "20" }).writesPerMinute).toBe(20)
    expect(resolveLimits({}, { SMITHERS_GITHUB_WRITES_PER_MINUTE: " " }).writesPerMinute).toBe(80)
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS)
  })

  it("refuse a value that would silently disable a limit", () => {
    expect(() => resolveLimits({}, { SMITHERS_GITHUB_MAX_CONCURRENT: "0" })).toThrow(/maxConcurrent/)
    expect(() => resolveLimits({}, { SMITHERS_GITHUB_WRITE_SPACING_MS: "1.5" })).toThrow(/writeSpacingMs/)
    expect(() => resolveLimits({ writesPerHour: Number.NaN })).toThrow(/writesPerHour/)
    expect(resolveLimits({ writeSpacingMs: 0, minPauseMs: 0 }).writeSpacingMs).toBe(0)
  })
})

describe("request classification", () => {
  it("counts every verb but GET, HEAD, and OPTIONS as a write", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "post"]) expect(isWrite(method)).toBe(true)
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) expect(isWrite(method)).toBe(false)
  })

  it("names the primary budget a path spends", () => {
    expect(resourceOf("https://api.github.com/graphql")).toBe("graphql")
    expect(resourceOf("/api/graphql")).toBe("graphql")
    expect(resourceOf("graphql")).toBe("graphql")
    expect(resourceOf("/search/code?q=x")).toBe("code_search")
    expect(resourceOf("https://api.github.com/search/issues?q=graphql")).toBe("search")
    expect(resourceOf("repos/o/r/issues/1/comments")).toBe("core")
    expect(resourceOf("/repos/o/graphql-tools/issues")).toBe("core")
  })
})

describe("write slots", () => {
  it("space writes by writeSpacingMs and book them all or none", () => {
    const first = reserveWrites(emptyState, T0, 3, DEFAULT_LIMITS)
    expect(first.slots).toEqual([T0, T0 + 1000, T0 + 2000])
    expect(first.state.writes).toEqual(first.slots)
    expect(emptyState.writes).toEqual([])
    const second = reserveWrites(first.state, T0 + 500, 1, DEFAULT_LIMITS)
    expect(second.slots).toEqual([T0 + 3000])
  })

  it("start no earlier than now or the machine-wide pause", () => {
    expect(reserveWrites({ ...emptyState, writes: [T0 - 10_000] }, T0, 1, DEFAULT_LIMITS).slots).toEqual([T0])
    expect(reserveWrites({ ...emptyState, pausedUntil: T0 + 5000 }, T0, 1, DEFAULT_LIMITS).slots).toEqual([T0 + 5000])
  })

  it("never start more than writesPerMinute in any 60 s", () => {
    const tight = { ...DEFAULT_LIMITS, writeSpacingMs: 0, writesPerMinute: 3 }
    const { slots } = reserveWrites(emptyState, T0, 7, tight)
    expect(slots).toEqual([T0, T0, T0, T0 + 60_000, T0 + 60_000, T0 + 60_000, T0 + 120_000])
    for (const at of slots) {
      expect(slots.filter((other) => other > at - 60_000 && other <= at).length).toBeLessThanOrEqual(3)
    }
  })

  it("never start more than writesPerHour in any hour, and forget writes older than an hour", () => {
    const hourly = { ...DEFAULT_LIMITS, writeSpacingMs: 0, writesPerMinute: 100, writesPerHour: 2 }
    const booked = reserveWrites(emptyState, T0, 3, hourly)
    expect(booked.slots).toEqual([T0, T0, T0 + 3_600_000])
    const later = reserveWrites(booked.state, T0 + 3_600_001, 1, hourly)
    expect(later.state.writes).toEqual([T0 + 3_600_000, T0 + 3_600_001])
    expect(later.slots).toEqual([T0 + 3_600_001])
  })
})

describe("starting a request", () => {
  it("waits out a machine-wide pause", () => {
    expect(begin({ ...emptyState, pausedUntil: T0 + 9000 }, T0, "core"))
      .toEqual({ admitted: false, reason: "paused", until: T0 + 9000 })
    expect(begin({ ...emptyState, pausedUntil: T0 }, T0, "core").admitted).toBe(true)
  })

  it("spends the modeled budget per start and waits for the reset once it is gone", () => {
    const state: State = { ...emptyState, budgets: { core: { limit: 5000, remaining: 1, resetAt: T0 + 60_000 } } }
    const first = begin(state, T0, "core")
    expect(first.admitted && first.state.budgets["core"]?.remaining).toBe(0)
    if (!first.admitted) throw new Error("expected admission")
    expect(begin(first.state, T0, "core")).toEqual({ admitted: false, reason: "budget", until: T0 + 60_000 })
    // Another resource's budget is its own.
    expect(begin(first.state, T0, "graphql").admitted).toBe(true)
    // A window that has reset no longer binds, and is not spent.
    const reset = begin(first.state, T0 + 60_000, "core")
    expect(reset.admitted && reset.state).toBe(first.state)
    expect(currentBudget(first.state, T0 + 60_000, "core")).toBeUndefined()
  })
})

describe("finishing a request", () => {
  const started = emptyState

  it("records the primary budget from x-ratelimit-* headers under x-ratelimit-resource", () => {
    const { state, pause } = finish(started, T0, {
      resource: "core",
      limited: false,
      headers: headers({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": resetIn(3_600_000),
        "x-ratelimit-resource": "core"
      })
    }, limits)
    expect(pause).toBeUndefined()
    expect(state.budgets["core"]).toEqual({ limit: 5000, remaining: 4999, resetAt: T0 + 3_600_000 })
  })

  it("keeps the lower count within a window, replaces it in a new one, and ignores a late answer", () => {
    const at = (remaining: string, reset: number) =>
      headers({ "x-ratelimit-limit": "5000", "x-ratelimit-remaining": remaining, "x-ratelimit-reset": resetIn(reset) })
    const base: State = { ...emptyState, budgets: { core: { limit: 5000, remaining: 10, resetAt: T0 + 60_000 } } }
    const same = finish(base, T0, { resource: "core", limited: false, headers: at("12", 60_000) }, limits).state
    expect(same.budgets["core"]?.remaining).toBe(10)
    const lower = finish(base, T0, { resource: "core", limited: false, headers: at("3", 60_000) }, limits).state
    expect(lower.budgets["core"]?.remaining).toBe(3)
    const next = finish(base, T0, { resource: "core", limited: false, headers: at("4999", 120_000) }, limits).state
    expect(next.budgets["core"]).toEqual({ limit: 5000, remaining: 4999, resetAt: T0 + 120_000 })
    const late = finish(base, T0, { resource: "core", limited: false, headers: at("0", 30_000) }, limits).state
    expect(late.budgets["core"]?.remaining).toBe(10)
    // Once the stored window has passed, any current answer replaces it.
    const expired =
      finish(base, T0 + 60_000, { resource: "core", limited: false, headers: at("7", 61_000) }, limits).state
    expect(expired.budgets["core"]?.remaining).toBe(7)
  })

  it("ignores missing, malformed, or past budget headers", () => {
    for (
      const values of [
        {},
        { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "x", "x-ratelimit-reset": resetIn(1000) },
        { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "-1", "x-ratelimit-reset": resetIn(1000) },
        { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "1", "x-ratelimit-reset": resetIn(0) }
      ]
    ) {
      expect(finish(started, T0, { resource: "core", limited: false, headers: headers(values) }, limits).state.budgets)
        .toEqual({})
    }
    expect(finish(started, T0, { resource: "core", limited: false }, limits).state.budgets).toEqual({})
  })

  it("caps a reset beyond maxPauseMs, so a skewed header cannot park callers for days", () => {
    const { state } = finish(started, T0, {
      resource: "core",
      limited: false,
      headers: headers({ "x-ratelimit-limit": "1", "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(9e9) })
    }, limits)
    expect(state.budgets["core"]?.resetAt).toBe(T0 + limits.maxPauseMs)
  })

  it("pauses every caller for retry-after seconds", () => {
    const { state, pause } = finish(started, T0, {
      resource: "core",
      limited: true,
      headers: headers({ "retry-after": "30" })
    }, limits)
    expect(state.pausedUntil).toBe(T0 + 30_000)
    expect(pause).toEqual({ until: T0 + 30_000, cause: "retry-after 30s" })
    // The backoff still grows, for the next limit that names no wait.
    expect(state.backoffMs).toBe(60_000)
  })

  it("pauses until x-ratelimit-reset when the primary budget is spent", () => {
    const { state, pause } = finish(started, T0, {
      resource: "core",
      limited: true,
      headers: headers({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": resetIn(600_000),
        "x-ratelimit-resource": "core"
      })
    }, limits)
    expect(state.pausedUntil).toBe(T0 + 600_000)
    expect(pause?.cause).toMatch(/core budget exhausted/)
  })

  it("backs off a minute, doubling while limits persist, capped, and resets on success", () => {
    let state: State = started
    const seen: Array<number> = []
    for (let i = 0; i < 8; i++) {
      state = finish(state, T0, { resource: "core", limited: true }, limits).state
      seen.push(state.backoffMs)
    }
    expect(seen).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000])
    expect(state.pausedUntil).toBe(T0 + 3_600_000)
    expect(finish(state, T0, { resource: "core", limited: false }, limits).state.backoffMs).toBe(0)
  })

  it("never shortens a pause another caller set, and reports only a pause it extended", () => {
    const paused: State = { ...started, pausedUntil: T0 + 120_000 }
    const shorter = finish(
      paused,
      T0,
      { resource: "core", limited: true, headers: headers({ "retry-after": "5" }) },
      limits
    )
    expect(shorter.state.pausedUntil).toBe(T0 + 120_000)
    expect(shorter.pause).toBeUndefined()
    const capped = finish(
      paused,
      T0,
      { resource: "core", limited: true, headers: headers({ "retry-after": "99999" }) },
      limits
    )
    expect(capped.state.pausedUntil).toBe(T0 + limits.maxPauseMs)
  })
})

describe("the earliest start", () => {
  it("is now for an idle principal", () => {
    expect(earliestStart(emptyState, T0, 0, "core", DEFAULT_LIMITS)).toBe(T0)
    expect(earliestStart(emptyState, T0, 1, "core", DEFAULT_LIMITS)).toBe(T0)
  })

  it("covers every write booked ahead, the pause, and a spent budget, booking nothing", () => {
    const state = reserveWrites(emptyState, T0, 2, DEFAULT_LIMITS).state
    expect(earliestStart(state, T0, 3, "core", DEFAULT_LIMITS)).toBe(T0 + 4000)
    expect(state.writes).toHaveLength(2)
    expect(earliestStart({ ...emptyState, pausedUntil: T0 + 9000 }, T0, 0, "core", DEFAULT_LIMITS)).toBe(T0 + 9000)
    const spent: State = { ...emptyState, budgets: { core: { limit: 1, remaining: 0, resetAt: T0 + 5000 } } }
    expect(earliestStart(spent, T0, 0, "core", DEFAULT_LIMITS)).toBe(T0 + 5000)
    expect(earliestStart(spent, T0, 0, "search", DEFAULT_LIMITS)).toBe(T0)
  })
})
