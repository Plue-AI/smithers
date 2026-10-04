import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-COL-03.md; not a qualification receipt.
// Written before implementation: mvp.md J7.4, J3.5, §6.7; lands with T-COL-03r, T-COL-03a, T-COL-03, T-STK-08, T-APP-14a
test("C-COL-03: Typing survives rebase while saves wait", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J7.4, J3.5, §6.7; lands with T-COL-03r, T-COL-03a, T-COL-03, T-STK-08, T-APP-14a")
  await owner(page)
  await page.goto("/")
  // Seed: pending rebase with a delayed host acknowledgement and a busy
  // writer followed by successful freeze/rewrite. FIFO/cgroup timing and the
  // real-client matrix remain component and reference-host checks.
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "Rebase now", exact: true }).last().press("Enter")
  await expect(page.getByText("Waiting for a write in Ben's terminal", { exact: true }).last()).toBeVisible()
  await say(page, "/file src/webhooks/retry.ts")
  const editor = page.getByRole("textbox", { name: "src/webhooks/retry.ts", exact: true }).last()
  await editor.press("Control+End")
  await editor.pressSequentially("\n// Ben keeps retries bounded")
  await expect(page.getByText("Rebasing…", { exact: true }).last()).toBeVisible()
  await expect(editor).toHaveValue(/Ben keeps retries bounded/)
  await expect(page.getByText("Rebased onto T8", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Saved to the machine", { exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/file src/webhooks/retry.ts")
  await expect(editor).toHaveValue(/Ben keeps retries bounded/)
})
