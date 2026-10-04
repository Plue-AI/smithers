import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md Appendix A, J2.5, J3.4, §6.8; lands with T-STK-01, T-COL-04
test("A-DIFF: shows only the branch change", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J2.5, J3.4, §6.8; lands with T-STK-01, T-COL-04")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch T8")
  await say(page, "/diff")
  await expect(page.getByRole("region", { name: "package.json changes", exact: true }).last()).toContainText("17.2.0")
  await expect(page.getByRole("region", { name: "src/webhooks/verify.ts changes", exact: true }).last()).toContainText("TOLERANCE")
  await page.reload()
  await expect(page.getByRole("region", { name: "package.json changes", exact: true }).last()).toContainText("17.2.0")
})

// Seeded UI projection; live provider qualification remains above.
test("A-DIFF: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/diff T8")
  await expect(page.getByRole("region", { name: "package.json changes", exact: true }).last()).toContainText("17.2.0")
  await expect(page.getByRole("region", { name: "src/webhooks/verify.ts changes", exact: true }).last()).toContainText("TOLERANCE")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
