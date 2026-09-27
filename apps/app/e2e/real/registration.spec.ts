import type { Request } from "@playwright/test"
import { scenario } from "./coverage/types"
import { awaitBoot, closeComposer, command, expect, openComposer, reloadApp, test } from "./support/test"
import { workflowTest } from "./flow-execution/fixture"
import { acceptedRunId, gatewayCall, runSummary, waitForTerminalRun } from "./flow-execution/production"
import { attachProductionJson, bootProductionRepository, waitForImportJobId } from "./repositories-github/production"

const importRequest = (request: Request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/github/import"
const runRequest = (request: Request, repo: string) => {
  if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/workflow/rpc") return false
  const body = request.postDataJSON() as { repo?: string; procedure?: string } | null
  return body?.repo === repo && body.procedure === "Run"
}

test("signed-out registration refuses without importing or launching, including after reload", scenario("registration.signed-out-boundary", {
  capabilities: ["identity", "cloud"],
  coverage: ["action:repository.register", "host:local", "host:production", "path:permission", "path:persistence", "door:slash", "dimension:signed-out", "evidence:visible-refusal-and-no-work-requests"]
}), async ({ page }, testInfo) => {
  const work: string[] = []
  page.on("request", request => {
    const path = new URL(request.url()).pathname
    if (importRequest(request) || (request.method() === "POST" && path.startsWith("/api/workflow/"))) work.push(path)
  })
  const started = performance.now()
  await page.goto("/smithersai/smithers")
  await awaitBoot(page, "navigate", started)
  for (let attempt = 0; attempt < 2; attempt++) {
    await command(page, "/repository.register https://github.com/smithersai/smithers")
    await closeComposer(page)
    await expect(page.getByTestId("transcript").getByText(/^Sign in(?: with GitHub)? to register a repository/).last()).toBeVisible()
    await expect(page.locator('.smithers-card[data-kind="registration"], .smithers-card[data-kind="repo-import"], .smithers-card[data-kind="run-trace"]')).toHaveCount(0)
    expect(work).toEqual([])
    if (attempt === 0) await reloadApp(page)
  }
  await attachProductionJson(testInfo, "registration-refusal", { workRequests: work, attempts: 2 })
})

workflowTest.describe("authenticated registration", () => {
workflowTest.setTimeout(30 * 60_000)
workflowTest.use({ actionTimeout: 30_000 })

workflowTest("registration imports, survives reload, reaches review and completes once", scenario("registration.production-review-completion", {
  capabilities: ["identity", "cloud"],
  description: "Register the fixture's owned GitHub source through the real form, observe its import and exact run, reload and repeat the request, approve its actual review, then prove Ready and cached replay without a second launch.",
  coverage: ["action:repository.register", "host:production", "path:success", "path:persistence", "path:keyboard", "door:slash", "door:button", "dimension:exact-run-id", "dimension:keyboard", "dimension:registration-review", "dimension:duplicate-input", "evidence:import-terminal-review-completed-projection-and-replay"]
}), async ({ page, request, workflowRepo }, testInfo) => {
  testInfo.setTimeout(30 * 60_000)
  const { repo, workspaceId } = workflowRepo
  await bootProductionRepository(page, repo)
  // The fixture owns and provisions this source; registration must still use
  // its real import door and run path. No API response or model result is stubbed.
  expect(workspaceId).toBeDefined()
  await command(page, `/box.view ${workspaceId}`)
  await expect(page.getByTestId(`card-workspace-${workspaceId}`)).toBeVisible()
  await closeComposer(page)
  await command(page, `/repo.select ${repo}#workspace:${workspaceId}`)
  await closeComposer(page)
  const imports: string[] = [], launches: string[] = []
  const pendingImport = `Registration import for ${repo} has no observed terminal job.`
  const observe = (request: Request) => {
    if (importRequest(request)) {
      imports.push(request.url())
      workflowRepo.ambiguities.push(pendingImport)
    }
    if (runRequest(request, repo)) {
      launches.push(request.url())
      if (launches.length > 1) workflowRepo.ambiguities.push(`Unexpected additional registration run for ${repo}; preserve its repository.`)
    }
  }
  page.on("request", observe)
  try {
    await command(page, "/repository.register")
    await closeComposer(page)
    const form = page.locator('form[data-flow-name="repository.register"]')
    const link = form.getByRole("textbox", { name: "Repository link" })
    await expect(link).toBeVisible()
    await link.fill(`https://github.com/${repo}`)
    const imported = page.waitForResponse(response => importRequest(response.request()))
    void imported.catch(() => undefined)
    const accepted = acceptedRunId(page, repo, workflowRepo, 300_000)
    await link.press("Enter")
    const registration = page.getByTestId(`card-registration-${repo}`)
    await expect(registration).toBeVisible()
    await openComposer(page)
    const composer = page.getByTestId("composer-input")
    await composer.fill("Chat stays usable during registration")
    await expect(composer).toHaveValue("Chat stays usable during registration")
    await closeComposer(page)
    const importResponse = await imported
    const importBody = await importResponse.json() as { importJobId?: string }
    expect([200, 202]).toContain(importResponse.status())
    expect(importBody.importJobId).toEqual(expect.any(String))
    const importTerminal = await waitForImportJobId(page, request, importBody.importJobId!)
    // Never let fixture teardown delete a source while an unobserved import
    // or unexpected duplicate run may still be using it.
    const pending = workflowRepo.ambiguities.indexOf(pendingImport)
    if (pending >= 0) workflowRepo.ambiguities.splice(pending, 1)
    expect(importTerminal.status).toBe("ready")
    const runId = await accepted
    const trace = page.locator(`.smithers-card[data-kind="run-trace"][data-run-id="${runId}"]`)
    await expect(trace).toBeVisible({ timeout: 60_000 })
    await reloadApp(page)
    await expect(registration).toBeVisible()
    await command(page, `/repository.register ${repo}`)
    await closeComposer(page)
    await expect(registration).toHaveCount(1)
    const review = page.getByTestId("approval-answer").filter({ hasText: `Register ${repo}?` })
    await expect(review).toBeVisible({ timeout: 20 * 60_000 })
    await expect(registration.locator(".registration-go")).toHaveText("In review")
    const beforeApproval = runSummary(await gatewayCall(page, request, repo, "Projection.Snapshot", { selector: { _tag: "run-summary", runId } }, workspaceId))
    expect(beforeApproval?.runId).toBe(runId)
    expect(beforeApproval?.status).not.toMatch(/^(completed|failed|cancelled)$/)
    expect(imports).toHaveLength(1)
    expect(launches).toHaveLength(1)
    await review.getByRole("button", { name: "Approve", exact: true }).press("Enter")
    const completed = await waitForTerminalRun(page, request, repo, runId, 300_000, workspaceId)
    expect(completed.status).toBe("completed")
    expect(completed.finalOutput).toMatchObject({ review: { decision: "approve" }, report: { repo } })
    await expect(registration.locator(".registration-go")).toHaveText("Ready", { timeout: 60_000 })
    await command(page, `/repository.register https://github.com/${repo}`)
    await closeComposer(page)
    await expect(registration.locator(".registration-go")).toHaveText("Ready")
    await reloadApp(page)
    await expect(registration.locator(".registration-go")).toHaveText("Ready")
    expect(imports).toHaveLength(1)
    expect(launches).toHaveLength(1)
    await attachProductionJson(testInfo, "registration-completion", { repo, workspaceId, importJobId: importBody.importJobId, importTerminal, runId, beforeApproval, completed, imports: imports.length, launches: launches.length })
  } finally { page.off("request", observe) }
})

})
