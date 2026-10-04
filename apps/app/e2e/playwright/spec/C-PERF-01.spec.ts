import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-PERF-01.md; not a qualification receipt.
// Written before implementation: mvp.md §9, §6.5; lands with T-REL-01
test("C-PERF-01: Every no-machine answer includes context and a card", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §9, §6.5; lands with T-REL-01")
  await owner(page)
  await page.goto("/")
  // UI projection only: real 100-sample DOM timing, preflight clocks and p95
  // belong to the second-Mac performance harness, not the hermetic chat stub.
  await say(page, "/branch main")
  for (let sample = 0; sample < 100; sample++) {
    await say(page, "Why does the checkout test fail?")
    const context = page.getByRole("button", { name: /^Context · \d+$/ }).last()
    await expect(context).toBeVisible()
    await context.press("Enter")
    await expect(page.getByText("checkout.test.ts", { exact: true }).last()).toBeVisible()
    await page.getByRole("button", { name: "Inspect", exact: true }).last().press("Enter")
    await expect(page.getByText("Preflight", { exact: true }).last()).toBeVisible()
    await page.keyboard.press("Escape")
  }
  await say(page, "/stack")
  await expect(page.getByText("Asleep", { exact: true }).last()).toBeVisible()
  // Machine wake deltas and first-token/complete-answer timing must pass the
  // reference-host check before this represents performance qualification.
})
