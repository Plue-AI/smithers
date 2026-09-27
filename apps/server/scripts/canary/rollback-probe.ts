/*
 * CN-24 — rollback readiness, probed against the real Cloudflare account.
 *
 *   bun scripts/canary/rollback-probe.ts [--receipt <path>]
 *
 * Asserts three things about smithers-mvp-web:
 *
 *   1. the newest deploy receipt names a wrangler version id,
 *   2. that version is the one Cloudflare is actually serving,
 *   3. a prior version is still in Cloudflare's version list, so
 *      `wrangler rollback <id>` has something to target.
 *
 * "Reachable" means rollback-ELIGIBLE, not fetchable. A prior Worker version
 * has no URL of its own; nothing can HTTP it. The probe says exactly what it
 * checked and never implies more.
 *
 * Read-only diagnostic. scripts/deploy.ts owns automatic rollback through
 * the shared rollout implementation and verifies its exact captured target.
 *
 * Where it runs: deploy receipts are gitignored and exist only on the machine
 * that deployed, so this belongs in the deploy workflow after a real deploy,
 * not in a scheduled canary that has no receipt to read.
 *
 * Environment:
 *   CLOUDFLARE_API_TOKEN   required; unset skips every check and exits 0
 *   CLOUDFLARE_ACCOUNT_ID  defaults to the account named in DEPLOY.md
 *   CANARY_RECEIPT_PATH    defaults to ../../deploy-receipts/latest.json
 */
import { readFileSync } from "node:fs"
import { argReader } from "./CanaryArgs.ts"
import {
  deployedVerdict,
  parseDeployedVersions,
  parseReceipt,
  parseVersionList,
  receiptVerdict,
  rollbackVerdict
} from "./rollback-verdict.ts"

const DEFAULT_ACCOUNT_ID = "dd3525a4132493566aeb38de533c8827"
const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4"

const argv = process.argv.slice(2)
/*
 * Exit 2, not 1: a flag left empty is a mistake in this invocation, not a
 * verdict about the deployment, and it is refused before the first fetch.
 */
const argOf = argReader(argv, (detail) => {
  console.error(`FAIL: ${detail}`)
  process.exit(2)
})

const receiptPath = argOf("--receipt") ?? process.env.CANARY_RECEIPT_PATH ??
  new URL("../../deploy-receipts/latest.json", import.meta.url).pathname
const worker = argOf("--worker") ?? "smithers-mvp-web"
const accountId = argOf("--account") ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID
const apiBase = argOf("--api-base") ?? process.env.CLOUDFLARE_API_BASE ?? DEFAULT_API_BASE
const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? ""

let failures = 0
let passed = 0
let skipped = 0
const check = (label: string, ok: boolean, detail: string): void => {
  if (ok) {
    passed += 1
    console.log(`ok: ${label} — ${detail}`)
  } else {
    failures += 1
    console.log(`FAIL: ${label} — ${detail}`)
  }
}
/* A skip is neither a pass nor a failure: it states what went unverified. */
const skip = (label: string, detail: string): void => {
  skipped += 1
  console.log(`skip: ${label} — ${detail}`)
}

/* Explicitly typed so TypeScript treats every call as terminating control flow. */
const finish: () => never = () => {
  if (failures > 0) {
    console.log(`\nCN-24 ROLLBACK PROBE FAILED: ${failures} check(s), ${passed} passed, ${skipped} skipped.`)
    process.exit(1)
  }
  /* A run that checked nothing is inconclusive, not a pass. It still exits 0:
	 * a receipt-less or uncredentialed run should not go red, but it must not
	 * report success. */
  if (passed === 0) {
    console.log(`\nCN-24 ROLLBACK PROBE INCONCLUSIVE: nothing was verified, ${skipped} skipped.`)
  } else {
    console.log(`\nCN-24 ROLLBACK PROBE PASS: ${passed} check(s), 0 failures, ${skipped} skipped.`)
  }
  process.exit(0)
}

const cloudflareGet = async (path: string): Promise<{ ok: true; body: unknown } | { ok: false; detail: string }> => {
  const target = `${apiBase.replace(/\/$/, "")}${path}`
  let response: Response
  try {
    response = await fetch(target, { headers: { authorization: `Bearer ${apiToken}` } })
  } catch (error) {
    return { ok: false, detail: `${target} is unreachable: ${error instanceof Error ? error.message : String(error)}` }
  }
  const text = await response.text()
  if (response.status === 401 || response.status === 403) {
    return { ok: false, detail: `HTTP ${response.status} — CLOUDFLARE_API_TOKEN cannot read ${worker}'s versions.` }
  }
  try {
    return { ok: true, body: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, detail: `HTTP ${response.status} and the body is not JSON: ${text.trim().slice(0, 200)}` }
  }
}

/* 1. The receipt. */
let receiptText: string
try {
  receiptText = readFileSync(receiptPath, "utf8")
} catch {
  skip(
    "the deploy receipt names a version",
    `no receipt at ${receiptPath}. Receipts are gitignored and only exist on the machine that deployed; pass --receipt or set $CANARY_RECEIPT_PATH`
  )
  skip("the receipt names the version serving traffic", "no receipt to read")
  skip("a previous version is still rollback-eligible", "no receipt to read")
  finish()
}

const receipt = parseReceipt(receiptText)
if (!receipt.ok) {
  check("the deploy receipt names a version", false, `${receiptPath}: ${receipt.detail}`)
  finish()
}

const named = receiptVerdict(receipt.value)
check("the deploy receipt names a version", named.ok, named.detail)
const deployedVersionId = receipt.value.wranglerVersionId

/* 2 and 3 need Cloudflare. */
if (apiToken === "") {
  skip("the receipt names the version serving traffic", "CLOUDFLARE_API_TOKEN is unset")
  skip("a previous version is still rollback-eligible", "CLOUDFLARE_API_TOKEN is unset")
  finish()
}

const deployments = await cloudflareGet(`/accounts/${accountId}/workers/scripts/${worker}/deployments`)
if (!deployments.ok) {
  check("the receipt names the version serving traffic", false, deployments.detail)
} else {
  const parsed = parseDeployedVersions(deployments.body)
  if (!parsed.ok) {
    check("the receipt names the version serving traffic", false, parsed.detail)
  } else if (deployedVersionId === null) {
    check(
      "the receipt names the version serving traffic",
      false,
      `the receipt names no version; Cloudflare is serving ${parsed.value.map((v) => v.id).join(", ")}`
    )
  } else {
    const verdict = deployedVerdict(parsed.value, deployedVersionId)
    check("the receipt names the version serving traffic", verdict.ok, verdict.detail)
  }
}

const versions = await cloudflareGet(`/accounts/${accountId}/workers/scripts/${worker}/versions`)
if (!versions.ok) {
  check("a previous version is still rollback-eligible", false, versions.detail)
} else {
  const parsed = parseVersionList(versions.body)
  if (!parsed.ok) {
    check("a previous version is still rollback-eligible", false, parsed.detail)
  } else {
    const verdict = rollbackVerdict(parsed.value, deployedVersionId)
    check("a previous version is still rollback-eligible", verdict.ok, verdict.detail)
  }
}

finish()
