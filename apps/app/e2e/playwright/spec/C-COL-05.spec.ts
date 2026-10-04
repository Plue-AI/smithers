import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-COL-05.md; not a qualification receipt.
// Written before implementation: mvp.md J3.2, J3.4, §6.8; lands with T-COL-04, T-COL-04a, T-APP-10, T-APP-11
test("C-COL-05: Outside bursts update files once and restore only the selected path", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J3.2, J3.4, §6.8; lands with T-COL-04, T-COL-04a, T-APP-10, T-APP-11")
  await owner(page)
  await page.goto("/")
  // Seed: Maya's 12-file save, metadata changes and watcher overflow;
  // resync produces the committed snapshot, excluding generated/dependency paths.
  // Per-file hashes and actual inotify overflow remain component evidence.
  await say(page, "/branch retry-webhooks")
  const burst = page.getByRole("button", { name: "Maya via SSH changed 12 files", exact: true }).last()
  await expect(burst).toBeVisible()
  await burst.press("Enter")
  await expect(page.getByText("src/webhooks/retry.ts", { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/Maya keeps retries bounded/).last()).toBeVisible()
  await page.getByRole("button", { name: "Restore this file", exact: true }).last().press("Enter")
  await say(page, "/file src/webhooks/retry.ts")
  await expect(page.getByText(/await sleep\(30_000\)/).last()).toBeVisible()
  await say(page, "/branch retry-webhooks")
  await expect(page.getByRole("button", { name: "Maya via SSH changed 12 files", exact: true })).toHaveCount(1)
  await page.getByRole("tab", { name: /^Files/ }).last().press("Enter")
  await expect(page.getByRole("tabpanel").last()).not.toContainText("node_modules/")
  await page.reload()
  await say(page, "/file src/webhooks/retry.ts")
  await expect(page.getByText(/await sleep\(30_000\)/).last()).toBeVisible()
})

// The seeded Branch Files surface exists; watcher fault qualification remains above.
test("C-COL-05: Branch Files stays empty until a change and presence opens the file", async ({ page }) => {
  await page.goto("/")
  await say(page, "/branch retry-webhooks")
  const files = page.getByRole("tab", { name: /^Files/ }).last()
  await files.press("Enter")
  await expect(files).toHaveAttribute("aria-selected", "true")
  const panel = page.getByRole("tabpanel").last()
  await expect(panel.getByRole("list")).toBeEmpty()
  const retry = page.getByRole("list", { name: "On this branch", exact: true }).getByRole("button", { name: "src/webhooks/retry.ts", exact: true })
  await expect(retry).toBeVisible()
  await expect(panel).not.toContainText("node_modules/")
  await retry.press("Enter")
  await expect(page.getByRole("region", { name: "File content", exact: true }).last()).toContainText("await sleep(30_000)")
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("region", { name: "File content", exact: true }).last()).toContainText("await sleep(30_000)")
})
