import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-DUR-02.md; not a qualification receipt.
// Written before implementation: mvp.md §6.1 Restart, §9 Durability and Honesty; lands with T-FLW-09, T-REL-04
test("C-DUR-02: Interrupted machine work offers an explicit retry with retained evidence", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.1 Restart, §9 Durability and Honesty; lands with T-FLW-09, T-REL-04")
  await owner(page)
  await page.goto("/")

  // Fault seed M1–M4: D1 attempt interrupted without a reconcile declaration;
  // D2 is active. Same-disk recovery, exactly-once writes, D1 pinning and 60 s
  // liveness require the microVM fault suite.
  await say(page, "/todo T9")
  await expect(page.getByText("Failed", { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/interrupted/i).last()).toBeVisible()
  const retry = page.getByRole("button", { name: "Retry", exact: true }).last()
  await expect(retry).toBeVisible()
  await page.reload()
  await expect(retry).toBeVisible()
  await expect(page.getByText("Working", { exact: true })).toHaveCount(0)
  await retry.press("Enter")
  await expect(page.getByText("Working", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "Inspect", exact: true }).last().press("Enter")
  await expect(page.getByText("Attempt 1", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Attempt 2", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Interrupted", { exact: true }).last()).toBeVisible()
})

// Mounted projection only: the recorded interrupted attempt survives reload.
test("C-DUR-02: Recorded machine interruption remains visible after reload", async ({ page }) => {
  await page.goto("/")
  await say(page, "/run run-retry-1")
  await expect(page.getByText("Interrupted", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Edited 1 file", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByText("Interrupted", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Edited 1 file", { exact: true })).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
})
