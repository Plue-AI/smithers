import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md J3.2, §6.15, Appendix A /ssh; lands with T-TRM-03, T-APP-10
test("A-SSH: command and button copy the branch SSH line", async ({ page, context }) => {
  test.fixme(true, "Written before implementation: mvp.md J3.2, §6.15, Appendix A /ssh; lands with T-TRM-03, T-APP-10")
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await owner(page)
  await page.goto("/")
  await say(page, "/ssh retry-webhooks")
  await expect(page.getByText("ssh -p 2222 retry-webhooks@maya-mini.tail1234.ts.net", { exact: true }).last()).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("ssh -p 2222 retry-webhooks@maya-mini.tail1234.ts.net")
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "Copy SSH line", exact: true }).last().press("Enter")
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("ssh -p 2222 retry-webhooks@maya-mini.tail1234.ts.net")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded branch projection; /ssh and live host qualification remain pending above.
test("A-SSH: mounted branch copies its SSH line by keyboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await owner(page)
  await page.goto("/")
  await say(page, "/branch T9")
  const branch = page.locator(".branch-view").last()
  await expect(branch.getByText("ssh -p 2222 retry-webhooks@maya-mini.tail1234.ts.net", { exact: true })).toBeVisible()
  await branch.getByRole("button", { name: "Copy SSH line", exact: true }).press("Enter")
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("ssh -p 2222 retry-webhooks@maya-mini.tail1234.ts.net")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
