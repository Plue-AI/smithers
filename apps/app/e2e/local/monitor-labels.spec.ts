import { test, expect } from "@playwright/test"
import { readFileSync } from "node:fs"
// Real installed bundle and provider fixtures from the local walk; product state is created in the UI.
// Run after setup-no-github.spec.ts with playwright.monitor.config.ts. Video and traces are retained.
test("J11 Appendix C titles, one Engine disclosure, and scoped Monitor Inspect", async ({ page }) => {
  test.setTimeout(600_000)
  const run = JSON.parse(readFileSync("test-results/local-no-github/run.json", "utf8"))
  await page.goto("http://localhost:4000/api/auth/github")
  await page.getByRole("link", { name: "Authorize", exact: true }).click()
  await expect(page.getByTestId("composer-input")).toBeAttached()
  const say = async (line: string) => {
    const input = page.getByTestId("composer-input")
    if (!await input.isVisible()) await page.keyboard.press("Control+k")
    await input.fill(line); await input.press("Enter")
  }
  await say("/todo.new")
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await draft.getByLabel("Title", { exact: true }).fill("Monitor the greeting")
  await draft.getByLabel("Prompt", { exact: true }).fill("Add one greeting line to JOURNEY.md. Keep the existing tests passing.")
  await draft.getByRole("button", { name: "Commit", exact: true }).click()
  // Reads verify the UI's admission; they never manufacture TODOs or run state.
  let todo: { n: number; run?: { id: string }; branch?: { id: string } } | undefined
  await expect.poll(async () => {
    const response = await page.request.get("http://localhost:4000/api/todos")
    expect(response.ok()).toBe(true)
    todo = (await response.json()).find((row: { title: string }) => row.title === "Monitor the greeting")
    return Boolean(todo?.run && todo?.branch)
  }, { timeout: 300_000 }).toBe(true)
  await say("/monitor")
  const monitor = page.locator('[data-kind="run-list"]').last()
  await expect(monitor).toContainText(`T${todo!.n} · Monitor the greeting`, { timeout: 30_000 })
  const row = monitor.locator("li").filter({ hasText: `T${todo!.n} · Monitor the greeting` })
  await expect(row.getByRole("button", { name: "Inspect", exact: true })).toBeVisible()
  await row.getByRole("button", { name: "Inspect", exact: true }).click()
  const trace = page.locator('[data-kind="run-trace"]').last()
  await expect(trace).toBeVisible({ timeout: 30_000 })
  await trace.getByRole("button", { name: "Steps", exact: true }).click()
  await expect(trace.locator('[data-type="engine"] .run-step-text')).toHaveCount(1)
  await expect(trace.locator(".run-step-text").filter({ hasText: /^Edited the files$/ })).toBeVisible({ timeout: 300_000 })
  const engine = trace.getByRole("button", { name: /Engine/ })
  await expect(engine).toHaveAttribute("aria-expanded", "false")
  await engine.focus(); await page.keyboard.press("Enter")
  await expect(trace.getByRole("list", { name: "Engine records", exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeVisible()
  // The provider journal proves this install, rather than a browser route interception, served the run.
  expect((await (await page.request.get(`${run.fakeURL}/_fake/writes`)).json()).length).toBeGreaterThan(0)
})
