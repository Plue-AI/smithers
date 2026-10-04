import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MCH-02.md; not a qualification receipt.
// Written before implementation: mvp.md §6.7, M-13; lands with T-MCH-06
test("C-MCH-02: People wait ahead of TODOs without preempting working agents", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.7, M-13; lands with T-MCH-06")
  await owner(page)
  await page.goto("/")
  // Seed capacity 1: T1 working; learning, T5, T6, Alice, Ben queued in that order.
  // Clock/grant order and concurrent slot ownership remain integration evidence.
  await say(page, "/home")
  await expect(page.getByText("waiting for a machine #3", { exact: true })).toBeVisible()
  await expect(page.getByText("waiting for a machine #4", { exact: true })).toBeVisible()
  await say(page, "/branch alice-work")
  await expect(page.getByText("waiting for a machine #1", { exact: true }).last()).toBeVisible()
  await say(page, "/branch ben-work")
  await expect(page.getByText("waiting for a machine #2", { exact: true }).last()).toBeVisible()
  await say(page, "/todo T1")
  await expect(page.getByText("Working", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Paused", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("Working", { exact: true }).last()).toBeVisible()
})
