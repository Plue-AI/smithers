/*
 * CN-19, CN-20 and CN-21 — the pure half of the canary uptime probe.
 *
 * Everything here is a total function over recorded observations. The only
 * untested line in this lane is the network call itself: `uptime-probe.ts`
 * supplies a real `fetch`, `runUptimeProbe` takes it as a dependency, and the
 * tests beside this file supply a fake. That split exists because the lane has
 * no credential and no live deployment, so a probe whose decision logic could
 * only be exercised against production would never have been demonstrated at
 * all.
 *
 * Three separate questions, deliberately not collapsed into one number:
 *
 *   CN-21 uptime      — did each endpoint answer at all?
 *   CN-20 error rate  — of the requests we made, what fraction failed?
 *   CN-19 latency     — how long did the ones that answered take?
 *
 * An endpoint that is down fails all three. An endpoint that is up but flaky
 * fails only the error rate. An endpoint that is up and reliable but slow fails
 * only latency. Collapsing them would lose which of the three is true.
 */
import { TURN_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { AUTHENTICATED_USER_PATH, ApplicationUserSchema, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "@smthrs/rpc/ApplicationAuth"
import { APP_BOOTSTRAP_PATH, AppBootstrapSchema } from "@smthrs/rpc/AppBootstrap"
import { AgentTurnFrameSchema } from "@smthrs/rpc/NativeAgent"
import { resolveOrigin } from "./BuildStamp.ts"

const FIRST_FRAME_MAX_BYTES = 64 * 1024

/**
 * The end-to-end product bar this repo already states: row A-2's
 * `FIRST_MESSAGE_BUDGET_MS` in apps/app/scripts/launch-checklist/Probes.ts. It is
 * the only latency contract written down anywhere in the tree, so every budget
 * below is derived from it rather than invented.
 */
export const FIRST_MESSAGE_BUDGET_MS = 90_000

/*
 * How the 90s end-to-end bar is divided.
 *
 * A-2's 90s covers the whole journey: OAuth round trip, SPA download and
 * hydrate, session read, the first-run watched-repos read, then the turn
 * seam streaming its first useful token. The turn seam is one segment of that
 * journey, so its budget must be a fraction of 90s with room left for the
 * others.
 *
 *   turnFirstFrame 30_000 — one third of the bar, leaving 60s for every other
 *     segment, which the segments below show is ample. It is deliberately
 *     twice the 15s a median-backed budget would use, because this endpoint is
 *     sampled ONCE (see TURN_FIRST_FRAME_SAMPLES): a single sample has no
 *     median to absorb a Cloudflare Worker cold start, so the budget absorbs
 *     it instead. At 30s a single sample is a broken turn seam, not a cold one.
 *   spa 2_000 — the SPA is static assets from Cloudflare's edge. This is a
 *     transfer, not a computation.
 *   scopes 1_500 and turnGate 1_500 — both refuse or answer without reaching
 *     an upstream. `/api/agent/turn` signed out is rejected by
 *     requireTurnSession before the rate limiter and before any model call
 *     (apps/server/src/index.ts), so this measures the gate, not a turn.
 *
 * The three unmetered budgets are budgets for the MEDIAN of SAMPLES_PER_ENDPOINT
 * samples, so one slow cold start cannot open an issue. turnFirstFrame is the
 * documented exception and is handled by its size, not by a median.
 */
export const LATENCY_BUDGETS_MS = {
  spa: 2_000,
  scopes: 1_500,
  turnGate: 1_500,
  turnFirstFrame: 30_000
} as const

/*
 * How many times a metered run samples the turn seam, and what that costs.
 *
 * One. Every sample here spends real model credit — a nine-word prompt and a
 * cancelled stream, but a whole short turn as far as the account is concerned.
 * The scheduled workflow takes the metered sample on the hourly tick only, so
 * one sample is 24 short turns a day. Three samples, the smallest count for
 * which a median means anything, would be 72 a day for a probe whose job is to
 * notice an outage that the free turn-gate sample already notices.
 *
 * The cost of that choice, stated rather than hidden: this one endpoint is
 * judged on a single observation, so a cold start reads exactly like a
 * regression. The budget above is doubled to absorb that, and every verdict
 * this endpoint produces carries TURN_FIRST_FRAME_NOTE so the human reading
 * the GitHub issue is told which kind of number they are looking at. Raise
 * this to 3 and the median claim becomes true again; the bill triples.
 */
export const TURN_FIRST_FRAME_SAMPLES = 1

/**
 * Travels in the check detail, and therefore into the alert issue body. Change
 * it in the same edit that changes TURN_FIRST_FRAME_SAMPLES: its whole job is
 * to state the sampling the number above actually does.
 */
export const TURN_FIRST_FRAME_NOTE =
  "single sample: the turn seam spends model credit, so this endpoint is measured once per metered run and its budget absorbs a cold start instead of a median"

/**
 * CN-20's threshold. Read the honest scope note on `errorRateVerdict` before
 * changing it: this is the failure rate of THIS probe's own requests, not the
 * fleet's.
 */
export const ERROR_RATE_THRESHOLD = 0.05

/**
 * Below this many samples a rate is a coin flip dressed as a percentage, so
 * `errorRateVerdict` reports "not measured" rather than a number.
 */
export const MIN_SAMPLES_FOR_RATE = 5

/** Samples per unmetered endpoint per run. */
export const SAMPLES_PER_ENDPOINT = 5

/** Distinct failure reasons named in the error-rate line before it summarizes. */
export const MAX_REASONS_SHOWN = 6

/** Milliseconds between samples, so consecutive samples are independent. */
export const SAMPLE_GAP_MS = 250

/** Per-request ceiling. A request that exceeds it is recorded as a failure. */
export const REQUEST_TIMEOUT_MS = 20_000

export type CheckStatus = "pass" | "fail" | "skip"

export interface Check {
  readonly id: string
  readonly label: string
  readonly status: CheckStatus
  readonly detail: string
}

export const pass = (id: string, label: string, detail: string): Check => ({ id, label, status: "pass", detail })
export const fail = (id: string, label: string, detail: string): Check => ({ id, label, status: "fail", detail })
/** Not measured this run, and saying so out loud. Never fails the probe. */
export const skip = (id: string, label: string, detail: string): Check => ({ id, label, status: "skip", detail })

export interface Sample {
  readonly label: string
  /** undefined when the request never produced a response. */
  readonly status: number | undefined
  /** The status this endpoint answers when the deployment is healthy. */
  readonly expectedStatus: number
  readonly elapsedMs: number
  /** Set when the request threw: DNS, TLS, connection reset, timeout. */
  readonly transportError: string | undefined
}

/**
 * A sample is an error when it did not answer, or did not answer the status
 * this endpoint answers when healthy. `expectedStatus` is always below 500, so
 * every 5xx is an error by construction; an unexpected 4xx counts too, because
 * a gate that starts refusing valid traffic is as much an outage as a crash.
 */
export const isErrorSample = (sample: Sample): boolean =>
  sample.transportError !== undefined || sample.status === undefined || sample.status !== sample.expectedStatus

/** A sample that produced a response, and therefore carries a real duration. */
const answered = (sample: Sample): boolean => sample.transportError === undefined && sample.status !== undefined

/** undefined for an empty list: zero samples have no median, and no caller may pretend otherwise. */
export const median = (values: ReadonlyArray<number>): number | undefined => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * CN-19. Fails when the MEDIAN of the samples that answered exceeds the budget.
 * Equal to the budget passes: a budget is a ceiling, not an exclusive bound.
 *
 * `note` is appended to every detail this verdict produces. It exists so an
 * endpoint whose sampling differs from the rule — today only `turn-first-frame`,
 * which is sampled once — says so in the line the human reads in the alert
 * issue, instead of letting the word "median" imply a protection it does not
 * have.
 */
export const latencyVerdict = (
  id: string,
  label: string,
  samples: ReadonlyArray<Sample>,
  budgetMs: number,
  note?: string
): Check => {
  const suffix = note === undefined ? "" : ` — ${note}`
  if (samples.length === 0) {
    return skip(id, label, `${label}: no samples were taken, so latency was not measured${suffix}`)
  }
  const durations = samples.filter(answered).map((sample) => sample.elapsedMs)
  if (durations.length === 0) {
    // Not a skip. An endpoint that never answers has no latency to measure
    // because it failed, and reporting that as "not measured" would hide an
    // outage behind a word that means the opposite.
    return fail(
      id,
      label,
      `${label}: none of ${samples.length} request(s) answered, so latency is unbounded (budget ${budgetMs}ms)${suffix}`
    )
  }
  const middle = median(durations)!
  const max = Math.max(...durations)
  const detail =
    `${label}: median ${middle}ms, max ${max}ms (budget ${budgetMs}ms) over ${durations.length} answered sample(s) of ${samples.length}${suffix}`
  return middle <= budgetMs ? pass(id, label, detail) : fail(id, label, detail)
}

/**
 * CN-20's scope in one sentence, carried by every measured error-rate detail
 * so it reaches the human reading the alert issue rather than only the
 * maintainer reading this file.
 */
export const ERROR_RATE_SCOPE_NOTE =
  "scope: one vantage point, and only the requests this probe itself made — it cannot see errors that only signed-in users hit, nor errors on routes it does not call"

/**
 * CN-20, and the honest scope of it.
 *
 * This measures the failure rate of THIS probe's own requests, from one
 * vantage point, over one run. It is a sample, not the fleet's error rate.
 * Without log access it cannot see errors that only signed-in users hit,
 * cannot see errors on routes it does not call, and cannot see an error that
 * the deployment answers correctly with a 4xx. Read a passing verdict as "the
 * deployment answered this probe's requests", never as "the deployment is
 * error-free".
 *
 * It is still worth having: the sample is uniform, it runs on a schedule, and
 * a rate that moves is a real signal even when the absolute number is not the
 * fleet's.
 *
 * A caveat only a maintainer reading this file can see is a caveat nobody
 * reads, so the one-sentence form below travels in the check detail and lands
 * in the GitHub issue body next to the number it qualifies.
 */
export const errorRateVerdict = (
  samples: ReadonlyArray<Sample>,
  threshold: number
): { readonly check: Check; readonly rate: number | undefined } => {
  const id = "error-rate"
  const label = "probe-request error rate"
  if (samples.length === 0) {
    return {
      check: skip(id, label, `${label}: no requests were made, so there is no rate to compare against the threshold`),
      rate: undefined
    }
  }
  if (samples.length < MIN_SAMPLES_FOR_RATE) {
    return {
      check: skip(
        id,
        label,
        `${label}: only ${samples.length} sample(s); ${MIN_SAMPLES_FOR_RATE} are required before a rate means anything`
      ),
      rate: undefined
    }
  }
  const failed = samples.filter(isErrorSample)
  const rate = failed.length / samples.length
  // Distinct reasons, capped: fifteen identical connection refusals in one
  // line is noise, and this string is read inside a GitHub issue.
  const distinct = [
    ...new Set(
      failed.map(
        (sample) =>
          `${sample.label} (${
            sample.transportError ?? `HTTP ${String(sample.status)}, expected ${sample.expectedStatus}`
          })`
      )
    )
  ]
  const shown = distinct.slice(0, MAX_REASONS_SHOWN)
  const reasons = distinct.length > shown.length
    ? `${shown.join(", ")}, and ${distinct.length - shown.length} other distinct failure(s)`
    : shown.join(", ")
  const detail = `${failed.length}/${samples.length} probe request(s) failed (rate ${
    (rate * 100).toFixed(1)
  }%, threshold ${(threshold * 100).toFixed(1)}%)${reasons === "" ? "" : `: ${reasons}`} — ${ERROR_RATE_SCOPE_NOTE}`
  return { check: rate > threshold ? fail(id, label, detail) : pass(id, label, detail), rate }
}

/**
 * CN-21. The narrowest, loudest question: did each endpoint answer at all?
 * An endpoint with one good sample out of five is up and unreliable, which is
 * the error rate's finding. An endpoint with none is down, which is this one's.
 */
export const uptimeVerdict = (samples: ReadonlyArray<Sample>): Check => {
  const id = "uptime"
  const label = "every probed endpoint answered"
  if (samples.length === 0) {
    return skip(id, label, `${label}: no endpoints were probed`)
  }
  const byLabel = new Map<string, { good: number; total: number }>()
  for (const sample of samples) {
    const tally = byLabel.get(sample.label) ?? { good: 0, total: 0 }
    tally.total += 1
    if (!isErrorSample(sample)) tally.good += 1
    byLabel.set(sample.label, tally)
  }
  const rendered = [...byLabel.entries()].map(([name, tally]) => `${name} ${tally.good}/${tally.total}`)
  const down = [...byLabel.entries()].filter(([, tally]) => tally.good === 0).map(([name]) => name)
  const detail = `${byLabel.size - down.length}/${byLabel.size} endpoint(s) answered — ${rendered.join(", ")}`
  return down.length === 0
    ? pass(id, label, detail)
    : fail(id, label, `${detail}; fully down: ${down.join(", ")}`)
}

/*
 * WHOSE SESSION SPENDS THE METERED TURN.
 *
 * Will's ruling (Factory spec 2026-09-08, review/RULINGS.md 35): open sign-in
 * is on and the permission tiers behind it stay deliberately narrow, so the
 * canary and the e2e suites run as a SCOPED-DOWN signed-in user — not an
 * admin, not a hand-seeded allowlist entry — and prove the product works under
 * the permissions a real visitor has. A probe holding an admin's cookie passes
 * every check while the deployment refuses everyone else, which is exactly the
 * permission bug this probe is supposed to surface.
 *
 * So the probe reads its own session back through AUTHENTICATED_USER_PATH before it
 * spends anything, and refuses to spend under a privileged one. That read is
 * free: it reaches no model and no upstream beyond the identity Worker.
 *
 * ON `allowlisted`. Under open sign-in, identity answers `allowlisted: true`
 * for every login (Factory spec 01 §3), so the flag is a fact this check
 * REPORTS and never one it asserts — asserting `false` would red the canary on
 * the day the allowlist is flipped off. What separates a visitor from an
 * admitted alpha account is membership in the roster $CANARY_ALLOWLIST_LOGINS
 * names, the same roster invite-probe.ts reads back, so that is what is tested.
 */
export type SessionRead =
  | { readonly state: "signed-out" }
  | { readonly state: "unreadable"; readonly detail: string }
  | {
    readonly state: "known"
    readonly login: string
    /** undefined when the session route named no `admin` field at all. */
    readonly admin: boolean | undefined
    readonly allowlisted: boolean | undefined
  }

export const SCOPED_IDENTITY_CHECK_ID = "identity:scoped"
export const SCOPED_IDENTITY_LABEL = "the metered turn runs as a scoped-down user"

/** A body fragment short enough to read inside a GitHub issue. */
const preview = (body: string): string => {
  const flat = body.replace(/\s+/g, " ").trim()
  return flat.length <= 120 ? flat : `${flat.slice(0, 117)}...`
}

/**
 * Read the canonical application identity. A401 is signed out; malformed
 * successful responses never become authenticated identities.
 */
export const parseSessionRead = (status: number, body: string): SessionRead => {
  if (status === 401) return { state: "signed-out" }
  if (status !== 200) {
    return { state: "unreadable", detail: `HTTP ${status} from ${AUTHENTICATED_USER_PATH}: ${preview(body)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {
      state: "unreadable",
      detail: `${AUTHENTICATED_USER_PATH} answered 200 with a body that is not JSON: ${preview(body)}`
    }
  }
  const record = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined
  const identity = ApplicationUserSchema.safeParse(record)
  const login = identity.success ? identity.data.username : undefined
  if (typeof login !== "string" || login === "") {
    return {
      state: "unreadable",
      detail: `${AUTHENTICATED_USER_PATH} answered 200 with no login: ${preview(body)}`
    }
  }
  return {
    state: "known",
    login,
    admin: identity.success ? identity.data.is_admin : undefined,
    allowlisted: undefined
  }
}

export interface ScopedIdentityExpectation {
  /**
   * The login the deployment declares for this cookie: $CANARY_SESSION_LOGIN,
   * else $SMITHERS_E2E_USER, the scoped e2e account.
   */
  readonly expectedLogin: string | undefined
  /** The hand-seeded closed-alpha roster, $CANARY_ALLOWLIST_LOGINS. */
  readonly privilegedLogins: ReadonlyArray<string>
}

const sameLogin = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase()

/**
 * Is the cookie a plain visitor's? Every failing branch names what it saw and
 * what it wanted, because the operator reading it is holding a secret they
 * cannot print.
 */
export const scopedIdentityVerdict = (read: SessionRead, expectation: ScopedIdentityExpectation): Check => {
  const id = SCOPED_IDENTITY_CHECK_ID
  const label = SCOPED_IDENTITY_LABEL
  if (read.state === "signed-out") {
    return fail(
      id,
      label,
      `${label}: $CANARY_SESSION_COOKIE authenticated nobody, so a turn taken under it would have measured the signed-out gate at the price of a real turn`
    )
  }
  if (read.state === "unreadable") {
    return fail(
      id,
      label,
      `${label}: the session could not be read, so nothing here shows this cookie is a visitor's — ${read.detail}`
    )
  }
  const stated = `signed in as ${read.login}: admin=${
    read.admin === undefined ? "not stated" : String(read.admin)
  }, allowlisted=${read.allowlisted === undefined ? "not stated" : String(read.allowlisted)}`
  const expected = expectation.expectedLogin === undefined || expectation.expectedLogin === ""
    ? undefined
    : expectation.expectedLogin
  const reasons: Array<string> = []
  if (read.admin === true) {
    reasons.push(
      "the session carries the admin claim, so every check below would pass on privileges no visitor has"
    )
  }
  if (expected !== undefined && !sameLogin(expected, read.login)) {
    reasons.push(`the declared account is ${expected} ($CANARY_SESSION_LOGIN, else $SMITHERS_E2E_USER)`)
  }
  if (expectation.privilegedLogins.some((entry) => sameLogin(entry, read.login))) {
    reasons.push(
      `${read.login} is on the hand-seeded roster $CANARY_ALLOWLIST_LOGINS, so it is an admitted alpha account rather than an ordinary visitor`
    )
  }
  if (read.admin === undefined && expected === undefined) {
    reasons.push(
      `${AUTHENTICATED_USER_PATH} stated no admin field and no account is declared, so nothing here could tell an admin's cookie from a visitor's — set $CANARY_SESSION_LOGIN`
    )
  }
  return reasons.length === 0
    ? pass(id, label, `${label}: ${stated} — a plain signed-in account, the permission level a real visitor has`)
    : fail(id, label, `${label}: ${stated} — ${reasons.join("; ")}`)
}

export interface ProbeReport {
  readonly origin: string
  readonly generatedAt: string
  readonly samples: ReadonlyArray<Sample>
  readonly checks: ReadonlyArray<Check>
  readonly errorRate: number | undefined
  /** The turn seam costs money, so a run states plainly what it spent. */
  readonly meteredTurns: number
  readonly failed: boolean
}

/** A run fails when any check failed. A skipped check never fails a run. */
export const probeFailed = (checks: ReadonlyArray<Check>): boolean => checks.some((check) => check.status === "fail")

export const tallyChecks = (
  checks: ReadonlyArray<Check>
): { readonly passed: number; readonly failed: number; readonly skipped: number } => ({
  passed: checks.filter((check) => check.status === "pass").length,
  failed: checks.filter((check) => check.status === "fail").length,
  skipped: checks.filter((check) => check.status === "skip").length
})

const isCheck = (value: unknown): value is Check => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.detail === "string" &&
    (candidate.status === "pass" || candidate.status === "fail" || candidate.status === "skip")
  )
}

/**
 * A probe that crashed before writing its report must still alert. Anything
 * that is not a report becomes a failing report that says so, so the alert
 * path never depends on the probe having survived its own run — a silent
 * green from a probe that never ran is the one outcome this whole lane exists
 * to prevent.
 */
export const coerceReport = (parsed: unknown, source: string): ProbeReport => {
  const candidate = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  if (
    candidate !== undefined &&
    typeof candidate.origin === "string" &&
    typeof candidate.generatedAt === "string" &&
    typeof candidate.failed === "boolean" &&
    Array.isArray(candidate.checks) &&
    candidate.checks.every(isCheck)
  ) {
    return {
      origin: candidate.origin,
      generatedAt: candidate.generatedAt,
      samples: Array.isArray(candidate.samples) ? (candidate.samples as ReadonlyArray<Sample>) : [],
      checks: candidate.checks,
      errorRate: typeof candidate.errorRate === "number" ? candidate.errorRate : undefined,
      meteredTurns: typeof candidate.meteredTurns === "number" ? candidate.meteredTurns : 0,
      failed: candidate.failed
    }
  }
  return {
    origin: "unknown",
    generatedAt: new Date(0).toISOString(),
    samples: [],
    checks: [
      fail(
        "probe-report",
        "the probe produced a report",
        `${source} is missing or is not a canary uptime report, so this run proved nothing about the deployment`
      )
    ],
    errorRate: undefined,
    meteredTurns: 0,
    failed: true
  }
}

/**
 * Extra rows merged into a probe report: the browser verdict and the drill. A
 * skipped row never fails the merged report; a failed row always does.
 */
export const withChecks = (report: ProbeReport, extra: ReadonlyArray<Check>): ProbeReport => ({
  ...report,
  checks: [...report.checks, ...extra],
  failed: report.failed || probeFailed(extra)
})

/*
 * The browser probe (apps/app/scripts/canary-browser.ts) writes result.json
 * with a `status` in this same vocabulary. Unconfigured is `skip` with the
 * unset variable names, because a missing canary secret is a configuration
 * state, not an outage. Anything that is not a verdict fails, mirroring
 * coerceReport: a browser probe that crashed before writing one must alert.
 */
export const BROWSER_CHECK_ID = "browser"
const BROWSER_LABEL = "smithers.sh browser"

const stringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : []

export const browserVerdict = (parsed: unknown, source: string): Check => {
  const result = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  if (result.status === "pass") {
    return pass(BROWSER_CHECK_ID, BROWSER_LABEL, `Browser canary passed: ${stringList(result.checks).join("; ")}`)
  }
  const missing = stringList(result.missing)
  if (result.status === "skip" && missing.length > 0) {
    return skip(BROWSER_CHECK_ID, BROWSER_LABEL, `Browser canary not configured: set ${missing.join(", ")}`)
  }
  if (result.status === "fail") {
    const error = typeof result.error === "string" ? result.error : "no error recorded"
    return fail(
      BROWSER_CHECK_ID,
      BROWSER_LABEL,
      `Browser canary failed: ${error}. Download the canary-browser artifact from the linked Actions run.`
    )
  }
  return fail(BROWSER_CHECK_ID, BROWSER_LABEL, `the browser probe produced no verdict: ${source} is missing or unreadable`)
}

/** The alert drill: one failing row that says it was deliberate. */
export const drillCheck = (reason: string): Check =>
  fail("drill", "alert delivery drill", `deliberate failure to verify alert delivery (${reason})`)

/*
 * Alerting.
 *
 * There is no paging infrastructure in this project and none is invented here.
 * The alert is a GitHub issue with a fixed title: a failing scheduled run
 * creates it, later failing runs comment on it, and the first passing run
 * comments and closes it. That gives a durable record, a timestamp, a
 * notification path the maintainer already reads, and — because of the close —
 * no stale banner.
 *
 * Delivery does not depend on anyone's watch settings: the issue is created
 * assigned to ALERT_ASSIGNEES, and GitHub notifies an assignee whether or not
 * they watch the repository. Comments and the close then notify participants.
 *
 * The second accepted failure mode: a single transient blip opens an issue
 * that the next run closes fifteen minutes later. The three unmetered latency
 * checks are judged on a median of SAMPLES_PER_ENDPOINT samples, so ordinary
 * slowness cannot do this to them. `turn-first-frame` is the exception, and it
 * is an exception on purpose: it is sampled once because samples cost model
 * credit, so a cold start there can open a self-closing issue. Its budget is
 * doubled to make that unlikely and its detail says "single sample" so the
 * reader of the issue knows which number they have. A self-closing issue is
 * the cost of not suppressing real outages.
 */
export const ALERT_TITLE = "Canary: smithers.sh is failing"
/** The operator. The repository's watchers do not include them. */
export const ALERT_ASSIGNEES: ReadonlyArray<string> = ["roninjin10"]

export type AlertAction =
  | { readonly kind: "create"; readonly title: string; readonly body: string; readonly assignees: ReadonlyArray<string> }
  | { readonly kind: "comment"; readonly issue: number; readonly body: string }
  | { readonly kind: "close"; readonly issue: number; readonly body: string }
  | { readonly kind: "none"; readonly reason: string }

export interface AlertInputs {
  readonly report: ProbeReport
  /** The number of the open alert issue, or undefined when none is open. */
  readonly openIssue: number | undefined
  readonly runUrl: string
  readonly title?: string
  /**
   * The browser step did not run this tick (the quarter-hour schedule). Such a
   * pass cannot clear a browser failure it never retested.
   */
  readonly browserPending: boolean
}

const checkLine = (check: Check): string => {
  const marker = check.status === "pass" ? "ok" : check.status === "fail" ? "FAIL" : "skip"
  return `| ${marker} | ${check.label} | ${check.detail} |`
}

export const renderAlertBody = (report: ProbeReport, runUrl: string): string => {
  const tally = tallyChecks(report.checks)
  const lines = [
    `Origin: ${report.origin}`,
    `Probed at: ${report.generatedAt}`,
    `Run: ${runUrl}`,
    `Checks: ${tally.passed} passed, ${tally.failed} failed, ${tally.skipped} not measured`,
    `Metered turns spent by this run: ${report.meteredTurns}`,
    "",
    "| | check | detail |",
    "| --- | --- | --- |",
    ...report.checks.map(checkLine)
  ]
  return lines.join("\n")
}

export const alertAction = (inputs: AlertInputs): AlertAction => {
  const title = inputs.title ?? ALERT_TITLE
  const body = renderAlertBody(inputs.report, inputs.runUrl)
  if (inputs.report.failed) {
    return inputs.openIssue === undefined
      ? { kind: "create", title, body, assignees: ALERT_ASSIGNEES }
      : { kind: "comment", issue: inputs.openIssue, body }
  }
  if (inputs.openIssue === undefined) {
    return { kind: "none", reason: "the canary passed and no alert issue is open" }
  }
  if (inputs.browserPending) {
    return { kind: "none", reason: "browser recheck is pending on the next full run" }
  }
  return { kind: "close", issue: inputs.openIssue, body: `The canary recovered.\n\n${body}` }
}

/*
 * The endpoint plan.
 *
 * Paths come from @smthrs/rpc/AgentApiRoutes, the same module the Worker
 * dispatches on, so renaming a route breaks this probe loudly instead of
 * leaving it probing a 404 forever.
 */
export interface Endpoint {
  readonly label: string
  readonly method: "GET" | "POST"
  readonly path: string
  readonly expectedStatus: number
  readonly budgetMs: number
  readonly body: string | undefined
}

/** The body shape apps/app/scripts/canary-seam-probe.ts sends to the turn seam. */
export const turnRequestBody = (runId: string): string =>
  JSON.stringify({
    runId,
    journal: { version: 1, legId: `${runId}-leg`, token: crypto.randomUUID().replaceAll("-", "") },
    messages: [{ role: "user", content: "Say the word ok and nothing else." }],
    instructions: "Answer briefly."
  })

export const endpointPlan = (runId: string): ReadonlyArray<Endpoint> => [
  { label: "spa", method: "GET", path: "/", expectedStatus: 200, budgetMs: LATENCY_BUDGETS_MS.spa, body: undefined },
  {
    label: "scopes",
    method: "GET",
    path: APP_BOOTSTRAP_PATH,
    expectedStatus: 200,
    budgetMs: LATENCY_BUDGETS_MS.scopes,
    body: undefined
  },
  {
    // Signed out the turn seam answers 401 (asserted by
    // apps/app/scripts/canary-seam-probe.ts). This measures the GATE, not a
    // model turn: requireTurnSession refuses before the rate limiter and
    // before any upstream call, so these samples cost nothing and cannot
    // consume the login's turn ceiling.
    label: "turn-gate",
    method: "POST",
    path: TURN_PATH,
    expectedStatus: 401,
    budgetMs: LATENCY_BUDGETS_MS.turnGate,
    body: turnRequestBody(runId)
  }
]

/*
 * Which origin gets probed, and the refusal that keeps a non-URL out.
 *
 * The bug this replaces: the origin was `args.find((arg) => !arg.startsWith("--"))`,
 * the first non-flag token anywhere in argv. The scheduled workflow invokes
 * the probe as `uptime-probe.ts --json "$RUNNER_TEMP/canary-uptime.json"`, so
 * the first non-flag token was the VALUE of --json. Every scheduled run
 * fetched `/home/runner/work/_temp/canary-uptime.json/` and friends, recorded
 * a transport error on all fifteen samples, and reported the deployment fully
 * down whether it was up or down — a verdict that could not move with the
 * thing it graded, opening an alert issue every fifteen minutes forever.
 *
 * Two changes stop it. Source selection is delegated to BuildStamp.ts's
 * `resolveOrigin`, which reads argv[0] only and then $CANARY_URL, so a flag's
 * value is never mistaken for a positional. And the result must parse as an
 * http or https URL, because the root cause was that a filesystem path was
 * accepted as an origin at all. A probe that silently accepts nonsense as its
 * target is the defect, not the symptom.
 */
export type OriginResolution = { readonly origin: string } | { readonly error: string }

const ORIGIN_SOURCES = "the first positional argument, then $CANARY_URL, then the built-in canary default"

export const resolveProbeOrigin = (
  argv: ReadonlyArray<string>,
  env: { readonly CANARY_URL?: string | undefined }
): OriginResolution => {
  // Trailing slashes go before parsing so `origin + path` never doubles one.
  const candidate = resolveOrigin(argv, env).trim().replace(/\/+$/, "")
  if (candidate === "") {
    return { error: `no origin to probe: ${ORIGIN_SOURCES} all resolved to an empty string` }
  }
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return {
      error:
        `refusing to probe "${candidate}": that is not a URL. The origin is read from ${ORIGIN_SOURCES}; a flag's value is never the origin`
    }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      error: `refusing to probe "${candidate}": ${parsed.protocol}// is not http or https, so this is not a deployment`
    }
  }
  return { origin: candidate }
}

export interface ProbeDeps {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

export interface ProbeOptions {
  readonly origin: string
  readonly samplesPerEndpoint: number
  readonly gapMs: number
  readonly requestTimeoutMs: number
  /*
   * CN-19's metered half. When set, the run takes exactly ONE signed-in
   * sample of the turn seam. When unset, the run says out loud that it
   * measured the refusal gate only. It never silently claims to have
   * measured a turn.
   */
  readonly sessionCookie: string | undefined
  /*
   * Who that cookie must be. `expectedSessionLogin` is $CANARY_SESSION_LOGIN,
   * else $SMITHERS_E2E_USER; `privilegedLogins` is the hand-seeded roster
   * $CANARY_ALLOWLIST_LOGINS. Both feed `scopedIdentityVerdict`, which decides
   * whether this run may spend anything at all.
   */
  readonly expectedSessionLogin: string | undefined
  readonly privilegedLogins: ReadonlyArray<string>
  readonly runId: string
}

const errorText = (error: unknown): string => error instanceof Error ? `${error.name}: ${error.message}` : String(error)

const takeSample = async (deps: ProbeDeps, options: ProbeOptions, endpoint: Endpoint): Promise<Sample> => {
  const started = deps.now()
  try {
    const response = await deps.fetch(`${options.origin}${endpoint.path}`, {
      method: endpoint.method,
      headers: endpoint.body === undefined ? {} : { "content-type": "application/json" },
      body: endpoint.body,
      signal: AbortSignal.timeout(options.requestTimeoutMs)
    })
    const elapsedMs = deps.now() - started
    // Drain rather than read: nothing here inspects the body, and an
    // undrained response holds a connection open for the whole run.
    let contractError: string | undefined
    if (endpoint.path === APP_BOOTSTRAP_PATH && response.status === 200) {
      const parsed = AppBootstrapSchema.safeParse(await response.json())
      if (!parsed.success) contractError = "invalid canonical bootstrap"
    } else await response.body?.cancel()
    return {
      label: endpoint.label,
      status: response.status,
      expectedStatus: endpoint.expectedStatus,
      elapsedMs,
      transportError: contractError
    }
  } catch (error) {
    return {
      label: endpoint.label,
      status: undefined,
      expectedStatus: endpoint.expectedStatus,
      elapsedMs: deps.now() - started,
      transportError: errorText(error)
    }
  }
}

/*
 * The identity read is deliberately NOT a Sample.
 *
 * Samples feed CN-20's error rate and CN-21's uptime, and this request is only
 * made on a metered run. Counting it would move both numbers between the
 * hourly tick and the quarter-hour ticks, so a rate that moved would say
 * "which schedule ran" rather than "how the deployment behaved". Its verdict
 * is a Check of its own instead.
 */
const readSessionIdentity = async (deps: ProbeDeps, options: ProbeOptions, cookie: string): Promise<SessionRead> => {
  try {
    const response = await deps.fetch(`${options.origin}${AUTHENTICATED_USER_PATH}`, {
      method: "GET",
      headers: { cookie },
      signal: AbortSignal.timeout(options.requestTimeoutMs)
    })
    return parseSessionRead(response.status, await response.text())
  } catch (error) {
    return { state: "unreadable", detail: errorText(error) }
  }
}

/**
 * CN-19's metered half: one signed-in turn, timed to the first NDJSON byte.
 *
 * Cost, stated plainly: one model turn per call. The prompt is nine words and
 * the instruction is two, and the stream is cancelled the moment the first
 * frame arrives, so this run reads no more than it must. Cancelling stops this
 * probe's read; whether the deployment finishes generating the turn is the
 * deployment's business, so budget the cost as one full short turn, not as a
 * partial one. `uptime-probe.ts` takes exactly one sample and only when
 * $CANARY_SESSION_COOKIE is set, and the scheduled workflow supplies that
 * cookie on the hourly tick only — 24 short turns a day, not 96.
 */
export const csrfHeaders = (cookie: string): Record<string, string> => {
  const value = cookie.split(";").map(part => part.trim()).find(part => part.startsWith(`${CSRF_COOKIE_NAME}=`))?.slice(CSRF_COOKIE_NAME.length + 1)
  if (!value) return {}
  try { return { [CSRF_HEADER_NAME]: decodeURIComponent(value) } } catch { return {} }
}

export const meteredTurnSample = async (deps: ProbeDeps, options: ProbeOptions, cookie: string): Promise<Sample> => {
  const started = deps.now()
  try {
    const response = await deps.fetch(`${options.origin}${TURN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, ...csrfHeaders(cookie) },
      body: turnRequestBody(`${options.runId}-metered`),
      signal: AbortSignal.timeout(options.requestTimeoutMs)
    })
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel()
      return {
        label: "turn-first-frame",
        status: response.status,
        expectedStatus: 200,
        elapsedMs: deps.now() - started,
        transportError: undefined
      }
    }
    const reader = response.body.getReader()
    const chunks: Array<Uint8Array> = []
    let received = 0
    let newline = -1
    while (received < FIRST_FRAME_MAX_BYTES && newline === -1) {
      const next = await reader.read()
      if (next.done) break
      const remaining = FIRST_FRAME_MAX_BYTES - received
      const value = next.value.subarray(0, remaining)
      chunks.push(value)
      const localNewline = value.indexOf(0x0a)
      if (localNewline !== -1) newline = received + localNewline
      received += value.byteLength
    }
    const elapsedMs = deps.now() - started
    await reader.cancel()
    let frameError: string | undefined
    if (newline === -1) {
      frameError = received === 0
        ? "the turn seam answered 200 but streamed no frame"
        : `the turn seam did not stream a complete frame within ${FIRST_FRAME_MAX_BYTES} bytes`
    } else {
      const bytes = new Uint8Array(newline)
      let offset = 0
      for (const chunk of chunks) {
        const slice = chunk.subarray(0, Math.min(chunk.byteLength, newline - offset))
        bytes.set(slice, offset)
        offset += slice.byteLength
        if (offset >= newline) break
      }
      try {
        const decoded = AgentTurnFrameSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
        const expectedRunId = `${options.runId}-metered`
        if (!decoded.success) frameError = "the turn seam streamed a malformed AgentTurnFrame"
        else if (decoded.data.runId !== expectedRunId) frameError = "the turn seam streamed a frame for another run"
        else if (decoded.data.type !== "delta") {
          frameError = "the turn seam streamed a terminal or non-delta first frame"
        }
      } catch {
        frameError = "the turn seam streamed malformed NDJSON"
      }
    }
    return {
      label: "turn-first-frame",
      status: response.status,
      expectedStatus: 200,
      elapsedMs,
      // A 200 that closes without a single frame is a failed turn, not a
      // fast one, and the elapsed time above would otherwise read as a
      // very good latency.
      transportError: frameError
    }
  } catch (error) {
    return {
      label: "turn-first-frame",
      status: undefined,
      expectedStatus: 200,
      elapsedMs: deps.now() - started,
      transportError: errorText(error)
    }
  }
}

export const runUptimeProbe = async (deps: ProbeDeps, options: ProbeOptions): Promise<ProbeReport> => {
  const generatedAt = new Date(deps.now()).toISOString()
  const plan = endpointPlan(options.runId)
  const samples: Array<Sample> = []
  for (const endpoint of plan) {
    for (let index = 0; index < options.samplesPerEndpoint; index += 1) {
      if (samples.length > 0) await deps.sleep(options.gapMs)
      samples.push(await takeSample(deps, options, endpoint))
    }
  }

  // Who the cookie is, before a cent of model credit is spent under it. A
  // privileged cookie fails here and takes no turn: the run then says the
  // identity was wrong instead of reporting a latency nobody can trust.
  const cookie = options.sessionCookie === undefined || options.sessionCookie === ""
    ? undefined
    : options.sessionCookie
  const identityCheck = cookie === undefined ? undefined : scopedIdentityVerdict(
    await readSessionIdentity(deps, options, cookie),
    { expectedLogin: options.expectedSessionLogin, privilegedLogins: options.privilegedLogins }
  )

  // TURN_FIRST_FRAME_SAMPLES is 1 and is a cost decision, not an oversight.
  // Read its comment before raising it: each extra sample is another short
  // model turn on every hourly tick.
  const turnSamples: Array<Sample> = []
  if (cookie !== undefined && identityCheck?.status === "pass") {
    for (let index = 0; index < TURN_FIRST_FRAME_SAMPLES; index += 1) {
      if (index > 0) await deps.sleep(options.gapMs)
      const taken = await meteredTurnSample(deps, options, cookie)
      turnSamples.push(taken)
      samples.push(taken)
    }
  }
  const meteredTurns = turnSamples.length

  const checks: Array<Check> = [uptimeVerdict(samples)]
  for (const endpoint of plan) {
    checks.push(
      latencyVerdict(
        `latency:${endpoint.label}`,
        `${endpoint.label} latency`,
        samples.filter((sample) => sample.label === endpoint.label),
        endpoint.budgetMs
      )
    )
  }
  if (identityCheck !== undefined) checks.push(identityCheck)
  checks.push(
    turnSamples.length === 0
      ? skip(
        "latency:turn-first-frame",
        "turn-seam first-frame latency",
        identityCheck === undefined
          ? "turn-seam first-frame latency: not measured — $CANARY_SESSION_COOKIE is unset, so this run measured the signed-out refusal gate only"
          : "turn-seam first-frame latency: not measured — the canary session is not a scoped-down user, so this run spent nothing under it"
      )
      : latencyVerdict(
        "latency:turn-first-frame",
        "turn-seam first-frame latency",
        turnSamples,
        LATENCY_BUDGETS_MS.turnFirstFrame,
        TURN_FIRST_FRAME_NOTE
      )
  )
  const rate = errorRateVerdict(samples, ERROR_RATE_THRESHOLD)
  checks.push(rate.check)

  return {
    origin: options.origin,
    generatedAt,
    samples,
    checks,
    errorRate: rate.rate,
    meteredTurns,
    failed: probeFailed(checks)
  }
}
