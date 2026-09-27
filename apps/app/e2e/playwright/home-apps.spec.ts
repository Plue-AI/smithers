import { expect, test, type Page } from "./browserTest"
import { installCloudFixture, runningBox } from "./cloudFixture"
import { signedOutVisitor } from "./identity"

/*
 * The app home (PRODUCT.md D-18): one question, the composer, and the apps
 * the repository's homepage declares. Opening an app renders its flow's form
 * (one input, one button); the run card follows, the launch is acknowledged
 * at once, and the shared toast settles only with the real run — through an
 * unresolved launch, a refusal and a duplicate launch, with Chat usable
 * throughout. Signed out, the tiles show and opening one asks to sign in.
 */

const repo = "smithersai/smithers"
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
const home = {
  kind: "blocks",
  blocks: [
    { type: "prompt", title: "What should we work on?", placeholder: "Ask Smithers…" },
    { type: "app", flow: "issue.implement", title: "Fix an issue", picture: "issue" },
    { type: "app", flow: "prs.triage", title: "Review a PR", picture: "review" },
    { type: "app", flow: "wiki.ask", title: "Ask the codebase", picture: "wiki" },
    { type: "app", flow: "triggers.register", title: "Run it every night", picture: "schedule" }
  ]
}
const landing = { number: 70, title: "Make the help link visible", state: "open", body: "The footer link is hard to find.", author: { login: "ada" }, updated_at: "2026-09-26T00:00:00Z", change_ids: ["kchange"] }

/** The homepage, the open issues and pull requests the pickers read, and nothing invented. */
const installHome = async (page: Page) => {
  await page.route(url => url.pathname === `/api/repos/${repo}/home`, route => route.fulfill({ json: home }))
  await page.route(url => url.pathname === `/api/repos/${repo}/issues`, route => route.fulfill({ json: [
    { number: 42, title: "Footer help link is hard to find", state: "open", author: { login: "ada" }, updated_at: "2026-09-26T00:00:00Z", labels: [] }
  ] }))
  await page.route(url => url.pathname === `/api/repos/${repo}/landings`, route => route.fulfill({ json: [landing] }))
  await page.route(url => url.pathname === `/api/repos/${repo}/landings/70`, route => route.fulfill({ json: landing }))
}

/** Chat from anywhere: the chord the home's composer names. */
const openChat = async (page: Page) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await expect(input).toBeVisible()
  return input
}

/** Open the Review a PR app and review #70: the tile, the picker, the one button. */
const reviewSeventy = async (page: Page) => {
  await page.getByTestId("app-tile").filter({ hasText: "Review a PR" }).click()
  const form = page.locator('form.flow-form[data-flow-name="prs.triage"]')
  await expect(form).toBeVisible()
  await expect(form.locator("label")).toHaveCount(1)
  await expect(form.getByTestId("flow-form-number")).toBeVisible()
  await expect(form.locator('datalist option[value="70"]')).toHaveCount(1)
  await form.getByTestId("flow-form-number").fill("70")
  await expect(form.getByTestId("flow-form-submit")).toHaveText("Review")
  await form.getByTestId("flow-form-submit").click()
}

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

test("the home is the question, the composer and the apps; opening one gives one input and one button, then the run card, and the toast follows the real run", async ({ page }) => {
  const preparation = gate(), launch = gate()
  let ready = false, complete = false
  const calls: Array<{ procedure: string; payload: { input?: { args?: string } } }> = []
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat"], workspaces: [runningBox("smithersai/smithers")] })
  await installHome(page)
  await page.route("**/api/workflow/provision", async route => {
    await preparation.promise
    await route.fulfill({ status: ready ? 200 : 503, headers: { "Retry-After": "0" }, json: ready ? { status: "ready" } : { code: "workspace_starting", message: "Waking up" } })
  })
  await page.route("**/api/workflow/rpc", async route => {
    const call = route.request().postDataJSON()
    calls.push(call)
    let payload: unknown = {}
    if (call.procedure === "Plan") payload = { planId: "plan-home", digest: "digest", envelope: { capabilities: [], flows: [], budget: {} } }
    if (call.procedure === "Run") { await launch.promise; payload = { runId: "home-run" } }
    if (call.procedure === "Projection.Snapshot") payload = { rows: call.payload.selector._tag === "run-summary" ? [{
      runId: "home-run", flowId: "pr-triage", status: complete ? "completed" : "running", createdAt: 1, updatedAt: complete ? 3 : 2,
      turns: 1, calls: 1, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 1, outputTokens: 1, verdict: complete ? "Approve · 2 notes" : "Running", diagnosis: "Recorded status"
    }] : [] }
    await route.fulfill({ json: { ok: true, payload } })
  })
  await page.goto("/")
  const tiles = page.getByTestId("app-tile")
  await expect(tiles).toHaveCount(4)
  await expect(page.getByRole("heading", { level: 1, name: "What should we work on?" })).toBeVisible()
  // The tile's name is its title; the picture is a drawing (aria-hidden), not words.
  await expect(page.getByRole("button", { name: "Fix an issue", exact: true })).toBeVisible()
  await expect(tiles.nth(0).locator(".app-tile-title")).toHaveText("Fix an issue")
  await expect(tiles.nth(3).locator(".app-tile-title")).toHaveText("Run it every night")
  // Four across at full width, one row.
  expect(new Set(await tiles.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)))).size).toBe(1)
  await expect(page.getByPlaceholder("Ask Smithers…")).toBeVisible()
  // The home replaces the setup checklist, the recommended jobs and the host diagnostic.
  await expect(page.getByTestId("setup-checklist")).toHaveCount(0)
  await expect(page.getByTestId("first-run-actions")).toHaveCount(0)
  await expect(page.getByText("Smithers initialized successfully")).toHaveCount(0)
  // The home alone carries no chat controls strip: no Chat button, no Filter, no Mode, and no tip over them. ⌘K still summons Chat.
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Mode: Normal", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Filter" })).toHaveCount(0)
  await expect(page.getByRole("note", { name: "Help" })).toHaveCount(0)
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await page.keyboard.press("Escape")
  // Words on the home: the question, the placeholder and the four names, the pictures aside.
  const words = await page.locator(".factory-home").evaluate(node => [...node.querySelectorAll("h1, .app-tile-title")].map(each => each.textContent).join(" ").split(/\s+/).length)
  expect(words).toBeLessThanOrEqual(20)
  if (process.env.SMITHERS_HOME_CAPTURE) {
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: process.env.SMITHERS_HOME_CAPTURE })
  }
  // Run it every night: one input, the flow, and one button, Schedule.
  await page.getByTestId("app-tile").filter({ hasText: "Run it every night" }).click()
  const nightly = page.locator('form.flow-form[data-flow-name="triggers.register"]')
  await expect(nightly).toBeVisible()
  await expect(nightly.locator("label")).toHaveCount(1)
  await expect(nightly.getByTestId("flow-form-flow")).toBeVisible()
  await expect(nightly.getByTestId("flow-form-submit")).toHaveText("Schedule")
  await nightly.getByTestId("flow-form-cancel").click()
  // Keyboard-only: Tab reaches a tile and Enter opens it.
  await page.getByTestId("app-tile").filter({ hasText: "Fix an issue" }).focus()
  await page.keyboard.press("Enter")
  const fix = page.locator('form.flow-form[data-flow-name="issue.implement"]')
  await expect(fix).toBeVisible()
  await expect(fix.locator("label")).toHaveCount(1)
  await expect(fix.getByTestId("flow-form-submit")).toHaveText("Fix")
  await expect(fix.locator('datalist option[value="42"]')).toHaveCount(1)
  await fix.getByTestId("flow-form-cancel").click()

  await reviewSeventy(page)
  const card = page.locator('[data-kind="run-trace"]')
  await expect(card).toContainText("Requested")
  const toast = page.locator('[data-toast-status="running"]').filter({ hasText: "pr-triage" })
  await expect(toast).toBeVisible()
  // A conversation exists now: the chat controls are back.
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  // Chat stays usable while the launch is unresolved.
  const input = await openChat(page)
  await input.fill("Chat stays usable")
  await expect(input).toBeEditable()
  await expect(input).toHaveValue("Chat stays usable")
  await input.press("Escape")
  expect(calls.filter(call => call.procedure === "Run")).toHaveLength(0)
  // A second Review of the same pull request joins the request already in flight.
  await reviewSeventy(page)
  await expect(card).toHaveCount(1)
  preparation.release()
  ready = true
  await expect.poll(() => calls.filter(call => call.procedure === "Run").length).toBe(1)
  await expect(card).toContainText("Requested")
  await expect(toast).toBeVisible()
  launch.release()
  await expect(card).toHaveAttribute("data-run-id", "home-run")
  // The flow's context is the pull request as data, never its words as instructions.
  const plan = calls.find(call => call.procedure === "Plan")
  expect(JSON.parse(plan?.payload.input?.args ?? "{}")).toMatchObject({ kind: "pr", number: 70, title: "Make the help link visible" })
  await reviewSeventy(page)
  await expect(card).toHaveCount(1)
  expect(calls.filter(call => call.procedure === "Run")).toHaveLength(1)
  // The tile now wears the last result, live.
  await expect(page.getByTestId("app-tile").filter({ hasText: "Review a PR" }).getByTestId("app-tile-preview")).toBeVisible()
  complete = true
  const completed = page.locator('[data-toast-status="ok"]').filter({ hasText: "pr-triage" })
  await expect(completed).toBeVisible({ timeout: 15_000 })
  await expect(completed.locator(".toast-title")).toContainText(/\bDone\b/)
  await expect(card.getByText("Finished.", { exact: true })).toBeVisible()
})

test("a refused launch stays visible on the run card and the toast, and the home stays usable", async ({ page }) => {
  const refusal = gate()
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat"], workspaces: [runningBox("smithersai/smithers")] })
  await installHome(page)
  await page.route("**/api/workflow/provision", route => route.fulfill({ json: { status: "ready" } }))
  await page.route("**/api/workflow/rpc", async route => {
    const call = route.request().postDataJSON()
    if (call.procedure === "Plan") {
      await refusal.promise
      return route.fulfill({ json: { ok: false, error: { message: "Provider unavailable", detail: { code: "provider_unavailable" } } } })
    }
    return route.fulfill({ json: { ok: true, payload: { rows: [] } } })
  })
  await page.goto("/")
  await expect(page.getByTestId("app-tile")).toHaveCount(4)
  await reviewSeventy(page)
  await expect(page.locator('[data-toast-status="running"]').filter({ hasText: "pr-triage" })).toBeVisible()
  refusal.release()
  await expect(page.locator('[data-toast-status="failed"]').filter({ hasText: "pr-triage" })).toBeVisible()
  await expect(page.locator('[data-kind="run-trace"]').getByRole("alert")).toHaveText("Provider unavailable")
  await expect(page.getByTestId("app-tile")).toHaveCount(4)
  const input = await openChat(page)
  await expect(input).toBeEditable()
})

test("signed out, the tiles show and opening one asks to sign in", async ({ page }) => {
  await signedOutVisitor(page)
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [
    { name: repo, title: "Smithers", url: `https://github.com/${repo}`, summary: "Smithers.", stats: null }
  ] } }))
  await page.route(url => url.pathname === `/api/repos/${repo}/home`, route => route.fulfill({ json: home }))
  await page.goto(`/${repo}/`)
  const tiles = page.getByTestId("app-tile")
  await expect(tiles).toHaveCount(4)
  await tiles.filter({ hasText: "Fix an issue" }).click()
  const prompt = page.getByRole("article").filter({ has: page.getByRole("button", { name: "Sign in with GitHub", exact: true }) }).last()
  await expect(prompt).toBeVisible()
  await expect(page.locator('form.flow-form[data-flow-name="issue.implement"]')).toHaveCount(0)
})
