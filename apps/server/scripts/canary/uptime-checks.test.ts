/*
 * Every decision the canary uptime probe makes, exercised against fixtures.
 *
 * The lane that wrote these has no credential and no live deployment, so the
 * network call is the only line here that cannot be covered. `runUptimeProbe`
 * takes its fetch as a dependency for exactly that reason: the tests below
 * drive whole probe runs — a healthy deployment, a dead endpoint, a slow turn
 * seam, a turn that streams nothing — without touching a network.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  ALERT_ASSIGNEES,
  ALERT_TITLE,
  alertAction,
  BROWSER_CHECK_ID,
  browserVerdict,
  type Check,
  coerceReport,
  drillCheck,
  endpointPlan,
  ERROR_RATE_SCOPE_NOTE,
  ERROR_RATE_THRESHOLD,
  errorRateVerdict,
  isErrorSample,
  LATENCY_BUDGETS_MS,
  latencyVerdict,
  median,
  meteredTurnSample,
  type ProbeDeps,
  probeFailed,
  type ProbeOptions,
  type ProbeReport,
  renderAlertBody,
  parseSessionRead,
  resolveProbeOrigin,
  runUptimeProbe,
  type Sample,
  SCOPED_IDENTITY_CHECK_ID,
  scopedIdentityVerdict,
  tallyChecks,
  TURN_FIRST_FRAME_NOTE,
  TURN_FIRST_FRAME_SAMPLES,
  uptimeVerdict,
  withChecks
} from "./uptime-checks.ts"

const sample = (over: Partial<Sample> = {}): Sample => ({
  label: "spa",
  status: 200,
  expectedStatus: 200,
  elapsedMs: 100,
  transportError: undefined,
  ...over
})

const byId = (checks: ReadonlyArray<Check>, id: string): Check => {
  const found = checks.find((check) => check.id === id)
  if (found === undefined) throw new Error(`no check with id ${id} in ${checks.map((c) => c.id).join(", ")}`)
  return found
}

/*
 * The regression this file exists to keep dead.
 *
 * The probe used to resolve its origin as the first non-flag token anywhere in
 * argv. The scheduled workflow passes `--json <path>` and no positional, so
 * the origin became the temp-file path, every sample recorded a transport
 * error, and the run reported the deployment fully down no matter what the
 * deployment was doing. The first test below is that exact invocation.
 */
describe("resolveProbeOrigin", () => {
  const WORKFLOW_ARGV = ["--json", "/home/runner/work/_temp/canary-uptime.json"]

  test("the scheduled workflow's argument form probes $CANARY_URL, never the --json path", () => {
    expect(resolveProbeOrigin(WORKFLOW_ARGV, { CANARY_URL: "https://canary.smithers.sh" })).toEqual({
      origin: "https://canary.smithers.sh"
    })
  })

  test("the workflow's argument form with the origin passed first still probes the origin", () => {
    expect(
      resolveProbeOrigin(["https://canary.smithers.sh", ...WORKFLOW_ARGV], { CANARY_URL: "https://canary.smithers.sh" })
    ).toEqual({ origin: "https://canary.smithers.sh" })
  })

  test("a flag's value is never the origin, even with no CANARY_URL to fall back to", () => {
    expect(resolveProbeOrigin(WORKFLOW_ARGV, {})).toEqual({ origin: "https://canary.smithers.sh" })
    expect(resolveProbeOrigin(["--samples", "1", "--gap-ms", "1"], {})).toEqual({
      origin: "https://canary.smithers.sh"
    })
  })

  test("a positional origin beats $CANARY_URL", () => {
    expect(resolveProbeOrigin(["https://staging.test"], { CANARY_URL: "https://env.test" })).toEqual({
      origin: "https://staging.test"
    })
  })

  test("trailing slashes are dropped so origin + path never doubles one", () => {
    expect(resolveProbeOrigin(["https://staging.test//"], {})).toEqual({ origin: "https://staging.test" })
  })

  test("a filesystem path is refused by name instead of being probed", () => {
    const resolution = resolveProbeOrigin([], { CANARY_URL: "/home/runner/work/_temp/canary-uptime.json" })
    expect(resolution).not.toHaveProperty("origin")
    expect("error" in resolution ? resolution.error : "").toContain(
      "refusing to probe \"/home/runner/work/_temp/canary-uptime.json\""
    )
    expect("error" in resolution ? resolution.error : "").toContain("that is not a URL")
  })

  test("a bare hostname with no scheme is refused, because it is not a URL", () => {
    const resolution = resolveProbeOrigin(["canary.smithers.sh"], {})
    expect("error" in resolution ? resolution.error : "").toContain("is not a URL")
  })

  test("a URL that is not http or https is refused and names the scheme", () => {
    const resolution = resolveProbeOrigin(["file:///tmp/canary-uptime.json"], {})
    expect("error" in resolution ? resolution.error : "").toContain("file:// is not http or https")
  })

  test("an empty $CANARY_URL is refused rather than silently becoming a relative fetch", () => {
    const resolution = resolveProbeOrigin([], { CANARY_URL: "" })
    expect("error" in resolution ? resolution.error : "").toContain("no origin to probe")
  })

  test("http is accepted, so a local deployment can be probed", () => {
    expect(resolveProbeOrigin(["http://127.0.0.1:8787"], {})).toEqual({ origin: "http://127.0.0.1:8787" })
  })
})

describe("median", () => {
  test("an empty list has no median, so it answers undefined instead of zero", () => {
    expect(median([])).toBeUndefined()
  })

  test("an odd count takes the middle value", () => {
    expect(median([300, 100, 200])).toBe(200)
  })

  test("an even count averages the two middle values", () => {
    expect(median([100, 200, 300, 500])).toBe(250)
  })

  test("the input is not reordered in place", () => {
    const values = [300, 100, 200]
    median(values)
    expect(values).toEqual([300, 100, 200])
  })
})

describe("isErrorSample", () => {
  test("the expected status is not an error, even when it is a refusal", () => {
    expect(isErrorSample(sample({ label: "turn-gate", status: 401, expectedStatus: 401 }))).toBe(false)
  })

  test("a transport failure is an error", () => {
    expect(isErrorSample(sample({ status: undefined, transportError: "TimeoutError: timed out" }))).toBe(true)
  })

  test("a 5xx is an error", () => {
    expect(isErrorSample(sample({ status: 503 }))).toBe(true)
  })

  test("an unexpected 4xx is an error: a gate that starts refusing valid traffic is an outage", () => {
    expect(isErrorSample(sample({ status: 401, expectedStatus: 200 }))).toBe(true)
  })
})

describe("latencyVerdict (CN-19)", () => {
  test("under budget passes and reports median, max and budget", () => {
    const check = latencyVerdict(
      "latency:spa",
      "spa latency",
      [sample({ elapsedMs: 100 }), sample({ elapsedMs: 300 })],
      2_000
    )
    expect(check.status).toBe("pass")
    expect(check.detail).toBe("spa latency: median 200ms, max 300ms (budget 2000ms) over 2 answered sample(s) of 2")
  })

  test("over budget fails", () => {
    const check = latencyVerdict(
      "latency:spa",
      "spa latency",
      [sample({ elapsedMs: 2_400 }), sample({ elapsedMs: 2_600 }), sample({ elapsedMs: 2_500 })],
      2_000
    )
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("median 2500ms")
    expect(check.detail).toContain("budget 2000ms")
  })

  test("exactly at the budget passes: a budget is a ceiling, not an exclusive bound", () => {
    expect(latencyVerdict("latency:spa", "spa latency", [sample({ elapsedMs: 2_000 })], 2_000).status).toBe("pass")
  })

  test("one slow sample cannot fail the budget, because the verdict reads the median", () => {
    const check = latencyVerdict(
      "latency:spa",
      "spa latency",
      [sample({ elapsedMs: 120 }), sample({ elapsedMs: 9_000 }), sample({ elapsedMs: 140 })],
      2_000
    )
    expect(check.status).toBe("pass")
    expect(check.detail).toContain("max 9000ms")
  })

  test("zero samples is skipped, never passed", () => {
    const check = latencyVerdict("latency:spa", "spa latency", [], 2_000)
    expect(check.status).toBe("skip")
    expect(check.detail).toContain("no samples were taken")
  })

  test("all requests failing is a latency failure, not an unmeasured skip", () => {
    const check = latencyVerdict(
      "latency:spa",
      "spa latency",
      [
        sample({ status: undefined, transportError: "ConnectionRefused", elapsedMs: 12 }),
        sample({ status: undefined, transportError: "ConnectionRefused", elapsedMs: 9 })
      ],
      2_000
    )
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("none of 2 request(s) answered")
  })

  test("a 5xx still carries a duration, so it is measured rather than discarded", () => {
    const check = latencyVerdict("latency:spa", "spa latency", [sample({ status: 500, elapsedMs: 30 })], 2_000)
    expect(check.status).toBe("pass")
    expect(check.detail).toContain("over 1 answered sample(s) of 1")
  })
})

describe("errorRateVerdict (CN-20)", () => {
  const many = (count: number, over: Partial<Sample> = {}): Array<Sample> =>
    Array.from({ length: count }, () => sample(over))

  test("zero samples is skipped with no rate", () => {
    const { check, rate } = errorRateVerdict([], ERROR_RATE_THRESHOLD)
    expect(check.status).toBe("skip")
    expect(rate).toBeUndefined()
    expect(check.detail).toContain("no requests were made")
  })

  test("too few samples is skipped rather than dressed up as a percentage", () => {
    const { check, rate } = errorRateVerdict(many(4), ERROR_RATE_THRESHOLD)
    expect(check.status).toBe("skip")
    expect(rate).toBeUndefined()
    expect(check.detail).toContain("only 4 sample(s)")
  })

  test("a clean run passes with a zero rate", () => {
    const { check, rate } = errorRateVerdict(many(15), ERROR_RATE_THRESHOLD)
    expect(check.status).toBe("pass")
    expect(rate).toBe(0)
    expect(check.detail).toBe(`0/15 probe request(s) failed (rate 0.0%, threshold 5.0%) — ${ERROR_RATE_SCOPE_NOTE}`)
  })

  test("exactly at the threshold passes", () => {
    const samples = [...many(19), sample({ status: 502 })]
    const { check, rate } = errorRateVerdict(samples, ERROR_RATE_THRESHOLD)
    expect(rate).toBe(0.05)
    expect(check.status).toBe("pass")
  })

  test("one failure in fifteen exceeds the threshold and names the failure", () => {
    const samples = [...many(14), sample({ label: "scopes", status: 502 })]
    const { check, rate } = errorRateVerdict(samples, ERROR_RATE_THRESHOLD)
    expect(rate).toBeCloseTo(1 / 15, 10)
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("1/15 probe request(s) failed")
    expect(check.detail).toContain("scopes (HTTP 502, expected 200)")
  })

  test("identical failures collapse to one reason, so the issue body stays readable", () => {
    const { check } = errorRateVerdict(many(10, { status: 503 }), ERROR_RATE_THRESHOLD)
    expect(check.detail).toBe(
      `10/10 probe request(s) failed (rate 100.0%, threshold 5.0%): spa (HTTP 503, expected 200) — ${ERROR_RATE_SCOPE_NOTE}`
    )
  })

  test("more distinct reasons than fit are summarized rather than dumped", () => {
    const samples = Array.from(
      { length: 8 },
      (_unused, index) => sample({ label: `endpoint-${String(index)}`, status: 500 + index })
    )
    const { check } = errorRateVerdict(samples, ERROR_RATE_THRESHOLD)
    expect(check.detail).toContain("and 2 other distinct failure(s)")
    expect(check.detail).toContain("endpoint-0 (HTTP 500, expected 200)")
    expect(check.detail).not.toContain("endpoint-7")
  })

  test("every request failing is a 100% rate that names the transport error", () => {
    const { check, rate } = errorRateVerdict(
      many(10, { status: undefined, transportError: "TimeoutError: The operation timed out." }),
      ERROR_RATE_THRESHOLD
    )
    expect(rate).toBe(1)
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("10/10 probe request(s) failed (rate 100.0%, threshold 5.0%)")
    expect(check.detail).toContain("TimeoutError")
  })
})

describe("uptimeVerdict (CN-21)", () => {
  test("no endpoints probed is skipped", () => {
    expect(uptimeVerdict([]).status).toBe("skip")
  })

  test("every endpoint answering passes and reports the per-endpoint tally", () => {
    const check = uptimeVerdict([
      sample({ label: "spa" }),
      sample({ label: "spa" }),
      sample({ label: "turn-gate", status: 401, expectedStatus: 401 })
    ])
    expect(check.status).toBe("pass")
    expect(check.detail).toBe("2/2 endpoint(s) answered — spa 2/2, turn-gate 1/1")
  })

  test("an endpoint that answered once is up: unreliability is the error rate's finding, not this one's", () => {
    const check = uptimeVerdict([sample({ label: "spa" }), sample({ label: "spa", status: 503 })])
    expect(check.status).toBe("pass")
    expect(check.detail).toContain("spa 1/2")
  })

  test("an endpoint with no good sample is down and is named", () => {
    const check = uptimeVerdict([
      sample({ label: "spa" }),
      sample({ label: "scopes", status: undefined, transportError: "ConnectionRefused" }),
      sample({ label: "scopes", status: undefined, transportError: "ConnectionRefused" })
    ])
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("1/2 endpoint(s) answered")
    expect(check.detail).toContain("fully down: scopes")
  })
})

describe("probeFailed and tallyChecks", () => {
  const checks: Array<Check> = [
    { id: "a", label: "a", status: "pass", detail: "" },
    { id: "b", label: "b", status: "skip", detail: "" }
  ]

  test("a skipped check never fails a run", () => {
    expect(probeFailed(checks)).toBe(false)
  })

  test("one failed check fails the run", () => {
    expect(probeFailed([...checks, { id: "c", label: "c", status: "fail", detail: "" }])).toBe(true)
  })

  test("the tally counts each status", () => {
    expect(tallyChecks([...checks, { id: "c", label: "c", status: "fail", detail: "" }])).toEqual({
      passed: 1,
      failed: 1,
      skipped: 1
    })
  })
})

describe("coerceReport", () => {
  const good: ProbeReport = {
    origin: "https://canary.smithers.sh",
    generatedAt: "2026-08-18T00:00:00.000Z",
    samples: [sample()],
    checks: [{ id: "uptime", label: "every probed endpoint answered", status: "pass", detail: "d" }],
    errorRate: 0,
    meteredTurns: 1,
    failed: false
  }

  test("a round-tripped report survives JSON unchanged", () => {
    expect(coerceReport(JSON.parse(JSON.stringify(good)), "report.json")).toEqual(good)
  })

  test("a missing report is a FAILING report that names the file", () => {
    const report = coerceReport(undefined, "/tmp/uptime.json")
    expect(report.failed).toBe(true)
    expect(report.checks[0]!.status).toBe("fail")
    expect(report.checks[0]!.detail).toContain("/tmp/uptime.json")
    expect(report.checks[0]!.detail).toContain("proved nothing about the deployment")
  })

  test("a report whose checks are not checks is treated as no report at all", () => {
    expect(coerceReport({ ...good, checks: [{ id: 1 }] }, "report.json").failed).toBe(true)
  })

  test("a report missing its verdict is treated as no report at all", () => {
    const { failed: _dropped, ...withoutVerdict } = good
    expect(coerceReport(withoutVerdict, "report.json").checks[0]!.id).toBe("probe-report")
  })
})

describe("alertAction", () => {
  const report = (failed: boolean): ProbeReport => ({
    origin: "https://canary.smithers.sh",
    generatedAt: "2026-08-18T00:00:00.000Z",
    samples: [],
    checks: [{ id: "uptime", label: "every probed endpoint answered", status: failed ? "fail" : "pass", detail: "d" }],
    errorRate: 0,
    meteredTurns: 0,
    failed
  })
  const runUrl = "https://github.com/smithersai/smithers/actions/runs/1"

  test("a first failure opens the one issue, under the fixed title", () => {
    const action = alertAction({ report: report(true), openIssue: undefined, runUrl, browserPending: false })
    expect(action.kind).toBe("create")
    if (action.kind !== "create") throw new Error("unreachable")
    expect(action.title).toBe(ALERT_TITLE)
    expect(action.body).toContain("https://canary.smithers.sh")
  })

  /*
   * Delivery must not depend on anyone's watch settings: the repository's only
   * watcher is not the operator. Assignment notifies the assignee regardless.
   */
  test("a first failure assigns the operator, so the alert notifies someone who operates", () => {
    const action = alertAction({ report: report(true), openIssue: undefined, runUrl, browserPending: false })
    if (action.kind !== "create") throw new Error(`expected create, got ${action.kind}`)
    expect(action.assignees).toEqual(ALERT_ASSIGNEES)
    expect(ALERT_ASSIGNEES.length).toBeGreaterThan(0)
  })

  /*
   * The quarter-hour tick never runs the browser. Its pass cannot clear a
   * browser failure it never retested, but a failure it did measure still
   * reaches the open issue, and a full run still closes it.
   */
  test("a pending browser recheck leaves a healthy open issue alone", () => {
    const action = alertAction({ report: report(false), openIssue: 42, runUrl, browserPending: true })
    expect(action.kind).toBe("none")
    if (action.kind !== "none") throw new Error("unreachable")
    expect(action.reason).toContain("browser recheck is pending")
  })

  test("a pending browser recheck still comments a failure on the open issue", () => {
    const action = alertAction({ report: report(true), openIssue: 42, runUrl, browserPending: true })
    expect(action.kind).toBe("comment")
  })

  test("a pending browser recheck with nothing open and a failure still opens the issue", () => {
    const action = alertAction({ report: report(true), openIssue: undefined, runUrl, browserPending: true })
    expect(action.kind).toBe("create")
  })

  test("a full healthy run closes the open issue", () => {
    const action = alertAction({ report: report(false), openIssue: 42, runUrl, browserPending: false })
    expect(action.kind).toBe("close")
  })

  test("a repeat failure comments on the open issue instead of opening a second", () => {
    const action = alertAction({ report: report(true), openIssue: 42, runUrl, browserPending: false })
    expect(action.kind).toBe("comment")
    if (action.kind !== "comment") throw new Error("unreachable")
    expect(action.issue).toBe(42)
  })

  test("recovery closes the open issue, so the alert cannot become a stale banner", () => {
    const action = alertAction({ report: report(false), openIssue: 42, runUrl, browserPending: false })
    expect(action.kind).toBe("close")
    if (action.kind !== "close") throw new Error("unreachable")
    expect(action.issue).toBe(42)
    expect(action.body).toStartWith("The canary recovered.")
  })

  test("a passing run with nothing open does nothing at all", () => {
    const action = alertAction({ report: report(false), openIssue: undefined, runUrl, browserPending: false })
    expect(action.kind).toBe("none")
  })

  test("the body carries the run link, the metered-turn count and every check", () => {
    const body = renderAlertBody(report(true), runUrl)
    expect(body).toContain(`Run: ${runUrl}`)
    expect(body).toContain("Metered turns spent by this run: 0")
    expect(body).toContain("| FAIL | every probed endpoint answered | d |")
  })
})

/*
 * The browser probe speaks the same Check vocabulary as every other probe. An
 * unconfigured browser canary is a configuration state said out loud, never an
 * outage: a missing secret must not file "smithers.sh is failing".
 */
describe("browserVerdict", () => {
  const source = "/tmp/canary-browser/result.json"

  test("a passing browser run is one passing row", () => {
    const check = browserVerdict({ status: "pass", checks: ["signed-in browser session"] }, source)
    expect(check.id).toBe(BROWSER_CHECK_ID)
    expect(check.status).toBe("pass")
    expect(check.detail).toContain("signed-in browser session")
  })

  test("an unconfigured browser canary skips and names every missing variable", () => {
    const check = browserVerdict({ status: "skip", missing: ["CANARY_SESSION_COOKIE", "CANARY_BROWSER_FLOW"] }, source)
    expect(check.status).toBe("skip")
    expect(check.detail).toContain("CANARY_SESSION_COOKIE")
    expect(check.detail).toContain("CANARY_BROWSER_FLOW")
  })

  test("a failing browser run fails and points at the evidence", () => {
    const check = browserVerdict({ status: "fail", error: "Error: Chat input is not editable" }, source)
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("Chat input is not editable")
    expect(check.detail).toContain("canary-browser artifact")
  })

  test("a browser probe that wrote no verdict fails rather than passing silently", () => {
    for (const parsed of [undefined, null, "pass", {}, { status: "green" }, { status: "skip" }, { status: "skip", missing: [] }]) {
      const check = browserVerdict(parsed, source)
      expect(check.status).toBe("fail")
      expect(check.detail).toContain(source)
    }
  })
})

describe("drillCheck", () => {
  test("the alert drill is a failing row that says it was deliberate", () => {
    const check = drillCheck("workflow_dispatch drill")
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("deliberate")
    expect(check.detail).toContain("workflow_dispatch drill")
  })
})

describe("withChecks", () => {
  const healthy: ProbeReport = {
    origin: "https://smithers.sh",
    generatedAt: "2026-09-23T00:00:00.000Z",
    samples: [],
    checks: [{ id: "uptime", label: "u", status: "pass", detail: "d" }],
    errorRate: 0,
    meteredTurns: 0,
    failed: false
  }

  test("a skipped extra row leaves a healthy report healthy and still shows the row", () => {
    const merged = withChecks(healthy, [browserVerdict({ status: "skip", missing: ["CANARY_SESSION_COOKIE"] }, "r")])
    expect(merged.failed).toBe(false)
    expect(merged.checks.map((check) => check.id)).toEqual(["uptime", BROWSER_CHECK_ID])
  })

  test("a failing extra row fails the merged report", () => {
    expect(withChecks(healthy, [drillCheck("drill")]).failed).toBe(true)
  })

  test("a failing report stays failed under passing extras", () => {
    const failing = { ...healthy, failed: true }
    expect(withChecks(failing, [browserVerdict({ status: "pass", checks: [] }, "r")]).failed).toBe(true)
  })
})

describe("endpointPlan", () => {
  test("it probes the SPA, the scopes read and the signed-out turn gate", () => {
    expect(endpointPlan("run-1").map((endpoint) => endpoint.label)).toEqual(["spa", "scopes", "turn-gate"])
  })

  test("the turn gate expects the 401 refusal, so a 200 there is an error", () => {
    const gate = endpointPlan("run-1").find((endpoint) => endpoint.label === "turn-gate")!
    expect(gate.expectedStatus).toBe(401)
    expect(gate.method).toBe("POST")
    expect(JSON.parse(gate.body!)).toMatchObject({ runId: "run-1" })
  })
})

/*
 * Whole probe runs against a fake transport. The clock advances a fixed step
 * per reading, so every sample's elapsedMs is exactly `step` and the budgets
 * are the only thing under test.
 */
const makeDeps = (
  step: number,
  handler: (url: string, init: RequestInit) => Response | Promise<Response>
): { deps: ProbeDeps; calls: Array<{ url: string; init: RequestInit }> } => {
  let clock = 0
  const calls: Array<{ url: string; init: RequestInit }> = []
  return {
    calls,
    deps: {
      now: () => {
        const value = clock
        clock += step
        return value
      },
      sleep: async () => {},
      fetch: async (url, init) => {
        calls.push({ url, init })
        return await handler(url, init)
      }
    }
  }
}

const options = (over: Partial<ProbeOptions> = {}): ProbeOptions => ({
  origin: "https://canary.test",
  samplesPerEndpoint: 5,
  gapMs: 0,
  requestTimeoutMs: 20_000,
  sessionCookie: undefined,
  expectedSessionLogin: "smithers-visitor",
  privilegedLogins: [],
  runId: "run-1",
  ...over
})

/**
 * The scoped-down account the metered half must authenticate as: a plain
 * signed-in login with no admin claim (RULINGS 35). `allowlisted` is true
 * because open sign-in makes identity answer true for every login.
 */
const SCOPED_SESSION = "{\"username\":\"smithers-visitor\",\"allowlisted\":true,\"is_admin\":false}"

const bootstrap = { apiVersion: 1, host: "cloud", version: "1", buildSha: "a".repeat(40), capabilities: ["agent", "identity"], authFlow: "redirect", sandbox: null }
const healthy = (url: string): Response => {
  if (url.endsWith("/api/bootstrap")) return Response.json(bootstrap)
  if (url.endsWith("/api/agent/turn")) return new Response("Unauthorized", { status: 401 })
  if (url.endsWith("/api/user")) return new Response(SCOPED_SESSION, { status: 200 })
  return new Response("ok", { status: 200 })
}

/** Turn-seam calls only: the identity read-back carries a cookie too. */
const meteredCalls = (calls: ReadonlyArray<{ url: string; init: RequestInit }>): number =>
  calls.filter((call) =>
    call.url.endsWith("/api/agent/turn") && (call.init.headers as Record<string, string>).cookie !== undefined
  ).length

const ndjson = (frames: ReadonlyArray<string>): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(`${frame}\n`))
      controller.close()
    }
  })

const chunked = (chunks: ReadonlyArray<string>): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    }
  })

describe("runUptimeProbe", () => {
  test("a healthy deployment passes uptime, every latency budget and the error rate", async () => {
    const { deps, calls } = makeDeps(50, (url) => healthy(url))
    const report = await runUptimeProbe(deps, options())

    expect(report.failed).toBe(false)
    expect(report.samples).toHaveLength(15)
    expect(calls).toHaveLength(15)
    expect(report.errorRate).toBe(0)
    expect(report.meteredTurns).toBe(0)
    expect(byId(report.checks, "uptime").status).toBe("pass")
    expect(byId(report.checks, "latency:spa").status).toBe("pass")
    expect(byId(report.checks, "latency:turn-gate").status).toBe("pass")
    expect(byId(report.checks, "error-rate").status).toBe("pass")
  })

  test("with no session cookie the turn-seam latency check is skipped and says why", async () => {
    const { deps } = makeDeps(50, (url) => healthy(url))
    const report = await runUptimeProbe(deps, options())
    const check = byId(report.checks, "latency:turn-first-frame")

    expect(check.status).toBe("skip")
    expect(check.detail).toContain("$CANARY_SESSION_COOKIE is unset")
    expect(report.failed).toBe(false)
  })

  test("a slow deployment fails only the latency checks it actually blew", async () => {
    const { deps } = makeDeps(1_600, (url) => healthy(url))
    const report = await runUptimeProbe(deps, options())

    expect(byId(report.checks, "uptime").status).toBe("pass")
    expect(byId(report.checks, "error-rate").status).toBe("pass")
    // 1600ms is inside the 2000ms SPA budget and outside the 1500ms
    // budgets for the two API reads.
    expect(byId(report.checks, "latency:spa").status).toBe("pass")
    expect(byId(report.checks, "latency:scopes").status).toBe("fail")
    expect(byId(report.checks, "latency:turn-gate").status).toBe("fail")
    expect(report.failed).toBe(true)
  })

  test("a dead endpoint fails uptime, its latency and the error rate together", async () => {
    const { deps } = makeDeps(20, (url) => {
      if (url.endsWith("/api/bootstrap")) throw new Error("connect ECONNREFUSED")
      return healthy(url)
    })
    const report = await runUptimeProbe(deps, options())

    expect(byId(report.checks, "uptime").detail).toContain("fully down: scopes")
    expect(byId(report.checks, "latency:scopes").status).toBe("fail")
    expect(byId(report.checks, "error-rate").status).toBe("fail")
    expect(report.errorRate).toBeCloseTo(5 / 15, 10)
    expect(report.samples.filter((s) => s.transportError !== undefined)).toHaveLength(5)
    expect(report.failed).toBe(true)
  })

  test("a turn seam that stops refusing anonymous callers is an error, not a pass", async () => {
    const { deps } = makeDeps(
      20,
      (url) => url.endsWith("/api/agent/turn") ? new Response("streaming", { status: 200 }) : healthy(url)
    )
    const report = await runUptimeProbe(deps, options())

    expect(byId(report.checks, "error-rate").detail).toContain("turn-gate (HTTP 200, expected 401)")
    expect(report.failed).toBe(true)
  })

  test("with a session cookie the probe takes exactly one metered turn and times its first frame", async () => {
    const { deps, calls } = makeDeps(3_000, (url, init) => {
      if (url.endsWith("/api/agent/turn") && (init.headers as Record<string, string>).cookie !== undefined) {
        return new Response(
          ndjson(["{\"runId\":\"run-1-metered\",\"type\":\"delta\",\"kind\":\"text\",\"text\":\"ok\"}"]),
          { status: 200 }
        )
      }
      return healthy(url)
    })
    const report = await runUptimeProbe(deps, options({ sessionCookie: "smithers_session=abc" }))

    expect(report.meteredTurns).toBe(1)
    expect(meteredCalls(calls)).toBe(1)
    expect(byId(report.checks, SCOPED_IDENTITY_CHECK_ID).status).toBe("pass")
    const check = byId(report.checks, "latency:turn-first-frame")
    expect(check.status).toBe("pass")
    expect(check.detail).toContain(`budget ${LATENCY_BUDGETS_MS.turnFirstFrame}ms`)
  })

  test("the metered sample decodes one complete split NDJSON frame", async () => {
    const frame = "{\"runId\":\"run-1-metered\",\"type\":\"delta\",\"kind\":\"text\",\"text\":\"ok\"}\n"
    const { deps } = makeDeps(1, () => new Response(chunked([frame.slice(0, 12), frame.slice(12)]), { status: 200 }))
    const result = await meteredTurnSample(deps, options(), "s=1")
    expect(result.transportError).toBeUndefined()
  })

  test("the metered sample rejects corrupt, foreign-run, and HTML first frames", async () => {
    for (
      const body of [
        "{broken}\n",
        "{\"runId\":\"other\",\"type\":\"delta\",\"kind\":\"text\",\"text\":\"ok\"}\n",
        "<html>upstream error</html>\n"
      ]
    ) {
      const { deps } = makeDeps(1, () => new Response(body, { status: 200 }))
      const result = await meteredTurnSample(deps, options(), "s=1")
      expect(result.transportError).toBeDefined()
    }
  })

  test("a metered turn slower than the first-frame budget fails", async () => {
    const { deps } = makeDeps(LATENCY_BUDGETS_MS.turnFirstFrame + 1_000, (url, init) => {
      if (url.endsWith("/api/agent/turn") && (init.headers as Record<string, string>).cookie !== undefined) {
        return new Response(
          ndjson(["{\"runId\":\"run-1-metered\",\"type\":\"delta\",\"kind\":\"text\",\"text\":\"ok\"}"]),
          { status: 200 }
        )
      }
      return healthy(url)
    })
    const report = await runUptimeProbe(deps, options({ samplesPerEndpoint: 1, sessionCookie: "s=1" }))

    expect(byId(report.checks, "latency:turn-first-frame").status).toBe("fail")
    expect(report.failed).toBe(true)
  })

  test("a 200 that streams no frame is a failed turn, never a very fast one", async () => {
    const { deps } = makeDeps(10, (url, init) => {
      if (url.endsWith("/api/agent/turn") && (init.headers as Record<string, string>).cookie !== undefined) {
        return new Response(ndjson([]), { status: 200 })
      }
      return healthy(url)
    })
    const report = await runUptimeProbe(deps, options({ samplesPerEndpoint: 5, sessionCookie: "s=1" }))

    const turn = report.samples.find((s) => s.label === "turn-first-frame")!
    expect(turn.transportError).toBe("the turn seam answered 200 but streamed no frame")
    expect(byId(report.checks, "latency:turn-first-frame").status).toBe("fail")
    expect(byId(report.checks, "uptime").detail).toContain("turn-first-frame 0/1")
    expect(report.failed).toBe(true)
  })

  test("a signed-in turn refused with a 401 is recorded as the failure it is", async () => {
    const { deps } = makeDeps(
      10,
      (url, init) =>
        url.endsWith("/api/agent/turn") && (init.headers as Record<string, string>).cookie !== undefined
          ? new Response("Unauthorized", { status: 401 })
          : healthy(url)
    )
    const report = await runUptimeProbe(deps, options({ sessionCookie: "expired" }))

    const turn = report.samples.find((s) => s.label === "turn-first-frame")!
    expect(turn.status).toBe(401)
    expect(turn.expectedStatus).toBe(200)
    expect(report.failed).toBe(true)
  })

  test("the probe sleeps between samples so consecutive samples are independent", async () => {
    let sleeps = 0
    const { deps } = makeDeps(10, (url) => healthy(url))
    const counting: ProbeDeps = {
      ...deps,
      sleep: async () => {
        sleeps += 1
      }
    }
    await runUptimeProbe(counting, options({ samplesPerEndpoint: 2 }))
    // Six samples, five gaps: nothing is slept before the first request.
    expect(sleeps).toBe(5)
  })

  /*
   * CN-19's honesty gate. The turn seam costs model credit, so it is sampled
   * once (TURN_FIRST_FRAME_SAMPLES). A verdict built on one observation must
   * not describe itself with a word that implies many, so the detail carries
   * the note and the alert issue carries the detail.
   */
  test("the turn-seam verdict declares that it is a single sample, in the line a human reads", async () => {
    const { deps, calls } = makeDeps(3_000, (url, init) => {
      if (url.endsWith("/api/agent/turn") && (init.headers as Record<string, string>).cookie !== undefined) {
        return new Response(
          ndjson(["{\"runId\":\"run-1-metered\",\"type\":\"delta\",\"kind\":\"text\",\"text\":\"ok\"}"]),
          { status: 200 }
        )
      }
      return healthy(url)
    })
    const report = await runUptimeProbe(deps, options({ sessionCookie: "s=1" }))

    expect(TURN_FIRST_FRAME_SAMPLES).toBe(1)
    expect(report.meteredTurns).toBe(TURN_FIRST_FRAME_SAMPLES)
    expect(meteredCalls(calls)).toBe(TURN_FIRST_FRAME_SAMPLES)
    const check = byId(report.checks, "latency:turn-first-frame")
    expect(check.detail).toContain(TURN_FIRST_FRAME_NOTE)
    expect(renderAlertBody(report, "https://runs.test/1")).toContain(TURN_FIRST_FRAME_NOTE)
  })

  /*
   * CN-20's caveat used to live only in a doc comment. The number it qualifies
   * is read in a GitHub issue, so the caveat has to be there too.
   */
  test("the error-rate verdict carries its scope caveat into the alert issue body", async () => {
    const { deps } = makeDeps(20, (url) => {
      if (url.endsWith("/api/bootstrap")) throw new Error("connect ECONNREFUSED")
      return healthy(url)
    })
    const report = await runUptimeProbe(deps, options())

    const check = byId(report.checks, "error-rate")
    expect(check.status).toBe("fail")
    expect(check.detail).toContain(ERROR_RATE_SCOPE_NOTE)
    expect(renderAlertBody(report, "https://runs.test/1")).toContain(ERROR_RATE_SCOPE_NOTE)
  })

  test("the report names the origin it probed and stamps when it ran", async () => {
    const { deps } = makeDeps(1, (url) => healthy(url))
    const report = await runUptimeProbe(deps, options({ origin: "https://other.test", samplesPerEndpoint: 5 }))

    expect(report.origin).toBe("https://other.test")
    expect(report.generatedAt).toBe(new Date(0).toISOString())
    expect(report.samples.every((s) => s.label !== "turn-first-frame")).toBe(true)
  })
})

/*
 * The belt-and-braces half of the same regression, checked against the file
 * that actually invokes the probe.
 *
 * `resolveProbeOrigin` above makes the workflow's flag-only form safe. This
 * block keeps the workflow from drifting back to a form that relies on that
 * safety net alone: the origin is passed first and positionally, and the
 * environment the probe falls back to is exported on the same step. A test
 * that only checked the pure function would stay green while the workflow
 * once again handed the probe a temp-file path.
 */
describe("the scheduled workflow invokes the probe with an origin", () => {
  const canaryYml = readFileSync(
    fileURLToPath(new URL("../../../../.github/workflows/canary.yml", import.meta.url)),
    "utf8"
  )
  const invocation = canaryYml
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.includes("scripts/canary/uptime-probe.ts"))

  test("the workflow invokes the probe at all", () => {
    // A guard on the guard: an invocation this block cannot find would make
    // every assertion below vacuous.
    expect(invocation).toBeDefined()
  })

  test("the origin is the first argument, before any flag", () => {
    const args = (invocation as string).split("scripts/canary/uptime-probe.ts")[1]!.trim().split(/\s+/)
    expect(args[0]).toBe("\"$CANARY_URL\"")
  })

  test("the step exports the CANARY_URL the invocation and the fallback both read", () => {
    expect(canaryYml).toMatch(/^\s*CANARY_URL: /m)
  })
})

/*
 * RULINGS 35: the probes run as a scoped-down signed-in user, never an admin
 * and never a hand-seeded allowlist entry, so a permission bug that refuses
 * ordinary visitors cannot hide behind the operator's own privileges. These
 * assertions are the loud failure that ruling asks for.
 */
describe("parseSessionRead", () => {
  test("reads a plain signed-in account", () => {
    expect(parseSessionRead(200, "{\"username\":\"visitor\",\"allowlisted\":true,\"is_admin\":false}")).toEqual({
      state: "known",
      login: "visitor",
      admin: false,
      allowlisted: undefined
    })
  })

  test("requires the canonical signed-out status", () => {
    expect(parseSessionRead(401, "{\"error\":\"Unauthorized\"}")).toEqual({ state: "signed-out" })
    expect(parseSessionRead(200, "{\"status\":\"signed-out\"}").state).toBe("unreadable")
  })

  test("an absent admin field is 'not stated', never a quiet false", () => {
    const read = parseSessionRead(200, "{\"username\":\"visitor\",\"allowlisted\":true}")
    expect(read).toEqual({ state: "known", login: "visitor", admin: undefined, allowlisted: undefined })
  })

  test("a non-200, a non-JSON body and a body with no login are unreadable, not answers", () => {
    expect(parseSessionRead(500, "upstream failure").state).toBe("unreadable")
    expect(parseSessionRead(200, "<html>error</html>").state).toBe("unreadable")
    expect(parseSessionRead(200, "{\"allowlisted\":true}").state).toBe("unreadable")
  })
})

describe("scopedIdentityVerdict", () => {
  const expectation = { expectedLogin: "smithers-visitor", privilegedLogins: ["will", "octocat"] }
  const known = (over: Partial<{ login: string; admin: boolean | undefined; allowlisted: boolean | undefined }>) =>
    ({ state: "known", login: "smithers-visitor", admin: false, allowlisted: true, ...over }) as const

  test("a plain signed-in account passes and states what it read", () => {
    const check = scopedIdentityVerdict(known({}), expectation)
    expect(check.status).toBe("pass")
    expect(check.detail).toContain("signed in as smithers-visitor")
    expect(check.detail).toContain("admin=false")
  })

  test("an admin cookie fails and names the claim", () => {
    const check = scopedIdentityVerdict(known({ admin: true }), expectation)
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("admin claim")
  })

  test("a cookie for another login fails, so a swapped secret is caught by name", () => {
    const check = scopedIdentityVerdict(known({ login: "someone-else" }), expectation)
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("smithers-visitor")
  })

  test("a login on the hand-seeded roster fails even with admin false", () => {
    const check = scopedIdentityVerdict(
      known({ login: "octocat", admin: false }),
      { expectedLogin: "octocat", privilegedLogins: ["will", "octocat"] }
    )
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("$CANARY_ALLOWLIST_LOGINS")
  })

  test("allowlisted:true alone never fails, because open sign-in sets it for every login", () => {
    expect(scopedIdentityVerdict(known({ allowlisted: true }), expectation).status).toBe("pass")
  })

  test("with no admin field and no declared login the check refuses to guess", () => {
    const check = scopedIdentityVerdict(
      known({ admin: undefined }),
      { expectedLogin: undefined, privilegedLogins: [] }
    )
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("$CANARY_SESSION_LOGIN")
  })

  test("with no admin field a declared login that matches is enough", () => {
    expect(scopedIdentityVerdict(known({ admin: undefined }), expectation).status).toBe("pass")
  })

  test("a cookie that authenticated nobody fails rather than buying a signed-out measurement", () => {
    const check = scopedIdentityVerdict({ state: "signed-out" }, expectation)
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("authenticated nobody")
  })

  test("a session that could not be read fails and carries the reason", () => {
    const check = scopedIdentityVerdict({ state: "unreadable", detail: "HTTP 503" }, expectation)
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("HTTP 503")
  })
})

describe("runUptimeProbe refuses to spend under a privileged cookie", () => {
  const adminDeployment = (url: string): Response => {
    if (url.endsWith("/api/user")) {
      return new Response("{\"username\":\"smithers-visitor\",\"allowlisted\":true,\"is_admin\":true}", { status: 200 })
    }
    return healthy(url)
  }

  test("an admin cookie fails the run, takes no turn, and says the latency was not measured", async () => {
    const { deps, calls } = makeDeps(10, (url) => adminDeployment(url))
    const report = await runUptimeProbe(deps, options({ samplesPerEndpoint: 1, sessionCookie: "s=1" }))

    expect(report.failed).toBe(true)
    expect(report.meteredTurns).toBe(0)
    expect(meteredCalls(calls)).toBe(0)
    expect(byId(report.checks, SCOPED_IDENTITY_CHECK_ID).status).toBe("fail")
    const latency = byId(report.checks, "latency:turn-first-frame")
    expect(latency.status).toBe("skip")
    expect(latency.detail).toContain("not a scoped-down user")
  })

  test("the identity read never becomes a sample, so CN-20 and CN-21 mean the same on every tick", async () => {
    const { deps } = makeDeps(10, (url) => healthy(url))
    const metered = await runUptimeProbe(deps, options({ samplesPerEndpoint: 5, sessionCookie: "s=1" }))
    const free = await runUptimeProbe(makeDeps(10, (url) => healthy(url)).deps, options({ samplesPerEndpoint: 5 }))

    expect(metered.samples.filter((sample) => sample.label !== "turn-first-frame")).toHaveLength(free.samples.length)
    expect(metered.samples.some((sample) => sample.label.includes("session"))).toBe(false)
  })

  test("without a cookie the run states the cookie is unset, not that the identity was wrong", async () => {
    const { deps } = makeDeps(10, (url) => healthy(url))
    const report = await runUptimeProbe(deps, options({ samplesPerEndpoint: 1 }))

    expect(report.checks.some((check) => check.id === SCOPED_IDENTITY_CHECK_ID)).toBe(false)
    expect(byId(report.checks, "latency:turn-first-frame").detail).toContain("$CANARY_SESSION_COOKIE is unset")
  })
})

test("a legacy health body cannot certify canonical bootstrap", async () => {
  const { deps } = makeDeps(1, url => url.endsWith("/api/bootstrap") ? Response.json({ ok: true }) : healthy(url))
  const report = await runUptimeProbe(deps, options())
  expect(report.failed).toBe(true)
})
