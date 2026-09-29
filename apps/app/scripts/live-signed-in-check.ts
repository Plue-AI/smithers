/*
 * Live signed-in check (Wave 10): drives the REAL OAuth flow on
 * https://canary.smithers.sh with the sanctioned persistent Playwright
 * profile (codeplanesmithers — see the multi-test-github-account skill),
 * then verifies the signed-in chat states wave 10 owns:
 *  - (retired with the watch subsystem, lane piper: the chooser bar)
 *    selection, the chat opens clean,
 *  - no standing composer status chrome (§2g),
 *  - zero console errors.
 * Screenshots archive under reports/live-checks/<timestamp>/.
 *
 * Usage: bun scripts/live-signed-in-check.ts [screenshots-dir]
 */
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright"
import { resetPersistedStore } from "./live-store-reset"

const PROFILE = process.env.MULTI_E2E_PROFILE ?? join(homedir(), ".multi-e2e-profile")
const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh"
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const dir = process.argv[2] ?? `reports/live-checks/${timestamp}-signed-in`
mkdirSync(dir, { recursive: true })

const failures: Array<string> = []
const check = (label: string, ok: boolean, detail: string): void => {
  if (ok) console.log(`ok: ${label} — ${detail}`)
  else {
    console.error(`FAIL: ${label} — ${detail}`)
    failures.push(label)
  }
}

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1280, height: 900 }
})
const page = context.pages()[0] ?? (await context.newPage())
const consoleErrors: Array<string> = []
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text())
})
page.on("pageerror", (error) => consoleErrors.push(String(error)))

// Start signed-out (the profile holds github.com cookies, not ours): the
// chat's opening message carries the sign-in act.
await page.goto(BASE, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(3000)

const sessionProbe = await page.evaluate(async () => {
  const response = await fetch("/api/user")
  return { status: response.status, body: await response.json().catch(() => null) }
})
check("the session probe answers", sessionProbe.status === 200, JSON.stringify(sessionProbe.body))

const signedIn = typeof sessionProbe.body === "object" &&
  sessionProbe.body !== null &&
  "login" in sessionProbe.body &&
  typeof (sessionProbe.body as { login?: unknown }).login === "string"

if (!signedIn) {
  // Drive the real OAuth: the sign-in action rides the opening message.
  const signIn = page.locator("[data-flow=\"auth.sign-in\"]").first()
  await signIn.click()
  await page.waitForURL(/canary\.smithers\.sh|github\.com/, { timeout: 30_000 })
  // GitHub may ask to authorize the OAuth app once; approve if it does.
  const authorize = page.locator("button:has-text(\"Authorize\")")
  if (await authorize.isVisible().catch(() => false)) await authorize.click()
  await page.waitForURL(/canary\.smithers\.sh/, { timeout: 30_000 })
  await page.waitForTimeout(4000)
  const after = await page.evaluate(async () => {
    const response = await fetch("/api/user")
    return response.json().catch(() => null)
  })
  check(
    "the OAuth round trip signed the session in",
    typeof after === "object" && after !== null && typeof (after as { login?: unknown }).login === "string",
    JSON.stringify(after)
  )
}

/*
 * These bars are about what a signed-in FIRST LOAD renders, and the sanctioned
 * profile persists the app's store between runs: an earlier run's cards
 * sat in the transcript and failed bars about THIS load for a product that
 * had done nothing wrong. Start from a genuinely clean slate (the
 * session cookie survives) so a failure here means the product, not history.
 */
const survivors = await resetPersistedStore(context, page, BASE)
check(
  "the persisted store is cleared, so these bars are about THIS load",
  survivors.length === 0,
  survivors.length === 0 ? "localStorage + OPFS empty" : `OPFS still holds: ${survivors.join(", ")}`
)
await page.waitForTimeout(3000)

// §2g: no standing status chrome; §2: no admin affordances for this non-admin.
const bodyText = (await page.locator("body").textContent()) ?? ""
check("no standing composer status line (§2g)", !bodyText.includes("Smithers Cloud · live"), "calm composer")
check("no devtools panel (§2b)", (await page.locator(".devtools-panel").count()) === 0, "absent")
// §2f: no slop pills — any pill present is the one derived binding.
const pillTexts = await page.locator(".smithers-suggestion").allTextContents()
check(
  "pill row holds at most the one derived binding (§2f)",
  pillTexts.length <= 1 && !pillTexts.some((text) => /work queue|Plan my day|connect GitHub/i.test(text)),
  JSON.stringify(pillTexts)
)

await page.screenshot({ path: `${dir}/signed-in-chat.png`, fullPage: true })
check(
  "zero console errors on the signed-in chat",
  consoleErrors.length === 0,
  consoleErrors.length === 0 ? "console is clean" : consoleErrors.join(" | ").slice(0, 400)
)

await context.close()
if (failures.length > 0) {
  console.error(`SIGNED-IN LIVE CHECK FAIL: ${failures.length} failure(s) — screenshots in ${dir}`)
  process.exit(1)
}
console.log(`SIGNED-IN LIVE CHECK PASS: screenshots in ${dir}`)
process.exit(0)