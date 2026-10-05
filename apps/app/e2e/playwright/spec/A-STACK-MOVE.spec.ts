import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// mvp.md Appendix A, J4.2, §4.2 (T-STK-02): /stack.move runs through the TODO seam, the seed here; the install's
// POST /api/todos/{n} {op: move} is proven by the J4 rehearsal's row 12.
test("A-STACK-MOVE: moves a stable ref up and down", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/stack")
  const refs = page.locator(".mvp-home").first().locator(".mvp-stack-row .mvp-ref")
  await expect(refs).toHaveText(["T8", "T9", "T10", "T11"])
  await say(page, "/stack.move T11 up")
  await expect(refs).toHaveText(["T8", "T9", "T11", "T10"])
  await say(page, "/stack.move T11 down")
  await expect(refs).toHaveText(["T8", "T9", "T10", "T11"])
  await page.reload()
  await expect(refs).toHaveText(["T8", "T9", "T10", "T11"])
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Mounted control projection.
test("A-STACK-MOVE: mounted command projection", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  const refs = page.locator(".mvp-home").first().locator(".mvp-stack-row .mvp-ref")
  await expect(refs).toHaveText(["T8", "T9", "T10", "T11"])
  await say(page, "/stack.move T11 up")
  await expect(refs).toHaveText(["T8", "T9", "T11", "T10"])
  await say(page, "/stack.move T11 down")
  await expect(refs).toHaveText(["T8", "T9", "T10", "T11"])
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
