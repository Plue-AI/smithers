import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-UI-05.md.
// Integration and reference-host evidence remains required separately.
// Written before implementation: mvp.md §2 rule 5, §9 Honesty; lands with T-COL-02
test("C-UI-05: Honest state on the live channel", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §2 rule 5, §9 Honesty; lands with T-COL-02")
  // Required seed: capacity one, occupied machine, held creation request,
  // independently released admission/failure events and a reconnectable socket.
  await owner(page)
  await page.goto("/")
  await say(page, "/todo.new")
  await page.getByLabel("Title", { exact: true }).fill("Held launch")
  await page.getByLabel("Prompt", { exact: true }).fill("Exercise honest launch state")
  await page.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  await expect(page.getByText("Requested", { exact: true })).toBeVisible()
  await expect(page.getByText("Working", { exact: true })).toHaveCount(0)
  await say(page, "What is waiting?")
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await expect(page.getByText("The launch is waiting", { exact: true })).toBeVisible()
  // Release hold after the independent chat answer, then admit and fail T12.
  await expect(page.getByText("Waiting for a machine · #1", { exact: true })).toBeVisible()
  await page.reload()
  await say(page, "/todo T12")
  const card = page.locator(".smithers-card").last()
  await expect(card).toContainText("Failed")
  await expect(card.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
  await say(page, "/todo.retry T12")
  await say(page, "/todo.retry T12")
  await expect(card).toContainText("Attempt 2")
  await expect(card).not.toContainText("Attempt 3")
  await page.reload()
  await say(page, "/todo T12")
  await expect(page.locator(".smithers-card").last()).toContainText("In review")
})
