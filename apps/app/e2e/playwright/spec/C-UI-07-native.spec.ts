import { expect, test, type Page } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// Go owns the authenticated install, PostgreSQL, native mirror, encrypted
// credentials, dispatcher and packaged model host. Only unrelated shell data
// uses browser fixtures. No conversation or source response is synthesized.
test("C-UI-07: native shared preflight survives tab closure and opens four sources", async ({ page, context }) => {
  test.fixme(!process.env.SMITHERS_CONTEXT_ORIGIN, "Run TestLocalSharedPreflightBrowser with SMITHERS_CONTEXT_BROWSER=1")
  const origin = process.env.SMITHERS_CONTEXT_ORIGIN!
  const revision = process.env.SMITHERS_CONTEXT_REVISION!
  const writes: string[] = []
  const prompts: Array<{ prompt: string; idempotencyKey: string }> = []
  const configure = async (target: Page) => {
    await installCloudFixture(target, { repos: [{ owner: "chatowner", name: "chatrepo", full_name: "chatowner/chatrepo", default_bookmark: "main", owner_type: "User" }] })
    await target.route("**/api/user", route => route.fulfill({ json: { id: Number(process.env.SMITHERS_CONTEXT_MEMBER), username: "ben", is_admin: false } }))
    await target.route("**/api/bootstrap", route => route.fulfill({ json: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "redirect", sandbox: null } }))
    await target.route("**/api/install", route => route.fulfill({ json: { ...installFixture(), repository: { owner: "chatowner", name: "chatrepo" }, repositories: ["chatowner/chatrepo"], github: { ...installFixture().github, owner: "chatowner" } } }))
    for (const pattern of ["**/api/conversations/**", "**/api/branches/**/files/**", "**/api/repos/**/wiki/**", "**/api/todos/**"]) {
      await target.route(pattern, async route => {
        const request = route.request()
        const url = new URL(request.url())
        if (url.pathname.endsWith("/prompt")) prompts.push(request.postDataJSON())
        try {
          const response = await route.fetch({ url: origin + url.pathname + url.search, headers: { ...request.headers(), cookie: "context_session=composed-context-session" } })
          await route.fulfill({ response })
        } catch (error) {
          if (!target.isClosed()) throw error
        }
      })
    }
    target.on("request", request => { if (request.method() === "POST") writes.push(new URL(request.url()).pathname) })
  }
  await configure(page)
  await page.goto("/")
  await page.getByRole("button", { name: "Chat", exact: true }).press("Enter")
  const composer = page.getByTestId("composer-input")
  await composer.fill("Where do we retry webhooks?")
  const accepted = page.waitForResponse(response => response.url().endsWith("/api/conversations/main/prompt") && response.status() === 202)
  await composer.press("Enter")
  const admission = await (await accepted).json() as { runId: string }
  await page.close()
  const reader = await context.newPage()
  await configure(reader)
  await reader.goto("/")
  const disclosure = reader.getByRole("button", { name: "Context · 4", exact: true })
  await expect(disclosure).toBeVisible({ timeout: 30_000 })
  await disclosure.press("Enter")
  const file = reader.locator('.context-chip[data-flow="file"]')
  await expect(file).toHaveAttribute("title", `src/webhooks/retry.ts · ${revision} · Retry implementation`)
  await file.press("Enter")
  await expect(reader.locator(".smithers-card").last()).toContainText("export const retries = 3")
  await reader.locator('.context-chip[data-flow="wiki.page"]').click()
  await expect(reader.getByTestId("wiki-pinned-content")).toHaveAttribute("data-revision", "1")
  await expect(reader.getByTestId("wiki-pinned-content")).toContainText("Public wiki context")
  await reader.locator('.context-chip[data-flow="todo"]').press("Space")
  await expect(reader.getByRole("article", { name: "TODO T1", exact: true })).toContainText("Repair retries")
  await reader.locator('.context-chip[data-flow="run.inspect"]').press("Enter")
  const sourceRun = reader.getByTestId(`card-run:${process.env.SMITHERS_CONTEXT_RUN}`)
  await expect(sourceRun).toContainText("Retry implementation")
  await sourceRun.locator('[data-flow="card.minimize"]').click()
  await reader.locator('[data-shared-turn]').last().getByRole("button", { name: "Inspect", exact: true }).click()
  const monitor = reader.locator(".mvp-run[data-maximized]")
  await expect(monitor.locator(".mvp-run-step-head").first()).toHaveText("Preflight")
  for (const reason of ["Retry implementation", "Retry policy", "Retry work", "Retry evidence"]) await expect(monitor).toContainText(reason)
  await expect(monitor).toContainText("fast")
  await reader.reload()
  await expect(monitor).toContainText("Retry implementation")
  await reader.getByTestId(`card-run:${admission.runId}`).locator('[data-flow="card.minimize"]').click()
  await disclosure.click()
  await expect(disclosure).toHaveAttribute("aria-expanded", "true")
  await expect(file).toBeVisible()
  await expect(reader.locator("button.context-chip")).toHaveCount(4)
  expect(prompts.length).toBeGreaterThan(0)
  expect(new Set(prompts.map(prompt => prompt.idempotencyKey)).size).toBe(1)
  for (const prompt of prompts) expect(prompt.prompt).toBe("Where do we retry webhooks?")
  expect(writes.filter(path => /\/(?:wake|agent\/turn|chat\/turn)$/.test(path))).toEqual([])
  await reader.close()
})
