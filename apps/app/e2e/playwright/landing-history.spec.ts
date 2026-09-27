import { fillComposer } from "./composer"
import { expect, test } from "./browserTest"
import { installCloudFixture } from "./cloudFixture"

for (const theme of ["light", "dark"] as const) test(`retained PR history recovers in the selected tab (${theme})`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat"] })
  await page.route("**/api/billing/balance", route => route.fulfill({ json: {
    state: "ok", allowedToStartWork: true,
    balance: { totalUsd: "500", lifetimeChargedUsd: "0", chargeCount: 0 }
  } }))
  const repo = "smithersai/smithers"
  let unavailable = true, historyReads = 0
  const writes: string[] = []
  await page.route(url => url.pathname.includes(`/repos/${repo}/landings/9`), async route => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() !== "GET") writes.push(path)
    if (path.endsWith("/reviews")) return route.fulfill({ json: [] })
    if (path.endsWith("/changes") || path.endsWith("/diff")) {
      historyReads++
      if (unavailable) return route.fulfill({ status: 404, json: { message: "Retained history unavailable" } })
      return route.fulfill({ json: path.endsWith("/changes") ? [{
        change_id: "abandoned-change", commit_id: "retained-commit", description: "Keep review history",
        author_name: "reviewer", timestamp: "2026-09-21T10:00:00Z"
      }] : { landing_number: 9, changes: [{ change_id: "abandoned-change", file_diffs: [{
        path: "README.md", change_type: "modified", additions: 1, deletions: 0,
        patch: "--- a/README.md\n+++ b/README.md\n@@ -0,0 +1 @@\n+Retained review history\n"
      }] }] } })
    }
    return route.fulfill({ json: {
      number: 9, title: "Keep review history", body: "A merged review.", state: "merged",
      author: { login: "reviewer" }, change_ids: ["abandoned-change"], target_bookmark: "main",
      conflict_status: "clean", stack_size: 1, created_at: "2026-09-21T10:00:00Z"
    } })
  })
  await page.goto("/")
  await expect(page.getByTestId("first-run-actions")).toBeVisible()
  await fillComposer(page, `/prs.view 9 ${repo}`)
  await page.getByTestId("composer-send").click()
  const card = page.locator('[data-kind="pr"]')
  await expect(card).toContainText("Keep review history")
  if (await page.getByTestId("composer-input").isVisible()) await page.getByTestId("composer-input").press("Escape")
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await card.getByRole("tab", { name: /Commits/ }).click()
  await expect(card.getByRole("alert")).toContainText("Commits unavailable")
  await card.getByRole("tab", { name: /Files changed/ }).click()
  await expect(card.getByRole("alert")).toContainText("Files unavailable")
  if (process.env.CAPTURE_DIR) {
    await page.evaluate(theme => {
      const label = document.createElement("div")
      label.textContent = `CAP-002-${theme}-r001 · LOCAL APP / CONTROLLED RESPONSES`
      label.style.cssText = "position:fixed;bottom:4px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#111;color:white;font:12px monospace;padding:5px;pointer-events:none"
      document.body.append(label)
    }, theme)
    await page.screenshot({ path: `${process.env.CAPTURE_DIR}/CAP-002-error.${theme}.png` })
  }
  unavailable = false
  await card.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(card.getByRole("tab", { name: /Files changed/ })).toHaveAttribute("aria-selected", "true")
  await expect(card).toContainText("README.md")
  await expect(card.getByText("Retained review history", { exact: false })).toBeVisible()
  await expect(card.getByRole("alert")).toHaveCount(0)
  expect(historyReads).toBe(4)
  expect(writes).toEqual([])
  if (process.env.CAPTURE_DIR) await page.screenshot({ path: `${process.env.CAPTURE_DIR}/CAP-002-files.${theme}.png` })
  await card.getByRole("tab", { name: /Commits/ }).click()
  await expect(card).toContainText("retained")
  if (process.env.CAPTURE_DIR) await page.screenshot({ path: `${process.env.CAPTURE_DIR}/CAP-002-commits.${theme}.png` })
})
