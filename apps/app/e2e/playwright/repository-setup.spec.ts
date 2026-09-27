import { controlTabKey, expect, test, type Page } from "./browserTest"
import type { SetupHostInput, SetupOperationResponseSchema } from "@smthrs/rpc/RepositorySetup"
import type { z } from "zod"
import { SCOPED_TEST_USER, skipSignup, identityRoute } from "./identity"
import { settleAnimations } from "./animations"

// Real built app, SQLite, registry and keyboard. Setup/Control responses are
// explicit fixtures: these tests do not claim a host executed repository work.
const repo = "smithersai/smithers"
const workspaceId = "de29f26b-e593-4ec2-99fc-583d4711f20a"
type Response = z.infer<typeof SetupOperationResponseSchema>
type Start = Omit<SetupHostInput, "operation">
const bootstrap = async (page: Page, signedIn: boolean) => {
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["agent", "identity", "cloud"], authFlow: "native-handoff", sandbox: null
  } }))
  await page.route("**/api/user", identityRoute(signedIn ? SCOPED_TEST_USER.login : null))
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: repo }] } }))
  await page.route("**/api/user/repos", route => route.fulfill({ json: [{ owner: "smithersai", name: "smithers", full_name: repo, owner_type: "Organization", default_bookmark: "main" }] }))
  await page.route(`**/api/repos/${repo}/contents`, route => route.fulfill({ json: [] }))
  await page.route(url => url.pathname === "/api/repository-setup/state", route => route.fulfill({ json: {
    owner: SCOPED_TEST_USER.login, repo, job: new URL(route.request().url()).searchParams.get("job"),
    registration: { state: "known" }, setup: { state: "none" }
  } }))
}
const open = async (page: Page, signedIn = false) => {
  await page.goto(`/${repo}/`)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  if (signedIn) await skipSignup(page)
}
const keyboardClick = async (page: Page, name: string) => {
  const button = page.getByRole("button", { name, exact: true })
  await expect(button).toBeEnabled()
  await button.focus()
  await expect(button).toBeFocused()
  await page.keyboard.press("Enter")
}
const response = (body: Start, operation: SetupHostInput["operation"], phase: "queued" | "running" | "waiting" | "completed" = "completed"): Response => ({
  requestId: body.requestId, revision: body.revision, digest: body.digest, workspaceId,
  receipt: {
    requestId: body.requestId, revision: body.revision, digest: body.digest, operation, phase,
    ...(phase === "queued" ? {} : { runId: `fixture-${operation}-${body.requestId}` }), updatedAt: Date.now(),
    results: operation === "evaluate" ? body.draft.cases.map(item => ({ caseId: item.id, status: "passed", observed: "Explicit UI fixture result", evidence: ["fixture:case"], executionId: `fixture-${item.id}` })) : [],
    evidence: phase === "completed" ? ["fixture:operation"] : [],
    ...(operation === "trial" ? { sourceRevision: "fixture-source", trialIssue: { source: "smithers-cloud", number: 991 } } : {}),
    ...(operation === "apply" || operation === "pause" ? { registrationId: "fixture-registration", sourceRevision: "fixture-source" } : {}),
    ...(operation === "run" ? { jobRunId: `fixture-job-${body.requestId}` } : {})
  },
  ...(operation === "inspect" && phase === "completed" ? { inspection: { inspectedAt: Date.now(), suggestedDraft: { ...body.draft, cases: [{
    id: "fixture-duplicate", name: "Similar issues", input: "Explicit UI fixture input", expected: "Explicit UI fixture expectation", required: true
  }] },
    sources: [{ path: ".github/workflows/ci.yml", status: "read", summary: "Fixture: existing test command" }] } } : {})
})

test("setup preview offers all five jobs, keeps prompt edits and fits 320px", async ({ page }, testInfo) => {
  const requests: string[] = []
  await bootstrap(page, false)
  await page.route("**/api/repository-setup/**", route => { requests.push(route.request().url()); return route.fulfill({ status: 401, json: { message: "Sign in" } }) })
  await page.setViewportSize({ width: 320, height: 800 })
  await open(page)
  for (const name of ["Handle issues", "Review PRs", "Set up CI", "Build a feature", "Automate a chore"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible()
  }
  await keyboardClick(page, "Handle issues")
  const setup = page.getByTestId("setup-issues")
  await expect(setup).toBeVisible()
  await expect(setup.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
  await expect(setup.getByRole("button", { name: "Inspect repository" })).toHaveCount(0)
  await setup.getByRole("button", { name: "Prompts", exact: true }).focus()
  await page.keyboard.press("Enter")
  const prompt = setup.getByRole("textbox", { name: "Prompt", exact: true })
  await prompt.fill("")
  await prompt.pressSequentially("Check observability before changing the adapter.", { delay: 5 })
  await expect(prompt).toHaveValue("Check observability before changing the adapter.")
  await prompt.press(controlTabKey(page))
  await expect(prompt).toHaveValue("Check observability before changing the adapter.")
  // The next durable view command follows all queued prompt edits. Await
  // its projection before reload instead of interrupting in-flight writes.
  await setup.getByRole("button", { name: "Flows", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(setup.getByRole("button", { name: "Research issue", exact: true })).toBeVisible({ timeout: 30_000 })
  await setup.getByRole("button", { name: "Prompts", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(prompt).toHaveValue("Check observability before changing the adapter.")
  await page.reload()
  await expect(page.getByTestId("setup-issues").getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Check observability before changing the adapter.")
  const overflow = await setup.evaluate(node => [...node.querySelectorAll<HTMLElement>("input, textarea, select, button")]
    .filter(element => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
    .map(element => element.outerHTML.slice(0, 120)))
  expect(overflow).toEqual([])
  expect(requests).toEqual([])
  await page.screenshot({ path: testInfo.outputPath("setup-preview-320.png"), fullPage: true })
})

test("Chat summons at the top over setup and closes with keyboard or an outside press", async ({ page }, testInfo) => {
  await bootstrap(page, false)
  await open(page)
  await keyboardClick(page, "Handle issues")
  await expect(page.getByTestId("setup-issues")).toBeVisible()
  const hint = page.getByRole("button", { name: "Dismiss help", exact: true })
  if (await hint.isVisible()) await hint.click()
  const transcript = page.getByTestId("transcript")
  await page.evaluate(settleAnimations)
  const before = await transcript.boundingBox()
  await page.keyboard.press("Control+k")
  const composer = page.getByTestId("composer-input")
  await expect(composer).toBeFocused()
  const overlay = page.getByTestId("composer-overlay")
  await expect(overlay).toBeVisible()
  await page.evaluate(settleAnimations)
  const metrics = await overlay.evaluate(node => ({ position: getComputedStyle(node).position,
    background: getComputedStyle(node).backgroundColor, top: node.querySelector(".composer-wrap")!.getBoundingClientRect().top }))
  expect(metrics).toMatchObject({ position: "fixed", background: "rgba(0, 0, 0, 0)" })
  expect(metrics.top).toBeLessThan(60)
  expect(await transcript.boundingBox()).toEqual(before)
  await composer.press("Control+k")
  await expect(overlay).toBeHidden()
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeFocused()
  await page.keyboard.press("Control+k")
  await composer.fill("Keep this draft")
  await composer.press("Escape")
  await expect(overlay).toBeHidden()
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeFocused()
  await page.keyboard.press("Control+k")
  await expect(overlay).toBeVisible()
  await expect(composer).toHaveValue("Keep this draft")
  await page.evaluate(settleAnimations)
  await page.screenshot({ path: testInfo.outputPath("setup-composer.png"), fullPage: true })
  await overlay.click({ position: { x: 5, y: 500 } })
  await expect(overlay).toBeHidden()
})

test("held setup admission leaves Chat usable; only observed runs expose access", async ({ page }) => {
  await bootstrap(page, true)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let submitted: Start | undefined
  let observed: Response | undefined
  await page.route("**/api/repository-setup/**", async route => {
    if (new URL(route.request().url()).pathname.endsWith("/state")) return route.fallback()
    if (route.request().method() === "POST") {
      submitted = route.request().postDataJSON() as Start
      await held
      observed = response(submitted, "inspect", "queued")
    }
    await route.fulfill({ json: observed })
  })
  try {
    await open(page, true)
    await keyboardClick(page, "Handle issues")
    const setup = page.getByTestId("setup-issues")
    await expect(setup.locator("footer")).toContainText("Requested")
    await expect.poll(() => submitted !== undefined).toBe(true)
    await page.keyboard.press("Control+k")
    const input = page.getByTestId("composer-input")
    await expect(input).toBeFocused()
    await input.pressSequentially("I can still type while setup waits.", { delay: 5 })
    await expect(input).toHaveValue("I can still type while setup waits.")
    await input.press("Escape")
    await expect(setup.getByRole("button", { name: "Run", exact: true })).toHaveCount(0)
    release()
    await expect(setup.locator("footer")).toContainText("Queued")
    await expect(setup.getByRole("button", { name: "Run", exact: true })).toHaveCount(0)
    observed = response(submitted!, "inspect", "waiting")
    await expect(setup.locator("footer")).toContainText("Waiting")
    await expect(setup.getByRole("button", { name: "Run", exact: true })).toBeVisible()
  } finally { release() }
})

test("activation needs current evidence; a paused configuration can resume but edits need retesting", async ({ page }, testInfo) => {
  await bootstrap(page, true)
  const calls: Array<{ body: Start; operation: SetupHostInput["operation"] }> = []
  await page.route("**/api/repository-setup/**", async route => {
    if (new URL(route.request().url()).pathname.endsWith("/state")) return route.fallback()
    const body = route.request().postDataJSON() as Start
    const operation = new URL(route.request().url()).pathname.split("/").at(-1)! as SetupHostInput["operation"]
    calls.push({ body, operation })
    await route.fulfill({ json: response(body, operation) })
  })
  await open(page, true)
  // Prevent automatic guidance from sending a model turn in this UI fixture.
  await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill("A draft I am still writing")
  await page.getByTestId("composer-input").press("Escape")
  await keyboardClick(page, "Handle issues")
  const setup = page.getByTestId("setup-issues")
  await expect(setup.getByRole("button", { name: "Inspect repository" })).toBeEnabled()
  const enable = setup.getByRole("button", { name: "Enable issue handling", exact: true })
  await expect(enable).toBeDisabled()
  await keyboardClick(page, "Evals")
  await keyboardClick(page, "Run evals")
  await expect(setup.getByText("Similar issues · passed", { exact: true })).toBeVisible()
  await expect(enable).toBeDisabled()
  await keyboardClick(page, "Test")
  await keyboardClick(page, "Create test issue")
  await expect(setup.getByRole("button", { name: "Issue #991", exact: true })).toBeVisible()
  await expect(enable).toBeEnabled()
  await enable.focus(); await page.keyboard.press("Enter")
  await expect(setup.locator(".setup-heading").first()).toContainText("Enabled")
  const applied = calls.find(call => call.operation === "apply")!
  await setup.getByRole("button", { name: "Flows", exact: true }).focus()
  await page.keyboard.press("Enter")
  await keyboardClick(page, "Run Fix for real")
  await setup.getByRole("combobox", { name: "Source", exact: true }).selectOption("smithers-cloud")
  await setup.getByRole("spinbutton", { name: "Issue number", exact: true }).fill("42")
  await setup.getByRole("textbox", { name: "Instructions (optional)", exact: true }).fill("Preserve compatibility")
  await keyboardClick(page, "Fix for real")
  await expect(setup.getByRole("button", { name: "Job run", exact: true })).toBeVisible()
  expect(calls.find(call => call.operation === "run")!.body.manual).toEqual({ stepId: "fix", prompt: "Preserve compatibility", subject: { source: "smithers-cloud", kind: "issue", number: 42 } })
  await page.screenshot({ path: testInfo.outputPath("setup-manual-work.png"), fullPage: true })
  await keyboardClick(page, "Pause")
  await expect(setup.locator(".setup-heading").first()).toContainText("Paused")
  await expect(enable).toBeEnabled()
  await keyboardClick(page, "Prompts")
  await setup.getByRole("textbox", { name: "Prompt", exact: true }).fill("Research the issue before proposing a change.")
  await expect(enable).toBeDisabled()
  await keyboardClick(page, "Evals")
  await keyboardClick(page, "Run evals")
  await expect.poll(() => calls.filter(call => call.operation === "evaluate").length).toBe(2)
  await expect(setup.getByRole("button", { name: "Run evals" })).toBeEnabled()
  expect(calls.filter(call => call.operation === "evaluate").at(-1)!.body.revision).toBe(applied.body.revision + 2)
  await expect(enable).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath("setup-paused-evals.png"), fullPage: true })
})

for (const [job, title, trial] of [["ci", "Set up CI", "Test CI checks"], ["review", "Review PRs", "Review test PR"]] as const) {
  test(`${job} trial selects an actual PR through the shared editable draft`, async ({ page }, testInfo) => {
    await bootstrap(page, true)
    const trials: Start[] = []
    await page.route("**/api/repository-setup/**", async route => {
      if (new URL(route.request().url()).pathname.endsWith("/state")) return route.fallback()
      const body = route.request().postDataJSON() as Start
      const operation = new URL(route.request().url()).pathname.split("/").at(-1)! as SetupHostInput["operation"]
      if (operation === "trial") trials.push(body)
      await route.fulfill({ json: response(body, operation) })
    })
    await open(page, true)
    await page.keyboard.press("Control+k")
    await page.getByTestId("composer-input").fill("A draft I am still writing")
    await page.getByTestId("composer-input").press("Escape")
    await keyboardClick(page, title)
    const setup = page.getByTestId(`setup-${job}`)
    await expect(setup.getByRole("button", { name: "Inspect repository" })).toBeEnabled()
    await keyboardClick(page, "Test")
    await expect(setup.getByRole("button", { name: trial, exact: true })).toBeDisabled()
    await setup.getByRole("combobox", { name: "Source", exact: true }).selectOption("smithers-cloud")
    await setup.getByRole("spinbutton", { name: "PR number", exact: true }).fill("42")
    await keyboardClick(page, trial)
    await expect(setup.getByRole("button", { name: "Issue #991", exact: true })).toBeVisible()
    expect(trials).toHaveLength(1)
    expect(JSON.parse(trials[0]!.draft.trialBody)).toEqual({ source: "smithers-cloud", number: 42 })
    await page.screenshot({ path: testInfo.outputPath(`setup-${job}-trial.png`), fullPage: true })
  })
}
