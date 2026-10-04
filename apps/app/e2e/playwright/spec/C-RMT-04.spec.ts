import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection; does not replace the check's integration/reference-host receipts.
// Written before implementation: engineering spec.md §8.13, C-RMT-04; lands with T-RMT-04
test("C-RMT-04: capacity, pinned waiting and unreachable removal stay honest", async ({ page }) => {
  test.fixme(true, "Written before implementation: engineering spec.md §8.13, C-RMT-04; lands with T-RMT-04")
  await owner(page)
  await page.goto("/")
  // Rig: This Mac capacity 6, beaver capacity 3, seven Auto TODOs;
  // ties favor This Mac, disks stay on their computer, fork stays with origin.
  // Admission ordering/disk deletion need implementing-ticket receipts.
  await say(page, "/settings")
  const settings = page.getByRole("region", { name: "Settings", exact: true }).last()
  await expect(settings).toContainText("9 machines")
  await say(page, "/todo.new")
  await page.getByLabel("Title", { exact: true }).fill("Pinned retry")
  await page.getByLabel("Prompt", { exact: true }).fill("Test retry on beaver")
  await expect(page.getByText("Runs on", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "beaver", exact: true }).last().press("Enter")
  await page.getByRole("button", { name: "Commit", exact: true }).last().press("Enter")
  await expect(page.getByText("Runs on beaver", { exact: true })).toBeVisible()
  await expect(page.getByText("Waiting for a machine · beaver · #1", { exact: true })).toBeVisible()
  // Rig releases beaver's slot, wakes the pinned TODO, then faults the host.
  await expect(page.getByText(/awake · beaver/).last()).toBeVisible()
  await say(page, "/branch T9")
  await expect(page.getByText("Machine unreachable · beaver", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Retry", exact: true }).last().press("Enter")
  await say(page, "/settings")
  await expect(settings).toContainText("6 machines")
  const computer = settings.getByRole("listitem").filter({ hasText: "beaver" })
  await computer.getByRole("button").last().press("Enter")
  await page.getByRole("menuitem", { name: "Remove", exact: true }).press("Enter")
  await expect(computer).toContainText("Remove beaver?")
  await expect(computer).toContainText("branches close")
  await computer.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
  await expect(computer).not.toContainText("Remove beaver?")
  await computer.getByRole("button").last().press("Enter")
  await page.getByRole("menuitem", { name: "Remove", exact: true }).press("Enter")
  await computer.getByRole("button", { name: "Remove", exact: true }).press("Enter")
  await say(page, "/branch T9")
  await page.getByRole("tab", { name: "Activity", exact: true }).last().press("Enter")
  await expect(page.getByText(/Closed · beaver removed by/)).toBeVisible()
  await say(page, "/todo T9")
  await page.getByRole("button", { name: "Retry", exact: true }).last().press("Enter")
  await expect(page.getByText("In review", { exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
