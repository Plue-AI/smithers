import { describe, expect, test } from "bun:test"
import {
  cloudflareEdgeError,
  formatVerdictLine,
  probeWorker,
  runWorkersHealth,
  summarizeHealth,
  workerHealthVerdict
} from "./workers-health.ts"
import type { HealthVerdict, ProbeFetch, ProbeResponse } from "./workers-health.ts"
import { BACKING_WORKERS, RETIRED_WORKERS, expandTargets, healthUrl, withOriginOverrides } from "./workers-manifest.ts"
import type { BackingWorker } from "./workers-manifest.ts"

/*
 * CN-18. The backing Workers this probe watches are not in this repository and
 * there is no credential here to reach a deployment with, so the probe's logic
 * is held to fakes: the network call is the only line these tests do not cover.
 *
 * What they hold: the three states never collapse into two (a Worker an
 * operator deliberately left unset must not read as broken, and a broken one
 * must never read as unset), and a run that asserted nothing never reports
 * PASS.
 */

const worker = (over: Partial<BackingWorker> = {}): BackingWorker => ({
  name: "identity",
  origin: "https://identity.test",
  alternateOrigins: [],
  path: "/healthz",
  contract: "ok-json",
  note: "test worker",
  ...over
})

const jsonResponse = (status: number, body: unknown): ProbeResponse => ({
  status,
  text: async () => JSON.stringify(body)
})

const textResponse = (status: number, text: string): ProbeResponse => ({ status, text: async () => text })

/** A response whose body cannot be read: the probe must not guess what it said. */
const unreadableResponse = (status: number): ProbeResponse => ({
  status,
  text: async () => {
    throw new Error("body stream already read")
  }
})

/*
 * Cloudflare edge error bodies, captured live on 2026-08-19 from
 * https://this-worker-does-not-exist-xyz123.willcory10.workers.dev/ — a
 * *.workers.dev hostname with no Worker deployed behind it. All three came from
 * that one host; only the request headers differed, because the edge
 * content-negotiates its error page.
 *
 * Every one of them arrives with HTTP 404, the same status the live chat Worker
 * answers at / with the body "Not found". That collision is CN-18.
 */
const EDGE_JSON_404 = JSON.stringify({
  type: "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/",
  title: "Error 1042: Cloudflare Error",
  status: 404,
  detail: "No Workers script was found for this host on workers.dev.",
  instance: "a2d6011749dfdf9a",
  error_code: 1042,
  error_name: "workers_dev_script_not_found",
  error_category: "worker",
  ray_id: "a2d6011749dfdf9a",
  zone: "this-worker-does-not-exist-xyz123.willcory10.workers.dev",
  cloudflare_error: true,
  retryable: false
})

/** What the same host returns to an uncompressed non-browser request. */
const EDGE_PLAIN_404 = "error code: 1042\n"

/** The workers.dev placeholder page, returned when the request accepts HTML. */
const EDGE_HTML_404 = [
  "<!DOCTYPE html>",
  "<html class=\"no-js\" lang=\"en-US\">",
  "  <head>",
  "    <title>Page not found</title>",
  "    <link rel=\"icon\" type=\"image/png\" href=\"https://workers.cloudflare.com/favicon.ico\" sizes=\"48x48\"/>",
  "  </head>",
  "  <body><div class=\"box\"><h1>Page not found</h1></div></body>",
  "</html>"
].join("\n")

/** The classic branded page, still served for WAF and rate-limit blocks. */
const EDGE_CLASSIC_HTML_403 = [
  "<!DOCTYPE html>",
  "<html><head><title>example.com | 1020: Access denied</title></head><body>",
  "<span class=\"cf-error-type\">Error</span> <span class=\"cf-error-code\">1020</span>",
  "<div id=\"cf-error-details\" class=\"cf-error-details-wrapper\">Access denied</div>",
  "</body></html>"
].join("\n")

/** A fake fetch keyed by URL. A function value throws instead of answering. */
const fakeFetch = (routes: Record<string, ProbeResponse | (() => never)>): ProbeFetch => {
  const seen: Array<string> = []
  const impl: ProbeFetch = async (url) => {
    seen.push(url)
    const route = routes[url]
    if (route === undefined) throw new Error(`unexpected probe request: ${url}`)
    if (typeof route === "function") route()
    return route as ProbeResponse
  }
  return Object.assign(impl, { seen })
}

const timeoutError = (): never => {
  throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" })
}

const dnsError = (): never => {
  throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
    cause: { code: "ENOTFOUND" }
  })
}

/** A pinned clock: elapsed times appear in output, so they must not be wall time. */
const steppingClock = (): () => number => {
  let value = 1_000
  return () => {
    value += 25
    return value
  }
}

describe("the manifest", () => {
  test("names the backing Workers with a public origin each", () => {
    expect(BACKING_WORKERS.map((entry) => entry.name).sort()).toEqual([
      "application", "connectors-catalog", "status"
    ])
    expect(RETIRED_WORKERS.map(entry => entry.name).sort()).toEqual([
      "billing", "chat", "cron", "identity", "sync", "webhooks"
    ])
    for (const entry of BACKING_WORKERS) {
      expect(entry.origin).toStartWith("https://")
      expect(entry.note).not.toBe("")
    }
  })

  test("carries no credential: no origin embeds userinfo or a query token", () => {
    for (const entry of BACKING_WORKERS) {
      const url = new URL(entry.origin ?? "https://unset.invalid")
      expect(url.username).toBe("")
      expect(url.password).toBe("")
      expect(url.search).toBe("")
    }
  })

  test("covers every upstream origin apps/server/wrangler.jsonc configures", async () => {
    // The drift guard that makes a committed manifest worth trusting: if an
    // operator repoints a seam at a host this file does not know, CN-18 would
    // otherwise stay green while probing a stack the product no longer calls.
    const wrangler = await Bun.file(new URL("../../wrangler.jsonc", import.meta.url)).text()
    const configured = [...wrangler.matchAll(/"([A-Z_]*(?:UPSTREAM_URL|CHAT_URL|CLOUD_API_BASE_URL|BACKEND_ORIGIN))"\s*:\s*"([^"]+)"/g)].map(
      (match) => ({ name: match[1] as string, origin: new URL(match[2] as string).origin })
    )
    expect(configured.length).toBeGreaterThan(0)
    const known = new Set(
      BACKING_WORKERS.flatMap((entry) => [entry.origin, ...entry.alternateOrigins]).filter(
        (origin): origin is string => origin !== undefined
      )
    )
    for (const upstream of configured) {
      expect({ ...upstream, known: known.has(upstream.origin) }).toEqual({ ...upstream, known: true })
    }
  })

  test("active dependencies all assert a real health contract", () => {
    const responds = BACKING_WORKERS.filter((entry) => entry.contract === "responds").map((entry) => entry.name)
    expect(responds).toEqual([])
  })

  test("sync's health path is /health — /healthz is a 404 on that Worker", () => {
    expect(healthUrl(worker({ name: "sync", origin: "https://sync.test", path: "/health" }))).toBe(
      "https://sync.test/health"
    )
  })
})

describe("$CANARY_WORKER_ORIGINS", () => {
  test("an unset variable leaves the manifest alone", () => {
    expect(withOriginOverrides(BACKING_WORKERS, undefined)).toEqual(BACKING_WORKERS)
    expect(withOriginOverrides(BACKING_WORKERS, "  ")).toEqual(BACKING_WORKERS)
  })

  test("overriding one origin leaves the others at their defaults", () => {
    const overridden = withOriginOverrides(BACKING_WORKERS, JSON.stringify({ status: "https://status.staging" }))
    expect(overridden.find((entry) => entry.name === "status")?.origin).toBe("https://status.staging")
    expect(overridden.find((entry) => entry.name === "application")?.origin).toBe(
      BACKING_WORKERS.find((entry) => entry.name === "application")?.origin
    )
  })

  test("\"\" and null declare a Worker unset on this deployment", () => {
    const overridden = withOriginOverrides(BACKING_WORKERS, "{\"connectors-catalog\":\"\",\"status\":null}")
    expect(overridden.find((entry) => entry.name === "connectors-catalog")?.origin).toBeUndefined()
    expect(overridden.find((entry) => entry.name === "status")?.origin).toBeUndefined()
  })

  test("malformed values throw instead of silently probing the default deployment", () => {
    expect(() => withOriginOverrides(BACKING_WORKERS, "not json")).toThrow(/not a JSON object/)
    expect(() => withOriginOverrides(BACKING_WORKERS, "[1,2]")).toThrow(/not a JSON object/)
    expect(() => withOriginOverrides(BACKING_WORKERS, "{\"status\":7}")).toThrow(/must be an origin string/)
    expect(() => withOriginOverrides(BACKING_WORKERS, "{\"status\":\"status.example\"}")).toThrow(
      /not an absolute URL/
    )
    expect(() => withOriginOverrides(BACKING_WORKERS, "{\"status\":\"ftp://status.example\"}")).toThrow(
      /must be http or https/
    )
  })

  test("a typo'd Worker name throws and lists the known names", () => {
    expect(() => withOriginOverrides(BACKING_WORKERS, "{\"identiy\":\"https://status.test\"}")).toThrow(
      /unknown Worker "identiy"/
    )
  })
})

describe("Cloudflare's edge error page", () => {
  /*
   * The regression suite for CN-18. Before the body check, every one of these
   * bodies read as a healthy Worker, because the probe kept only the status and
   * the edge answers 404 for a host with nothing deployed on it.
   */
  test("names the error code in each shape the edge serves", () => {
    expect(cloudflareEdgeError(EDGE_JSON_404)).toBe("1042")
    expect(cloudflareEdgeError(EDGE_PLAIN_404)).toBe("1042")
    expect(cloudflareEdgeError(EDGE_CLASSIC_HTML_403)).toBe("1020")
    expect(cloudflareEdgeError(EDGE_HTML_404)).toBe("unnumbered")
  })

  test("a live Worker's own body is never mistaken for the edge", () => {
    // The three responds Workers, as measured on 2026-08-19.
    expect(cloudflareEdgeError("Not found")).toBeUndefined()
    expect(cloudflareEdgeError(JSON.stringify({ error: "Forbidden origin" }))).toBeUndefined()
    expect(cloudflareEdgeError("")).toBeUndefined()
    // A Worker that quotes the phrase is still a Worker: the plain shape has
    // to be the whole body, and the JSON shape has to be edge-authored.
    expect(cloudflareEdgeError("upstream said: error code: 1042, retrying")).toBeUndefined()
    expect(cloudflareEdgeError(JSON.stringify({ error: "error code: 1042" }))).toBeUndefined()
    expect(cloudflareEdgeError(JSON.stringify({ error_name: "rate_limited", error_code: "slow_down" }))).toBeUndefined()
    expect(cloudflareEdgeError("<html><title>Page not found</title><p>this Worker has no such route</p></html>"))
      .toBeUndefined()
  })
})

describe("one Worker's verdict", () => {
  // Plue's /healthz (packages/backend/internal/routes/healthz.go) answers
  // {status, checks}, never ok:true; CN-18 read the live cloud-api as down.
  const plue = worker({ name: "cloud-api", origin: "https://api.test", contract: "status-ok-json" })
  test("status-ok-json: Plue's healthy body is healthy", async () => {
    const observation = await probeWorker(plue, {
      fetch: fakeFetch({ "https://api.test/healthz": jsonResponse(200, { status: "ok", checks: { database: "ok", repo_host: "ok" } }) })
    })
    expect(workerHealthVerdict(observation).state).toBe("healthy")
  })

  test("status-ok-json: a failing dependency check is unhealthy even on HTTP 200", async () => {
    for (const body of [{ status: "ok", checks: { database: "ok", repo_host: "error" } }, { status: "degraded", checks: {} }, { ok: true }]) {
      const observation = await probeWorker(plue, { fetch: fakeFetch({ "https://api.test/healthz": jsonResponse(200, body) }) })
      expect(workerHealthVerdict(observation).state).toBe("unhealthy")
    }
  })

  test("the manifest holds the shared backend to its canonical bootstrap contract", () => {
    expect(BACKING_WORKERS.find((entry) => entry.name === "application")?.contract).toBe("application-bootstrap")
  })

  test("ok-json: HTTP 200 with ok:true is healthy", async () => {
    const observation = await probeWorker(worker(), {
      fetch: fakeFetch({ "https://identity.test/healthz": jsonResponse(200, { ok: true, oauth: true }) }),
      now: steppingClock()
    })
    const verdict = workerHealthVerdict(observation)
    expect(verdict.state).toBe("healthy")
    expect(verdict.detail).toContain("ok in 25ms")
    expect(formatVerdictLine(verdict)).toStartWith("ok: ")
  })

  test("ok-json: HTTP 500 is unhealthy and names the status", async () => {
    const observation = await probeWorker(worker({ name: "billing", origin: "https://billing.test" }), {
      fetch: fakeFetch({ "https://billing.test/healthz": textResponse(500, "Internal Error") })
    })
    const verdict = workerHealthVerdict(observation)
    expect(verdict.state).toBe("unhealthy")
    expect(verdict.detail).toContain("answered HTTP 500")
    expect(formatVerdictLine(verdict)).toStartWith("FAIL: ")
  })

  test("ok-json: HTTP 200 with a malformed body is unhealthy, and the excerpt is bounded", async () => {
    const observation = await probeWorker(worker(), {
      fetch: fakeFetch({ "https://identity.test/healthz": textResponse(200, `<!doctype html>${"x".repeat(500)}`) })
    })
    const verdict = workerHealthVerdict(observation)
    expect(verdict.state).toBe("unhealthy")
    expect(verdict.detail).toContain("the body is not JSON")
    expect(verdict.detail.length).toBeLessThan(260)
  })

  test("ok-json: HTTP 200 reporting ok:false is unhealthy, not healthy-because-200", async () => {
    const observation = await probeWorker(worker(), {
      fetch: fakeFetch({ "https://identity.test/healthz": jsonResponse(200, { ok: false, oauth: false }) })
    })
    const verdict = workerHealthVerdict(observation)
    expect(verdict.state).toBe("unhealthy")
    expect(verdict.detail).toContain("without ok:true")
  })

  test("responds: a 403 from an origin-gated Worker is healthy — routability is the assertion", async () => {
    const cron = worker({ name: "cron", origin: "https://cron.test", path: "/", contract: "responds" })
    const observation = await probeWorker(cron, {
      fetch: fakeFetch({ "https://cron.test/": jsonResponse(403, { error: "Forbidden origin" }) })
    })
    const verdict = workerHealthVerdict(observation)
    expect(verdict.state).toBe("healthy")
    expect(verdict.detail).toContain("HTTP 403")
  })

  test("responds: HTTP 404 from Cloudflare's edge is unhealthy — the Worker is gone (CN-18)", async () => {
    // The exact collision: this is byte-for-byte what an undeployed
    // *.workers.dev host returned on 2026-08-19, and the status is the same
    // 404 the live chat Worker answers with at /.
    const chat = worker({ name: "chat", origin: "https://chat.test", path: "/", contract: "responds" })
    const observation = await probeWorker(chat, {
      fetch: fakeFetch({ "https://chat.test/": textResponse(404, EDGE_JSON_404) })
    })
    const verdict = workerHealthVerdict(observation)
    expect(verdict.state).toBe("unhealthy")
    expect(verdict.detail).toContain("error code 1042")
    expect(verdict.detail).toContain("Nothing is deployed on this route")
  })

  test("responds: the same 404 with the Worker's own body stays healthy — the fix is not an inversion", async () => {
    const chat = worker({ name: "chat", origin: "https://chat.test", path: "/", contract: "responds" })
    const observation = await probeWorker(chat, {
      fetch: fakeFetch({ "https://chat.test/": textResponse(404, "Not found") })
    })
    expect(workerHealthVerdict(observation).state).toBe("healthy")
  })

  test("responds: an unreadable body is unhealthy — an unchecked body cannot be called healthy", async () => {
    const chat = worker({ name: "chat", origin: "https://chat.test", path: "/", contract: "responds" })
    const observation = await probeWorker(chat, {
      fetch: fakeFetch({ "https://chat.test/": unreadableResponse(404) })
    })
    const verdict = workerHealthVerdict(observation)
    expect(verdict.state).toBe("unhealthy")
    expect(verdict.detail).toContain("cannot be ruled out")
  })

  test("ok-json: a non-200 from the edge says so, so an operator is sent to the right place", async () => {
    const observation = await probeWorker(worker(), {
      fetch: fakeFetch({ "https://identity.test/healthz": textResponse(404, EDGE_PLAIN_404) })
    })
    const verdict = workerHealthVerdict(observation)
    expect(verdict.state).toBe("unhealthy")
    expect(verdict.detail).toContain("from Cloudflare's edge (error code 1042)")
  })

  test("responds: a 5xx is unhealthy — a routable Worker is not the same as a working one", async () => {
    const cron = worker({ name: "cron", origin: "https://cron.test", path: "/", contract: "responds" })
    const observation = await probeWorker(cron, {
      fetch: fakeFetch({ "https://cron.test/": textResponse(522, "connection timed out") })
    })
    expect(workerHealthVerdict(observation).state).toBe("unhealthy")
  })

  test("a timeout is unhealthy and says so — not a DNS failure, not a bad status", async () => {
    const observation = await probeWorker(worker({ name: "sync", origin: "https://sync.test", path: "/health" }), {
      fetch: fakeFetch({ "https://sync.test/health": timeoutError }),
      timeoutMs: 8_000
    })
    const verdict = workerHealthVerdict(observation)
    expect(verdict.state).toBe("unhealthy")
    expect(verdict.detail).toContain("timed out after 8000ms")
  })

  test("a DNS failure is unhealthy and carries the error code", async () => {
    const observation = await probeWorker(worker({ name: "status", origin: "https://status.test", path: "/healthz" }), {
      fetch: fakeFetch({ "https://status.test/healthz": dnsError })
    })
    const verdict = workerHealthVerdict(observation)
    expect(verdict.state).toBe("unhealthy")
    expect(verdict.detail).toContain("ENOTFOUND")
  })

  test("an unset Worker is not-configured, and no request is made for it", async () => {
    const fetchImpl = fakeFetch({})
    const observation = await probeWorker(worker({ origin: undefined }), { fetch: fetchImpl })
    const verdict = workerHealthVerdict(observation)
    expect(verdict.state).toBe("not-configured")
    expect(verdict.detail).toContain("CANARY_WORKER_ORIGINS")
    expect(formatVerdictLine(verdict)).toStartWith("skip: ")
    expect((fetchImpl as unknown as { seen: Array<string> }).seen).toEqual([])
  })
})

describe("the run", () => {
  const allHealthy = (): Record<string, ProbeResponse | (() => never)> =>
    Object.fromEntries(
      expandTargets(BACKING_WORKERS).map((entry) => [
        healthUrl(entry) as string,
        entry.contract === "application-bootstrap" ? jsonResponse(200, { apiVersion: 1, host: "cloud", version: "1.0.0", capabilities: ["agent", "identity"] }) : entry.contract === "ok-json" ? jsonResponse(200, { ok: true }) : entry.contract === "status-ok-json" ? jsonResponse(200, { status: "ok", checks: { database: "ok" } }) : textResponse(404, "Not found")
      ])
    )

  const runWith = async (
    routes: Record<string, ProbeResponse | (() => never)>,
    env: Record<string, string | undefined> = {}
  ): Promise<{ summary: Awaited<ReturnType<typeof runWorkersHealth>>; lines: Array<string> }> => {
    const lines: Array<string> = []
    const summary = await runWorkersHealth({
      fetch: fakeFetch(routes),
      env,
      now: steppingClock(),
      log: (line) => lines.push(line)
    })
    return { summary, lines }
  }

  const TARGET_COUNT = expandTargets(BACKING_WORKERS).length

  test("every route healthy exits 0 and reports every route", async () => {
    const { summary, lines } = await runWith(allHealthy())
    expect(summary).toMatchObject({ healthy: TARGET_COUNT, unhealthy: 0, notConfigured: 0, exitCode: 0 })
    expect(summary.line).toContain("CN-18 PASS")
    expect(lines.filter((line) => line.startsWith("ok: "))).toHaveLength(TARGET_COUNT)
  })

  test("the canonical application failing bootstrap fails the run", async () => {
    const routes = allHealthy()
    routes["https://api.jjhub.tech/api/bootstrap"] = jsonResponse(200, { ok: true })
    const { summary, lines } = await runWith(routes)
    expect(summary.exitCode).toBe(1)
    expect(lines).toContainEqual(expect.stringContaining("FAIL: application"))
  })

  test("retired authorities are never probed by the active dependency check", async () => {
    const fetch = fakeFetch(allHealthy())
    const summary = await runWorkersHealth({ fetch, env: {}, now: steppingClock(), log: () => {} })
    expect(summary.exitCode).toBe(0)
    expect((fetch as unknown as { seen: string[] }).seen).toEqual([
      "https://api.jjhub.tech/api/bootstrap", "https://connectors.smithers.sh/healthz", "https://status.smithers.sh/healthz"
    ])
  })

  test("pointing status at an undeployed workers.dev host fails the run (the CN-18 reproduction)", async () => {
    // The auditor's command, in fake form:
    //   CANARY_WORKER_ORIGINS='{"chat":"https://this-worker-does-not-exist…"}'
    // The run used to report CN-18 PASS with exit 0.
    const routes = allHealthy()
    routes["https://this-worker-does-not-exist-xyz123.willcory10.workers.dev/healthz"] = textResponse(404, EDGE_JSON_404)
    const { summary, lines } = await runWith(routes, {
      CANARY_WORKER_ORIGINS: "{\"status\":\"https://this-worker-does-not-exist-xyz123.willcory10.workers.dev\"}"
    })
    expect(summary.exitCode).toBe(1)
    expect(summary.unhealthy).toBe(1)
    expect(summary.line).toContain("CN-18 FAILED")
    expect(lines).toContainEqual(expect.stringContaining("FAIL: status"))
  })

  test("an override replaces a Worker's routes rather than adding to them", async () => {
    const routes = allHealthy()
    routes["https://status.staging/healthz"] = jsonResponse(200, { ok: true })
    // No route is registered for the canary's workers.dev twin here: the fake
    // fetch throws on an unexpected URL, so probing it would fail this test.
    const { summary, lines } = await runWith(routes, {
      CANARY_WORKER_ORIGINS: "{\"status\":\"https://status.staging\"}"
    })
    expect(summary.exitCode).toBe(0)
    expect(lines.filter((line) => line.includes("status"))).toHaveLength(1)
  })

  test("reports in manifest order so a diff of two runs is readable", async () => {
    const { lines } = await runWith(allHealthy())
    const names = lines.filter((line) => line.startsWith("ok: ")).map((line) => line.slice(4).split(" ")[0])
    expect(names).toEqual(expandTargets(BACKING_WORKERS).map((entry) => entry.name.split(" ")[0]))
  })

  test("one 500, one timeout, one unconfigured: two failures, one skip, and exit 1", async () => {
    const routes = allHealthy()
    routes["https://api.jjhub.tech/api/bootstrap"] = textResponse(500, "boom")
    routes["https://status.smithers.sh/healthz"] = timeoutError
    const { summary, lines } = await runWith(routes, { CANARY_WORKER_ORIGINS: "{\"connectors-catalog\":\"\"}" })
    expect(summary).toMatchObject({ healthy: TARGET_COUNT - 3, unhealthy: 2, notConfigured: 1, exitCode: 1 })
    expect(summary.line).toContain("application, status")
    expect(lines.some((line) => line.startsWith("skip: connectors-catalog"))).toBe(true)
    // The skip must not be counted as a failure, and the failures must not
    // be counted as skips: three states, three tallies.
    expect(lines.filter((line) => line.startsWith("FAIL: "))).toHaveLength(2)
  })

  test("a healthy Worker an operator left unset never reads as broken", async () => {
    const routes = allHealthy()
    const { summary, lines } = await runWith(routes, { CANARY_WORKER_ORIGINS: "{\"status\":null}" })
    expect(summary.exitCode).toBe(0)
    expect(summary.notConfigured).toBe(1)
    expect(lines.some((line) => line.startsWith("FAIL"))).toBe(false)
  })

  test("a run that probed nothing fails instead of reporting a green CN-18", async () => {
    const blanked = JSON.stringify(Object.fromEntries(BACKING_WORKERS.map((entry) => [entry.name, ""])))
    const { summary } = await runWith({}, { CANARY_WORKER_ORIGINS: blanked })
    expect(summary).toMatchObject({ healthy: 0, unhealthy: 0, notConfigured: BACKING_WORKERS.length, exitCode: 1 })
    // Nine, not twelve: an unset Worker has no routes to expand.
    expect(summary.line).toContain("ASSERTED NOTHING")
  })

  test("a bad override aborts the run rather than probing the wrong deployment", async () => {
    await expect(runWith({}, { CANARY_WORKER_ORIGINS: "{" })).rejects.toThrow(/not a JSON object/)
  })
})

describe("the summary", () => {
  const verdicts = (...states: ReadonlyArray<HealthVerdict["state"]>): ReadonlyArray<HealthVerdict> =>
    states.map((state, index) => ({ name: `w${index}`, state, detail: "" }))

  test("any unhealthy Worker fails the run", () => {
    expect(summarizeHealth(verdicts("healthy", "unhealthy", "not-configured")).exitCode).toBe(1)
  })

  test("not-configured alone never fails the run", () => {
    expect(summarizeHealth(verdicts("healthy", "not-configured")).exitCode).toBe(0)
  })
})
