import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md Appendix A, M-35; lands with T-APP-20
test("A-DOCS: /docs opens Quickstart", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, M-35; lands with T-APP-20")
  await owner(page)
  await page.goto("/")
  await say(page, "/docs")
  await page.getByRole("link", { name: "Quickstart", exact: true }).last().press("Enter")
  await expect(page.getByRole("heading", { name: "Quickstart", exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
