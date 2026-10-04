import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-DUR-01.md; not a qualification receipt.
// Written before implementation: mvp.md §6.1 Restart, §9 Durability; lands with T-FLW-09, T-REL-04
test("C-DUR-01: A recovered host keeps the question and completed step evidence", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.1 Restart, §9 Durability; lands with T-FLW-09, T-REL-04")
  await owner(page)
  await page.goto("/")

  // Required fault seed: K1–K5 host/database restarts during plan, model,
  // check and wait. Each browser reload reconnects to the same recovered run.
  // Journal attempts, provider call counts and event-before-projection ordering
  // are proved by the real fault suite, never by this UI projection.
  await say(page, "/todo T9")
  const question = page.getByText("Change the delay, or raise the test timeout?", { exact: true }).last()
  await expect(question).toBeVisible()
  await page.getByRole("button", { name: "Inspect", exact: true }).last().press("Enter")
  await expect(page.getByText("Waiting for a person since 10:42", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByText("Waiting for a person since 10:42", { exact: true }).last()).toBeVisible()
  await say(page, "/todo T9")
  await expect(question).toBeVisible()
  await page.getByRole("textbox", { name: "Answer", exact: true }).last().fill("Change the delay")
  await page.getByRole("button", { name: "Answer", exact: true }).last().press("Enter")
  await expect(page.getByText(/answered/).last()).toBeVisible()
  await expect(page.getByText("In review", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "Inspect", exact: true }).last().press("Enter")
  await expect(page.getByRole("navigation", { name: "Run timeline", exact: true }).last().getByText("Read 3 files", { exact: true })).toHaveCount(1)
})
