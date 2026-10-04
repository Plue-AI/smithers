import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Live branch, machine and durable provider receipts remain pending.
// Written before implementation: mvp.md Appendix A, J7.3, §6.7; lands with T-MCH-08, T-STK-05
test("A-BRANCH-ADD-TO-STACK: adds scratch work after its source and keeps it after drop", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J7.3, §6.7; lands with T-MCH-08, T-STK-05")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch.fork T10")
  const scratch = page.locator(".branch-view").last()
  const name = await scratch.getByRole("heading", { level: 2 }).innerText()
  await say(page, `/branch.add-to-stack ${name}`)
  await expect(scratch).toContainText("T12")
  await expect(scratch).not.toContainText("Scratch")
  await say(page, "/todo.drop T10")
  await say(page, "/stack")
  const rows = page.locator(".mvp-home").first().locator(".mvp-stack-row")
  await expect(rows.filter({ hasText: "T10" })).toHaveCount(0)
  await expect(rows.locator(".mvp-ref")).toHaveText(["T8", "T9", "T12", "T11"])
  await page.reload()
  await expect(page.locator(".mvp-home").first()).toContainText("T12")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded UI projection; does not discharge the live-provider scenario above.
test("A-BRANCH-ADD-TO-STACK: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/branch.fork T10")
  const scratch = page.locator(".branch-view").last()
  const name = await scratch.getByRole("heading", { level: 2 }).innerText()
  await say(page, `/branch.add-to-stack ${name}`)
  await expect(scratch).toContainText("T12")
  await expect(scratch).not.toContainText("Scratch")
  await expect(scratch.getByRole("button", { name: "Add to stack", exact: true })).toHaveCount(0)
  await say(page, "/stack")
  await expect(page.locator(".mvp-home").first().locator(".mvp-stack-row .mvp-ref")).toHaveText(["T8", "T9", "T10", "T12", "T11"])
})
