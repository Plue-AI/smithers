import { describe, expect, test } from "bun:test"
import type { Cookie } from "@playwright/test"
import { OwnerSessionCookies, withOwnerAuthRetry, type OwnerSessionScope } from "./owner-session"
import { parseAuthenticatedUser, ownerCredentialsFromEnvironment } from "./profile"

describe("matrix authenticated-user probe", () => {
  test("reads the canonical GET /api/user shape", () => {
    expect(parseAuthenticatedUser(200, { username: "owner", is_admin: true })).toEqual({
      login: "owner",
      admin: true
    })
    expect(parseAuthenticatedUser(200, { username: "member" })).toEqual({
      login: "member",
      admin: false
    })
  })

  test("treats canonical unauthorized as signed out and rejects old session bodies", () => {
    expect(parseAuthenticatedUser(401, undefined)).toBeUndefined()
    expect(() => parseAuthenticatedUser(200, { login: "legacy" } as never)).toThrow("unrecognized user body")
  })
})

const scope: OwnerSessionScope = {
  appOrigin: "http://127.0.0.1:4000/owner/repo", apiOrigin: "http://127.0.0.1:4000",
  username: "owner", password: "unit-test-password", bootstrapToken: "unit-bootstrap"
}
const cookies = (): Cookie[] => [{
  name: "session", value: "issued-session", domain: "127.0.0.1", path: "/",
  expires: -1, httpOnly: true, secure: false, sameSite: "Lax"
}]

describe("verified owner session cookies", () => {
  test("isolates browser-context copies and keeps only cookies", () => {
    const cache = new OwnerSessionCookies()
    const original = cookies()
    cache.remember(scope, original)
    original[0]!.value = "changed after save"
    const first = cache.read(scope)
    expect(first[0]!.value).toBe("issued-session")
    first[0]!.value = "changed by one context"
    expect(cache.read(scope)[0]!.value).toBe("issued-session")
    expect(cache.read({ ...scope, appOrigin: "http://127.0.0.1:4000/another/repo" })).toEqual(cookies())
  })

  test("never reuses another origin, owner, or credential envelope", () => {
    const cache = new OwnerSessionCookies()
    cache.remember(scope, cookies())
    for (const change of [
      { appOrigin: "http://127.0.0.1:4001" }, { apiOrigin: "http://127.0.0.1:4001" },
      { username: "another-owner" }, { password: "rotated-password" }, { bootstrapToken: "new-installation" }
    ]) expect(cache.read({ ...scope, ...change })).toEqual([])
  })

  test("forgets a rejected session without clearing a different owner", () => {
    const cache = new OwnerSessionCookies()
    const another = { ...scope, username: "another-owner" }
    cache.remember(scope, cookies())
    cache.remember(another, cookies())
    cache.forget(scope)
    expect(cache.read(scope)).toEqual([])
    expect(cache.read(another)).toEqual(cookies())
  })

  test("separate workers do not share mutable credential state", () => {
    const first = new OwnerSessionCookies(), second = new OwnerSessionCookies()
    first.remember(scope, cookies())
    expect(second.read(scope)).toEqual([])
  })
})

const timer = () => {
  let now = Date.UTC(2026, 0, 1)
  const waits: number[] = []
  return { now: () => now, wait: async (ms: number) => { waits.push(ms); now += ms }, waits }
}

describe("owner authentication Retry-After", () => {
  test("honors seconds and HTTP dates before retrying an actually rejected request", async () => {
    const time = timer()
    const replies = [
      { status: 429, retryAfter: "2" },
      { status: 429, retryAfter: new Date(time.now() + 5_000).toUTCString() },
      { status: 200, retryAfter: null, token: "issued-token" }
    ]
    const result = await withOwnerAuthRetry(async () => replies.shift()!, time)
    expect(result).toEqual({ status: 200, retryAfter: null, token: "issued-token" })
    expect(time.waits).toEqual([2_000, 3_000])
  })

  test("does not retry invalid credentials, server errors, or successful writes", async () => {
    for (const status of [200, 201, 401, 403, 500, 503]) {
      let calls = 0
      const time = timer()
      expect(await withOwnerAuthRetry(async () => { calls++; return { status, retryAfter: "1" } }, time))
        .toEqual({ status, retryAfter: "1" })
      expect(calls).toBe(1)
      expect(time.waits).toEqual([])
    }
  })

  test("leaves missing, invalid, stale, and over-budget retry headers as failures", async () => {
    for (const retryAfter of [null, "invalid", "-1", "61", "", "Thu, 01 Jan 1970 00:00:00 GMT"]) {
      const time = timer()
      expect((await withOwnerAuthRetry(async () => ({ status: 429, retryAfter }), time)).status).toBe(429)
      expect(time.waits).toEqual([])
    }
  })

  test("bounds repeated throttling and never spins on Retry-After zero", async () => {
    const time = timer()
    let calls = 0
    await withOwnerAuthRetry(async () => { calls++; return { status: 429, retryAfter: "0" } }, time)
    expect(calls).toBe(6)
    expect(time.waits).toEqual([1, 1, 1, 1, 1])
    const slow = timer()
    await withOwnerAuthRetry(async () => ({ status: 429, retryAfter: "40" }), slow)
    expect(slow.waits).toEqual([40_000])
  })
})

test("owner credential envelopes retain legacy login fields and validate the optional seeded cookie", () => {
  const previousName = process.env.SMITHERS_REAL_AUTH_ENVIRONMENT
  const previousValue = process.env.MATRIX_SEEDED_COOKIE_TEST
  process.env.SMITHERS_REAL_AUTH_ENVIRONMENT = "MATRIX_SEEDED_COOKIE_TEST"
  const legacy = { username: "owner", password: "unused-fixture-password", bootstrapToken: "unused-fixture-bootstrap" }
  try {
    process.env.MATRIX_SEEDED_COOKIE_TEST = JSON.stringify(legacy)
    expect(ownerCredentialsFromEnvironment()).toEqual(legacy)
    const seeded = { ...legacy, sessionCookie: "a".repeat(64) }
    process.env.MATRIX_SEEDED_COOKIE_TEST = JSON.stringify(seeded)
    expect(ownerCredentialsFromEnvironment()).toEqual(seeded)
    for (const sessionCookie of [null, 1, "", "a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
      process.env.MATRIX_SEEDED_COOKIE_TEST = JSON.stringify({ ...legacy, sessionCookie })
      expect(() => ownerCredentialsFromEnvironment()).toThrow("invalid seeded session cookie")
    }
  } finally {
    if (previousName === undefined) delete process.env.SMITHERS_REAL_AUTH_ENVIRONMENT
    else process.env.SMITHERS_REAL_AUTH_ENVIRONMENT = previousName
    if (previousValue === undefined) delete process.env.MATRIX_SEEDED_COOKIE_TEST
    else process.env.MATRIX_SEEDED_COOKIE_TEST = previousValue
  }
})
