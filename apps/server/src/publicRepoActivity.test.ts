import { describe, expect, test } from "bun:test"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { configLayer } from "./Config"
import { EdgeCache, memoryEdgeCache } from "./githubApp"
import type { EdgeCacheShape } from "./githubApp"
import { transportLayer } from "./Http"
import type { FetchImplementation } from "./Http"
import { ACTIVITY_WINDOW_MS, activitySentence, makePublicRepoActivityHandler, parsePublicRepoActivityPath } from "./publicRepoActivity"
import type { PublicRepoActivity } from "./publicRepoActivity"

const NOW = Date.parse("2026-09-07T12:00:00Z")
const MIRROR = "https://cloud.test/api/repos/smithers-canary/smithers"
const DAY = 24 * 60 * 60 * 1000

const at = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString()

/**
 * A mirror for one week: 12 commits on main inside the window, 3 landing
 * requests and 5 issues opened inside the window and one of each opened
 * before it. The commit count is the mirror's own ancestry count, so no
 * change feed takes part.
 */
const mirror = () => {
  const landings = [{ number: 4, created_at: at(1) }, { number: 3, created_at: at(3) }, { number: 2, created_at: at(6) }, { number: 1, created_at: at(20) }]
  const issues = [5, 4, 3, 2, 1].map((number) => ({ number, created_at: at(number) })).concat([{ number: 0, created_at: at(8) }])
  return {
    documents: {
      "": { default_bookmark: "main", full_name: "smithers-canary/smithers" },
      "/git/refs": [
        { ref: "refs/heads/side", object: { sha: "sha-s0", type: "commit" } },
        { ref: "refs/heads/main", object: { sha: "sha-m0", type: "commit" } }
      ],
      "/changes/count": { count: 12 },
      "/landings": landings,
      "/issues": issues
    } as Record<string, unknown>
  }
}

type Answer = (path: string, url: URL) => Response | undefined | Promise<Response>

/** A clock the test moves by hand; sleeps (deadlines) still run on the real timer. */
const testClock = (start: number) => {
  let now = start
  const real = Clock.Clock.defaultValue()
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: real.monotonicTimeNanos,
    sleep: (duration) => real.sleep(duration)
  }
  return { clock, advance: (ms: number) => { now += ms } }
}

const ACTIVITY_PATH = "/api/public/repos/smithersai/smithers/activity"

/**
 * One Worker isolate: an activity handler over an injected transport (the
 * mirror), the configured Cloud origin, an edge cache, and a clock.
 */
const harness = (answer?: Answer, documents: Record<string, unknown> = mirror().documents, edge: EdgeCacheShape = memoryEdgeCache()) => {
  const { clock, advance } = testClock(NOW)
  const requests: Array<Request> = []
  const fetchImpl: FetchImplementation = async (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    const url = new URL(request.url)
    if (!url.href.startsWith(MIRROR)) return Response.json({ message: "not the mirror" }, { status: 404 })
    const path = url.pathname.slice(new URL(MIRROR).pathname.length)
    const custom = answer?.(path, url)
    if (custom !== undefined) return custom
    return path in documents ? Response.json(documents[path]) : Response.json({ message: "not found" }, { status: 404 })
  }
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    transportLayer(fetchImpl),
    configLayer({ SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" }),
    Layer.succeed(EdgeCache, edge),
    Layer.succeed(Clock.Clock, clock)
  ))
  const handler = makePublicRepoActivityHandler()
  const toRequest = (path = ACTIVITY_PATH, init?: RequestInit) =>
    new Request(`https://app.test${path}`, { headers: { origin: "https://smithers.sh", cookie: "session=private" }, ...init })
  return {
    request: (path?: string, init?: RequestInit) => runtime.runPromise(handler(toRequest(path, init))),
    /** N concurrent readers of this isolate, as N fibers. */
    concurrently: (paths: ReadonlyArray<string>) =>
      runtime.runPromise(Effect.all(paths.map((path) => handler(toRequest(path))), { concurrency: "unbounded" })),
    /** Another isolate over the same mirror, edge cache, and clock. */
    coldIsolate: () => {
      const cold = makePublicRepoActivityHandler()
      return (path?: string) => runtime.runPromise(cold(toRequest(path)))
    },
    requests,
    advance
  }
}

describe("the activity sentence", () => {
  test("unavailable mirror documents release their unused response bodies", async () => {
    let cancelled = 0
    const server = harness(() => new Response(new ReadableStream({ cancel() { cancelled++ } }), { status: 503 }))
    expect((await server.request()).status).toBe(200)
    expect(server.requests.length).toBeGreaterThan(0)
    expect(cancelled).toBe(server.requests.length)
  })

  test("names each count with its own number and verb", () => {
    expect(activitySentence({ commits: 12, pullRequests: 3, issues: 5 }, "main"))
      .toBe("In the last 7 days, 12 commits landed on main, 3 pull requests were opened, and 5 issues were filed.")
    expect(activitySentence({ commits: 1, pullRequests: 1, issues: 1 }, "main"))
      .toBe("In the last 7 days, 1 commit landed on main, 1 pull request was opened, and 1 issue was filed.")
    expect(activitySentence({ commits: 0, pullRequests: 0, issues: 0 }, "trunk"))
      .toBe("In the last 7 days, no commits landed on trunk, no pull requests were opened, and no issues were filed.")
  })

  test("drops a count the mirror could not answer and says so after the sentence", () => {
    expect(activitySentence({ commits: 2, pullRequests: null, issues: 0 }, "main"))
      .toBe("In the last 7 days, 2 commits landed on main and no issues were filed. Pull request activity is not available.")
    expect(activitySentence({ commits: null, pullRequests: null, issues: 4 }, null))
      .toBe("In the last 7 days, 4 issues were filed. Commit activity is not available. Pull request activity is not available.")
    expect(activitySentence({ commits: null, pullRequests: null, issues: null }, null))
      .toBe("Recent activity is not available.")
  })

  test("is one sentence, no em dashes, deterministic for equal counts", () => {
    const first = activitySentence({ commits: 7, pullRequests: 2, issues: 1 }, "main")
    expect(first).toBe(activitySentence({ commits: 7, pullRequests: 2, issues: 1 }, "main"))
    expect(first).not.toContain("—")
  })
})

describe("GET /api/public/repos/<owner>/<name>/activity", () => {
  test("recognizes the route for a catalog spelling and rejects other paths", () => {
    expect(parsePublicRepoActivityPath("/api/public/repos/smithersai/smithers/activity")).toBe("smithersai/smithers")
    expect(parsePublicRepoActivityPath("/api/public/repos/SmithersAI/Smithers/activity/")).toBe("SmithersAI/Smithers")
    for (const path of ["/api/public/repos", "/api/public/repos/smithersai/smithers", "/api/public/repos/a/../activity", "/api/repos/smithersai/smithers/activity"]) {
      expect(parsePublicRepoActivityPath(path)).toBeUndefined()
    }
  })

  test("counts the week from the mirror's own feeds: commits on the default bookmark, landings, and issues", async () => {
    const { request, requests } = harness()
    const response = await request()
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=300")
    const body = await response.json() as PublicRepoActivity
    expect(body).toEqual({
      sentence: "In the last 7 days, 12 commits landed on main, 3 pull requests were opened, and 5 issues were filed.",
      counts: { commits: 12, pullRequests: 3, issues: 5 },
      since: new Date(NOW - ACTIVITY_WINDOW_MS).toISOString()
    })
    // Every read is the credential-free mirror read at the configured Cloud origin; GitHub is never called.
    expect(requests.length).toBeGreaterThan(0)
    for (const upstream of requests) {
      expect(upstream.url.startsWith(MIRROR)).toBe(true)
      expect(upstream.headers.has("authorization")).toBe(false)
      expect(upstream.headers.has("cookie")).toBe(false)
    }
    expect(requests.map((upstream) => new URL(upstream.url).pathname.slice(new URL(MIRROR).pathname.length)).sort())
      .toEqual(["", "/changes/count", "/git/refs", "/issues", "/landings"])
  })

  test("a feed the mirror cannot answer yields the honest partial sentence and a short cache", async () => {
    const { request } = harness((path) => path === "/landings" ? Response.json({ message: "not found" }, { status: 404 }) : undefined)
    const response = await request()
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=30")
    const body = await response.json() as PublicRepoActivity
    expect(body.counts).toEqual({ commits: 12, pullRequests: null, issues: 5 })
    expect(body.sentence).toBe("In the last 7 days, 12 commits landed on main and 5 issues were filed. Pull request activity is not available.")
  })

  test("a malformed feed is unavailable, never a zero", async () => {
    for (const bad of [
      () => new Response("not json"),
      () => Response.json({ count: "12" }),
      () => Response.json({ count: -1 }),
      () => { throw new Error("offline") }
    ]) {
      const { request } = harness((path) => path === "/changes/count" ? bad() : undefined)
      const body = await (await request()).json() as PublicRepoActivity
      expect(body.counts).toEqual({ commits: null, pullRequests: 3, issues: 5 })
      expect(body.sentence).toBe("In the last 7 days, 3 pull requests were opened and 5 issues were filed. Commit activity is not available.")
    }
    const { request } = harness(undefined, { ...mirror().documents, "": { default_bookmark: "" } })
    expect(((await (await request()).json()) as PublicRepoActivity).sentence)
      .toBe("In the last 7 days, 3 pull requests were opened and 5 issues were filed. Commit activity is not available.")
  })

  test("a mirror that answers nothing is the honest empty sentence", async () => {
    const { request, requests } = harness(() => Response.json({ message: "not found" }, { status: 404 }))
    const response = await request()
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=30")
    expect(((await response.json()) as PublicRepoActivity).sentence).toBe("Recent activity is not available.")
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((upstream) => upstream.url.startsWith(MIRROR))).toBe(true)
  })

  test("the commit count query carries the default bookmark's head and the window start", async () => {
    const { request, requests } = harness()
    const body = await (await request()).json() as PublicRepoActivity
    expect(body.counts.commits).toBe(12)
    const counts = requests.filter((upstream) => new URL(upstream.url).pathname.endsWith("/changes/count"))
    expect(counts).toHaveLength(1)
    const query = new URL(counts[0]!.url).searchParams
    expect(query.get("rev")).toBe("sha-m0")
    expect(query.get("since")).toBe(new Date(NOW - ACTIVITY_WINDOW_MS).toISOString())
  })

  // Regression for #3000: a repository whose ancestry outruns the old
  // twenty-page change-feed walk (smithersai/smithers has ~14k commits) still
  // reports commits, because the mirror counts the window itself.
  test("a history larger than the old page bound still reports commits, without reading the change feed", async () => {
    const { request, requests } = harness((path) =>
      path === "/changes/count"
        ? Response.json({ count: 13452 })
        : path === "/changes" || path.startsWith("/changes/")
        ? Response.json({ message: "the feed cannot answer this history" }, { status: 404 })
        : undefined)
    const response = await request()
    expect(response.headers.get("cache-control")).toBe("public, max-age=300")
    const body = await response.json() as PublicRepoActivity
    expect(body.counts).toEqual({ commits: 13452, pullRequests: 3, issues: 5 })
    expect(body.sentence).toBe("In the last 7 days, 13452 commits landed on main, 3 pull requests were opened, and 5 issues were filed.")
    // The paged change feed is never touched: it is what could not scale.
    expect(requests.filter((upstream) => new URL(upstream.url).pathname.endsWith("/changes"))).toHaveLength(0)
  })

  test("a count the mirror cannot answer is unavailable, never a zero", async () => {
    for (const answer of [
      () => Response.json({ message: "unknown revision" }, { status: 400 }),
      () => Response.json({ message: "not found" }, { status: 404 }),
      () => Response.json({ count: 1.5 })
    ]) {
      const { request } = harness((path) => path === "/changes/count" ? answer() : undefined)
      const body = await (await request()).json() as PublicRepoActivity
      expect(body.counts).toEqual({ commits: null, pullRequests: 3, issues: 5 })
      expect(body.sentence).toBe("In the last 7 days, 3 pull requests were opened and 5 issues were filed. Commit activity is not available.")
    }
  })

  test("a repository outside the catalog is 404 and reaches no upstream", async () => {
    const { request, requests } = harness()
    for (const path of ["/api/public/repos/example/other/activity", "/api/public/repos/smithersai/smithers-docs/activity"]) {
      const response = await request(path)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        status: "error",
        code: "route_not_found",
        message: "Repository is not in the public catalog."
      })
    }
    expect(requests).toHaveLength(0)
  })

  test("a completed cache hit skips the upstream for five minutes across catalog spellings", async () => {
    const { request, requests, advance } = harness()
    const responses = [await request(ACTIVITY_PATH), await request("/api/public/repos/SmithersAI/Smithers/activity"), await request(`${ACTIVITY_PATH}?bust=1`)]
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
    const first = requests.length
    expect(first).toBe(5)
    advance(299_000)
    expect((await request()).headers.get("cache-control")).toBe("public, max-age=1")
    expect(requests).toHaveLength(first)
    advance(1_001)
    await request()
    expect(requests).toHaveLength(first * 2)
  })

  test("a cold activity miss owns its refresh instead of waiting on another Worker's request", async () => {
    const pending: Array<(response: Response) => void> = []
    const { request } = harness(path => path === "/issues" ? new Promise(resolve => pending.push(resolve)) : undefined)
    const flush = async (count: number) => {
      for (let attempt = 0; attempt < 100 && pending.length < count; attempt++) await new Promise(resolve => setTimeout(resolve, 2))
    }
    const first = request()
    await flush(1)
    const second = request()
    try {
      await flush(2)
      expect(pending).toHaveLength(2)
      pending[1]!(Response.json([{ number: 1, created_at: at(1) }]))
      expect((await (await second).json() as PublicRepoActivity).counts.issues).toBe(1)
      pending[0]!(Response.json([]))
      expect((await (await first).json() as PublicRepoActivity).counts.issues).toBe(0)
      expect((await (await request()).json() as PublicRepoActivity).counts.issues).toBe(0)
      expect(pending).toHaveLength(2)
    } finally {
      for (const resolve of pending) resolve(Response.json([]))
      await Promise.all([first, second])
    }
  })

  test("the edge cache is reusable across Worker instances and expires", async () => {
    const edge = memoryEdgeCache()
    const { request, coldIsolate, requests, advance } = harness(undefined, mirror().documents, edge)
    await request()
    const second = await coldIsolate()(`${ACTIVITY_PATH}?different=1`)
    expect(requests).toHaveLength(5)
    expect(((await second.json()) as PublicRepoActivity).counts.commits).toBe(12)
    expect([...edge.records.keys()]).toEqual([`https://app.test${ACTIVITY_PATH}`])
    advance(300_001)
    await coldIsolate()()
    expect(requests).toHaveLength(10)
  })

  test("preflight and unsupported writes do not touch the mirror", async () => {
    const { request, requests } = harness()
    const options = await request(undefined, { method: "OPTIONS" })
    expect(options.status).toBe(204)
    const post = await request(undefined, { method: "POST" })
    expect(post.status).toBe(405)
    expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS")
    expect(await post.json()).toEqual({ status: "error", code: "method_not_allowed", message: "Method not allowed." })
    expect(requests).toHaveLength(0)
    const head = await request(undefined, { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
  })
})
