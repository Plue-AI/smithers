/*
 * The canary uptime probe (CN-19, CN-20, CN-21).
 *
 *   bun scripts/canary/uptime-probe.ts [origin] [options]
 *
 *     --json <path>       write the machine-readable report (uptime-report.ts reads it)
 *     --samples <n>       samples per unmetered endpoint (default 5)
 *     --gap-ms <n>        milliseconds between samples (default 250)
 *     --timeout-ms <n>    per-request ceiling (default 20000)
 *     --no-turn           never take the metered turn, even with a cookie set
 *
 *   $CANARY_URL             the origin, when no POSITIONAL origin is given.
 *                           The origin is argv[0] and nothing else, so a
 *                           flag's value can never become the target.
 *   $CANARY_SESSION_COOKIE  a signed-in cookie header for the SCOPED-DOWN test
 *                           account. Present: the run reads the session back,
 *                           and only if that account is a plain visitor does it
 *                           take ONE metered turn and measure CN-19's real bar.
 *                           Absent: the run measures the signed-out refusal
 *                           gate and says so, and never claims otherwise.
 *   $CANARY_SESSION_LOGIN   the login that cookie must belong to. Falls back to
 *                           $SMITHERS_E2E_USER, the scoped e2e account. Unset,
 *                           and with a deployment that states no `admin` field,
 *                           the identity check fails rather than guess.
 *
 * WHOSE ACCOUNT. Will's ruling (Factory spec 2026-09-08, RULINGS 35): the
 * canary and e2e suites run as a scoped-down signed-in user, never an admin, so a
 * permission bug that refuses ordinary visitors cannot hide behind the
 * operator's own privileges. The accounts and variables
 * are documented in apps/server/DEPLOY.md.
 *
 * WHAT THIS RUN COSTS. Without the cookie: nothing. Every request is a static
 * asset read, an unauthenticated scopes read, or a refusal that never reaches
 * an upstream. With the cookie: exactly one short model turn — a nine-word
 * prompt, a two-word instruction, and the stream cancelled at the first frame.
 * The scheduled workflow supplies the cookie on the hourly tick only, so the
 * standing cost is 24 short turns a day.
 *
 * This file is the process shell only: argument parsing, the real fetch,
 * printing and the exit code. Every decision it prints comes from
 * uptime-checks.ts, which is covered by uptime-checks.test.ts. The fetch is
 * the one line in this lane that no test can reach.
 */
import { writeFileSync } from "node:fs"
import { argReader } from "./CanaryArgs.ts"
import {
  type Check,
  REQUEST_TIMEOUT_MS,
  resolveProbeOrigin,
  runUptimeProbe,
  SAMPLE_GAP_MS,
  SAMPLES_PER_ENDPOINT,
  tallyChecks
} from "./uptime-checks.ts"

const args = process.argv.slice(2)
/*
 * Exit 2, not 1. Exit 1 means "the canary failed", which a caller may read as
 * a statement about the deployment. A flag left empty is a statement about
 * this invocation, and it must never be mistaken for a verdict. The refusal
 * happens before the first fetch and before the report is written.
 *
 * Explicitly typed so TypeScript treats every call as terminating control flow.
 */
const refuseInvocation: (detail: string) => never = (detail) => {
  console.error(`FAIL: ${detail}`)
  process.exit(2)
}
const flagValue = argReader(args, refuseInvocation)
const positive = (name: string, fallback: number): number => {
  const raw = flagValue(name)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) refuseInvocation(`${name} must be a positive number, got ${raw}`)
  return parsed
}

/* A misconfigured target is refused the same way, and for the same reason. */
const resolved = resolveProbeOrigin(args, { CANARY_URL: process.env.CANARY_URL })
if ("error" in resolved) refuseInvocation(resolved.error)
const origin = resolved.origin
const cookie = args.includes("--no-turn") ? undefined : process.env.CANARY_SESSION_COOKIE
const expectedSessionLogin = (process.env.CANARY_SESSION_LOGIN ?? process.env.SMITHERS_E2E_USER)?.trim()

const report = await runUptimeProbe(
  {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  },
  {
    origin,
    samplesPerEndpoint: positive("--samples", SAMPLES_PER_ENDPOINT),
    gapMs: positive("--gap-ms", SAMPLE_GAP_MS),
    requestTimeoutMs: positive("--timeout-ms", REQUEST_TIMEOUT_MS),
    sessionCookie: cookie === "" ? undefined : cookie,
    expectedSessionLogin: expectedSessionLogin === "" ? undefined : expectedSessionLogin,
    runId: `canary-uptime-probe-${Date.now()}`
  }
)

// The same three prefixes apps/app/scripts/canary-seam-probe.ts prints, so a
// human reading two canary logs side by side reads one format.
const print = (check: Check): void => {
  const prefix = check.status === "pass" ? "ok" : check.status === "fail" ? "FAIL" : "skip"
  console.log(`${prefix}: ${check.label} — ${check.detail}`)
}
for (const check of report.checks) print(check)

const jsonPath = flagValue("--json")
if (jsonPath !== undefined) {
  writeFileSync(jsonPath, `${JSON.stringify(report, null, "\t")}\n`)
  console.log(`report: ${jsonPath}`)
}

const tally = tallyChecks(report.checks)
const summary =
  `${tally.passed} passed, ${tally.failed} failed, ${tally.skipped} not measured; ${report.meteredTurns} metered turn(s) spent`
if (report.failed) {
  console.log(`\nCANARY UPTIME PROBE FAILED against ${origin}: ${summary}.`)
  process.exit(1)
}
console.log(`\nCANARY UPTIME PROBE PASS against ${origin}: ${summary}.`)
