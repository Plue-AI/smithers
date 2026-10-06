import { expect, test } from "./browserTest"
import { owner, say } from "./spec/j1-fixtures"
import { installFixture } from "../../src/mainview/state/seams/InstallFixtures.test-support"

// HTTP fixtures exercise the install seam and durable card, not loader/merge qualification.
test("install flow versions retain selection across refresh and reload", async ({ page }) => {
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "credentials", sandbox: null
  } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/members", route => route.fulfill({ json: { members: [], access_url: "https://github.com/acme/api/settings/access" } }))
  let state = "proposed"
  await page.route("**/api/flows", route => route.fulfill({ json: [{ name: "todo", source: { builtin: true }, system: false, versions: [
    { id: "d1", state: "active", steps: [{ id: "implement", label: "Implement", agent: "implementer" }] },
    { id: "d2", state, todo: 42, ...(state === "merged-failed" ? { error: "Unknown reviewer" } : {}), steps: [{ id: "implement", label: "Implement" }, { id: "docs", label: "Update changelog" }] },
    { id: "d0", state: "previous", steps: [] }
  ] }] }))
  await page.goto("/")
  await say(page, "/flow todo")
  const flow = page.locator('.flow-view').last()
  await expect(flow.getByRole("button", { name: "Active", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(flow.getByRole("button", { name: "Previous", exact: true })).toHaveCount(0)
  await flow.locator('.flow-version[data-state="proposed"]').press("Enter")
  await expect(flow.locator('[data-added="true"]')).toHaveText(/Update changelog/)
  await page.reload()
  await expect(flow.locator('.flow-version[data-state="proposed"]')).toHaveAttribute("aria-pressed", "true")
  state = "merged-syncing"
  await say(page, "/flow todo")
  await expect(flow.locator('.flow-version[data-state="merged-syncing"]')).toHaveAttribute("aria-pressed", "true")
  state = "merged-failed"
  await say(page, "/flow todo")
  await expect(flow.getByText("Load failed", { exact: true })).toBeVisible()
  await flow.getByRole("button", { name: "Active", exact: true }).press("Enter")
  await expect(flow.getByText("Load failed", { exact: true })).toHaveCount(0)
  await expect(flow.locator('[data-flow="agent"]')).toHaveText("implementer")
  await expect(flow.getByRole("button", { name: "Source", exact: true })).toBeVisible()
  await expect(flow.getByRole("button", { name: "Run", exact: true })).toHaveCount(0)
})
