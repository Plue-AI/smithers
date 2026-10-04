import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md Appendix A, J3.2, §6.8; lands with T-APP-10, T-COL-04
test("A-FILES: browses live branch files", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J3.2, §6.8; lands with T-APP-10, T-COL-04")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch T9")
  await say(page, "/files")
  await page.getByRole("button", { name: "src/webhooks/retry.ts", exact: true }).last().press("Enter")
  await expect(page.getByRole("region", { name: "File content", exact: true }).last()).toContainText("await sleep(30_000)")
  await page.reload()
  await say(page, "/files")
  await expect(page.getByRole("button", { name: "src/webhooks/retry.ts", exact: true }).last()).toBeVisible()
})

// Seeded UI projection; live provider qualification remains above.
test("A-FILES: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/files T9")
  await page.getByRole("button", { name: "src/webhooks/retry.ts", exact: true }).last().press("Enter")
  await expect(page.getByRole("region", { name: "File content", exact: true }).last()).toContainText("await sleep(30_000)")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
