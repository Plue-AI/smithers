/**
 * Scheduled, external Chromium check of the deployed product. No saved profile is used.
 *
 * `${dir}/result.json` always carries `status` (pass, skip or fail), which
 * apps/server/scripts/canary/uptime-checks.ts `browserVerdict` reads. An unset
 * cookie, flow or workspace is `skip` naming the variables and exits 0: a
 * missing canary secret is a configuration state, not an outage. A configured
 * cookie that is signed out, unnamed, someone else's or an admin's fails.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { chromium, type Browser, type Page } from "playwright"

// The session cookie belongs only to production.
const origin = "https://smithers.sh"
const repo = process.env.CANARY_BROWSER_REPO ?? "codeplanesmithers/canary-sandbox"
const flow = process.env.CANARY_BROWSER_FLOW
const workspaceId = process.env.CANARY_BROWSER_WORKSPACE
const login = process.env.CANARY_SESSION_LOGIN
const cookie = process.env.CANARY_SESSION_COOKIE
const dir = process.env.CANARY_BROWSER_EVIDENCE ?? "/tmp/smithers-browser-canary"
const results: Record<string, unknown> = { origin, repo, at: new Date().toISOString(), checks: [] as string[] }
const record = (label: string): void => { (results.checks as string[]).push(label) }
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
const boot = async (page: Page, path: string): Promise<void> => {
  await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "Chat", exact: true }).waitFor({ timeout: 120_000 })
}
const chatUsable = async (page: Page): Promise<void> => {
  const chat = page.getByRole("button", { name: "Chat", exact: true })
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await chat.click()
  await input.waitFor({ timeout: 15_000 })
  if (!await input.isEditable()) throw new Error("Chat input is not editable")
  await input.press("Escape")
}
const slash = async (page: Page, text: string): Promise<void> => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.getByRole("button", { name: "Chat", exact: true }).click()
  await input.fill(text)
  await input.press("Enter")
}

await mkdir(dir, { recursive: true })
const missing = Object.entries({
  CANARY_SESSION_COOKIE: cookie,
  CANARY_BROWSER_FLOW: flow,
  CANARY_BROWSER_WORKSPACE: workspaceId
}).filter(([, value]) => !value).map(([name]) => name)
if (missing.length > 0) {
  await writeFile(`${dir}/result.json`, JSON.stringify({ ...results, status: "skip", missing }, null, 2))
  console.log(`skip: browser canary not configured - set ${missing.join(", ")}`)
  process.exit(0)
}
let browser: Browser | undefined
let active: Page | undefined
let failure: unknown
try {
  requireValue(cookie && flow && workspaceId, "unreachable: the configuration gate above skips an unset cookie, flow or workspace")
  requireValue(login, "CANARY_SESSION_LOGIN must name the account CANARY_SESSION_COOKIE belongs to")
  requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(workspaceId), "CANARY_BROWSER_WORKSPACE must name the fixture workspace UUID")
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(repo), "CANARY_BROWSER_REPO must be owner/name")
  const pair = cookie.split(";")[0]!.trim().split(/=(.*)/s)
  requireValue(pair[0] && pair[1], "CANARY_SESSION_COOKIE must begin with name=value")
  browser = await chromium.launch({ headless: true })

  const fresh = await browser.newContext()
  active = await fresh.newPage()
  await boot(active, "/smithersai/smithers")
  await chatUsable(active)
  const signedOut = await active.evaluate(async () => (await fetch("/api/user")).status)
  if (signedOut !== 401) throw new Error("Fresh browser was unexpectedly signed in")
  record("fresh session boot and editable Chat")
  await active.screenshot({ path: `${dir}/fresh.png` })
  await fresh.close()

  const signed = await browser.newContext()
  await signed.addCookies([{ name: pair[0]!, value: pair[1]!, url: origin, httpOnly: true, secure: true }])
  active = await signed.newPage()
  await boot(active, `/${repo}`)
  await active.getByTestId("signup").waitFor({ state: "hidden", timeout: 120_000 })
  const session = await active.evaluate(async () => (await fetch("/api/user")).json()) as { login?: string; admin?: boolean }
  if (session.login !== login) throw new Error(`Expected signed-in session for ${login}`)
  if (session.admin !== false) throw new Error("Browser canary requires an ordinary non-admin session")
  record("signed-in browser session")
  await chatUsable(active)
  const [owner, name] = repo.split("/")
  const contents = await active.evaluate(async (path) => {
    const response = await fetch(path)
    return { status: response.status, body: await response.json().catch(() => null) }
  }, `/api/repos/${owner}/${name}/contents`)
  if (contents.status !== 200) throw new Error(`Repository browsing returned ${contents.status}`)
  record("repository root browse")

  await slash(active, `/repo.select ${repo}#workspace:${workspaceId}`)

  await slash(active, `/files.list / ${repo}`)
  await active.locator('.smithers-card[data-kind="file-list"]').first().waitFor({ timeout: 120_000 })
  await chatUsable(active)
  record("rendered Files browse and editable Chat")

  await slash(active, `/flow.list ${repo}`)
  await active.locator('.smithers-card[data-kind="workflow-list"]').first().waitFor({ timeout: 120_000 })
  await chatUsable(active)
  record("flow list and editable Chat")

  // Hold the actual launch response: the UI must remain usable while the server
  // request is unresolved, then a real remote run must reach terminal state.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held = false
  let launchTargetMatches = false
  await active.route("**/api/workflow/rpc", async (route) => {
    const body = route.request().postDataJSON() as { procedure?: string; repo?: string; workspaceId?: string }
    if (body?.procedure === "Run" && !held) {
      launchTargetMatches = body.repo === repo && body.workspaceId === workspaceId
      held = true
      await gate
    }
    await route.continue()
  })
  const accepted = active.waitForResponse((candidate) => {
    if (new URL(candidate.url()).pathname !== "/api/workflow/rpc") return false
    try { return (candidate.request().postDataJSON() as { procedure?: string }).procedure === "Run" }
    catch { return false }
  }, { timeout: 180_000 }).then((response) => ({ response }), (error: unknown) => ({ error }))
  try {
    await slash(active, `/flow.run ${flow} ${repo}`)
    const deadline = Date.now() + 30_000
    while (!held && Date.now() < deadline) await active.waitForTimeout(100)
    if (!held) throw new Error("The UI did not submit a Run request")
    if (!launchTargetMatches) throw new Error("Run request did not target the configured fixture workspace")
    record("fixture workspace selected")
    await chatUsable(active)
    record("Chat editable during held real launch")
  } finally {
    release()
  }
  const received = await accepted
  if ("error" in received) throw received.error
  const response = received.response
  const answer = await response.json() as { ok?: boolean; payload?: { runId?: string } }
  const runId = answer.payload?.runId
  requireValue(response.ok() && answer.ok && runId, "Real flow launch returned no accepted run id")
  results.runId = runId
  record("real run accepted")
  const runCard = active.locator(`.smithers-card[data-kind="run-trace"][data-run-id="${runId}"]`)
  await runCard.waitFor({ timeout: 120_000 })
  record("run receipt rendered in Chat")
  let terminal = ""
  let observedRunning = false
  for (let i = 0; i < 90; i++) {
    await chatUsable(active)
    const status = await active.evaluate(async ({ repo, workspaceId, runId }) => {
      const response = await fetch("/api/workflow/rpc", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, workspaceId, procedure: "Projection.Snapshot", payload: { selector: { _tag: "run-summary", runId } } })
      })
      const body = await response.json() as { payload?: { rows?: { status?: string }[] } }
      return body.payload?.rows?.[0]?.status ?? ""
    }, { repo, workspaceId, runId })
    if (status === "running") observedRunning = true
    if (/^(completed|failed|cancelled)$/.test(status)) { terminal = status; break }
    await active.waitForTimeout(2_000)
  }
  results.terminal = terminal
  results.observedRunning = observedRunning
  if (terminal !== "completed") throw new Error(`Real run ${runId} ended ${terminal || "without terminal receipt"}`)
  if (!observedRunning) throw new Error("Fixture completed before running-state Chat coverage; configure a longer safe flow")
  // RuntimeProjection maps a completed run to the card shell's acted status.
  await active.locator(`.smithers-card[data-kind="run-trace"][data-run-id="${runId}"][data-status="acted"]`).waitFor({ timeout: 30_000 })
  record("Chat usable through real remote completion")
} catch (error) {
  failure = error
  results.error = String(error)
} finally {
  if (active && !active.isClosed()) await active.screenshot({ path: `${dir}/last.png`, fullPage: true }).catch(() => undefined)
  await browser?.close()
  await writeFile(`${dir}/result.json`, JSON.stringify({ ...results, status: failure ? "fail" : "pass" }, null, 2))
}
if (failure) { console.error(`Browser canary failed: ${String(failure)}`); process.exit(1) }
console.log(`Browser canary passed: ${JSON.stringify(results)}`)