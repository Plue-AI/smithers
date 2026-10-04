import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Requires production TODO projections and a seeded T9 question; issue #7 includes retry discussion.
// Written before implementation: mvp.md Appendix A, J7.1, §4.2; lands with T-STK-02, T-STK-06
test("A-TODO-AMEND: retains the amended TODO identity", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J7.1, §4.2; lands with T-STK-02, T-STK-06")
  await owner(page)
  await page.goto("/")
  await say(page, "/todo.amend T9 Also log each retry.")
  await page.getByRole("button", { name: "Confirm", exact: true }).last().press("Enter")
  await say(page, "/todo T9")
  const card = page.locator(".smithers-card").last()
  await expect(card).toContainText("T9")
  await expect(card).toContainText("1 amendment")
  await card.getByText("1 amendment", { exact: true }).press("Enter")
  await expect(card).toContainText("Also log each retry.")
  await expect(card).toContainText("Needs you")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
