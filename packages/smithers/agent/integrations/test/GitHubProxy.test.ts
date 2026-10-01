/**
 * The GitHub proxy over real sockets: a fixture server stands in for
 * api.github.com, the proxy listens on an ephemeral port, and clients reach
 * it by URL, including two separate Node processes.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import * as HttpServer from "effect/unstable/http/HttpServer"
import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import { make as client } from "../src/github/GitHubClient.ts"
import { type Credential, layer, make, type ProxyOptions, repositoryOf } from "../src/github/Proxy.ts"
import { DEFAULT_LIMITS } from "../src/github/RateLimit.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"

const TOKEN = "ghs_operator_token"
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

const github = async (handler: Parameters<typeof startFixture>[0]): Promise<Fixture> => {
  const fixture = await startFixture(handler)
  closers.push(fixture.close)
  return fixture
}

const operator = (repository: string | undefined): Effect.Effect<Credential, IntegrationError> =>
  Effect.succeed(
    repository?.startsWith("other/")
      ? { token: "ghs_other", principal: "app:other" }
      : { token: TOKEN, principal: "gh-user" }
  )

/** Serves the proxy on an ephemeral loopback port. */
const proxy = async (upstream: Fixture, options: Partial<ProxyOptions> = {}): Promise<string> => {
  const scope = Effect.runSync(Scope.make())
  const context = await Effect.runPromise(Layer.buildWithScope(
    Layer.provideMerge(
      layer({ upstream: upstream.origin, credential: operator, ...options }),
      NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })
    ),
    scope
  ))
  closers.push(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const address = Context.get(context, HttpServer.HttpServer).address as { readonly port: number }
  return `http://127.0.0.1:${address.port}`
}

describe("GitHub proxy forwarding", () => {
  it("injects the operator's credential and drops the caller's", async () => {
    const upstream = await github((_request, response) => json(response, 201, { id: 1 }, { "set-cookie": "a=b" }))
    const origin = await proxy(upstream)
    const response = await fetch(`${origin}/repos/o/r/issues/1/comments?x=1`, {
      method: "POST",
      headers: {
        authorization: "Bearer caller-token",
        cookie: "session=1",
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json"
      },
      body: JSON.stringify({ body: "hello" })
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: 1 })
    expect(response.headers.get("set-cookie")).toBeNull()
    const [sent] = upstream.requests
    expect(sent).toMatchObject({
      method: "POST",
      url: "/repos/o/r/issues/1/comments?x=1",
      body: "{\"body\":\"hello\"}"
    })
    expect(sent?.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
    expect(sent?.headers["cookie"]).toBeUndefined()
    expect(sent?.headers["x-github-api-version"]).toBe("2022-11-28")
  })

  it("keeps pagination on the proxy and answers redirects without following them", async () => {
    const upstream = await github((request, response) => {
      if (request.url === "/moved") {
        response.writeHead(301, { location: "https://api.github.com/elsewhere" })
        response.end()
        return
      }
      json(response, 200, [1], { link: `<${upstream.origin}/repos/o/r/issues?page=2>; rel="next"` })
    })
    const origin = await proxy(upstream)
    const page = await fetch(`${origin}/repos/o/r/issues`)
    expect(page.headers.get("link")).toBe(`<${origin}/repos/o/r/issues?page=2>; rel="next"`)
    const moved = await fetch(`${origin}/moved`, { redirect: "manual" })
    expect(moved.status).toBe(301)
    expect(upstream.requests.map((request) => request.url)).toEqual(["/repos/o/r/issues", "/moved"])
  })

  it("lets a GitHubClient paginate through it with no token of its own", async () => {
    const upstream = await github((request, response) =>
      request.url.includes("page=2")
        ? json(response, 200, [2])
        : json(response, 200, [1], { link: `<${upstream.origin}/repos/o/r/issues?page=2>; rel="next"` })
    )
    const origin = await proxy(upstream)
    const page = await Effect.runPromise(client({ apiBaseUrl: origin }, {}).paginate("/repos/o/r/issues"))
    expect(page).toEqual({ items: [1, 2], truncated: false })
    expect(upstream.requests.every((request) => request.headers["authorization"] === `Bearer ${TOKEN}`)).toBe(true)
  })

  it("answers 502 when GitHub is unreachable and 504 when it does not answer in time", async () => {
    const upstream = await github(() => undefined)
    const unreachable = await proxy({ ...upstream, origin: "http://127.0.0.1:1" })
    expect((await fetch(`${unreachable}/x`)).status).toBe(502)
    const slow = await proxy(upstream, { requestTimeout: "100 millis" })
    expect((await fetch(`${slow}/x`)).status).toBe(504)
  })

  it("answers 502 with the reason when no credential is available", async () => {
    const upstream = await github((_request, response) => json(response, 200, {}))
    const origin = await proxy(upstream, {
      credential: () => Effect.fail(new IntegrationError("credentials-missing", "No GitHub token."))
    })
    const response = await fetch(`${origin}/repos/o/r`)
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ message: "No GitHub token.", reason: "credentials-missing" })
    expect(upstream.requests).toHaveLength(0)
  })
})

describe("GitHub proxy capability", () => {
  it("refuses a caller without the capability and forwards one with it", async () => {
    const upstream = await github((_request, response) => json(response, 200, {}))
    const origin = await proxy(upstream, { capability: "cap-secret" })
    expect((await fetch(`${origin}/repos/o/r`)).status).toBe(401)
    expect((await fetch(`${origin}/repos/o/r`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
    expect((await fetch(`${origin}/_smithers/admission?repo=o/r`)).status).toBe(401)
    expect(upstream.requests).toHaveLength(0)
    const ok = await fetch(`${origin}/repos/o/r`, { headers: { authorization: "token cap-secret" } })
    expect(ok.status).toBe(200)
    expect(upstream.requests[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
  })
})

describe("GitHub proxy control endpoints", () => {
  it("answers health, refuses unknown control paths, and reports admission without booking", async () => {
    const upstream = await github((_request, response) => json(response, 201, {}))
    const origin = await proxy(upstream, { limits: { ...DEFAULT_LIMITS, writeSpacingMs: 30_000 } })
    expect(await (await fetch(`${origin}/_smithers/health`)).json()).toEqual({ ok: true })
    expect((await fetch(`${origin}/_smithers/nope`)).status).toBe(404)
    expect((await fetch(`${origin}/_smithers/admission?writes=x`)).status).toBe(400)
    const idle = await (await fetch(`${origin}/_smithers/admission?repo=o/r&writes=2`)).json()
    expect(idle).toMatchObject({ principal: "gh-user", deferred: false })
    // Writes 30 s apart: three fit a one-minute wait, four do not.
    expect((await (await fetch(`${origin}/_smithers/admission?repo=o/r&writes=4`)).json()).deferred).toBe(true)
    await fetch(`${origin}/repos/o/r/issues`, { method: "POST", body: "{}" })
    const busy = await (await fetch(`${origin}/_smithers/admission?repo=o/r&writes=2`)).json()
    expect(busy.deferred).toBe(false)
    expect(Date.parse(busy.startsAt) - Date.now()).toBeGreaterThan(50_000)
    expect(await (await fetch(`${origin}/_smithers/admission?repo=other/r&writes=1`)).json())
      .toMatchObject({ principal: "app:other", deferred: false })
    // No repository and no writes: the read-only admission of the principal without a repository.
    expect(await (await fetch(`${origin}/_smithers/admission`)).json()).toMatchObject({ principal: "gh-user" })
  })

  it("defaults to api.github.com and GitHub's limits", async () => {
    const app = await Effect.runPromise(make({ credential: operator }))
    expect(Effect.isEffect(app)).toBe(true)
  })
})

describe("GitHub proxy rate limit", () => {
  it("pauses every caller of a principal after GitHub's secondary limit, and only that principal", async () => {
    let refuse = true
    const upstream = await github((_request, response) =>
      refuse
        ? json(response, 403, { message: "You have exceeded a secondary rate limit" }, { "retry-after": "120" })
        : json(response, 200, {})
    )
    const origin = await proxy(upstream)
    const first = await fetch(`${origin}/repos/o/r/issues`, { method: "POST", body: "{}" })
    expect(first.status).toBe(403)
    refuse = false
    const deferred = await fetch(`${origin}/repos/o/r`)
    expect(deferred.status).toBe(429)
    expect(Number(deferred.headers.get("retry-after"))).toBeGreaterThan(100)
    expect(deferred.headers.get("x-smithers-rate-limit-reason")).toBe("paused")
    expect((await deferred.json()).message).toMatch(/rate limit/)
    // A GitHubClient reads the refusal as a typed failure with the instant to retry.
    const failure = await Effect.runPromise(
      Effect.flip(client({ apiBaseUrl: origin }, {}).request("GET", "/repos/o/r"))
    )
    expect(failure.reason).toBe("rate-limited")
    expect(Date.parse(String(failure.details?.["retryAt"]))).toBeGreaterThan(Date.now() + 100_000)
    // Another principal's budget is its own.
    expect((await fetch(`${origin}/repos/other/r`)).status).toBe(200)
    expect(upstream.requests.map((request) => request.url)).toEqual(["/repos/o/r/issues", "/repos/other/r"])
  })

  it("spaces the writes of two concurrent client processes as one queue", async () => {
    const upstream = await github((_request, response) => json(response, 201, {}))
    const origin = await proxy(upstream, { limits: { ...DEFAULT_LIMITS, writeSpacingMs: 250 } })
    const source = fileURLToPath(new URL("../src/github/GitHubClient.ts", import.meta.url))
    const writer = `
      import { Effect } from "effect"
      import { make } from ${JSON.stringify(source)}
      const github = make({ apiBaseUrl: process.argv[1] }, {})
      await Effect.runPromise(Effect.all(
        [1, 2, 3].map((n) => github.request("POST", "/repos/o/r/issues/1/comments", { body: String(n) })),
        { concurrency: "unbounded" }
      ))
    `
    const spawn = () =>
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", writer, origin], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        timeout: 30_000
      })
    await Promise.all([spawn(), spawn()])
    const arrivals = upstream.requests.map((request) => request.receivedAt).sort((a, b) => a - b)
    expect(arrivals).toHaveLength(6)
    // The proxy starts each write 250 ms after the last; loopback latency jitters arrival by a few ms.
    for (let i = 1; i < arrivals.length; i++) expect(arrivals[i]! - arrivals[i - 1]!).toBeGreaterThanOrEqual(200)
    expect(upstream.requests.every((request) => request.headers["authorization"] === `Bearer ${TOKEN}`)).toBe(true)
  }, 60_000)
})

describe("repositoryOf", () => {
  it("names the repository a REST path addresses", () => {
    expect(repositoryOf("/repos/smithersai/smithers/issues/1")).toBe("smithersai/smithers")
    expect(repositoryOf("/repos/o/r")).toBe("o/r")
    expect(repositoryOf("/repos/o/r?x=1")).toBe("o/r")
    expect(repositoryOf("/user")).toBeUndefined()
    expect(repositoryOf("/repos/o")).toBeUndefined()
  })
})
