import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-REL-01.md; not a qualification receipt.
// mvp.md §12.4, M-35: bundled Markdown through the person-facing /docs flow.
test("C-REL-01: Docs expose only Quickstart and Flows reference", async ({ page }) => {
  test.setTimeout(60_000)
  await owner(page)
  await page.goto("/")
  await say(page, "/docs")
  await expect(page.getByRole("navigation", { name: "Docs pages" }).getByRole("link", { name: "Quickstart", exact: true })).toBeVisible()
  await expect(page.getByRole("navigation", { name: "Docs pages" }).getByRole("link", { name: "Flows reference", exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Put HTTPS in front", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "install page", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: /HTTP API reference/ })).toBeVisible()
  await expect(page.getByText("smthrs host start --bind 0.0.0.0 --origin http://studio-mini.local:4000", { exact: false })).toBeVisible()
  await expect(page.getByText("smthrs login https://smithers.example.com", { exact: false })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Open the wiki in Obsidian", exact: true })).toHaveCount(1)
  await page.getByRole("navigation", { name: "Docs pages" }).getByRole("link", { name: "Flows reference", exact: true }).press("Enter")
  await expect(page.getByText("flows/<name>/flow.ts", { exact: false })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText("/flow.edit", { exact: false })).toBeVisible()
})
