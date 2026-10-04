import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-DUR-04.md; not a qualification receipt.
// Written before implementation: mvp.md §6.8 Save and recovery guarantees, §9 Durability, M-27; lands with T-COL-03, T-COL-08, T-COL-09, T-REL-04, T-COL-03a, T-COL-04a, T-COL-04, T-COL-08a, T-COL-08b
test("C-DUR-04: Recovered documents keep saved bytes and offer retained unsaved edits", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.8 Save and recovery guarantees, §9 Durability, M-27; lands with T-COL-03, T-COL-08, T-COL-09, T-REL-04, T-COL-03a, T-COL-04a, T-COL-04, T-COL-08a, T-COL-08b")
  await owner(page)
  await page.goto("/")

  // Seed K1–K8 outcomes: one recovered burst, saved collaborative text,
  // lost document epoch with two retained local edits, and saved wiki text.
  // Real watcher hashes, stale-base receipts, outbox deduplication and ten
  // trials per kill point belong to the daemon/VM/host fault suite.
  await say(page, "/branch retry-webhooks")
  const burst = page.getByRole("button", { name: "Maya via SSH changed 3 files", exact: true }).last()
  await expect(burst).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: "Maya via SSH changed 3 files", exact: true })).toHaveCount(1)
  await burst.press("Enter")
  await expect(page.getByText("src/webhooks/retry.ts", { exact: true }).last()).toBeVisible()
  await say(page, "/file src/webhooks/retry.ts")
  const editor = page.getByRole("textbox", { name: "src/webhooks/retry.ts", exact: true }).last()
  await expect(editor).toHaveValue(/Alice keeps delivery idempotent/)
  await expect(page.getByText("2 edits weren't saved", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "Reapply", exact: true }).last().press("Enter")
  await expect(editor).toHaveValue(/Ben keeps retries bounded/)
  await expect(page.getByText("Saved to the machine", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(editor).toHaveValue(/Ben keeps retries bounded/)
  await expect(editor).toHaveValue(/Alice keeps delivery idempotent/)
  await expect(page.getByText("2 edits weren't saved", { exact: true })).toHaveCount(0)
  await say(page, "/wiki.page Webhook retries")
  await expect(page.getByRole("textbox").last()).toHaveValue(/Retry failed deliveries.*at most 5 attempts/)
})
