/*
 * CN-1: the deployed bundle is the git sha the deploy receipt claims.
 *
 *   bun scripts/canary/build-probe.ts [origin] [--sha <sha>] [--receipt <path>]
 *                                     [--max-drift <n>] [--json <path>]
 *                                     [--allow-unstamped-html]
 *                                     [--settle-ms <n>] [--settle-interval-ms <n>]
 *
 * Reads the build stamp the deployment carries (the site build writes it,
 * apps/site/scripts/build-stamp-integration.ts over apps/app/scripts/build-stamp.ts)
 * and compares it with the sha the caller expects. No credential is needed:
 * the stamp is a static asset on a public deployment.
 *
 * Expected sha resolution, first hit wins: --sha, $CANARY_EXPECTED_SHA,
 * --receipt <path>, then ../../deploy-receipts/latest.json when it exists.
 * Receipts are gitignored, so a scheduled run usually resolves none; that
 * check then prints as skipped, never as a pass.
 *
 * PROPAGATION. A Worker version reaches every edge seconds after
 * `wrangler deploy` returns, so this reads the deployment until it agrees or
 * `--settle-ms` (default 90 s, $CANARY_SETTLE_MS) passes, rather than judging
 * on the first read. A match on the first read costs one round trip and no
 * wait. A disagreement that outlives the window fails exactly as it always
 * did, and the failure says how long it waited and what it saw. Pass
 * `--settle-ms 0` for the old single-read behaviour. BuildPropagation.ts
 * carries the reasoning and the loop.
 *
 * The HTML-vs-asset row compares the served app document (the prerendered
 * /<owner>/<name>/ page, the one HTML in the build that carries the stamp) with
 * the served /__build.json and fails either direction of disagreement,
 * including HTML that carries no stamp at all. It does not fetch the hashed
 * chunks the document names. Pass --allow-unstamped-html only while the deploy that introduces the
 * stamp is landing; it downgrades that row to a skip and never to a pass.
 *
 * This file is the process shell only. Every verdict lives in BuildStamp.ts
 * and the waiting in BuildPropagation.ts, both unit-tested; the real fetch,
 * the real clock and the exit code are the untested lines.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  awaitDeployment,
  describeRead,
  describeWait,
  SETTLE_INTERVAL_MS,
  SETTLE_MS
} from "./BuildPropagation.ts"
import {
  BUILD_STAMP_PATH,
  buildShaVerdict,
  expectedShaFromReceipt,
  hasFlag,
  HTML_AGREEMENT_COVERAGE,
  htmlAgreementVerdict,
  resolveOrigin
} from "./BuildStamp.ts"
import type { BuildStamp } from "./BuildStamp.ts"
import { argReader } from "./CanaryArgs.ts"
import { DEFAULT_APP_DOCUMENT_PATH } from "../../src/appDocument.ts"

const argv = process.argv.slice(2)
/*
 * Exit 2, not 1: a flag the operator left empty is a mistake in this
 * invocation, and it must never be read as a verdict about the deployment.
 */
const flag = argReader(argv, (detail) => {
  console.error(`FAIL: ${detail}`)
  process.exit(2)
})
/*
 * The escape hatch for the single deploy that introduces the stamp, and for
 * nothing else. It downgrades unstamped HTML from a failure to a skip; it
 * cannot turn any comparison into a pass.
 */
const allowUnstampedHtml = hasFlag(argv, "--allow-unstamped-html")
const origin = resolveOrigin(argv, { CANARY_URL: process.env.CANARY_URL })
/** A count of something, refused before any fetch when it is not one. Exit 2 for the same reason as above. */
const count = (name: string, raw: string | undefined, unit: string): number | undefined => {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) {
    console.error(`FAIL: ${name} takes ${unit}, not "${raw}".`)
    process.exit(2)
  }
  return Number.parseInt(raw, 10)
}
const maxDrift = count("--max-drift", flag("--max-drift"), "a commit count")
const settleMs = count("--settle-ms", flag("--settle-ms"), "milliseconds") ??
  count("$CANARY_SETTLE_MS", process.env.CANARY_SETTLE_MS, "milliseconds") ?? SETTLE_MS
const intervalMs = count("--settle-interval-ms", flag("--settle-interval-ms"), "milliseconds") ?? SETTLE_INTERVAL_MS
const jsonPath = flag("--json")
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url))

let failures = 0
const checks: Array<{ label: string; status: "ok" | "FAIL" | "skip"; detail: string }> = []
const record = (label: string, status: "ok" | "FAIL" | "skip", detail: string): void => {
  if (status === "FAIL") failures += 1
  console.log(`${status}: ${label} — ${detail}`)
  checks.push({ label, status, detail })
}
const check = (label: string, ok: boolean, detail: string): void => record(label, ok ? "ok" : "FAIL", detail)
const skip = (label: string, detail: string): void => record(label, "skip", detail)

/*
 * 1. The expected sha, if anything states one. It is resolved before the first
 * fetch because it is what the probe waits for: with no expectation there is
 * nothing propagation can settle into, and the loop only waits for the rows it
 * could still change.
 */
const receiptPath = flag("--receipt") ??
  fileURLToPath(new URL("../../deploy-receipts/latest.json", import.meta.url))
let expectedSha = flag("--sha") ?? process.env.CANARY_EXPECTED_SHA
let receiptNote = expectedSha === undefined ? "" : "from --sha/$CANARY_EXPECTED_SHA"
if (expectedSha === undefined) {
  if (existsSync(receiptPath)) {
    const claim = expectedShaFromReceipt(readFileSync(receiptPath, "utf8"))
    if (claim.kind === "sha") {
      expectedSha = claim.gitSha
      receiptNote = `from ${receiptPath}${claim.gitDirty ? " (built from a dirty tree)" : ""}`
    } else {
      receiptNote = claim.reason
    }
  } else {
    receiptNote = `no deploy receipt at ${receiptPath}`
  }
}

/*
 * 2. Read the deployment until it agrees or the window closes. The stamp and
 * the app document are read together on every pass: mid-rollout they can come
 * from different versions, and that disagreement is a propagation symptom
 * before it is a verdict.
 */
const settle = await awaitDeployment({ fetch, now: Date.now, sleep: Bun.sleep, abortAfter: AbortSignal.timeout }, {
  origin,
  documentPath: DEFAULT_APP_DOCUMENT_PATH,
  expectedSha,
  allowUnstampedHtml,
  settleMs,
  intervalMs
})
const waited = describeWait(settle)
/** What the window did, for the machine-readable report: a run that waited must be able to say so afterwards. */
const report = () => ({ settleMs, intervalMs, reads: settle.reads, waitedMs: settle.waitedMs, settled: settle.settled })
if (settle.reads > 1) {
  console.log(
    settle.settled
      ? `note: ${origin} settled ${waited} (propagation window ${settleMs} ms).`
      : `note: the ${settleMs} ms propagation window closed ${waited}, and ${origin} still disagreed on every one.`
  )
}

// 3. The deployment states what it is.
const parsed = settle.read.stamp
check(
  "the deployment carries a build stamp",
  typeof parsed !== "string",
  typeof parsed === "string" ? parsed : `${BUILD_STAMP_PATH} names ${parsed.gitSha}`
)

if (typeof parsed === "string") {
  console.log(
    `\nCN-1 FAILED: ${failures} check(s). The deployment cannot state which commit it is (${waited}).`
  )
  if (jsonPath !== undefined) {
    writeFileSync(
      jsonPath,
      `${JSON.stringify({ origin, stamp: null, settle: report(), checks }, null, "\t")}\n`
    )
  }
  process.exit(1)
}
const stamp: BuildStamp = parsed

/*
 * 4. Drift. `git rev-list --count <sha>..origin/main` is the only honest
 * measure of how far behind a deployment is, and it needs a checkout that has
 * both commits. A shallow clone or an unfetched origin cannot answer, and that
 * is reported rather than guessed. It is not part of the propagation window:
 * it measures whether anyone ran the deploy, which no wait can change.
 */
let commitsBehind: number | undefined
let driftNote = "not requested (--max-drift)"
if (maxDrift !== undefined) {
  const proc = Bun.spawn(["git", "rev-list", "--count", `${stamp.gitSha}..origin/main`], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe"
  })
  const out = (await new Response(proc.stdout).text()).trim()
  const exitCode = await proc.exited
  if (exitCode === 0 && /^\d+$/.test(out)) {
    commitsBehind = Number.parseInt(out, 10)
  } else {
    driftNote = `git could not measure drift from ${stamp.gitSha} to origin/main in ${repoRoot} (exit ${exitCode})`
  }
}

/*
 * The stamp parsed, so the build that emitted it also stamped its own app
 * document. Unstamped HTML from here on is evidence of a half-published
 * deploy, not of an unverifiable input, and it is graded as one.
 */
const agreement = htmlAgreementVerdict(stamp, settle.read.html, allowUnstampedHtml)
record("the served HTML and the build stamp are from the same build", agreement.status, agreement.detail)
console.log(`note: that check ${HTML_AGREEMENT_COVERAGE}.`)

/*
 * Each of the last two checks makes exactly one claim, so a failing line names
 * the thing that is wrong. Both are skipped rather than passed when the input
 * they need is absent: a probe that reports "ok" for a comparison it never made
 * is the failure mode CN-1 exists to end.
 */
if (expectedSha === undefined) {
  skip("the deployed sha matches the expected sha", receiptNote)
} else {
  /*
   * metaSha is not passed: the HTML/asset comparison has its own row above, and
   * this line claims only that the served sha is the expected one. Reporting a
   * disagreement twice under two labels hides which one is broken.
   */
  const verdict = buildShaVerdict(stamp, expectedSha, null, undefined, 0)
  check(
    "the deployed sha matches the expected sha",
    verdict.ok,
    `${verdict.detail} (${receiptNote}${verdict.ok ? "" : `, still wrong ${waited}`})`
  )
}

if (maxDrift === undefined || commitsBehind === undefined) {
  skip("the deployment is within the drift budget of origin/main", driftNote)
} else {
  const verdict = buildShaVerdict(stamp, undefined, null, commitsBehind, maxDrift)
  check("the deployment is within the drift budget of origin/main", verdict.ok, verdict.detail)
}

if (jsonPath !== undefined) {
  writeFileSync(
    jsonPath,
    `${
      JSON.stringify(
        {
          origin,
          stamp,
          expectedSha: expectedSha ?? null,
          metaSha: settle.read.html.metaSha,
          htmlAgreementCoverage: HTML_AGREEMENT_COVERAGE,
          commitsBehind: commitsBehind ?? null,
          settle: report(),
          checks
        },
        null,
        "\t"
      )
    }\n`
  )
}

if (failures > 0) {
  console.log(
    `\nCN-1 FAILED: ${failures} check(s). ${origin} is not serving the commit it is supposed to (${waited}: ${
      describeRead(settle.read)
    }).`
  )
  process.exit(1)
}
/*
 * A pass line names the rows that were never graded. A skipped row is not a
 * verified one, and CN-1 exists because a green summary that hides an ungraded
 * comparison is how a stale deployment stayed invisible for thirteen commits.
 */
const skipped = checks.filter((entry) => entry.status === "skip")
console.log(
  `\nCN-1 PASS: ${origin} serves ${stamp.gitSha}, built ${stamp.builtAt}${
    settle.reads === 1 ? "" : ` (${waited})`
  }${
    skipped.length === 0
      ? ""
      : ` (${skipped.length} check(s) not graded: ${skipped.map((entry) => entry.label).join("; ")})`
  }.`
)
