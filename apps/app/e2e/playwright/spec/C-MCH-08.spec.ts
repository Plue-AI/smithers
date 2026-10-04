import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MCH-08.md; not a qualification receipt.
// Written before implementation: mvp.md §6.7, J7.2; lands with T-MCH-08
test("C-MCH-08: Fork preserves the source and captured files", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.7, J7.2; lands with T-MCH-08")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const input = page.getByRole("textbox", { name: "Terminal input", exact: true }).last()
  await input.fill("printf captured > src/try.ts; cat /proc/sys/kernel/random/boot_id")
  await input.press("Enter")
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "Fork", exact: true }).last().press("Enter")
  await expect(page.getByText("Scratch", { exact: true }).last()).toBeVisible()
  await say(page, "/file src/try.ts")
  await expect(page.getByRole("region", { name: "File content", exact: true }).last()).toContainText("captured")
  await page.reload()
  await expect(page.getByText("Scratch", { exact: true }).last()).toBeVisible()
  await say(page, "/branch retry-webhooks")
  await expect(page.getByText("Awake", { exact: true }).last()).toBeVisible()
})

// Mounted fork projection; source boot continuity requires reference-host evidence.
test("C-MCH-08: Fork opens a scratch branch and preserves the source state", async ({ page }) => {
  await page.goto("/")
  await say(page, "/branch retry-webhooks")
  await expect(page.getByText("Awake", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "Fork", exact: true }).last().press("Enter")
  await expect(page.getByText("Scratch", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Add to stack", exact: true }).last()).toBeVisible()
  await say(page, "/branch retry-webhooks")
  await expect(page.getByText("Awake", { exact: true }).last()).toBeVisible()
})
