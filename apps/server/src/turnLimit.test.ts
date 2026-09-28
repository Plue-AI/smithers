import { describe, expect, spyOn, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import { memoryStorage, storageLayer } from "./DurableStorage"
import { RECOMMEND_ALL_CEILING, RECOMMEND_CEILING } from "./recommend"
import type { NativeNamespace } from "./DurableStorage"
import {
  ANONYMOUS_ALL_CEILING,
  ANONYMOUS_ALL_KEY,
  ANONYMOUS_ALL_TURN_MAX,
  ANONYMOUS_CEILING,
  ANONYMOUS_TURN_MAX,
  anonymousBucketAddress,
  ERASE_CEILING,
  anonymousTurnKey,
  LOGIN_CEILING,
  LOGIN_ALL_CEILING,
  LOGIN_ALL_KEY,
  LOGIN_DAILY_CEILING,
  loginDailyKey,
  TURN_WINDOW_MAX,
  TURN_WINDOW_MS,
  TurnLimits,
  turnLimitResponse,
  turnLimitsLayer,
  TurnRateLimiter,
  turnRateLimiterRequest
} from "./turnLimit"
import type { TurnBudget, TurnCeiling } from "./turnLimit"

/*
 * The per-login turn ceiling. Chat is comped during the alpha, so the balance
 * is not a spend limit and nothing else bounds what one session can cost. These
 * tests hold the ceiling to being an ABUSE guard: it must be invisible to a
 * person, it must not read like a paywall when it does fire, and it must never
 * lock someone out because our own infrastructure hiccuped.
 */

/**
 * A namespace of in-memory buckets. `spent` names keys whose budget is
 * already exhausted — seeding the window is how a test reaches the refusal
 * without driving `TURN_WINDOW_MAX` real turns through the seam, which would
 * make the suite slower every time the ceiling rises.
 */
const memoryLimits = (
  spent: ReadonlyArray<string> = []
): NativeNamespace & { readonly logins: () => Array<string> } => {
  const buckets = new Map<string, TurnRateLimiter>()
  const bucketFor = (name: string): TurnRateLimiter => {
    let bucket = buckets.get(name)
    if (bucket === undefined) {
      bucket = new TurnRateLimiter({
        storage: spent.includes(name)
          ? memoryStorage({ window: { start: Date.now(), count: TURN_WINDOW_MAX } })
          : memoryStorage()
      })
      buckets.set(name, bucket)
    }
    return bucket
  }
  return {
    logins: () => [...buckets.keys()],
    idFromName: (name) => name,
    get: (id) => ({ fetch: (request) => bucketFor(String(id)).fetch(request) })
  }
}

const spend = async (limiter: TurnRateLimiter): Promise<TurnBudget> => {
  const response = await limiter.fetch(new Request("https://turn-limit.internal/spend", { method: "POST" }))
  return (await response.json()) as TurnBudget
}

/** Spend through the Worker-side service, over `limits` (or no binding at all). */
const spendTurn = (limits: NativeNamespace | undefined, key: string, ceiling?: TurnCeiling): Promise<TurnBudget> =>
  Effect.runPromise(
    TurnLimits.use((service) => service.spend(key, ceiling)).pipe(Effect.provide(turnLimitsLayer(limits)))
  )

const keyFor = (request: Request, salt: string | undefined): Promise<string> => Effect.runPromise(anonymousTurnKey(request, salt))

describe("the per-login turn ceiling (Durable Object state)", () => {
  test("admits every turn up to the ceiling and counts down honestly", async () => {
    const limiter = new TurnRateLimiter({ storage: memoryStorage() })
    const first = await spend(limiter)
    expect(first.allowed).toBe(true)
    expect(first.remaining).toBe(TURN_WINDOW_MAX - 1)

    for (let turn = 2; turn <= TURN_WINDOW_MAX; turn += 1) {
      const budget = await spend(limiter)
      expect(budget.allowed).toBe(true)
      expect(budget.remaining).toBe(TURN_WINDOW_MAX - turn)
    }
    const over = await spend(limiter)
    expect(over.allowed).toBe(false)
    expect(over.remaining).toBe(0)
    expect(typeof over.retryAt).toBe("number")
  })

  test("a refused turn does not push its own reset further away", async () => {
    const opened = Date.now() - 30 * 60 * 1000
    const storage = memoryStorage({ window: { start: opened, count: TURN_WINDOW_MAX } })
    const limiter = new TurnRateLimiter({ storage })
    const first = await spend(limiter)
    const second = await spend(limiter)
    expect(first.allowed).toBe(false)
    expect(second.retryAt).toBe(first.retryAt)
    expect(first.retryAt).toBe(opened + TURN_WINDOW_MS)
  })

  test("a window older than the budget period starts a fresh one", async () => {
    const storage = memoryStorage({
      window: { start: Date.now() - TURN_WINDOW_MS - 1, count: TURN_WINDOW_MAX }
    })
    const budget = await spend(new TurnRateLimiter({ storage }))
    expect(budget.allowed).toBe(true)
    expect(budget.remaining).toBe(TURN_WINDOW_MAX - 1)
  })

  test("the window is the clock's: a spent bucket reopens exactly one window after it opened", async () => {
    // The object reads the Effect clock, so the expiry is proved by moving
    // time instead of by seeding a stale window.
    const opened = 1_700_000_000_000
    const storage = memoryStorage()
    const spendAt = () =>
      turnRateLimiterRequest(new Request("https://turn-limit.internal/spend?max=2&windowMs=1000", { method: "POST" })).pipe(
        Effect.flatMap((response) => Effect.promise(() => response.json() as Promise<TurnBudget>))
      )
    const budgets = await Effect.runPromise(
      Effect.gen(function*() {
        yield* TestClock.setTime(opened)
        const first = yield* spendAt()
        const second = yield* spendAt()
        const refused = yield* spendAt()
        yield* TestClock.adjust(999)
        const stillRefused = yield* spendAt()
        yield* TestClock.adjust(1)
        const reopened = yield* spendAt()
        return { first, second, refused, stillRefused, reopened }
      }).pipe(Effect.provide(Layer.mergeAll(storageLayer(storage), TestClock.layer())))
    )
    expect(budgets.first.remaining).toBe(1)
    expect(budgets.second.remaining).toBe(0)
    expect(budgets.refused).toEqual({ allowed: false, remaining: 0, retryAt: opened + 1000 })
    expect(budgets.stillRefused.retryAt).toBe(opened + 1000)
    expect(budgets.reopened).toEqual({ allowed: true, remaining: 1 })
    expect(storage.data.get("window")).toEqual({ start: opened + 1000, count: 1 })
  })

  test("spend is the object's only route: a read-only peek is 404 and leaves the window alone", async () => {
    const storage = memoryStorage()
    const limiter = new TurnRateLimiter({ storage })
    await spend(limiter)
    expect((await limiter.fetch(new Request("https://turn-limit.internal/peek"))).status).toBe(404)
    expect(storage.data.get("window")).toMatchObject({ count: 1 })
  })

  test("concurrent spends never admit past the ceiling", async () => {
    // Every read answers its snapshot a macrotask later, which is where a
    // second request can arrive between one spend's read and its write.
    const inner = memoryStorage()
    const limiter = new TurnRateLimiter({
      storage: {
        ...inner,
        get: async (key) => {
          const snapshot = await inner.get(key)
          await new Promise((resolve) => setTimeout(resolve, 1))
          return snapshot as never
        }
      }
    })
    const spendOne = async (): Promise<TurnBudget> =>
      (await (await limiter.fetch(new Request("https://turn-limit.internal/spend?max=1&windowMs=60000", { method: "POST" }))).json()) as TurnBudget
    const budgets = await Promise.all([spendOne(), spendOne(), spendOne()])
    expect(budgets.filter((budget) => budget.allowed)).toHaveLength(1)
    expect((inner.data.get("window") as { count: number }).count).toBe(1)
  })

  test("an unknown path is the object's own 404", async () => {
    const limiter = new TurnRateLimiter({ storage: memoryStorage() })
    expect((await limiter.fetch(new Request("https://turn-limit.internal/nope"))).status).toBe(404)
  })

  test("the caller names the ceiling with each request", async () => {
    const limiter = new TurnRateLimiter({ storage: memoryStorage() })
    const small = new Request("https://turn-limit.internal/spend?max=2&windowMs=60000", { method: "POST" })
    expect(((await (await limiter.fetch(small)).json()) as TurnBudget).remaining).toBe(1)
    expect(((await (await limiter.fetch(small)).json()) as TurnBudget).remaining).toBe(0)
    expect(((await (await limiter.fetch(small)).json()) as TurnBudget).allowed).toBe(false)
    // A malformed ceiling is the login default, never zero.
    const malformed = new Request("https://turn-limit.internal/spend?max=-1&windowMs=abc", { method: "POST" })
    expect(((await (await limiter.fetch(malformed)).json()) as TurnBudget).remaining).toBe(TURN_WINDOW_MAX - 3)
  })

  test("a storage failure is the object's own 500, not a defect", async () => {
    const limiter = new TurnRateLimiter({
      storage: {
        get: async () => {
          throw new Error("storage unavailable")
        },
        put: async () => {}
      }
    })
    const response = await limiter.fetch(new Request("https://turn-limit.internal/spend", { method: "POST" }))
    expect(response.status).toBe(500)
  })

  test("with no namespace bound the ceiling fails open", async () => {
    const budget = await spendTurn(undefined, "will")
    expect(budget.allowed).toBe(true)
    expect(budget.remaining).toBe(TURN_WINDOW_MAX)
  })

  test("an unreadable answer from our own Durable Object admits the turn", async () => {
    const broken: NativeNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => new Response("not json at all", { status: 500 }) })
    }
    expect((await spendTurn(broken, "will")).allowed).toBe(true)
  })

  test("a rejected Durable Object spend admits a login's turn and logs the cause", async () => {
    const cause = new Error("Durable Object reset because its code was updated.")
    const broken: NativeNamespace = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => {
          throw cause
        }
      })
    }
    const logged = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await spendTurn(broken, "will")).toEqual({ allowed: true, remaining: TURN_WINDOW_MAX })
      expect(await spendTurn(broken, "will", ERASE_CEILING)).toEqual({ allowed: true, remaining: ERASE_CEILING.max })
      expect(logged).toHaveBeenCalledWith("turn-limit spend failed:", cause)
    } finally {
      logged.mockRestore()
    }
  })

  /*
   * The anonymous and recommend ceilings are COST caps on the deployment's
   * own credentials. Admitting while their object is down would lift the cap
   * exactly when a flood has knocked it over, so each refuses as unavailable.
   */
  const brokenAnswers: ReadonlyArray<readonly [string, () => Promise<Response>]> = [
    ["a rejected fetch", async () => {
      throw new Error("Durable Object is overloaded.")
    }],
    ["a non-2xx answer", async () => new Response("storage is sealed", { status: 500 })],
    ["an unreadable 200", async () => new Response("not json at all", { status: 200 })]
  ]
  for (const ceiling of [ANONYMOUS_CEILING, ANONYMOUS_ALL_CEILING, RECOMMEND_CEILING, RECOMMEND_ALL_CEILING]) {
    for (const [what, fetch] of brokenAnswers) {
      test(`the ${ceiling.kind} cost ceiling (max ${ceiling.max}) refuses on ${what}`, async () => {
        const broken: NativeNamespace = { idFromName: (name) => name, get: () => ({ fetch }) }
        const logged = spyOn(console, "error").mockImplementation(() => {})
        try {
          expect(await spendTurn(broken, "anonymous:abc", ceiling)).toEqual({ allowed: false, remaining: 0, unavailable: true })
          expect(logged).toHaveBeenCalledTimes(1)
          expect(logged.mock.calls[0]![0]).toBe("turn-limit spend failed:")
        } finally {
          logged.mockRestore()
        }
      })
    }
  }

  test("a cost ceiling with no namespace bound still admits: local dev has no credential to protect", async () => {
    expect(await spendTurn(undefined, "anonymous:abc", ANONYMOUS_ALL_CEILING)).toEqual({
      allowed: true,
      remaining: ANONYMOUS_ALL_CEILING.max
    })
  })

  test("an unavailable budget is a 503 that blames our infrastructure, never the visitor's own limit", async () => {
    for (const ceiling of [ANONYMOUS_CEILING, ANONYMOUS_ALL_CEILING, RECOMMEND_CEILING]) {
      const response = turnLimitResponse({ allowed: false, remaining: 0, unavailable: true }, { "x-iso": "1" }, ceiling)
      expect(response.status).toBe(503)
      expect(response.headers.get("x-iso")).toBe("1")
      expect(response.headers.get("retry-after")).toBeNull()
      const body = (await response.json()) as { status: string; code: string; message: string; retryAt?: string }
      expect(body.status).toBe("error")
      expect(body.code).toBe("service_temporarily_unavailable")
      expect(body.retryAt).toBeUndefined()
      expect(body.message).toContain("Not your fault")
      expect(body.message).toContain("Nothing was charged")
      expect(body.message).not.toContain("daily limit")
    }
  })

  test("a refusal from our own Durable Object is logged with its status and body, not as a decoder error", async () => {
    const refusing: NativeNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => new Response("storage is sealed", { status: 500 }) })
    }
    const logged = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect((await spendTurn(refusing, "will")).allowed).toBe(true)
      expect(logged).toHaveBeenCalledTimes(1)
      expect(logged.mock.calls[0]![0]).toBe("turn-limit spend failed:")
      const cause = logged.mock.calls[0]![1] as Error
      expect(cause).toBeInstanceOf(Error)
      expect(cause.message).toBe("The turn limiter answered HTTP 500: storage is sealed")
    } finally {
      logged.mockRestore()
    }
  })

  test("an unreadable 200 answer is logged with what the decoder choked on", async () => {
    const broken: NativeNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => new Response("not json at all", { status: 200 }) })
    }
    const logged = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect((await spendTurn(broken, "will")).allowed).toBe(true)
      expect(logged).toHaveBeenCalledTimes(1)
      expect(logged.mock.calls[0]![0]).toBe("turn-limit spend failed:")
      expect(logged.mock.calls[0]![1]).toBeInstanceOf(SyntaxError)
    } finally {
      logged.mockRestore()
    }
  })

  test("each login has its own budget", async () => {
    const limits = memoryLimits()
    for (let turn = 0; turn < TURN_WINDOW_MAX; turn += 1) await spendTurn(limits, "will")
    expect((await spendTurn(limits, "will")).allowed).toBe(false)
    expect((await spendTurn(limits, "someone-else")).allowed).toBe(true)
    expect(limits.logins()).toEqual(["will", "someone-else"])
  })

  test("a spent bucket refuses before anything else is asked, with a retry time", async () => {
    const limits = memoryLimits(["will"])
    const refused = await spendTurn(limits, "will")
    expect(refused.allowed).toBe(false)
    expect(typeof refused.retryAt).toBe("number")
    expect(turnLimitResponse(refused, {}).headers.get("retry-after")).not.toBeNull()
  })

  test("the refusal reads as a bug report, not a bill", () => {
    const response = turnLimitResponse({ allowed: false, remaining: 0, retryAt: Date.now() + 600_000 }, {})
    expect(response.status).toBe(429)
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0)
  })

  test("the refusal never sends the user to billing", async () => {
    const response = turnLimitResponse({ allowed: false, remaining: 0, retryAt: Date.now() + 600_000 }, {})
    const body = (await response.json()) as { message: string; code: string }
    expect(body.code).toBe("turn_rate_limited")
    expect(body.message).toContain("looping")
    expect(body.message).toContain("balance is untouched")
    for (const word of ["upgrade", "billing", "pay", "plan", "$"]) {
      expect(body.message.toLowerCase()).not.toContain(word)
    }
  })

  test("the refusal carries the isolation headers it is given", () => {
    const response = turnLimitResponse({ allowed: false, remaining: 0 }, { "x-iso": "1" })
    expect(response.headers.get("x-iso")).toBe("1")
    expect(response.headers.get("content-type")).toBe("application/json")
  })

  test("an ordinary hour of chat never reaches the ceiling", async () => {
    // The guard is worthless if it fires on a real person. Sixty messages is
    // a heavy hour of conversation, and the browser chain authors several
    // links for each, so the ceiling has to clear sixty times a handful — it
    // sits at a thousand.
    const limits = memoryLimits()
    for (let turn = 0; turn < 60; turn += 1) {
      expect((await spendTurn(limits, "will")).allowed).toBe(true)
      // The chain's links for that message spend from the same budget.
      for (let link = 0; link < 8; link += 1) {
        expect((await spendTurn(limits, "will")).allowed).toBe(true)
      }
    }
  })
})

describe("signed-in daily and global ceilings", () => {
  test("the public ceiling contracts and bucket names are stable", () => {
    expect(LOGIN_DAILY_CEILING).toEqual({ kind: "login-daily", max: 5000, windowMs: 24 * 60 * 60 * 1000 })
    expect(LOGIN_ALL_CEILING).toEqual({ kind: "login-all", max: 50000, windowMs: 24 * 60 * 60 * 1000 })
    expect(LOGIN_ALL_KEY).toBe("login:all")
    expect(loginDailyKey("will")).toBe("login:daily:will")
    expect(loginDailyKey("alice")).not.toBe(loginDailyKey("will"))
    expect(loginDailyKey("will")).not.toBe(LOGIN_ALL_KEY)
  })

  for (const ceiling of [LOGIN_DAILY_CEILING, LOGIN_ALL_CEILING]) {
    test(`${ceiling.kind} admits the last call, holds its retry time, and resets at exactly 24 hours`, async () => {
      const opened = 1_700_000_000_000
      const storage = memoryStorage({ window: { start: opened, count: ceiling.max - 1 } })
      const spendAt = () => turnRateLimiterRequest(
        new Request(`https://turn-limit.internal/spend?max=${ceiling.max}&windowMs=${ceiling.windowMs}`, { method: "POST" })
      ).pipe(Effect.flatMap((response) => Effect.promise(() => response.json() as Promise<TurnBudget>)))
      const budgets = await Effect.runPromise(
        Effect.gen(function*() {
          yield* TestClock.setTime(opened)
          const last = yield* spendAt()
          const refused = yield* spendAt()
          yield* TestClock.adjust(ceiling.windowMs - 1)
          const stillRefused = yield* spendAt()
          yield* TestClock.adjust(1)
          const reopened = yield* spendAt()
          return { last, refused, stillRefused, reopened }
        }).pipe(Effect.provide(Layer.mergeAll(storageLayer(storage), TestClock.layer())))
      )
      expect(budgets.last).toEqual({ allowed: true, remaining: 0 })
      expect(budgets.refused).toEqual({ allowed: false, remaining: 0, retryAt: opened + ceiling.windowMs })
      expect(budgets.stillRefused).toEqual(budgets.refused)
      expect(budgets.reopened).toEqual({ allowed: true, remaining: ceiling.max - 1 })
      expect(storage.data.get("window")).toEqual({ start: opened + ceiling.windowMs, count: 1 })
    })
  }

  test("daily buckets remain per login and the global bucket spans logins", async () => {
    const names: Array<string> = []
    const buckets = new Map<string, ReturnType<typeof memoryStorage>>()
    const limits: NativeNamespace = {
      idFromName: (name) => { names.push(name); return name },
      get: (id) => ({ fetch: (request) => {
        const key = String(id)
        let storage = buckets.get(key)
        if (storage === undefined) {
          storage = memoryStorage({ window: { start: Date.now(), count: key === LOGIN_ALL_KEY ? LOGIN_ALL_CEILING.max - 1 : key === loginDailyKey("will") ? LOGIN_DAILY_CEILING.max : 0 } })
          buckets.set(key, storage)
        }
        return new TurnRateLimiter({ storage }).fetch(request)
      } })
    }
    expect((await spendTurn(limits, loginDailyKey("will"), LOGIN_DAILY_CEILING)).allowed).toBe(false)
    expect((await spendTurn(limits, loginDailyKey("alice"), LOGIN_DAILY_CEILING)).allowed).toBe(true)
    expect((await spendTurn(limits, LOGIN_ALL_KEY, LOGIN_ALL_CEILING)).remaining).toBe(0)
    expect((await spendTurn(limits, loginDailyKey("bob"), LOGIN_DAILY_CEILING)).allowed).toBe(true)
    expect((await spendTurn(limits, LOGIN_ALL_KEY, LOGIN_ALL_CEILING)).allowed).toBe(false)
    expect(names).toEqual([loginDailyKey("will"), loginDailyKey("alice"), LOGIN_ALL_KEY, loginDailyKey("bob"), LOGIN_ALL_KEY])
    expect((buckets.get(loginDailyKey("alice"))!.data.get("window") as { count: number }).count).toBe(1)
    expect((buckets.get(loginDailyKey("bob"))!.data.get("window") as { count: number }).count).toBe(1)
  })

  for (const ceiling of [LOGIN_CEILING, LOGIN_DAILY_CEILING, LOGIN_ALL_CEILING]) {
    test(`${ceiling.kind} fails open without a namespace and on every unreadable object result`, async () => {
      expect(await spendTurn(undefined, "bucket", ceiling)).toEqual({ allowed: true, remaining: ceiling.max })
      const failures: ReadonlyArray<readonly [string, () => Promise<Response>]> = [
        ["rejected fetch", async () => { throw new Error("Durable Object reset") }],
        ["non-2xx", async () => new Response("storage failure", { status: 500 })],
        ["invalid JSON", async () => new Response("not json", { status: 200 })],
        ["malformed budget", async () => Response.json({ allowed: false })]
      ]
      const logged = spyOn(console, "error").mockImplementation(() => {})
      try {
        for (const [, fetch] of failures) {
          const limits: NativeNamespace = { idFromName: (name) => name, get: () => ({ fetch }) }
          expect(await spendTurn(limits, "bucket", ceiling)).toEqual({ allowed: true, remaining: ceiling.max })
        }
      } finally {
        logged.mockRestore()
      }
    })
  }

  for (const ceiling of [LOGIN_DAILY_CEILING, LOGIN_ALL_CEILING]) {
    test(`${ceiling.kind} refusal names its scope and stays clear of sign-in and billing`, async () => {
      const retryAt = Date.now() + ceiling.windowMs
      const response = turnLimitResponse({ allowed: false, remaining: 0, retryAt }, { "x-iso": "1" }, ceiling)
      expect(response.status).toBe(429)
      expect(response.headers.get("x-iso")).toBe("1")
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0)
      const body = await response.json() as { code: string; message: string; retryAt: string }
      expect(body.code).toBe("turn_rate_limited")
      expect(Date.parse(body.retryAt)).toBe(retryAt)
      expect(body.message.toLowerCase()).toContain(ceiling.kind === "login-daily" ? "daily" : "everyone")
      for (const word of ["sign in", "upgrade", "billing", "pay", "plan", "$"]) {
        expect(body.message.toLowerCase()).not.toContain(word)
      }
    })
  }
})

/*
 * The anonymous ceiling (PUBLIC-REPOSITORIES.md): a signed-out visitor
 * exploring a catalog repository spends the deployment's credential, so the
 * bucket is a salted hash of the address, the ceiling is a day's worth of
 * questions, and the refusal names sign-in as the way on.
 */
describe("the anonymous ceiling", () => {
  const exploring = (ip: string): Request =>
    new Request("https://mvp.test/api/agent/turn", { method: "POST", headers: { "cf-connecting-ip": ip } })

  /** What the router does for a visitor: the address bucket, then the deployment-wide one. */
  const anonymousTurn = async (limits: NativeNamespace, ip: string): Promise<{ readonly budget: TurnBudget; readonly ceiling: TurnCeiling }> => {
    const key = await keyFor(exploring(ip), "test-salt")
    const budget = await spendTurn(limits, key, ANONYMOUS_CEILING)
    if (!budget.allowed) return { budget, ceiling: ANONYMOUS_CEILING }
    const shared = await spendTurn(limits, ANONYMOUS_ALL_KEY, ANONYMOUS_ALL_CEILING)
    return { budget: shared, ceiling: ANONYMOUS_ALL_CEILING }
  }

  test("one address gets a day of questions, then the sign-in refusal", async () => {
    const limits = memoryLimits()
    for (let turn = 0; turn < ANONYMOUS_TURN_MAX; turn += 1) {
      expect((await anonymousTurn(limits, "203.0.113.7")).budget.allowed).toBe(true)
    }
    const over = await anonymousTurn(limits, "203.0.113.7")
    expect(over.budget.allowed).toBe(false)
    const refused = turnLimitResponse(over.budget, {}, over.ceiling)
    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).not.toBeNull()
    const body = (await refused.json()) as { code: string; message: string }
    expect(body.code).toBe("turn_rate_limited")
    expect(body.message).toContain("Sign in with GitHub")
    expect(body.message).not.toContain("looping")
    // Another address is another bucket.
    expect((await anonymousTurn(limits, "198.51.100.9")).budget.allowed).toBe(true)
    // The buckets are hashes under the anonymous prefix: no address, no login.
    // The third bucket is the deployment-wide one, charged for every turn.
    expect(limits.logins()).toContain(ANONYMOUS_ALL_KEY)
    const addressed = limits.logins().filter((key) => key !== ANONYMOUS_ALL_KEY)
    expect(addressed).toHaveLength(2)
    for (const key of addressed) {
      expect(key).toMatch(/^anonymous:[0-9a-f]{64}$/)
      expect(key).not.toContain("203.0.113.7")
    }
  })

  test("an IPv6 visitor's whole /64 is one bucket", () => {
    expect(anonymousBucketAddress("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64")
    expect(anonymousBucketAddress("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64")
    expect(anonymousBucketAddress("2001:db8::1")).toBe("2001:db8:0:0::/64")
    expect(anonymousBucketAddress("::1")).toBe("0:0:0:0::/64")
    expect(anonymousBucketAddress("2001:db8:1:3::1")).not.toBe(anonymousBucketAddress("2001:db8:1:2::1"))
    expect(anonymousBucketAddress("203.0.113.7")).toBe("203.0.113.7")
    expect(anonymousBucketAddress("::ffff:203.0.113.7")).toBe("203.0.113.7")
  })

  test("two addresses in one /64 spend the same day of questions", async () => {
    const limits = memoryLimits()
    for (let turn = 0; turn < ANONYMOUS_TURN_MAX; turn += 1) {
      expect((await anonymousTurn(limits, "2001:db8:1:2::1")).budget.allowed).toBe(true)
    }
    // A sibling address in the same /64 finds the bucket already spent.
    const sibling = await anonymousTurn(limits, "2001:db8:1:2:aaaa:bbbb:cccc:dddd")
    expect(sibling.budget.allowed).toBe(false)
    const body = (await turnLimitResponse(sibling.budget, {}, sibling.ceiling).json()) as { message: string }
    expect(body.message).toContain(`${ANONYMOUS_TURN_MAX} turns today`)
    // The next /64 over is another visitor.
    expect((await anonymousTurn(limits, "2001:db8:1:3::1")).budget.allowed).toBe(true)
    expect(limits.logins().filter((key) => key !== ANONYMOUS_ALL_KEY)).toHaveLength(2)
  })

  test("the deployment-wide bucket refuses a fresh address once everyone's day is spent", async () => {
    const limits = memoryLimits([ANONYMOUS_ALL_KEY])
    const over = await anonymousTurn(limits, "198.51.100.9")
    expect(over.budget.allowed).toBe(false)
    expect(over.ceiling).toBe(ANONYMOUS_ALL_CEILING)
    const refused = turnLimitResponse(over.budget, {}, over.ceiling)
    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).not.toBeNull()
    const body = (await refused.json()) as { code: string; message: string }
    expect(body.code).toBe("turn_rate_limited")
    expect(body.message).toContain("everyone")
    expect(body.message).toContain("Sign in with GitHub")
    expect(body.message).not.toContain(`${ANONYMOUS_TURN_MAX} turns today`)
    // A login is not a visitor: its own bucket is untouched by the shared one.
    expect((await spendTurn(limits, "will")).allowed).toBe(true)
  })

  test("the deployment-wide ceiling counts every visitor together", async () => {
    const limits = memoryLimits()
    for (let turn = 0; turn < ANONYMOUS_ALL_TURN_MAX; turn += 1) {
      expect((await spendTurn(limits, ANONYMOUS_ALL_KEY, ANONYMOUS_ALL_CEILING)).allowed).toBe(true)
    }
    expect((await spendTurn(limits, ANONYMOUS_ALL_KEY, ANONYMOUS_ALL_CEILING)).allowed).toBe(false)
    // The per-address bucket is untouched: the refusal above is independent of it.
    expect((await spendTurn(limits, "anonymous:abc", ANONYMOUS_CEILING)).remaining).toBe(ANONYMOUS_TURN_MAX - 1)
  })

  test("the bucket key is salted and never a user's login", async () => {
    const request = new Request("https://mvp.test/api/agent/turn", { headers: { "cf-connecting-ip": "203.0.113.7" } })
    const salted = await keyFor(request, "salt-a")
    expect(salted).toMatch(/^anonymous:[0-9a-f]{64}$/)
    expect(await keyFor(request, "salt-a")).toBe(salted)
    expect(await keyFor(request, "salt-b")).not.toBe(salted)
    expect(await keyFor(request, undefined)).not.toBe(salted)
    expect(await keyFor(new Request("https://mvp.test/", { headers: { "cf-connecting-ip": "198.51.100.9" } }), "salt-a"))
      .not.toBe(salted)
  })

  test("the anonymous refusal names the day and sign-in, never a bug or a bill", async () => {
    const response = turnLimitResponse(
      { allowed: false, remaining: 0, retryAt: Date.now() + 5 * 60 * 60 * 1000 },
      {},
      ANONYMOUS_CEILING
    )
    expect(response.status).toBe(429)
    const body = (await response.json()) as { message: string; code: string }
    expect(body.code).toBe("turn_rate_limited")
    expect(body.message).toContain(`${ANONYMOUS_TURN_MAX} turns today`)
    expect(body.message).toContain("Sign in with GitHub")
    expect(body.message).toContain("hours")
    for (const word of ["looping", "upgrade", "billing", "pay", "plan", "$"]) {
      expect(body.message.toLowerCase()).not.toContain(word)
    }
  })

  test("a login's budget keeps its own ceiling beside the anonymous one", async () => {
    const limits = memoryLimits()
    for (let turn = 0; turn < ANONYMOUS_TURN_MAX; turn += 1) {
      expect((await spendTurn(limits, "will")).allowed).toBe(true)
    }
    // Twenty is nothing to a login; the same twenty spends an anonymous bucket.
    expect((await spendTurn(limits, "will")).remaining).toBe(TURN_WINDOW_MAX - ANONYMOUS_TURN_MAX - 1)
    for (let turn = 0; turn < ANONYMOUS_TURN_MAX; turn += 1) {
      expect((await spendTurn(limits, "anonymous:abc", ANONYMOUS_CEILING)).allowed).toBe(true)
    }
    expect((await spendTurn(limits, "anonymous:abc", ANONYMOUS_CEILING)).allowed).toBe(false)
  })
})
