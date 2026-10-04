import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md Appendix A, J3.2, §6.8; lands with T-COL-08, T-APP-14
test("A-FILE: opens and saves a shared file", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J3.2, §6.8; lands with T-COL-08, T-APP-14")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch T9")
  await say(page, "/file src/webhooks/retry.ts")
  const editor = page.getByRole("textbox", { name: /retry.ts/ }).last()
  await editor.fill("export const retries = 5")
  await expect(page.getByText("Saved", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByRole("textbox", { name: /retry.ts/ }).last()).toHaveValue("export const retries = 5")
})

// Seeded UI projection; live provider qualification remains above.
test("A-FILE: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/branch T9")
  await say(page, "/file src/webhooks/retry.ts")
  const content = page.getByRole("region", { name: "File content", exact: true }).last()
  await expect(content).toContainText("await sleep(30_000)")
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("region", { name: "File content", exact: true }).last()).toContainText("await sleep(30_000)")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
