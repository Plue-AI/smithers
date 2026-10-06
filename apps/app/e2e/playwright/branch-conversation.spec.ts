import { expect, test } from "./browserTest"
import { owner } from "./spec/j1-fixtures"
import { installFixture } from "../../src/mainview/state/seams/InstallFixtures.test-support"

for (const selection of ["historical", "empty", "unavailable"] as const) {
  test(`shared conversation preserves ${selection} context without an Inspect action`, async ({ page }) => {
    await owner(page)
    await page.route("**/api/bootstrap", route => route.fulfill({ json: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "redirect", sandbox: null } }))
    await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
    await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: {} }))
    await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: [{
      id: "old-turn", author: 1, authorLogin: "ben", runId: "old-run", prompt: "Old question", state: "completed",
      ...(selection === "historical" ? {} : { context: selection === "empty" ? [] : [{ kind: "page", label: "Unpinned page", ref: "retries" }] }),
      frames: [{ runId: "old-run", type: "delta", kind: "text", text: "Stored answer" }, { runId: "old-run", type: "done", reason: "stop" }]
    }] } }))
    const writes: string[] = []
    page.on("request", request => { if (request.method() === "POST") writes.push(new URL(request.url()).pathname) })
    await page.goto("/")
    const turn = page.locator('[data-shared-turn="old-turn"]')
    await expect(turn).toContainText("Stored answer")
    await expect(turn.getByRole("button", { name: "Inspect", exact: true })).toHaveCount(0)
    if (selection === "historical") await expect(turn.locator(".context-toggle")).toHaveCount(0)
    else {
      await turn.getByRole("button", { name: `Context · ${selection === "empty" ? 0 : 1}`, exact: true }).press("Enter")
      await expect(turn.locator("button.context-chip")).toHaveCount(0)
      if (selection === "unavailable") await expect(turn.getByText("Unpinned page", { exact: true })).toBeVisible()
    }
    await page.reload()
    await expect(turn).toContainText("Stored answer")
    await expect(turn.getByRole("button", { name: "Inspect", exact: true })).toHaveCount(0)
    expect(writes.filter(path => /\/api\/(?:conversations\/.*\/prompt|agent\/turn|chat\/turn)$/.test(path))).toEqual([])
  })
}
